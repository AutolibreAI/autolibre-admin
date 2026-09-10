import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { lookupDtc } from './dtc-catalog'
import { SEVERITY_RANK } from '~/lib/detections'
import { anomalyTypeLabel } from '~/lib/scan-sessions'
import type {
  DetectionRow,
  DetectionSearch,
  DetectionSortKey,
  DetectionsView,
  MissingDtc,
} from '~/lib/detections'

/**
 * Detecciones de escáner (DTC + anomalías) — SOLO LECTURA.
 *
 * Mismo dueño de SQL que `scanners.repo.ts` y `scan-sessions.repo.ts`: nosotros,
 * sobre tablas de `public`, con la consulta versionada acá. Motivo en
 * `.claude/rules/ops-metrics.md`.
 *
 * ── El corte `OK` se REUSA, no se recopia ──────────────────────────────────
 *
 * El universo de sesiones (y el denominador de los dos porcentajes) es
 * `status = 'completed' AND total_readings > 0` — el MISMO `OK` de
 * `scanners.repo.ts`. Acá no se importa la cadena porque necesita el alias
 * `ds.` sin prefijo (se usa en un CTE con otro nombre de tabla), pero es el
 * mismo predicado, palabra por palabra. Si divergen, esta pantalla cuenta
 * sobre un universo distinto al de Compatibilidad y nadie lo nota.
 * → `.claude/rules/scan-detections.md`
 *
 * **Ni una escritura.**
 */

const toInt = (v: unknown): number => Number(v ?? 0)
const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v)

/**
 * `sortKey → columna`, mapa cerrado: lo único que hace seguro interpolar la
 * columna y `dir` en el `ORDER BY`. Mismo patrón que `SORT_COLUMNS` de
 * `scan-sessions.repo.ts` y `listUsers`.
 */
const SORT_COLUMNS: Record<DetectionSortKey, string> = {
  label: 'key',
  kind: 'kind',
  severity: 'severity_rank',
  sessions: 'sessions',
  vehicles: 'vehicles',
  models: 'models',
  first: 'first_seen',
  last: 'last_seen',
}

interface Row {
  kind: string
  key: string
  severities: Array<string> | null
  severity_rank: number | string | null
  sessions: number | string
  occurrences: number | string
  vehicles: number | string
  models: number | string
  first_seen: Date | string
  last_seen: Date | string
}

interface DtcCodeRow {
  code: string
  sessions: number | string
  vehicles: number | string
  first_seen: Date | string
  last_seen: Date | string
}

/**
 * El CTE del universo, definido UNA vez y compartido entre las tres consultas.
 *
 * Son **las sesiones `completed`**, con un flag `has_data` (trajo lecturas de
 * telemetría). NO se filtra por `has_data` acá: la rama DTC lo necesita
 * completo —un código se lee incluso en una sesión que enganchó sin traer
 * telemetría en vivo (`scanner-compatibility.md`)— y la rama de anomalías se
 * queda con `has_data` porque el análisis de telemetría no existe sin datos.
 *
 * `vehicles → specs → catalogs` con `LEFT` porque la FK garantiza el spec y no
 * el catálogo — misma trampa que `scanner-compatibility.md`.
 * → `.claude/rules/scan-detections.md`
 */
const SCAN_SESSIONS_CTE = `
  scan_sessions as (
    select ds.id,
           ds.vehicle_id,
           ds.started_at,
           coalesce(ds.total_readings, 0) > 0 as has_data,
           vc.id as catalog_id
    from driving_sessions ds
    join vehicles v on v.id = ds.vehicle_id
    left join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
    left join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
    where ds.status::text = 'completed'
  )`

/**
 * Una fila por código DTC y una por tipo de anomalía.
 *
 * ── El CTE `scan_sessions` se resuelve UNA vez ─────────────────────────────
 *
 * Las tres consultas (tabla, denominadores, códigos sin título) parten del
 * mismo CTE, en la misma sentencia cuando se puede, para compartir el snapshot.
 * Con subconsultas separadas cada una tomaría su propio reloj.
 *
 * ── El envoltorio `select * from (...) s` ──────────────────────────────────
 *
 * `severities`, `severity_rank`, los conteos y las fechas son expresiones
 * agregadas. Filtrar y ordenar por ellas obliga a envolver y referenciar el
 * alias afuera. Mismo motivo que `scan-sessions.repo.ts` y `listUsers`.
 *
 * ── `q` matchea el código / tipo CRUDO ─────────────────────────────────────
 *
 * `key` es `P0171` o `UNSTABLE_MAF`. La etiqueta legible de la anomalía se
 * traduce en JS (`anomalyTypeLabel`), así que buscar "inestable" no la
 * encuentra pero buscar "maf" o "P017" sí. Es la misma limitación que
 * `scan-sessions.repo.ts` con los códigos DTC.
 */
