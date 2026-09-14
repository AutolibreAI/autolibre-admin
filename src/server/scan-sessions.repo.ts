import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { FAILED, NO_DATA, OK, PENDING } from './scanners.repo'
import { lookupDtc } from './dtc-catalog'
import { sessionBucket } from '~/lib/scanners'
import type {
  ScanAiDiagnostic,
  ScanAnomaly,
  ScanAnomalyDetail,
  ScanChunk,
  ScanDtcDetail,
  ScanEvidenceValue,
  ScanMetric,
  ScanNotEvaluable,
  ScanSessionDetail,
  ScanSessionRow,
  ScanSessionSearch,
  ScanSessionSortKey,
  ScanTelemetryAnalysis,
} from '~/lib/scan-sessions'

/**
 * Sesiones de escáner — SOLO LECTURA.
 *
 * Mismo dueño de SQL que `scanners.repo.ts`, `ops.repo.ts` y `users.repo.ts`:
 * nosotros, sobre tablas de `public`, con la consulta versionada acá y no como
 * función de `ops`. Motivo en `.claude/rules/ops-metrics.md`.
 *
 * **Ni una escritura.** Un escaneo es un hecho que pasó.
 */

const toInt = (v: unknown): number => Number(v ?? 0)
const toNum = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v)
const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v)

/**
 * `sortKey → expresión SQL`, mapa cerrado. Es lo que hace seguro interpolar la
 * columna y `dir` en el `ORDER BY`: los dos salen de un enum de zod y de este
 * `Record` que los tipos obligan a cubrir. Mismo patrón que `listFineDebtors` y
 * `listUsers`.
 */
const SORT_COLUMNS: Record<ScanSessionSortKey, string> = {
  date: 'started_at',
  duration: 'duration_s',
  user: 'user_email',
  vehicle: 'plate',
  readings: 'total_readings',
  dtcs: 'dtc_count',
  anomalies: 'anomaly_count',
  distance: 'distance_since_dtc_clear_km',
  battery: 'battery_volts',
  firmware: 'scanner_firmware',
  status: 'status',
}

interface Row {
  id: string
  external_session_id: string
  status: string
  started_at: Date | string
  ended_at: Date | string | null
  duration_s: number | string | null
  user_id: string
  user_email: string
  user_name: string | null
  vehicle_id: string
  plate: string
  alias: string | null
  brand: string | null
  model: string | null
  trim: string | null
  year: number | string | null
  scanner_type: string
  scanner_firmware: string | null
  obd_protocol: string | null
  battery_voltage: string | null
  detected_vin: string | null
  total_readings: number | string
  total_chunks: number | string
  chunks_uploaded: number | string
  distance_since_dtc_clear_km: number | string | null
  dtc_codes: Array<string> | null
  dtc_count: number | string
  anomalies: Array<{ type: string; severity: string; pid: string | null }> | null
  anomaly_count: number | string
  anom_red: number | string
  anom_violet: number | string
  anom_yellow: number | string
  produced_ai: boolean
  produced_telemetry: boolean
  speed_max: number | string | null
  rpm_max: number | string | null
  temp_max: number | string | null
}

/**
 * Todas las sesiones, una por fila.
 *
 * ── El envoltorio `select * from (...) s` ──────────────────────────────────
 *
 * `duration_s`, `dtc_count`, `anomaly_count`, `battery_volts` y las de anomalías
 * son expresiones o subconsultas del SELECT. Filtrar/ordenar por ellas obliga a
 * envolver una vez y referenciar el alias afuera — Postgres no deja usar un
 * alias del SELECT en su propio nivel. Mismo motivo que `listUsers`,
 * `listFineDebtors` y `listAppChats`.
 *
 * ── `JOIN` a `users`/`vehicles`, `LEFT` al catálogo ────────────────────────
 *
 * `driving_sessions.user_id` y `.vehicle_id` son NOT NULL con FK: un `LEFT`
 * escondería una corrupción. El catálogo es distinto — la FK garantiza que el
 * SPEC exista, no el catálogo (misma trampa que `scanner-compatibility.md`), así
 * que ahí sí `LEFT` y `catalogLabel` puede quedar `null`.
 *
 * ── El filtro de estado va en el WHERE INTERNO ─────────────────────────────
 *
 * Reusa las cadenas `OK`/`NO_DATA`/`FAILED`/`PENDING` exportadas por
 * `scanners.repo.ts` (alias `ds.`), así que va antes del envoltorio. Es el mismo
 * corte que agrega la matriz: si divergieran, la matriz diría "0 / 4" y esta
 * lista mostraría la sesión como `ok`.
 */
