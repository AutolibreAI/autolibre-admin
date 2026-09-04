import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import type {
  VehicleAlert,
  VehicleCensus,
  VehicleChat,
  VehicleDetail,
  VehicleDtc,
  VehicleFine,
  VehicleListItem,
  VehicleScan,
  VehicleSearch,
  VehicleSortKey,
  VehicleTask,
  VehicleTaskState,
  VehicleTaxDebt,
} from '~/lib/vehicles'

/**
 * Vehículos — mismo dueño de SQL que `users.repo.ts` y `chats.repo.ts`: leemos
 * tablas de `public`, que son dominio del backend (`vehicle-management/`,
 * `diagnostics/`, `assistant/`, …). Esto es enteramente de LECTURA.
 *
 * `vehicles.vehicle_catalog_spec_id → vehicle_catalog_specs.id →
 * vehicle_catalog_id` sigue el mismo `join`/`join` (no `left`) que
 * `findUserDetail` en `users.repo.ts`: los dos arrancan DESDE `vehicles`, y
 * ahí la FK NOT NULL de cada hop hace que un `left join` esconda una
 * corrupción de datos en vez de dejarla notarse.
 */

const toInt = (value: unknown): number => Number(value ?? 0)

const toIntOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)

const toIso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value)

const toIsoRequired = (value: unknown): string => toIso(value) ?? ''

// ── Listado ──────────────────────────────────────────────────────────────────

interface VehicleListRow {
  id: string
  plate: string
  alias: string | null
  archived: boolean
  created_at: Date | string
  brand: string
  model: string
  year: number | string
  trim: string
  owner_id: string
  owner_name: string | null
  owner_email: string
  last_activity_at: Date | string | null
  scans_ok: number | string
  scans_total: number | string
  last_scan_at: Date | string | null
  scan_minutes_total: number | string | null
  diagnostic_chat_count: number | string
  past_tasks_count: number | string
  pending_tasks_count: number | string
  active_alerts_count: number | string
  insurance_status: string | null
  insurance_expires_at: Date | string | null
  vtv_status: string | null
  vtv_expires_at: Date | string | null
  registration_card_loaded_at: Date | string | null
  fines_count: number | string
  fines_pending_count: number | string
  odometer_value: number | string
  distance_since_dtc_clear_km: number | string | null
  last_dtc_scan_session_id: string | null
  last_dtc_scan_at: Date | string | null
  active_dtc_codes: Array<string> | null
  inactive_dtc_codes: Array<string> | null
}

/**
 * Mapa cerrado `VehicleSortKey → expresión SQL`, mismo patrón que
 * `users.repo.ts` — una entrada por cada una de las 22 columnas visibles, sin
 * excepción. Los dos DTC ordenan por CANTIDAD (`array_length`), no por el
 * array en sí — Postgres no puede ordenar `text[]` de forma útil, y
 * "cuántos" es lo que la columna muestra.
 */
const SORT_COLUMNS: Record<VehicleSortKey, string> = {
  plate: 'plate',
  brand: 'brand',
  model: 'model',
  year: 'year',
  trim: 'trim',
  owner: 'owner_email',
  createdAt: 'created_at',
  lastActivity: 'last_activity_at',
  scans: 'scans_total',
  lastScanAt: 'last_scan_at',
  scanMinutes: 'scan_minutes_total',
  chats: 'diagnostic_chat_count',
  pastTasks: 'past_tasks_count',
  pendingTasks: 'pending_tasks_count',
  alerts: 'active_alerts_count',
  insurance: 'insurance_expires_at',
  vtv: 'vtv_expires_at',
  registrationCard: 'registration_card_loaded_at',
  fines: 'fines_pending_count',
  odometer: 'odometer_value',
  dtcClearKm: 'distance_since_dtc_clear_km',
  activeDtc: 'array_length(active_dtc_codes, 1)',
  inactiveDtc: 'array_length(inactive_dtc_codes, 1)',
}

/** `>=`/`<` de un `date` contra una columna `timestamptz` — el `< … + 1 día` incluye el día entero de `to`. */
function pushDateRange(
  where: Array<string>,
  params: Array<unknown>,
  column: string,
  from: string | undefined,
  to: string | undefined,
) {
  if (from) {
    params.push(from)
    where.push(`${column} >= $${params.length}::date`)
  }
  if (to) {
    params.push(to)
    where.push(`${column} < $${params.length}::date + interval '1 day'`)
  }
}

