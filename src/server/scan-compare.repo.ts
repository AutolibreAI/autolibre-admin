import '@tanstack/react-start/server-only'

import { sql } from './db'
import type {
  CompareCatalogOption,
  CompareLevel,
  CompareSession,
  CompareView,
} from '~/lib/scan-compare'
import type { ScanMetric } from '~/lib/scan-sessions'

/**
 * El comparador de escaneos — SOLO LECTURA. → `~/lib/scan-compare`
 *
 * ── El universo: escaneos CON análisis de telemetría ────────────────────────
 *
 * `JOIN` (no `LEFT`) a `driving_telemetry_analysis`: sin análisis no hay
 * `metrics`, o sea nada que comparar. Es un subconjunto del corte `OK` de
 * `scanners.repo.ts` (el análisis sólo existe cuando el escaneo trajo datos),
 * así que no hace falta importarlo: el join ya lo implica.
 *
 * ── El catálogo es JOIN acá, no LEFT ────────────────────────────────────────
 *
 * El resto de `/escaneres` usa `LEFT` al catálogo porque no quiere perder un
 * escaneo de un auto huérfano. Acá la pregunta ES por modelo: un escaneo sin
 * catálogo no tiene contra qué compararse, y queda afuera a propósito.
 */

const toInt = (v: unknown): number => Number(v ?? 0)
const toNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const toIso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v)

const CATALOG_LABEL = `concat_ws(' ', vc.brand, vc.model, vc.trim, vc.year)`

/** `upper(btrim())` de los dos lados: el proveedor de catálogo no garantiza mayúsculas. */
const norm = (x: string) => `upper(btrim(coalesce(${x}, '')))`

/**
 * El predicado de "similar" por nivel, contra el catálogo de referencia `ref`.
 * Mapa cerrado: `level` sale de un enum de zod, nunca se interpola texto libre.
 */
const LEVEL_PREDICATE: Record<CompareLevel, string> = {
  exact: `vc.id = ref.id`,
  version: `${norm('vc.brand')} = ${norm('ref.brand')} and ${norm('vc.model')} = ${norm('ref.model')}
            and ${norm('vc.trim')} = ${norm('ref.trim')}`,
  model: `${norm('vc.brand')} = ${norm('ref.brand')} and ${norm('vc.model')} = ${norm('ref.model')}`,
}

interface CatalogOptionRow {
  id: string
  label: string
  sessions: number | string
  vehicles: number | string
}

/** Los modelos del catálogo con al menos un escaneo analizado, para el selector. */
export async function listComparableCatalogs(): Promise<Array<CompareCatalogOption>> {
  const rows = await sql<CatalogOptionRow>(`
    select vc.id, ${CATALOG_LABEL} as label,
           count(*)::int as sessions,
           count(distinct ds.vehicle_id)::int as vehicles
      from driving_sessions ds
      join driving_telemetry_analysis t on t.session_id = ds.id
      join vehicles v on v.id = ds.vehicle_id
      join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
      join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
     group by vc.id
     order by vc.brand, vc.model, vc.trim, vc.year
  `)
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    sessions: toInt(r.sessions),
    vehicles: toInt(r.vehicles),
  }))
}

interface SessionRow {
  id: string
  started_at: Date | string
  duration_s: number | string | null
  total_readings: number | string
  vehicle_id: string
  plate: string
  alias: string | null
  odometer_value: number | string | null
  user_id: string
  user_label: string
  catalog_id: string
  catalog_label: string
  year: number | string | null
  fuel_type: string | null
  transmission: string | null
  distance_since_dtc_clear_km: number | string | null
  dtc_codes: Array<string> | null
  last_maintenance_name: string | null
  last_maintenance_days_before: number | string | null
  metrics: Record<string, ScanMetric> | null
}

/**
 * Todos los escaneos analizados de los catálogos "similares" al de referencia.
 *
 * La selección de autos/escaneos/PIDs NO entra acá: se aplica en el cliente
 * sobre esta lista. Son decenas de filas, y así el gráfico, las medianas y la
 * tabla salen del mismo snapshot (mismo criterio que el resumen de
 * `campaigns.repo.ts`, que se agrega en JS por el mismo motivo).
 *
 * El último mantenimiento es subconsulta ESCALAR, no JOIN: un auto con varios
 * mantenimientos multiplicaría el escaneo (`users.md`, trampa 2). Se compara
 * en hora de Buenos Aires — `performed_at` es la fecha que tipeó la persona.
 *
 * `metrics` viaja entero (≤13 claves × pocas decenas de filas): recortarlo a
 * los PIDs elegidos obligaría a volver al servidor cada vez que se tilda uno.
 */