export async function listScanSessions(
  search: ScanSessionSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<ScanSessionRow>> {
  void opts.signal // `pg` no acepta AbortSignal; queda documentado el hueco.

  const innerWhere: Array<string> = []
  if (search.scanState === 'ok') innerWhere.push(OK)
  else if (search.scanState === 'noData') innerWhere.push(NO_DATA)
  else if (search.scanState === 'failed') innerWhere.push(FAILED)
  else if (search.scanState === 'pending') innerWhere.push(PENDING)

  const params: Array<unknown> = []
  const outerWhere: Array<string> = []

  if (search.q) {
    params.push(`%${search.q}%`)
    const p = `$${params.length}`
    outerWhere.push(`(
      user_email ilike ${p}
      or coalesce(user_name, '') ilike ${p}
      or plate ilike ${p}
      or coalesce(alias, '') ilike ${p}
      or concat_ws(' ', brand, model, trim, year::text) ilike ${p}
      or coalesce(detected_vin, '') ilike ${p}
      or coalesce(scanner_firmware, '') ilike ${p}
      or exists (select 1 from unnest(dtc_codes) c where c ilike ${p})
    )`)
  }

  if (search.dtc === 'with') outerWhere.push('dtc_count > 0')
  else if (search.dtc === 'without') outerWhere.push('dtc_count = 0')

  if (search.anomaly === 'with') outerWhere.push('anomaly_count > 0')
  else if (search.anomaly === 'red') outerWhere.push('anom_red > 0')
  else if (search.anomaly === 'without') outerWhere.push('anomaly_count = 0')

  const sortColumn = SORT_COLUMNS[search.sort]

  const rows = await sql<Row>(
    `
    select * from (
      select
        ds.id,
        ds.external_session_id,
        ds.status::text                        as status,
        ds.started_at,
        ds.ended_at,
        extract(epoch from (ds.ended_at - ds.started_at))::int as duration_s,
        u.id as user_id, u.email as user_email, u.name as user_name,
        v.id as vehicle_id, v.plate, v.alias,
        vc.brand, vc.model, vc.trim, vc.year,
        ds.scanner_type::text                  as scanner_type,
        ds.scanner_firmware,
        ds.obd_protocol,
        ds.battery_voltage,
        nullif(regexp_replace(coalesce(ds.battery_voltage, ''), '[^0-9.]', '', 'g'), '')::numeric
                                               as battery_volts,
        ds.detected_vin,
        ds.total_readings,
        ds.total_chunks,
        (select count(*)::int from driving_session_chunks dsc where dsc.session_id = ds.id)
                                               as chunks_uploaded,
        ds.distance_since_dtc_clear_km,
        coalesce(
          (select s2.codes from session_dtc_snapshots s2 where s2.session_id = ds.id limit 1),
          array[]::text[]
        )                                      as dtc_codes,
        coalesce(
          array_length(
            (select s3.codes from session_dtc_snapshots s3 where s3.session_id = ds.id limit 1),
            1
          ),
          0
        )                                      as dtc_count,
        exists (select 1 from ai_diagnostics a where a.session_id = ds.id)         as produced_ai,
        exists (select 1 from driving_telemetry_analysis t2 where t2.session_id = ds.id)
                                               as produced_telemetry,
        case when jsonb_typeof(t.anomalies) = 'array' then (
          select coalesce(
            jsonb_agg(
              jsonb_build_object('type', a->>'type', 'severity', a->>'severity', 'pid', a->>'affectedPid')
              order by case a->>'severity'
                         when 'red' then 0 when 'violet' then 1 when 'yellow' then 2 else 3 end
            ),
            '[]'::jsonb
          )
          from jsonb_array_elements(t.anomalies) a
        ) else '[]'::jsonb end                  as anomalies,
        case when jsonb_typeof(t.anomalies) = 'array'
             then jsonb_array_length(t.anomalies) else 0 end as anomaly_count,
        coalesce((t.summary -> 'bySeverity' ->> 'red')::int, 0)    as anom_red,
        coalesce((t.summary -> 'bySeverity' ->> 'violet')::int, 0) as anom_violet,
        coalesce((t.summary -> 'bySeverity' ->> 'yellow')::int, 0) as anom_yellow,
        (t.metrics -> 'speed' ->> 'max')::numeric      as speed_max,
        (t.metrics -> 'rpm' ->> 'max')::numeric        as rpm_max,
        (t.metrics -> 'engineTemp' ->> 'max')::numeric as temp_max
      from driving_sessions ds
      join users u on u.id = ds.user_id
      join vehicles v on v.id = ds.vehicle_id
      left join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
      left join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
      left join driving_telemetry_analysis t on t.session_id = ds.id
      ${innerWhere.length ? `where ${innerWhere.join(' and ')}` : ''}
    ) s
    ${outerWhere.length ? `where ${outerWhere.join(' and ')}` : ''}
    order by ${sortColumn} ${search.dir} nulls last, started_at desc, id
    `,
    params,
  )

  return rows.map((r) => {
    const anomalies: Array<ScanAnomaly> = (r.anomalies ?? []).map((a) => ({
      type: a.type,
      severity: a.severity,
      pid: a.pid,
    }))

    return {
      id: r.id,
      externalSessionId: r.external_session_id,
      bucket: sessionBucket(r.status, toInt(r.total_readings)),
      status: r.status,
      startedAt: toIso(r.started_at) as string,
      endedAt: toIso(r.ended_at),
      durationSeconds: toNum(r.duration_s),
      userId: r.user_id,
      userEmail: r.user_email,
      userName: r.user_name,
      vehicleId: r.vehicle_id,
      plate: r.plate,
      alias: r.alias,
      catalogLabel: r.brand
        ? [r.brand, r.model, r.trim, r.year].filter(Boolean).join(' ')
        : null,
      scannerType: r.scanner_type,
      firmware: r.scanner_firmware,
      obdProtocol: r.obd_protocol,
      batteryVoltage: r.battery_voltage,
      detectedVin: r.detected_vin,
      totalReadings: toInt(r.total_readings),
      totalChunks: toInt(r.total_chunks),
      chunksUploaded: toInt(r.chunks_uploaded),
      distanceSinceDtcClearKm: toNum(r.distance_since_dtc_clear_km),
      dtcCodes: r.dtc_codes ?? [],
      dtcCount: toInt(r.dtc_count),
      anomalies,
      anomalyCount: toInt(r.anomaly_count),
      anomaliesBySeverity: {
        red: toInt(r.anom_red),
        violet: toInt(r.anom_violet),
        yellow: toInt(r.anom_yellow),
      },
      producedAiDiagnostic: r.produced_ai,
      producedTelemetryAnalysis: r.produced_telemetry,
      speedMax: toNum(r.speed_max),
      rpmMax: toNum(r.rpm_max),
      engineTempMax: toNum(r.temp_max),
    }
  })
}

// ── El detalle de UNA sesión ─────────────────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = { red: 0, violet: 1, yellow: 2 }
const byWorstSeverityFirst = (a: { severity: string }, b: { severity: string }) =>
  (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)

interface DetailRow {
  id: string
  external_session_id: string
  status: string
  started_at: Date | string
  ended_at: Date | string | null
  created_at: Date | string
  duration_s: number | string | null
  user_id: string
  user_email: string
  user_name: string | null
  vehicle_id: string
  plate: string
  alias: string | null
  brand: string | null
  model: string | null
  trim: string | null
  year: number | string | null
  scanner_type: string
  scanner_firmware: string | null
  obd_protocol: string | null
  battery_voltage: string | null
  detected_vin: string | null
  total_readings: number | string
  total_chunks: number | string
  chunk_size: number | string
  distance_since_dtc_clear_km: number | string | null
  dtc_codes: Array<string> | null
}

interface ChunkRow {
  chunk_index: number
  reading_count: number
  object_key: string
  content_sha256: string
  created_at: Date | string
}

interface DtcDetailRow {
  code: string
  standard_description: string | null
  raw_response: string | null
  created_at: Date | string
}

interface TelemetrySummaryJson {
  bySeverity?: { red?: number; violet?: number; yellow?: number }
  totalAnomalies?: number
  notEvaluable?: Array<{
    type: string
    study: string
    reason: string
    affectedPid?: string | null
    justification: string
    missingPidKeys?: Array<string>
  }>
}

interface TelemetryAnomalyJson {
  type: string
  severity: string
  affectedPid?: string | null
  justification: string
  probableCauses?: Array<string>
  evidence?: Record<string, ScanEvidenceValue>
}

interface TelemetryRow {
  summary: TelemetrySummaryJson | null
  anomalies: Array<TelemetryAnomalyJson> | null
  metrics: Record<string, ScanMetric> | null
}

interface AiDiagnosticRow {
  id: string
  text: string | null
  model: string | null
  status: string
  failure_reason: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  embedding_tokens: number | null
  embedding_model: string | null
  rag_docs_used: Array<string> | null
  created_at: Date | string
}

/**
 * El detalle entero de UNA sesión — todo lo que las tablas colgadas de
 * `session_id` tienen, no sólo los contadores de la fila de la lista.
 *
 * ── Por qué NO reusa el LEFT JOIN a `driving_telemetry_analysis` de la fila ──
 *
 * La fila (`listScanSessions`) sólo necesita contadores y el `max` de tres PIDs,
 * así que trae el análisis por columnas sueltas. Acá hace falta el jsonb
 * COMPLETO —`justification`, `probableCauses`, `evidence` por anomalía;
 * `notEvaluable`; el objeto `metrics` entero, no sólo 3 claves— así que se trae
 * aparte, en su propia consulta, y `speedMax`/`rpmMax`/`producedTelemetryAnalysis`
 * se DERIVAN de ese resultado en vez de volver a pedirlos por columna.
 *
 * ── Cinco consultas en paralelo, no una JOIN gigante ─────────────────────────
 *
 * `driving_session_chunks`, `diagnostic_dtcs` y `ai_diagnostics` son 1\:N (hasta
 * 5, y hasta 2 respectivamente, verificado contra producción) — traerlas por
 * JOIN multiplicaría la fila principal. Como es UNA sesión (no un listado que
 * necesite ordenar/filtrar por sus subtablas), no hace falta el envoltorio
 * `select * from (...) s` que sí necesitan `listScanSessions` o `listUsers`.
 *
 * `null` si el id no resuelve a ninguna sesión — el caller lo traduce a 404.
 */
export async function getScanSessionDetail(
  sessionId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ScanSessionDetail | null> {
  void opts.signal // `pg` no acepta AbortSignal; queda documentado el hueco.

  const [row, chunkRows, dtcRows, telemetryRow, aiRows] = await Promise.all([
    sqlOne<DetailRow>(
      `
      select
        ds.id,
        ds.external_session_id,
        ds.status::text                        as status,
        ds.started_at,
        ds.ended_at,
        ds.created_at,
        extract(epoch from (ds.ended_at - ds.started_at))::int as duration_s,
        u.id as user_id, u.email as user_email, u.name as user_name,
        v.id as vehicle_id, v.plate, v.alias,
        vc.brand, vc.model, vc.trim, vc.year,
        ds.scanner_type::text                  as scanner_type,
        ds.scanner_firmware,
        ds.obd_protocol,
        ds.battery_voltage,
        ds.detected_vin,
        ds.total_readings,
        ds.total_chunks,
        ds.chunk_size,
        ds.distance_since_dtc_clear_km,
        coalesce(
          (select s.codes from session_dtc_snapshots s where s.session_id = ds.id limit 1),
          array[]::text[]
        )                                      as dtc_codes
      from driving_sessions ds
      join users u on u.id = ds.user_id
      join vehicles v on v.id = ds.vehicle_id
      left join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
      left join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
      where ds.id = $1
      `,
      [sessionId],
    ),
    sql<ChunkRow>(
      `select chunk_index, reading_count, object_key, content_sha256, created_at
       from driving_session_chunks where session_id = $1 order by chunk_index`,
      [sessionId],
    ),
    sql<DtcDetailRow>(
      `select code, standard_description, raw_response, created_at
       from diagnostic_dtcs where session_id = $1 order by code`,
      [sessionId],
    ),
    sqlOne<TelemetryRow>(
      `select summary, anomalies, metrics
       from driving_telemetry_analysis where session_id = $1`,
      [sessionId],
    ),
    sql<AiDiagnosticRow>(
      `select id, diagnosis->>'text' as text, model, status::text as status,
              failure_reason, prompt_tokens, completion_tokens,
              embedding_tokens, embedding_model, rag_docs_used, created_at
       from ai_diagnostics where session_id = $1 order by created_at`,
      [sessionId],
    ),
  ])

  if (!row) return null

  const dtcCodes = row.dtc_codes ?? []

  const telemetry: ScanTelemetryAnalysis | null = telemetryRow
    ? {
        bySeverity: {
          red: toInt(telemetryRow.summary?.bySeverity?.red),
          violet: toInt(telemetryRow.summary?.bySeverity?.violet),
          yellow: toInt(telemetryRow.summary?.bySeverity?.yellow),
        },
        totalAnomalies:
          telemetryRow.summary?.totalAnomalies ?? (telemetryRow.anomalies ?? []).length,
        anomalies: (telemetryRow.anomalies ?? [])
          .map(
            (a): ScanAnomalyDetail => ({
              type: a.type,
              severity: a.severity,
              pid: a.affectedPid ?? null,
              justification: a.justification,
              probableCauses: a.probableCauses ?? [],
              evidence: a.evidence ?? {},
            }),
          )
          .sort(byWorstSeverityFirst),
        notEvaluable: (telemetryRow.summary?.notEvaluable ?? []).map(
          (n): ScanNotEvaluable => ({
            type: n.type,
            study: n.study,
            reason: n.reason,
            affectedPid: n.affectedPid ?? null,
            justification: n.justification,
            missingPidKeys: n.missingPidKeys ?? [],
          }),
        ),
        metrics: telemetryRow.metrics ?? {},
      }
    : null

  const aiDiagnostics: Array<ScanAiDiagnostic> = aiRows.map((r) => ({
    id: r.id,
    text: r.text,
    model: r.model,
    status: r.status,
    failureReason: r.failure_reason,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    embeddingTokens: r.embedding_tokens,
    embeddingModel: r.embedding_model,
    ragDocsUsed: r.rag_docs_used ?? [],
    createdAt: toIso(r.created_at) as string,
  }))

  const dtcDetails: Array<ScanDtcDetail> = dtcRows.map((r) => {
    const info = lookupDtc(r.code)
    return {
      code: r.code,
      title: info?.title ?? null,
      system: info?.system ?? null,
      standardDescription: r.standard_description,
      rawResponse: r.raw_response,
      createdAt: toIso(r.created_at) as string,
    }
  })

  const chunks: Array<ScanChunk> = chunkRows.map((r) => ({
    chunkIndex: r.chunk_index,
    readingCount: r.reading_count,
    objectKey: r.object_key,
    contentSha256: r.content_sha256,
    createdAt: toIso(r.created_at) as string,
  }))

  const anomalies: Array<ScanAnomaly> = (telemetry?.anomalies ?? []).map((a) => ({
    type: a.type,
    severity: a.severity,
    pid: a.pid,
  }))

  return {
    id: row.id,
    externalSessionId: row.external_session_id,
    bucket: sessionBucket(row.status, toInt(row.total_readings)),
    status: row.status,
    startedAt: toIso(row.started_at) as string,
    endedAt: toIso(row.ended_at),
    createdAt: toIso(row.created_at) as string,
    durationSeconds: toNum(row.duration_s),
    userId: row.user_id,
    userEmail: row.user_email,
    userName: row.user_name,
    vehicleId: row.vehicle_id,
    plate: row.plate,
    alias: row.alias,
    catalogLabel: row.brand
      ? [row.brand, row.model, row.trim, row.year].filter(Boolean).join(' ')
      : null,
    scannerType: row.scanner_type,
    firmware: row.scanner_firmware,
    obdProtocol: row.obd_protocol,
    batteryVoltage: row.battery_voltage,
    detectedVin: row.detected_vin,
    totalReadings: toInt(row.total_readings),
    totalChunks: toInt(row.total_chunks),
    chunkSize: toInt(row.chunk_size),
    chunksUploaded: chunks.length,
    distanceSinceDtcClearKm: toNum(row.distance_since_dtc_clear_km),
    dtcCodes,
    dtcCount: dtcCodes.length,
    anomalies,
    anomalyCount: anomalies.length,
    anomaliesBySeverity: telemetry?.bySeverity ?? { red: 0, violet: 0, yellow: 0 },
    producedAiDiagnostic: aiDiagnostics.length > 0,
    producedTelemetryAnalysis: telemetry !== null,
    speedMax: telemetry?.metrics.speed?.max ?? null,
    rpmMax: telemetry?.metrics.rpm?.max ?? null,
    engineTempMax: telemetry?.metrics.engineTemp?.max ?? null,
    chunks,
    dtcDetails,
    telemetry,
    aiDiagnostics,
  }
}
