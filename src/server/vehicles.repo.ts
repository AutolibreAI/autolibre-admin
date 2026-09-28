import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { lastSignalSql } from '~/lib/activity'
import { OK } from './scanners.repo'
import {
  REGION_RANK_SQL,
  loadLocationTable,
  locationJoin,
  mapLocation,
  type LocationQueryColumns,
} from './vehicle-location'
import type {
  CatalogUserRow,
  FleetMetricRow,
  FleetSearch,
  FleetSortKey,
  FleetSummary,
  VehicleFacets,
  VehicleListRow,
  VehicleSearch,
  VehicleSortKey,
} from '~/lib/vehicles'

/**
 * Vehículos — el padrón entero de autos y las métricas de flota. SOLO LECTURA.
 *
 * Mismo dueño de SQL que `users.repo.ts`, `catalog.repo.ts` y `fines.repo.ts`:
 * nosotros, sobre tablas de `public`, con las consultas en este archivo.
 *
 * ── Ni una escritura ───────────────────────────────────────────────────────
 *
 * Un `vehicle` lo crea el usuario en la app. Un `driving_session`, una `fine`,
 * una `insurance` son hechos que el backend escribe. Nada de esto lo mueve el
 * admin. Si aparece un `UPDATE`/`INSERT` acá, está mal.
 *
 * ── Predicados compartidos, a propósito ────────────────────────────────────
 *
 *  - "escaneo que sirvió" = `status = 'completed' AND total_readings > 0` — el
 *    MISMO que `scanners.repo.ts` y `users.repo.ts`. Documentado en
 *    `scanner-compatibility.md`.
 *  - "multa adeudada" = `status = 'pending'` — el MISMO que `fines.repo.ts` y
 *    `users.repo.ts`. Si divergen, el panel dice dos montos para el mismo auto.
 */

const toInt = (v: unknown): number => Number(v ?? 0)
const toIntOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v)
const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v)

// ── Listado total ──────────────────────────────────────────────────────────

interface ListRow extends LocationQueryColumns {
  id: string
  plate: string
  alias: string | null
  color: string
  archived: boolean
  odometer_km: number | string
  created_at: Date | string
  brand: string
  model: string
  trim: string
  year: number | string
  vehicle_type: string
  user_id: string
  user_name: string | null
  user_email: string
  vtv_expires_at: Date | string | null
  insurance_expires_at: Date | string | null
  registration_card_loaded_at: Date | string | null
  fine_consulted_at: Date | string | null
  fine_count: number | string
  fine_debt_amount: number | string | null
  tax_debt_amount: number | string | null
  tasks_past: number | string
  tasks_pending: number | string
  scans_ok: number | string
  scans_total: number | string
  last_scan_at: Date | string | null
  scan_minutes_total: number | string
  diagnostic_chat_count: number | string
  unread_alert_count: number | string
  distance_since_dtc_clear_km: number | string | null
  active_dtc_codes: Array<string> | null
  inactive_dtc_codes: Array<string> | null
  active_anomaly_count: number | string | null
  last_activity_at: Date | string | null
}

/**
 * Mapa cerrado `VehicleSortKey → columna`. Los dos valores del `ORDER BY` salen
 * de un enum de zod y de este `Record` — nunca de texto suelto. Mismo patrón
 * que `listUsers` y `listFineDebtors`.
 *
 * Los dos DTC ordenan por CANTIDAD, con `coalesce(…, 0)`: `array_length` de un
 * array VACÍO es `NULL` en Postgres, no `0`, y sin el `coalesce` un auto
 * escaneado y limpio se iría al fondo junto con los que nunca se escanearon.
 * Activos va con `-1` para "nunca" — así `null` ≠ `0` también al ordenar.
 */