export async function compareScanSessions(
  catalogId: string,
  level: CompareLevel,
): Promise<CompareView> {
  const [refRows, sessionRows] = await Promise.all([
    sql<CatalogOptionRow>(
      `select vc.id, ${CATALOG_LABEL} as label,
              count(ds.id)::int as sessions,
              count(distinct ds.vehicle_id)::int as vehicles
         from vehicle_catalogs vc
         left join vehicle_catalog_specs vcs on vcs.vehicle_catalog_id = vc.id
         left join vehicles v on v.vehicle_catalog_spec_id = vcs.id
         left join driving_sessions ds on ds.vehicle_id = v.id
          and exists (select 1 from driving_telemetry_analysis t where t.session_id = ds.id)
        where vc.id = $1
        group by vc.id`,
      [catalogId],
    ),
    sql<SessionRow>(
      `
      with ref as (select id, brand, model, trim from vehicle_catalogs where id = $1)
      select
        ds.id,
        ds.started_at,
        extract(epoch from (ds.ended_at - ds.started_at))::int as duration_s,
        ds.total_readings,
        v.id as vehicle_id, v.plate, v.alias, v.odometer_value,
        u.id as user_id, coalesce(nullif(btrim(u.name), ''), u.email) as user_label,
        vc.id as catalog_id, ${CATALOG_LABEL} as catalog_label, vc.year,
        vcs.fuel_type::text as fuel_type, vcs.transmission::text as transmission,
        ds.distance_since_dtc_clear_km,
        (select s.codes from session_dtc_snapshots s where s.session_id = ds.id limit 1) as dtc_codes,
        (select coalesce(mo.name, mo.service_slug)
           from maintenance_occurrences mo
          where mo.vehicle_id = v.id and not mo.archived and mo.performed_at is not null
            and mo.performed_at <= (ds.started_at at time zone 'America/Argentina/Buenos_Aires')::date
          order by mo.performed_at desc, mo.created_at desc limit 1) as last_maintenance_name,
        (select (ds.started_at at time zone 'America/Argentina/Buenos_Aires')::date - max(mo.performed_at)
           from maintenance_occurrences mo
          where mo.vehicle_id = v.id and not mo.archived and mo.performed_at is not null
            and mo.performed_at <= (ds.started_at at time zone 'America/Argentina/Buenos_Aires')::date
        ) as last_maintenance_days_before,
        t.metrics
      from ref
      join vehicle_catalogs vc on ${LEVEL_PREDICATE[level]}
      join vehicle_catalog_specs vcs on vcs.vehicle_catalog_id = vc.id
      join vehicles v on v.vehicle_catalog_spec_id = vcs.id
      join driving_sessions ds on ds.vehicle_id = v.id
      join driving_telemetry_analysis t on t.session_id = ds.id
      join users u on u.id = ds.user_id
      order by vc.year, v.plate, ds.started_at
      `,
      [catalogId],
    ),
  ])

  const refRow = refRows[0]
  const reference: CompareCatalogOption | null =
    refRow && toInt(refRow.sessions) > 0
      ? {
          id: refRow.id,
          label: refRow.label,
          sessions: toInt(refRow.sessions),
          vehicles: toInt(refRow.vehicles),
        }
      : null

  const sessions: Array<CompareSession> = sessionRows.map((r) => {
    const odometer = toNum(r.odometer_value)
    return {
      id: r.id,
      startedAt: toIso(r.started_at),
      durationSeconds: toNum(r.duration_s),
      totalReadings: toInt(r.total_readings),
      vehicleId: r.vehicle_id,
      plate: r.plate,
      alias: r.alias,
      userId: r.user_id,
      userLabel: r.user_label,
      catalogId: r.catalog_id,
      catalogLabel: r.catalog_label,
      year: toNum(r.year),
      fuelType: r.fuel_type,
      transmission: r.transmission,
      // 0 no es "cero km": es "nadie lo cargó" (`/vehiculos/listado` lo trata igual).
      odometerKm: odometer && odometer > 0 ? odometer : null,
      distanceSinceDtcClearKm: toNum(r.distance_since_dtc_clear_km),
      dtcCodes: r.dtc_codes ?? [],
      lastMaintenanceName: r.last_maintenance_name,
      lastMaintenanceDaysBefore: toNum(r.last_maintenance_days_before),
      metrics: r.metrics ?? {},
    }
  })

  const catalogs = [...new Map(sessions.map((s) => [s.catalogId, s.catalogLabel])).entries()].map(
    ([id, label]) => ({ id, label }),
  )

  return { reference, catalogs, sessions }
}