function pushIntRange(
  where: Array<string>,
  params: Array<unknown>,
  column: string,
  min: number | undefined,
  max: number | undefined,
) {
  if (min !== undefined) {
    params.push(min)
    where.push(`${column} >= $${params.length}`)
  }
  if (max !== undefined) {
    params.push(max)
    where.push(`${column} <= $${params.length}`)
  }
}

/**
 * El listado. Envuelto en `select * from (...) s`, mismo motivo que
 * `listUsers`: casi todas las columnas son subconsultas escalares del
 * SELECT, y Postgres no deja referenciar un alias del SELECT en su propio
 * `where`/`order by`.
 *
 * `active_dtc_codes` / `inactive_dtc_codes`:
 *
 *  - "activos" son los códigos del snapshot del ÚLTIMO escaneo
 *    (`vehicle_last_dtc_scans` → `session_dtc_snapshots`). `null` cuando el
 *    vehículo nunca tuvo un escaneo de DTC — no hay snapshot del que leer.
 *  - "inactivos" son códigos que aparecieron ALGUNA VEZ en `diagnostic_dtcs`
 *    y no están en ese snapshot más reciente. El `coalesce(snap.codes,
 *    array[]::text[])` hace que esto funcione IGUAL sin escaneo: si nunca
 *    hubo uno, todo el historial cuenta como "inactivo" — no hay snapshot
 *    contra el cual llamarlo "activo".
 *
 * Verificado contra producción (2026-09-04): el vehículo
 * `24345106-3dc5-4718-9392-1aa846393e1a` tiene `P0171` en `diagnostic_dtcs` y
 * el snapshot de su último escaneo viene vacío — es el caso real que separa
 * las dos columnas.
 */