const LIST_SORT_COLUMNS: Record<Exclude<VehicleSortKey, 'location'>, string> = {
  plate: 'plate',
  owner: 'user_email',
  model: 'model_sort',
  year: 'year',
  type: 'vehicle_type',
  odometer: 'odometer_km',
  dtcClearKm: 'distance_since_dtc_clear_km',
  vtv: 'vtv_expires_at',
  insurance: 'insurance_expires_at',
  registrationCard: 'registration_card_loaded_at',
  fineDebt: 'fine_debt_amount',
  fineCount: 'fine_count',
  taxDebt: 'tax_debt_amount',
  tasksPast: 'tasks_past',
  tasksPending: 'tasks_pending',
  scans: 'scans_total',
  lastScanAt: 'last_scan_at',
  scanMinutes: 'scan_minutes_total',
  activeDtc: `case when active_dtc_codes is null then -1
                   else coalesce(array_length(active_dtc_codes, 1), 0) end`,
  inactiveDtc: 'coalesce(array_length(inactive_dtc_codes, 1), 0)',
  anomalies: 'active_anomaly_count',
  chats: 'diagnostic_chat_count',
  alerts: 'unread_alert_count',
  lastActivity: 'last_activity_at',
  createdAt: 'created_at',
}

/** `>=` / `< +1 día` de un `date` contra una columna: el `to` incluye el día entero. */
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
    where.push(`${column} < $${params.length}::date + 1`)
  }
}

/** Los dos extremos son independientes: cargar uno solo filtra de un lado. */
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
 * Vigente / vencido / no cargado, por `expiration_date` contra hoy — NUNCA por
 * `status` (ver `VEHICLE_DOCUMENT_FILTERS`). Mismo corte que `ExpiryCell`.
 */
function pushDocumentFilter(
  where: Array<string>,
  column: string,
  value: VehicleSearch['vehicleVtv'],
) {
  if (value === 'valid') where.push(`${column} >= current_date`)
  else if (value === 'expired') where.push(`${column} < current_date`)
  else if (value === 'missing') where.push(`${column} is null`)
}

/**
 * "Chat con mensajes": el corte de `/chats` y `/actividad` (`chats.md`). Una
 * conversación abierta sin escribir nada no es uso.
 */
const CHAT_HAS_MESSAGES = `exists (select 1 from conversation_messages cm where cm.conversation_id = c.id)`

/**
 * Cada auto cargado, uno por fila, SIN deduplicar por patente.
 *
 * ── Va envuelto en `select * from (...) s` ─────────────────────────────────
 *
 * Casi todas las columnas son subconsultas escalares o dependen de un LEFT JOIN
 * del inner select (`vfs`, `lds`, `dta`). Filtrar y ordenar por ellas obliga a
 * envolver una vez y referenciar el alias afuera — Postgres no deja usar un
 * alias del SELECT en su propio nivel. Mismo motivo que `users.repo.ts`.
 *
 * ── `JOIN` y no `LEFT JOIN` en el catálogo y el dueño ──────────────────────
 *
 * `vehicle_catalog_spec_id` y `user_id` son NOT NULL con FK. Un `LEFT JOIN`
 * escondería corrupción detrás de celdas vacías. `vfs`/`lds`/`dta` sí son LEFT
 * (1:1 garantizado, sin fan-out) porque el `null` ES la respuesta — "nunca se
 * consultó / escaneó / analizó".
 */
