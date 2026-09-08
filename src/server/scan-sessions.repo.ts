import '@tanstack/react-start/server-only'

import { sql } from './db'
import { FAILED, NO_DATA, OK, PENDING } from './scanners.repo'
import { sessionBucket } from '~/lib/scanners'
import type {
  ScanAnomaly,
  ScanSessionRow,
  ScanSessionSearch,
  ScanSessionSortKey,
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