export async function listDetections(
  search: DetectionSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<DetectionsView> {
  void opts.signal // `pg` no acepta AbortSignal; queda documentado el hueco.

  const params: Array<unknown> = []
  const outerWhere: Array<string> = []

  if (search.q) {
    params.push(`%${search.q}%`)
    outerWhere.push(`key ilike $${params.length}`)
  }
  if (search.detectionKind !== 'all') {
    params.push(search.detectionKind)
    outerWhere.push(`kind = $${params.length}`)
  }
  if (search.detectionSeverity !== 'all') {
    params.push(search.detectionSeverity)
    // `severities` es NULL para los DTC, así que un filtro de severidad deja
    // sólo anomalías — que es lo correcto: un código no tiene severidad acá.
    outerWhere.push(`$${params.length} = any(severities)`)
  }
  if (search.detectionFamily !== 'all') {
    params.push(search.detectionFamily)
    outerWhere.push(`kind = 'dtc' and left(key, 1) = $${params.length}`)
  }

  const sortColumn = SORT_COLUMNS[search.sort]

  const [rows, denom, dtcCodes] = await Promise.all([
    sql<Row>(
      `
      with ${SCAN_SESSIONS_CTE},
      dtc as (
        select 'dtc'::text                          as kind,
               code                                 as key,
               null::text[]                         as severities,
               null::int                            as severity_rank,
               count(distinct ss.id)::int           as sessions,
               count(distinct ss.id)::int           as occurrences,
               count(distinct ss.vehicle_id)::int   as vehicles,
               count(distinct ss.catalog_id)::int   as models,
               min(ss.started_at)                   as first_seen,
               max(ss.started_at)                   as last_seen
        from session_dtc_snapshots s
        join scan_sessions ss on ss.id = s.session_id
        cross join lateral unnest(s.codes) as code
        group by code
      ),
      anomaly as (
        select 'anomaly'::text                      as kind,
               a->>'type'                           as key,
               array_agg(distinct a->>'severity')   as severities,
               max(case a->>'severity'
                     when 'red' then 3 when 'violet' then 2 when 'yellow' then 1
                     else 0 end)::int               as severity_rank,
               count(distinct ss.id)::int           as sessions,
               count(*)::int                        as occurrences,
               count(distinct ss.vehicle_id)::int   as vehicles,
               count(distinct ss.catalog_id)::int   as models,
               min(ss.started_at)                   as first_seen,
               max(ss.started_at)                   as last_seen
        from driving_telemetry_analysis t
        join scan_sessions ss on ss.id = t.session_id and ss.has_data
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(t.anomalies) = 'array' then t.anomalies else '[]'::jsonb end
        ) as a
        group by a->>'type'
      )
      select * from (
        select * from dtc
        union all
        select * from anomaly
      ) s
      ${outerWhere.length ? `where ${outerWhere.join(' and ')}` : ''}
      order by ${sortColumn} ${search.dir} nulls last, sessions desc, key
      `,
      params,
    ),
    sqlOne<{
      dtc_sessions: number | string
      dtc_vehicles: number | string
      anomaly_sessions: number | string
      anomaly_vehicles: number | string
    }>(
      `
      with ${SCAN_SESSIONS_CTE}
      select count(*)::int                                          as dtc_sessions,
             count(distinct vehicle_id)::int                        as dtc_vehicles,
             count(*) filter (where has_data)::int                  as anomaly_sessions,
             count(distinct vehicle_id) filter (where has_data)::int as anomaly_vehicles
      from scan_sessions
      `,
    ),
    /**
     * TODOS los códigos DTC detectados sobre sesiones `completed`, SIN los
     * filtros de la tabla: el bloque "sin título" es "todo lo que falta cargar",
     * no "lo que falta en esta vista". El título lo resuelve `lookupDtc` en JS.
     */
    sql<DtcCodeRow>(
      `
      with ${SCAN_SESSIONS_CTE}
      select code,
             count(distinct ss.id)::int         as sessions,
             count(distinct ss.vehicle_id)::int as vehicles,
             min(ss.started_at)                 as first_seen,
             max(ss.started_at)                 as last_seen
      from session_dtc_snapshots s
      join scan_sessions ss on ss.id = s.session_id
      cross join lateral unnest(s.codes) as code
      group by code
      `,
    ),
  ])

  const detections: Array<DetectionRow> = rows.map((r) => {
    const severities = (r.severities ?? [])
      .filter((s): s is string => s !== null)
      .sort((a, b) => (SEVERITY_RANK[b] ?? 0) - (SEVERITY_RANK[a] ?? 0))

    const isAnomaly = r.kind === 'anomaly'
    const info = isAnomaly ? null : lookupDtc(r.key)

    return {
      kind: isAnomaly ? 'anomaly' : 'dtc',
      key: r.key,
      label: isAnomaly ? anomalyTypeLabel(r.key) : r.key,
      dtcTitle: info?.title ?? null,
      dtcSystem: info?.system ?? null,
      severities,
      sessions: toInt(r.sessions),
      occurrences: toInt(r.occurrences),
      vehicles: toInt(r.vehicles),
      models: toInt(r.models),
      firstSeen: toIso(r.first_seen) as string,
      lastSeen: toIso(r.last_seen) as string,
    }
  })

  const missingDtcs: Array<MissingDtc> = dtcCodes
    .filter((r) => lookupDtc(r.code) === null)
    .map((r) => ({
      code: r.code,
      sessions: toInt(r.sessions),
      vehicles: toInt(r.vehicles),
      firstSeen: toIso(r.first_seen) as string,
      lastSeen: toIso(r.last_seen) as string,
    }))
    .sort((a, b) => b.sessions - a.sessions || a.code.localeCompare(b.code))

  return {
    rows: detections,
    missingDtcs,
    dtcSessions: toInt(denom?.dtc_sessions),
    dtcVehicles: toInt(denom?.dtc_vehicles),
    anomalySessions: toInt(denom?.anomaly_sessions),
    anomalyVehicles: toInt(denom?.anomaly_vehicles),
  }
}