export async function listVehicles(
  search: VehicleSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<VehicleListItem>> {
  void opts.signal

  const params: Array<unknown> = []
  const where: Array<string> = []

  // ── Filtros que resuelven contra columnas REALES (nivel interno) ────────────
  // `brand`/`model`/`year`/`created_at`/`odometer_value`/el km de borrado son
  // columnas de `vehicles`/`vehicle_catalogs`, no subconsultas — van acá
  // porque el motor puede empujarlos antes de calcular las ~20 subconsultas
  // escalares del resto del SELECT, y porque (a diferencia de las de abajo)
  // SÍ están disponibles en este nivel.

  if (search.q) {
    params.push(`%${search.q}%`)
    where.push(
      `(v.plate ilike $${params.length} or coalesce(v.alias, '') ilike $${params.length} ` +
        `or vc.brand ilike $${params.length} or vc.model ilike $${params.length} or vc.trim ilike $${params.length} ` +
        `or u.email ilike $${params.length} or coalesce(u.name, '') ilike $${params.length})`,
    )
  }

  if (search.archived !== 'all') {
    where.push(`v.archived = ${search.archived === 'archived' ? 'true' : 'false'}`)
  }

  if (search.brand) {
    params.push(search.brand)
    where.push(`vc.brand = $${params.length}`)
  }

  if (search.model) {
    params.push(search.model)
    where.push(`vc.model = $${params.length}`)
  }

  pushIntRange(where, params, 'vc.year', search.yearMin, search.yearMax)
  pushDateRange(where, params, 'v.created_at', search.createdFrom, search.createdTo)
  pushIntRange(where, params, 'v.odometer_value', search.odometerMin, search.odometerMax)
  pushIntRange(
    where,
    params,
    'v.current_distance_since_dtc_clear_km',
    search.dtcClearKmMin,
    search.dtcClearKmMax,
  )

  // ── Filtros que resuelven contra los ALIAS del SELECT (nivel externo) ───────
  // Postgres no deja referenciar un alias del SELECT en el `where` de la
  // MISMA consulta — por eso el envoltorio `select * from (...) s` y por eso
  // todo lo que depende de una subconsulta escalar (actividad, escaneos,
  // tareas, alertas, documentos, multas, DTC) va acá y no arriba.

  const outerWhere: Array<string> = []

  pushDateRange(outerWhere, params, 'last_activity_at', search.activityFrom, search.activityTo)
  if (search.onlyNeverActive) {
    outerWhere.push('last_activity_at is null')
  }

  if (search.scans === 'ok') {
    outerWhere.push('scans_ok > 0')
  } else if (search.scans === 'failures') {
    outerWhere.push('scans_total > 0 and scans_ok = 0')
  } else if (search.scans === 'never') {
    outerWhere.push('scans_total = 0')
  }
  pushDateRange(outerWhere, params, 'last_scan_at', search.lastScanFrom, search.lastScanTo)
  pushIntRange(outerWhere, params, 'scan_minutes_total', search.scanMinutesMin, search.scanMinutesMax)

  pushIntRange(outerWhere, params, 'diagnostic_chat_count', search.chatsMin, search.chatsMax)
  pushIntRange(outerWhere, params, 'past_tasks_count', search.pastTasksMin, search.pastTasksMax)
  pushIntRange(outerWhere, params, 'pending_tasks_count', search.pendingTasksMin, search.pendingTasksMax)

  if (search.onlyWithAlerts) {
    outerWhere.push('active_alerts_count > 0')
  }

  // `expired` agrupa `expired` y `pending_renewal` — ver el comentario en
  // `vehicleSearchSchema` sobre por qué la distinción no vale un tercer botón.
  if (search.insurance === 'valid') {
    outerWhere.push(`insurance_status = 'active'`)
  } else if (search.insurance === 'expired') {
    outerWhere.push(`insurance_status is not null and insurance_status <> 'active'`)
  } else if (search.insurance === 'missing') {
    outerWhere.push('insurance_status is null')
  }

  if (search.vtv === 'valid') {
    outerWhere.push(`vtv_status = 'active'`)
  } else if (search.vtv === 'expired') {
    outerWhere.push(`vtv_status is not null and vtv_status <> 'active'`)
  } else if (search.vtv === 'missing') {
    outerWhere.push('vtv_status is null')
  }

  if (search.registrationCard === 'loaded') {
    outerWhere.push('registration_card_loaded_at is not null')
  } else if (search.registrationCard === 'missing') {
    outerWhere.push('registration_card_loaded_at is null')
  }

  if (search.fines === 'pending') {
    outerWhere.push('fines_pending_count > 0')
  } else if (search.fines === 'none') {
    outerWhere.push('fines_count = 0')
  }

  // `array_length` de un array VACÍO es `NULL` en Postgres, no `0` — de ahí
  // el `coalesce(…, 0)`. Sin él, "con DTCs activos" incluiría en silencio a
  // los vehículos escaneados y limpios (array `{}`, no `NULL`).
  if (search.onlyWithActiveDtc) {
    outerWhere.push('coalesce(array_length(active_dtc_codes, 1), 0) > 0')
  }
  if (search.onlyWithInactiveDtc) {
    outerWhere.push('coalesce(array_length(inactive_dtc_codes, 1), 0) > 0')
  }

  const sortColumn = SORT_COLUMNS[search.sort]

  const rows = await sql<VehicleListRow>(
    `
    select * from (
      select
        v.id, v.plate, v.alias, v.archived, v.created_at,
        vc.brand, vc.model, vc.year, vc.trim,
        u.id as owner_id, u.name as owner_name, u.email as owner_email,

        greatest(
          (select max(d.started_at) from driving_sessions d where d.vehicle_id = v.id),
          (select max(c.created_at) from conversations c where c.vehicle_id = v.id),
          (select max(o.created_at) from maintenance_occurrences o where o.vehicle_id = v.id)
        ) as last_activity_at,

        (select count(*) filter (
                  where d.status::text = 'completed' and coalesce(d.total_readings, 0) > 0)::int
           from driving_sessions d where d.vehicle_id = v.id) as scans_ok,
        (select count(*)::int from driving_sessions d where d.vehicle_id = v.id) as scans_total,
        (select max(d.started_at) from driving_sessions d where d.vehicle_id = v.id) as last_scan_at,
        (select sum(extract(epoch from (d.ended_at - d.started_at))) / 60
           from driving_sessions d where d.vehicle_id = v.id and d.ended_at is not null) as scan_minutes_total,

        (select count(*)::int from conversations c where c.vehicle_id = v.id) as diagnostic_chat_count,

        (select count(*)::int from maintenance_occurrences o
           where o.vehicle_id = v.id and o.performed_at is not null) as past_tasks_count,
        (select count(*)::int from maintenance_occurrences o
           where o.vehicle_id = v.id and o.performed_at is null) as pending_tasks_count,

        (select count(*)::int from notifications n
           where n.vehicle_id = v.id and n.status::text <> 'read') as active_alerts_count,

        (select i.status::text from insurances i where i.vehicle_id = v.id
           order by i.archived asc, i.created_at desc limit 1) as insurance_status,
        (select i.expiration_date from insurances i where i.vehicle_id = v.id
           order by i.archived asc, i.created_at desc limit 1) as insurance_expires_at,

        (select vi.status::text from vehicle_inspections vi where vi.vehicle_id = v.id
           order by vi.archived asc, vi.created_at desc limit 1) as vtv_status,
        (select vi.expiration_date from vehicle_inspections vi where vi.vehicle_id = v.id
           order by vi.archived asc, vi.created_at desc limit 1) as vtv_expires_at,

        (select r.created_at from registration_cards r where r.vehicle_id = v.id
           order by r.created_at desc limit 1) as registration_card_loaded_at,

        (select count(*)::int from fines f where f.vehicle_id = v.id) as fines_count,
        (select count(*)::int from fines f where f.vehicle_id = v.id and f.status::text = 'pending') as fines_pending_count,

        v.odometer_value,
        v.current_distance_since_dtc_clear_km as distance_since_dtc_clear_km,

        lds.session_id as last_dtc_scan_session_id,
        lds.scanned_at as last_dtc_scan_at,
        snap.codes as active_dtc_codes,
        (select array(
            select distinct dd.code from diagnostic_dtcs dd
             where dd.vehicle_id = v.id
               and dd.code <> all(coalesce(snap.codes, array[]::text[]))
         )) as inactive_dtc_codes

      from vehicles v
      join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
      join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
      join users u on u.id = v.user_id
      left join vehicle_last_dtc_scans lds on lds.vehicle_id = v.id
      left join session_dtc_snapshots snap on snap.session_id = lds.session_id
      ${where.length ? `where ${where.join(' and ')}` : ''}
    ) s
    ${outerWhere.length ? `where ${outerWhere.join(' and ')}` : ''}
    order by ${sortColumn} ${search.dir} nulls last, id
    limit 500
    `,
    params,
  )

  return rows.map(
    (r): VehicleListItem => ({
      id: r.id,
      plate: r.plate,
      alias: r.alias,
      archived: r.archived,
      createdAt: toIsoRequired(r.created_at),
      brand: r.brand,
      model: r.model,
      year: toInt(r.year),
      trim: r.trim,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      ownerEmail: r.owner_email,
      lastActivityAt: toIso(r.last_activity_at),
      scansOk: toInt(r.scans_ok),
      scansTotal: toInt(r.scans_total),
      lastScanAt: toIso(r.last_scan_at),
      scanMinutesTotal: Math.round(toInt(r.scan_minutes_total)),
      diagnosticChatCount: toInt(r.diagnostic_chat_count),
      pastTasksCount: toInt(r.past_tasks_count),
      pendingTasksCount: toInt(r.pending_tasks_count),
      activeAlertsCount: toInt(r.active_alerts_count),
      insuranceStatus: r.insurance_status,
      insuranceExpiresAt: toIso(r.insurance_expires_at),
      vtvStatus: r.vtv_status,
      vtvExpiresAt: toIso(r.vtv_expires_at),
      registrationCardLoadedAt: toIso(r.registration_card_loaded_at),
      finesCount: toInt(r.fines_count),
      finesPendingCount: toInt(r.fines_pending_count),
      odometerValue: toInt(r.odometer_value),
      distanceSinceDtcClearKm: toIntOrNull(r.distance_since_dtc_clear_km),
      activeDtcCodes: r.last_dtc_scan_session_id === null ? null : (r.active_dtc_codes ?? []),
      inactiveDtcCodes: r.inactive_dtc_codes ?? [],
      lastDtcScanAt: toIso(r.last_dtc_scan_at),
    }),
  )
}

/**
 * Las marcas de los vehículos REGISTRADOS, no del catálogo entero —
 * `vehicle_catalogs` tiene 83 filas y algunas marcas nunca las eligió nadie.
 * Ofrecerlas en el filtro sería un dropdown con opciones que siempre dan
 * cero resultados. Mismo criterio que `listDistinctChatModels` en
 * `chats.repo.ts`: la lista sale de los datos, nunca se hardcodea.
 */
export async function listDistinctVehicleBrands(opts: { signal?: AbortSignal } = {}): Promise<Array<string>> {
  void opts.signal
  const rows = await sql<{ brand: string }>(
    `select distinct vc.brand
     from vehicles v
     join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
     join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
     order by vc.brand`,
  )
  return rows.map((r) => r.brand)
}

/** Ídem para modelo — sin acotar por marca: con 90 vehículos la lista entera todavía es chica. */
export async function listDistinctVehicleModels(opts: { signal?: AbortSignal } = {}): Promise<Array<string>> {
  void opts.signal
  const rows = await sql<{ model: string }>(
    `select distinct vc.model
     from vehicles v
     join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
     join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
     order by vc.model`,
  )
  return rows.map((r) => r.model)
}

// ── Detalle ──────────────────────────────────────────────────────────────────

interface VehicleRow {
  id: string
  plate: string
  vin: string | null
  alias: string | null
  color: string
  archived: boolean
  created_at: Date | string
  updated_at: Date | string
  registered_at: Date | string | null
  odometer_value: number | string
  engine_number: string | null
  distance_since_dtc_clear_baseline_km: number | string | null
  current_distance_since_dtc_clear_km: number | string | null
  dtc_clear_reading_at: Date | string | null
  catalog_id: string
  brand: string
  model: string
  year: number | string
  trim: string
  vehicle_type: string
  engine: string | null
  fuel_type: string | null
  transmission: string | null
  owner_id: string
  owner_name: string | null
  owner_email: string
  owner_phone: string | null
  insurance_status: string | null
  insurance_expires_at: Date | string | null
  insurance_insurer: string | null
  vtv_status: string | null
  vtv_expires_at: Date | string | null
  vtv_facility: string | null
  registration_card_loaded_at: Date | string | null
  registration_number: string | null
  registration_holder_name: string | null
  last_dtc_scan_session_id: string | null
  last_dtc_scan_at: Date | string | null
  active_dtc_codes: Array<string> | null
}

/**
 * La fila del vehículo, con catálogo, dueño y los tres documentos (seguro,
 * VTV, cédula) ya resueltos como subconsultas escalares — mismo patrón que
 * `VehicleRow` en `findUserDetail`. Esto es lo que evita una novena/décima
 * consulta separada en el `Promise.all` de abajo: los tres documentos son
 * 1:1 efectivos (se toma el más reciente no archivado), así que entran acá
 * en vez de como listas aparte.
 */
async function findVehicleRow(vehicleId: string): Promise<VehicleRow | null> {
  return sqlOne<VehicleRow>(
    `select
       v.id, v.plate, v.vin, v.alias, v.color, v.archived, v.created_at, v.updated_at,
       v.registered_at, v.odometer_value, v.engine_number,
       v.distance_since_dtc_clear_baseline_km, v.current_distance_since_dtc_clear_km,
       v.dtc_clear_reading_at,
       vc.id as catalog_id, vc.brand, vc.model, vc.year, vc.trim, vc.vehicle_type::text as vehicle_type,
       vcs.engine, vcs.fuel_type::text as fuel_type, vcs.transmission::text as transmission,
       u.id as owner_id, u.name as owner_name, u.email as owner_email, u.phone as owner_phone,

       (select i.status::text from insurances i where i.vehicle_id = v.id
          order by i.archived asc, i.created_at desc limit 1) as insurance_status,
       (select i.expiration_date from insurances i where i.vehicle_id = v.id
          order by i.archived asc, i.created_at desc limit 1) as insurance_expires_at,
       (select i.insurer from insurances i where i.vehicle_id = v.id
          order by i.archived asc, i.created_at desc limit 1) as insurance_insurer,

       (select vi.status::text from vehicle_inspections vi where vi.vehicle_id = v.id
          order by vi.archived asc, vi.created_at desc limit 1) as vtv_status,
       (select vi.expiration_date from vehicle_inspections vi where vi.vehicle_id = v.id
          order by vi.archived asc, vi.created_at desc limit 1) as vtv_expires_at,
       (select vi.facility from vehicle_inspections vi where vi.vehicle_id = v.id
          order by vi.archived asc, vi.created_at desc limit 1) as vtv_facility,

       (select r.created_at from registration_cards r where r.vehicle_id = v.id
          order by r.created_at desc limit 1) as registration_card_loaded_at,
       (select r.registration_number from registration_cards r where r.vehicle_id = v.id
          order by r.created_at desc limit 1) as registration_number,
       (select r.holder_name from registration_cards r where r.vehicle_id = v.id
          order by r.created_at desc limit 1) as registration_holder_name,

       lds.session_id as last_dtc_scan_session_id,
       lds.scanned_at as last_dtc_scan_at,
       snap.codes as active_dtc_codes

     from vehicles v
     join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
     join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
     join users u on u.id = v.user_id
     left join vehicle_last_dtc_scans lds on lds.vehicle_id = v.id
     left join session_dtc_snapshots snap on snap.session_id = lds.session_id
     where v.id = $1`,
    [vehicleId],
  )
}

type CensusRow = Record<string, number | string>

/**
 * Las 21 relaciones alcanzables desde un vehículo, en una sola sentencia —
 * mismo argumento que `CENSUS_SQL` en `users.repo.ts`: comparten el mismo
 * snapshot de Postgres. Los CTEs (`s`, `c`) son para las de segundo nivel:
 * `driving_session_chunks` y `conversation_messages` no tienen `vehicle_id`.
 */
const CENSUS_SQL = `
with s as (select id from driving_sessions where vehicle_id = $1),
     c as (select id from conversations where vehicle_id = $1)
select
  (select count(*) from driving_sessions where vehicle_id = $1)::int as driving_sessions,
  (select count(*) from driving_session_chunks where session_id in (select id from s))::int as driving_session_chunks,
  (select count(*) from driving_telemetry_analysis where vehicle_id = $1)::int as telemetry_analysis,
  (select count(*) from session_analysis_snapshots where vehicle_id = $1)::int as session_analysis_snapshots,
  (select count(*) from session_dtc_snapshots where vehicle_id = $1)::int as session_dtc_snapshots,
  (select count(*) from vehicle_last_dtc_scans where vehicle_id = $1)::int as last_dtc_scans,
  (select count(*) from diagnostic_dtcs where vehicle_id = $1)::int as diagnostic_dtcs,
  (select count(*) from ai_diagnostics where vehicle_id = $1)::int as ai_diagnostics,
  (select count(*) from conversations where vehicle_id = $1)::int as conversations,
  (select count(*) from conversation_messages where conversation_id in (select id from c))::int as conversation_messages,
  (select count(*) from assistant_proposals where vehicle_id = $1)::int as assistant_proposals,
  (select count(*) from recommendation_impressions where vehicle_id = $1)::int as recommendation_impressions,
  (select count(*) from fines where vehicle_id = $1)::int as fines,
  (select count(*) from vehicle_fine_syncs where vehicle_id = $1)::int as fine_syncs,
  (select count(*) from vehicle_tax_debts where vehicle_id = $1)::int as tax_debts,
  (select count(*) from insurances where vehicle_id = $1)::int as insurances,
  (select count(*) from registration_cards where vehicle_id = $1)::int as registration_cards,
  (select count(*) from vehicle_inspections where vehicle_id = $1)::int as inspections,
  (select count(*) from maintenance_plans where vehicle_id = $1)::int as maintenance_plans,
  (select count(*) from maintenance_occurrences where vehicle_id = $1)::int as maintenance_occurrences,
  (select count(*) from notifications where vehicle_id = $1)::int as notifications
`

interface DtcHistoryRow {
  code: string
  standard_description: string | null
  last_seen_at: Date | string
}

interface ScanRow {
  id: string
  started_at: Date | string
  ended_at: Date | string | null
  status: string
  scanner_type: string
  scanner_firmware: string | null
  total_readings: number | string
  distance_since_dtc_clear_km: number | string | null
}

interface ChatRow {
  id: string
  started_at: Date | string
  status: string
  title: string | null
  model: string | null
  user_message_count: number | string
  ai_message_count: number | string
}

interface TaskRow {
  id: string
  name: string
  item_type: string
  due_date: Date | string | null
  due_km: number | string | null
  performed_at: Date | string | null
  odometer_at_service: number | string | null
  workshop: string | null
  archived: boolean
  created_at: Date | string
}

interface AlertRow {
  id: string
  type: string
  title: string
  status: string
  channel: string
  scheduled_at: Date | string
  sent_at: Date | string | null
}

interface FineRow {
  id: string
  reason: string
  amount: string
  status: string
  jurisdiction: string | null
  infraction_date: Date | string
  due_date: Date | string | null
}

interface TaxDebtRow {
  id: string
  jurisdiction: string
  period: string
  amount: string
  cleared_at: Date | string | null
  due_date: Date | string | null
}

/**
 * El expediente completo de un vehículo. `null` si el uuid no existe.
 *
 * Ocho consultas en paralelo (la fila base + censo + seis listas), misma
 * escala que las ocho de `findUserDetail` — el pool tiene `max: 5`, así que
 * de nuevo: cuidado antes de agregar una novena.
 */
export async function findVehicleDetail(
  vehicleId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<VehicleDetail | null> {
  void opts.signal

  const vehicle = await findVehicleRow(vehicleId)
  if (!vehicle) return null

  const [census, dtcHistory, scans, chats, tasks, alerts, fines, taxDebts] = await Promise.all([
    sqlOne<CensusRow>(CENSUS_SQL, [vehicleId]),

    /**
     * Un renglón por código DISTINTO visto alguna vez, con su descripción y
     * la fecha en que se vio por última vez — `distinct on (code)` con
     * `order by code, created_at desc` se queda con la ocurrencia más
     * reciente de cada código.
     */
    sql<DtcHistoryRow>(
      `select distinct on (code) code, standard_description, created_at as last_seen_at
       from diagnostic_dtcs
       where vehicle_id = $1
       order by code, created_at desc`,
      [vehicleId],
    ),

    sql<ScanRow>(
      `select id, started_at, ended_at, status::text as status,
              scanner_type::text as scanner_type, scanner_firmware,
              total_readings, distance_since_dtc_clear_km
       from driving_sessions
       where vehicle_id = $1
       order by started_at desc`,
      [vehicleId],
    ),

    /** Mismo criterio de `title`/`model` que `listChats` en `chats.repo.ts`. */
    sql<ChatRow>(
      `select c.id, c.started_at, c.status::text as status,
              (select m.content from conversation_messages m
                 where m.conversation_id = c.id and m.author = 'user'
                 order by m.sent_at asc limit 1) as title,
              (select m.model from conversation_messages m
                 where m.conversation_id = c.id and m.author = 'ai'
                 order by m.sent_at desc limit 1) as model,
              (select count(*)::int from conversation_messages m
                 where m.conversation_id = c.id and m.author = 'user') as user_message_count,
              (select count(*)::int from conversation_messages m
                 where m.conversation_id = c.id and m.author = 'ai') as ai_message_count
       from conversations c
       where c.vehicle_id = $1
       order by c.started_at desc`,
      [vehicleId],
    ),

    sql<TaskRow>(
      `select id, name, item_type::text as item_type, due_date, due_km,
              performed_at, odometer_at_service, workshop, archived, created_at
       from maintenance_occurrences
       where vehicle_id = $1
       order by coalesce(performed_at, due_date, created_at) desc`,
      [vehicleId],
    ),

    sql<AlertRow>(
      `select id, type::text as type, title, status::text as status, channel::text as channel,
              scheduled_at, sent_at
       from notifications
       where vehicle_id = $1
       order by scheduled_at desc`,
      [vehicleId],
    ),

    sql<FineRow>(
      `select id, reason, amount::text as amount, status::text as status,
              jurisdiction::text as jurisdiction, infraction_date, due_date
       from fines
       where vehicle_id = $1
       order by infraction_date desc`,
      [vehicleId],
    ),

    sql<TaxDebtRow>(
      `select id, jurisdiction, period, amount::text as amount, cleared_at, due_date
       from vehicle_tax_debts
       where vehicle_id = $1
       order by coalesce(due_date, created_at) desc`,
      [vehicleId],
    ),
  ])

  // "Activos" = los del snapshot del último escaneo. Sin escaneo, el set está
  // vacío y TODO el historial cae del lado "inactivo" — ver el comentario de
  // `listVehicles` para el caso real que separa las dos columnas.
  const activeCodes = new Set(vehicle.last_dtc_scan_session_id === null ? [] : (vehicle.active_dtc_codes ?? []))

  const activeDtcs: Array<VehicleDtc> = []
  const inactiveDtcs: Array<VehicleDtc> = []
  for (const row of dtcHistory) {
    const dtc: VehicleDtc = {
      code: row.code,
      description: row.standard_description,
      lastSeenAt: toIsoRequired(row.last_seen_at),
    }
    ;(activeCodes.has(row.code) ? activeDtcs : inactiveDtcs).push(dtc)
  }

  return {
    id: vehicle.id,
    plate: vehicle.plate,
    vin: vehicle.vin,
    alias: vehicle.alias,
    color: vehicle.color,
    archived: vehicle.archived,
    createdAt: toIsoRequired(vehicle.created_at),
    updatedAt: toIsoRequired(vehicle.updated_at),
    registeredAt: toIso(vehicle.registered_at),
    odometerValue: toInt(vehicle.odometer_value),
    engineNumber: vehicle.engine_number,
    distanceSinceDtcClearBaselineKm: toIntOrNull(vehicle.distance_since_dtc_clear_baseline_km),
    distanceSinceDtcClearKm: toIntOrNull(vehicle.current_distance_since_dtc_clear_km),
    dtcClearReadingAt: toIso(vehicle.dtc_clear_reading_at),

    catalogId: vehicle.catalog_id,
    brand: vehicle.brand,
    model: vehicle.model,
    year: toInt(vehicle.year),
    trim: vehicle.trim,
    vehicleType: vehicle.vehicle_type,
    engine: vehicle.engine,
    fuelType: vehicle.fuel_type,
    transmission: vehicle.transmission,

    owner: {
      id: vehicle.owner_id,
      name: vehicle.owner_name,
      email: vehicle.owner_email,
      phone: vehicle.owner_phone,
    },

    insurance:
      vehicle.insurance_status && vehicle.insurance_expires_at
        ? {
            status: vehicle.insurance_status,
            expiresAt: toIsoRequired(vehicle.insurance_expires_at),
            insurer: vehicle.insurance_insurer ?? '',
          }
        : null,
    vtv:
      vehicle.vtv_status && vehicle.vtv_expires_at
        ? {
            status: vehicle.vtv_status,
            expiresAt: toIsoRequired(vehicle.vtv_expires_at),
            facility: vehicle.vtv_facility,
          }
        : null,
    registrationCard: vehicle.registration_card_loaded_at
      ? {
          loadedAt: toIsoRequired(vehicle.registration_card_loaded_at),
          registrationNumber: vehicle.registration_number,
          holderName: vehicle.registration_holder_name,
        }
      : null,

    census: mapCensus(census),

    activeDtcs,
    inactiveDtcs,
    lastDtcScanAt: toIso(vehicle.last_dtc_scan_at),

    scans: scans.map(
      (r): VehicleScan => ({
        id: r.id,
        startedAt: toIsoRequired(r.started_at),
        endedAt: toIso(r.ended_at),
        status: r.status,
        scannerType: r.scanner_type,
        scannerFirmware: r.scanner_firmware,
        totalReadings: toInt(r.total_readings),
        distanceSinceDtcClearKm: toIntOrNull(r.distance_since_dtc_clear_km),
      }),
    ),

    chats: chats.map(
      (r): VehicleChat => ({
        id: r.id,
        startedAt: toIsoRequired(r.started_at),
        status: r.status,
        title: r.title,
        model: r.model,
        userMessageCount: toInt(r.user_message_count),
        aiMessageCount: toInt(r.ai_message_count),
      }),
    ),

    tasks: tasks.map(
      (r): VehicleTask => ({
        id: r.id,
        name: r.name,
        itemType: r.item_type,
        dueDate: toIso(r.due_date),
        dueKm: toIntOrNull(r.due_km),
        performedAt: toIso(r.performed_at),
        odometerAtService: toIntOrNull(r.odometer_at_service),
        workshop: r.workshop,
        archived: r.archived,
        createdAt: toIsoRequired(r.created_at),
        state: deriveTaskState(r),
      }),
    ),

    alerts: alerts.map(
      (r): VehicleAlert => ({
        id: r.id,
        type: r.type,
        title: r.title,
        status: r.status,
        channel: r.channel,
        scheduledAt: toIsoRequired(r.scheduled_at),
        sentAt: toIso(r.sent_at),
      }),
    ),

    fines: fines.map(
      (r): VehicleFine => ({
        id: r.id,
        reason: r.reason,
        amount: Number(r.amount),
        status: r.status,
        jurisdiction: r.jurisdiction,
        infractionDate: toIsoRequired(r.infraction_date),
        dueDate: toIso(r.due_date),
      }),
    ),

    taxDebts: taxDebts.map(
      (r): VehicleTaxDebt => ({
        id: r.id,
        jurisdiction: r.jurisdiction,
        period: r.period,
        amount: Number(r.amount),
        clearedAt: toIso(r.cleared_at),
        dueDate: toIso(r.due_date),
      }),
    ),
  }
}

/** Mismo criterio que `deriveTaskState` en `users.repo.ts`: `done` es lo único que afirma el dominio. */
function deriveTaskState(row: TaskRow): VehicleTaskState {
  if (row.performed_at) return 'done'
  if (!row.due_date) return 'undated'
  const due = row.due_date instanceof Date ? row.due_date : new Date(row.due_date)
  return due.getTime() < Date.now() ? 'overdue' : 'pending'
}

/** `snake_case` → `camelCase` explícito, campo por campo — mismo motivo que `mapCensus` en `users.repo.ts`. */
function mapCensus(row: CensusRow | null): VehicleCensus {
  const n = (key: string) => toInt(row?.[key])
  return {
    drivingSessions: n('driving_sessions'),
    drivingSessionChunks: n('driving_session_chunks'),
    telemetryAnalysis: n('telemetry_analysis'),
    sessionAnalysisSnapshots: n('session_analysis_snapshots'),
    sessionDtcSnapshots: n('session_dtc_snapshots'),
    lastDtcScans: n('last_dtc_scans'),
    diagnosticDtcs: n('diagnostic_dtcs'),
    aiDiagnostics: n('ai_diagnostics'),
    conversations: n('conversations'),
    conversationMessages: n('conversation_messages'),
    assistantProposals: n('assistant_proposals'),
    recommendationImpressions: n('recommendation_impressions'),
    fines: n('fines'),
    fineSyncs: n('fine_syncs'),
    taxDebts: n('tax_debts'),
    insurances: n('insurances'),
    registrationCards: n('registration_cards'),
    inspections: n('inspections'),
    maintenancePlans: n('maintenance_plans'),
    maintenanceOccurrences: n('maintenance_occurrences'),
    notifications: n('notifications'),
  }
}