export async function listVehicles(
  search: VehicleSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<VehicleListRow>> {
  void opts.signal

  const params: Array<unknown> = []
  const outerWhere: Array<string> = []

  if (search.state === 'active') outerWhere.push('NOT archived')
  else if (search.state === 'archived') outerWhere.push('archived')

  if (search.vehicleType) {
    params.push(search.vehicleType)
    outerWhere.push(`vehicle_type = $${params.length}`)
  }

  if (search.q) {
    params.push(`%${search.q}%`)
    const p = `$${params.length}`
    outerWhere.push(
      `(plate ILIKE ${p} OR coalesce(alias, '') ILIKE ${p} OR user_email ILIKE ${p}
        OR coalesce(user_name, '') ILIKE ${p} OR model_sort ILIKE ${p})`,
    )
  }

  if (search.fineDebt) outerWhere.push('fine_debt_amount > 0')

  if (search.vehicleBrands.length) {
    params.push(search.vehicleBrands)
    outerWhere.push(`brand = any($${params.length}::text[])`)
  }
  if (search.vehicleModels.length) {
    params.push(search.vehicleModels)
    outerWhere.push(`model = any($${params.length}::text[])`)
  }
  pushIntRange(outerWhere, params, 'year', search.vehicleYearMin, search.vehicleYearMax)
  pushDateRange(outerWhere, params, 'created_at', search.vehicleCreatedFrom, search.vehicleCreatedTo)

  if (search.vehicleNeverActive) outerWhere.push('last_activity_at is null')
  pushDateRange(outerWhere, params, 'last_activity_at', search.vehicleActivityFrom, search.vehicleActivityTo)

  if (search.vehicleScans === 'ok') outerWhere.push('scans_ok > 0')
  else if (search.vehicleScans === 'failures') outerWhere.push('scans_total > 0 and scans_ok = 0')
  else if (search.vehicleScans === 'never') outerWhere.push('scans_total = 0')
  pushDateRange(outerWhere, params, 'last_scan_at', search.vehicleLastScanFrom, search.vehicleLastScanTo)
  pushIntRange(outerWhere, params, 'scan_minutes_total', search.vehicleScanMinutesMin, search.vehicleScanMinutesMax)

  pushIntRange(outerWhere, params, 'diagnostic_chat_count', search.vehicleChatsMin, search.vehicleChatsMax)
  pushIntRange(outerWhere, params, 'tasks_past', search.vehiclePastTasksMin, search.vehiclePastTasksMax)
  pushIntRange(outerWhere, params, 'tasks_pending', search.vehiclePendingTasksMin, search.vehiclePendingTasksMax)

  if (search.vehicleWithAlerts) outerWhere.push('unread_alert_count > 0')

  pushDocumentFilter(outerWhere, 'insurance_expires_at', search.vehicleInsurance)
  pushDocumentFilter(outerWhere, 'vtv_expires_at', search.vehicleVtv)
  if (search.vehicleRegistrationCard === 'loaded') outerWhere.push('registration_card_loaded_at is not null')
  else if (search.vehicleRegistrationCard === 'missing') outerWhere.push('registration_card_loaded_at is null')

  pushIntRange(outerWhere, params, 'odometer_km', search.vehicleOdometerMin, search.vehicleOdometerMax)
  pushIntRange(
    outerWhere,
    params,
    'distance_since_dtc_clear_km',
    search.vehicleDtcClearKmMin,
    search.vehicleDtcClearKmMax,
  )

  // `coalesce(array_length(…), 0)`: el array vacío da NULL, no 0.
  if (search.vehicleWithActiveDtc) outerWhere.push('coalesce(array_length(active_dtc_codes, 1), 0) > 0')
  if (search.vehicleWithInactiveDtc) outerWhere.push('coalesce(array_length(inactive_dtc_codes, 1), 0) > 0')

  // Radicación: la tabla clasificada entra como `unnest` de arrays (ver
  // `locationJoin`), así que región y provincia se filtran como columnas.
  const location = locationJoin(params, await loadLocationTable())
  if (search.vehicleRegions.length) {
    params.push(search.vehicleRegions)
    outerWhere.push(`loc_region = any($${params.length}::text[])`)
  }
  if (search.vehicleProvinces.length) {
    params.push(search.vehicleProvinces)
    outerWhere.push(`loc_province = any($${params.length}::text[])`)
  }

  // Radicación ordena por región (en el orden de `VEHICLE_REGIONS`), después
  // provincia y partido — no por el texto crudo, que separaría `CAPITAL
  // FEDERAL` de `Ciudad Autónoma de Buenos Aires`.
  const orderBy =
    search.sort === 'location'
      ? `${REGION_RANK_SQL} ${search.dir}, loc_province_label ${search.dir} nulls last, loc_partido ${search.dir} nulls last`
      : `${LIST_SORT_COLUMNS[search.sort]} ${search.dir} nulls last`

  const rows = await sql<ListRow>(
    `
    select * from (
      select
        v.id, v.plate, v.alias, v.color, v.archived,
        v.odometer_value as odometer_km, v.created_at,
        vc.brand, vc.model, vc.trim, vc.year,
        vc.vehicle_type::text as vehicle_type,
        lower(vc.brand || ' ' || vc.model || ' ' || vc.trim) as model_sort,
        u.id as user_id, u.name as user_name, u.email as user_email,

        (select vi.expiration_date from vehicle_inspections vi
          where vi.vehicle_id = v.id
          order by vi.archived asc, vi.created_at desc limit 1) as vtv_expires_at,
        (select i.expiration_date from insurances i
          where i.vehicle_id = v.id
          order by i.archived asc, i.created_at desc limit 1) as insurance_expires_at,
        (select r.created_at from registration_cards r
          where r.vehicle_id = v.id
          order by r.archived asc, r.created_at desc limit 1) as registration_card_loaded_at,

        vfs.last_synced_at as fine_consulted_at,
        (select count(*)::int from fines f
          where f.vehicle_id = v.id and f.status = 'pending') as fine_count,
        case when vfs.vehicle_id is null then null
             else coalesce((select round(sum(f.amount)) from fines f
                              where f.vehicle_id = v.id and f.status = 'pending'), 0)::bigint
        end as fine_debt_amount,

        -- Deuda de patente: monto sin saldar. Tabla vacía en produccion al
        -- 2026-09-06 — la columna sale null hasta que el backend la escriba.
        (select round(sum(coalesce(td.updated_amount, td.amount)))::bigint
           from vehicle_tax_debts td
          where td.vehicle_id = v.id and td.cleared_at is null) as tax_debt_amount,

        (select count(*)::int from maintenance_occurrences o
          where o.vehicle_id = v.id and o.performed_at is not null) as tasks_past,
        (select count(*)::int from maintenance_occurrences o
          where o.vehicle_id = v.id and o.performed_at is null) as tasks_pending,

        (select count(*) filter (where ${OK})::int
           from driving_sessions ds where ds.vehicle_id = v.id) as scans_ok,
        (select count(*)::int from driving_sessions ds where ds.vehicle_id = v.id) as scans_total,
        (select max(ds.started_at) from driving_sessions ds where ds.vehicle_id = v.id) as last_scan_at,
        (select coalesce(round(sum(extract(epoch from (ds.ended_at - ds.started_at))) / 60), 0)::int
           from driving_sessions ds
          where ds.vehicle_id = v.id and ds.ended_at is not null) as scan_minutes_total,

        (select count(*)::int from conversations c
          where c.vehicle_id = v.id and ${CHAT_HAS_MESSAGES}) as diagnostic_chat_count,

        (select count(*)::int from notifications n
          where n.vehicle_id = v.id and n.status::text <> 'read') as unread_alert_count,

        v.current_distance_since_dtc_clear_km as distance_since_dtc_clear_km,

        -- DTCs: activos = el snapshot del ultimo escaneo; inactivos = los que
        -- aparecieron en algun snapshot de este auto y no estan en ese. Sale de
        -- session_dtc_snapshots.codes y NO de diagnostic_dtcs (esa tabla solo
        -- tiene los codigos que alguien busco).
        case when lds.vehicle_id is null then null
             else coalesce(snap.codes, array[]::text[]) end as active_dtc_codes,
        array(
          select distinct code
            from session_dtc_snapshots s2, unnest(s2.codes) as code
           where s2.vehicle_id = v.id
             and code <> all(coalesce(snap.codes, array[]::text[]))
           order by code
        ) as inactive_dtc_codes,
        jsonb_array_length(dta.anomalies) as active_anomaly_count,

        greatest(
          (select max(ds.started_at) from driving_sessions ds where ds.vehicle_id = v.id),
          (select max(c.created_at) from conversations c
            where c.vehicle_id = v.id and ${CHAT_HAS_MESSAGES}),
          (select max(o.created_at) from maintenance_occurrences o where o.vehicle_id = v.id)
        ) as last_activity_at,

        ${location.columns}

      from vehicles v
      join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
      join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
      join users u on u.id = v.user_id
      left join vehicle_fine_syncs vfs on vfs.vehicle_id = v.id
      left join vehicle_last_dtc_scans lds on lds.vehicle_id = v.id
      left join session_dtc_snapshots snap on snap.session_id = lds.session_id
      left join driving_telemetry_analysis dta on dta.id = (
        select a.id from driving_telemetry_analysis a
         where a.vehicle_id = v.id order by a.created_at desc limit 1
      )
      ${location.joins}
    ) s
    ${outerWhere.length ? `where ${outerWhere.join(' and ')}` : ''}
    order by ${orderBy}, plate
    limit 1000
    `,
    params,
  )

  return rows.map(
    (r): VehicleListRow => ({
      id: r.id,
      plate: r.plate,
      alias: r.alias,
      color: r.color,
      archived: r.archived,
      odometerKm: toInt(r.odometer_km),
      createdAt: toIso(r.created_at) as string,
      brand: r.brand,
      model: r.model,
      trim: r.trim,
      year: toInt(r.year),
      vehicleType: r.vehicle_type,
      userId: r.user_id,
      userName: r.user_name,
      userEmail: r.user_email,
      vtvExpiresAt: toIso(r.vtv_expires_at),
      insuranceExpiresAt: toIso(r.insurance_expires_at),
      registrationCardLoadedAt: toIso(r.registration_card_loaded_at),
      fineConsultedAt: toIso(r.fine_consulted_at),
      fineCount: toInt(r.fine_count),
      fineDebtAmount: toIntOrNull(r.fine_debt_amount),
      taxDebtAmount: toIntOrNull(r.tax_debt_amount),
      tasksPast: toInt(r.tasks_past),
      tasksPending: toInt(r.tasks_pending),
      scansOk: toInt(r.scans_ok),
      scansTotal: toInt(r.scans_total),
      lastScanAt: toIso(r.last_scan_at),
      scanMinutesTotal: toInt(r.scan_minutes_total),
      diagnosticChatCount: toInt(r.diagnostic_chat_count),
      unreadAlertCount: toInt(r.unread_alert_count),
      distanceSinceDtcClearKm: toIntOrNull(r.distance_since_dtc_clear_km),
      activeDtcCodes: r.active_dtc_codes,
      inactiveDtcCodes: r.inactive_dtc_codes ?? [],
      activeAnomalyCount: toIntOrNull(r.active_anomaly_count),
      lastActivityAt: toIso(r.last_activity_at),
      location: mapLocation(r),
    }),
  )
}

/**
 * Las opciones de los multiselect de marca y modelo: las de los autos
 * CARGADOS, no del catálogo entero — un modelo que nadie eligió sería una
 * opción que siempre da cero filas. Mismo criterio que `listDistinctChatModels`:
 * la lista sale de los datos, nunca se hardcodea. Una sentencia, un snapshot.
 */
export async function listVehicleFacets(
  opts: { signal?: AbortSignal } = {},
): Promise<VehicleFacets> {
  void opts.signal
  const row = await sqlOne<{ brands: Array<string> | null; models: Array<string> | null }>(
    `select
       array(select distinct vc.brand from vehicles v
               join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
               join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
              order by 1) as brands,
       array(select distinct vc.model from vehicles v
               join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
               join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
              order by 1) as models`,
  )
  return { brands: row?.brands ?? [], models: row?.models ?? [] }
}

// ── Métricas de flota ──────────────────────────────────────────────────────

interface FleetRow {
  catalog_id: string
  brand: string
  model: string
  trim: string
  year: number | string
  vehicle_type: string
  vehicle_count: number | string
  archived_count: number | string
  user_count: number | string
  avg_odometer: number | string | null
  with_vtv: number | string
  with_insurance: number | string
  with_fines: number | string
  fine_debt_total: number | string
  scanned_ok: number | string
  manual_count: number | string
  spec_count: number | string
}

const FLEET_SORT_COLUMNS: Record<FleetSortKey, string> = {
  vehicles: 'vehicle_count',
  users: 'user_count',
  avgKm: 'avg_odometer',
  withFines: 'with_fines',
  fineDebt: 'fine_debt_total',
  scanned: 'scanned_ok',
  manuals: 'manual_count',
  model: 'model_sort',
  type: 'vehicle_type',
}

/**
 * El catálogo entero, con su flota. Un modelo por fila — grano `vehicle_catalogs`,
 * no el spec.
 *
 * Es la misma decisión que `/escaneres` (`scanner-compatibility.md`): bajar al
 * spec parte el mismo auto en dos filas cuando dos specs difieren sólo en un
 * campo que el proveedor no devolvió.
 *
 * ── El universo es el SUPERCONJUNTO: todos los modelos, con o sin auto ──────
 *
 * Hasta el 2026-09-17 esta consulta filtraba `vehicle_count > 0` ("no son
 * flota") y sólo alimentaba `/vehiculos/metricas`, separada del listado del
 * catálogo. Se sacó al unificar las dos pantallas: al 2026-09-17 hay 30
 * modelos —de 210— sin UN SOLO vehículo, y esconderlos por default es el
 * error que hace que alguien busque un modelo, no lo vea y concluya que no
 * existe. Los 30 entran con sus contadores en cero: el `join lateral … on
 * true` es un agregado sin `GROUP BY`, así que sigue devolviendo exactamente
 * una fila aunque el modelo no tenga autos, sin reescribir nada del `lateral`.
 *
 * Y esos 30 no son un resto histórico: `vehicles` apunta al SPEC, no al
 * catálogo (`vehicle-manuals.md`, trampa 3), así que un catálogo sin ninguna
 * variante cargada no puede tener autos, ni hoy ni nunca, hasta que alguien le
 * cree el spec. Verificado el 2026-09-17: el conjunto "0 variantes" y el
 * conjunto "0 autos" son EXACTAMENTE el mismo — de ahí los filtros
 * `onlyWithoutVehicles` / `onlyWithoutSpecs` de abajo, que hoy seleccionan lo
 * mismo pero son preguntas distintas y se tratan como tales.
 */
export async function fleetMetrics(
  search: FleetSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<FleetMetricRow>> {
  void opts.signal

  const params: Array<unknown> = []
  const outerWhere: Array<string> = []

  if (search.vehicleType) {
    params.push(search.vehicleType)
    outerWhere.push(`vehicle_type = $${params.length}`)
  }

  if (search.q) {
    params.push(`%${search.q}%`)
    outerWhere.push(`model_sort ILIKE $${params.length}`)
  }

  if (search.onlyWithVehicles) outerWhere.push('vehicle_count > 0')
  if (search.onlyWithoutVehicles) outerWhere.push('vehicle_count = 0')
  if (search.onlyWithoutSpecs) outerWhere.push('spec_count = 0')
  // `manual_count = 0`, ya calculado en el SELECT — reemplaza el `NOT EXISTS`
  // que usaba `listCatalogs` (borrado al unificar esta pantalla con el
  // listado del catálogo).
  if (search.onlyWithoutManual) outerWhere.push('manual_count = 0')

  const sortColumn = FLEET_SORT_COLUMNS[search.sort]

  const rows = await sql<FleetRow>(
    `
    select * from (
      select
        c.id as catalog_id, c.brand, c.model, c.trim, c.year,
        c.vehicle_type::text as vehicle_type,
        lower(c.brand || ' ' || c.model || ' ' || c.trim) as model_sort,
        vs.vehicle_count, vs.archived_count, vs.user_count, vs.avg_odometer,
        vs.with_vtv, vs.with_insurance, vs.with_fines, vs.fine_debt_total, vs.scanned_ok,
        (select count(*)::int from vehicle_catalog_manuals m where m.catalog_id = c.id) as manual_count,
        (select count(*)::int from vehicle_catalog_specs s where s.vehicle_catalog_id = c.id) as spec_count
      from vehicle_catalogs c
      join lateral (
        select
          count(*)::int as vehicle_count,
          count(*) filter (where v.archived)::int as archived_count,
          count(distinct v.user_id)::int as user_count,
          avg(v.odometer_value) filter (where not v.archived) as avg_odometer,
          count(*) filter (where exists (
            select 1 from vehicle_inspections vi where vi.vehicle_id = v.id))::int as with_vtv,
          count(*) filter (where exists (
            select 1 from insurances i where i.vehicle_id = v.id))::int as with_insurance,
          count(*) filter (where exists (
            select 1 from fines f where f.vehicle_id = v.id and f.status = 'pending'))::int as with_fines,
          coalesce(sum((
            select coalesce(round(sum(f.amount)), 0) from fines f
             where f.vehicle_id = v.id and f.status = 'pending')), 0)::bigint as fine_debt_total,
          count(*) filter (where exists (
            select 1 from driving_sessions d
             where d.vehicle_id = v.id and d.status::text = 'completed'
               and coalesce(d.total_readings, 0) > 0))::int as scanned_ok
        from vehicles v
        join vehicle_catalog_specs s on s.id = v.vehicle_catalog_spec_id
        where s.vehicle_catalog_id = c.id
      ) vs on true
    ) t
    ${outerWhere.length ? `where ${outerWhere.join(' and ')}` : ''}
    order by ${sortColumn} ${search.dir} nulls last, model_sort
    limit 500
    `,
    params,
  )

  return rows.map(
    (r): FleetMetricRow => ({
      catalogId: r.catalog_id,
      brand: r.brand,
      model: r.model,
      trim: r.trim,
      year: toInt(r.year),
      vehicleType: r.vehicle_type,
      vehicleCount: toInt(r.vehicle_count),
      archivedCount: toInt(r.archived_count),
      userCount: toInt(r.user_count),
      avgOdometerKm: r.avg_odometer === null ? null : Math.round(Number(r.avg_odometer)),
      withVtv: toInt(r.with_vtv),
      withInsurance: toInt(r.with_insurance),
      withFines: toInt(r.with_fines),
      fineDebtTotal: toInt(r.fine_debt_total),
      scannedOk: toInt(r.scanned_ok),
      manualCount: toInt(r.manual_count),
      specCount: toInt(r.spec_count),
    }),
  )
}

/**
 * Los números de arriba de la pantalla. Una sentencia, un snapshot — mismo
 * criterio que el censo de usuarios.
 */
export async function fleetSummary(
  opts: { signal?: AbortSignal } = {},
): Promise<FleetSummary> {
  void opts.signal

  const row = await sqlOne<{
    total_vehicles: number
    archived_vehicles: number
    total_models: number
    models_with_vehicles: number
    users_with_vehicle: number
  }>(
    `select
       (select count(*)::int from vehicles) as total_vehicles,
       (select count(*)::int from vehicles where archived) as archived_vehicles,
       (select count(*)::int from vehicle_catalogs) as total_models,
       (select count(distinct s.vehicle_catalog_id)::int
          from vehicles v
          join vehicle_catalog_specs s on s.id = v.vehicle_catalog_spec_id) as models_with_vehicles,
       (select count(distinct user_id)::int from vehicles) as users_with_vehicle`,
  )

  return {
    totalVehicles: toInt(row?.total_vehicles),
    archivedVehicles: toInt(row?.archived_vehicles),
    totalModels: toInt(row?.total_models),
    modelsWithVehicles: toInt(row?.models_with_vehicles),
    usersWithVehicle: toInt(row?.users_with_vehicle),
  }
}

// ── El desplegable "quién tiene este modelo" ────────────────────────────────

interface CatalogUserQueryRow extends LocationQueryColumns {
  vehicle_id: string
  user_id: string
  user_email: string
  user_name: string | null
  plate: string
  alias: string | null
  archived: boolean
  odometer_km: number | string
  scans_ok: number | string
  scans_total: number | string
  vtv_expires_at: Date | string | null
  insurance_expires_at: Date | string | null
  fine_debt_amount: number | string | null
  last_activity_at: Date | string | null
}

/**
 * Las personas que tienen ESTE modelo — el espejo de `getUserVehicleSummaries`
 * (`/usuarios`). Se llama al click, nunca desde el loader del catálogo: 210
 * modelos × esta consulta sería pagar por lo que nadie abre.
 *
 * `join` (no `left`) al catálogo y al dueño, mismo motivo que `listVehicles`:
 * `vehicle_catalog_spec_id` y `user_id` son NOT NULL con FK, y un `left join`
 * escondería corrupción detrás de celdas vacías. El doble salto
 * `vehicles → vehicle_catalog_specs → vehicle_catalogs` es la misma trampa
 * que documenta `vehicle-manuals.md` (trampa 3): `vehicles` apunta al SPEC,
 * no al catálogo.
 *
 * `OK` se IMPORTA de `scanners.repo.ts`, no se recopia — si diverge del
 * corte que usa la matriz de `/escaneres`, esta columna y esa matriz dicen
 * dos cosas distintas de la misma sesión.
 */
export async function listCatalogUsers(
  catalogId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<CatalogUserRow>> {
  void opts.signal

  const params: Array<unknown> = [catalogId]
  const location = locationJoin(params, await loadLocationTable())

  const rows = await sql<CatalogUserQueryRow>(
    `select
       v.id as vehicle_id,
       u.id as user_id, u.email as user_email, u.name as user_name,
       v.plate, v.alias, v.archived, v.odometer_value as odometer_km,
       (select count(*) filter (where ${OK})::int
          from driving_sessions ds where ds.vehicle_id = v.id) as scans_ok,
       (select count(*)::int from driving_sessions ds where ds.vehicle_id = v.id) as scans_total,
       (select vi.expiration_date from vehicle_inspections vi
          where vi.vehicle_id = v.id
          order by vi.archived asc, vi.created_at desc limit 1) as vtv_expires_at,
       (select i.expiration_date from insurances i
          where i.vehicle_id = v.id
          order by i.archived asc, i.created_at desc limit 1) as insurance_expires_at,
       case when not exists (select 1 from vehicle_fine_syncs vfs where vfs.vehicle_id = v.id)
            then null
            else coalesce((select round(sum(f.amount)) from fines f
                             where f.vehicle_id = v.id and f.status = 'pending'), 0)::bigint
       end as fine_debt_amount,
       ${lastSignalSql('u.id')} as last_activity_at,
       ${location.columns}
     from vehicles v
     join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
     join users u on u.id = v.user_id
     ${location.joins}
     where vcs.vehicle_catalog_id = $1
     order by u.email, v.plate`,
    params,
  )

  return rows.map(
    (r): CatalogUserRow => ({
      vehicleId: r.vehicle_id,
      userId: r.user_id,
      userEmail: r.user_email,
      userName: r.user_name,
      plate: r.plate,
      alias: r.alias,
      archived: r.archived,
      odometerKm: toInt(r.odometer_km),
      scansOk: toInt(r.scans_ok),
      scansTotal: toInt(r.scans_total),
      vtvExpiresAt: toIso(r.vtv_expires_at),
      insuranceExpiresAt: toIso(r.insurance_expires_at),
      fineDebtAmount: toIntOrNull(r.fine_debt_amount),
      lastActivityAt: toIso(r.last_activity_at),
      location: mapLocation(r),
    }),
  )
}
