import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import type {
  FleetMetricRow,
  FleetSearch,
  FleetSortKey,
  FleetSummary,
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

interface ListRow {
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
  user_id: string
  user_name: string | null
  user_email: string
  vtv_expires_at: Date | string | null
  insurance_expires_at: Date | string | null
  fine_consulted_at: Date | string | null
  fine_count: number | string
  fine_debt_amount: number | string | null
  tax_debt_amount: number | string | null
  tasks_past: number | string
  tasks_pending: number | string
  scans_ok: number | string
  scans_total: number | string
  diagnostic_chat_count: number | string
  active_dtc_count: number | string | null
  active_anomaly_count: number | string | null
}

/**
 * Mapa cerrado `VehicleSortKey → columna`. Los dos valores del `ORDER BY` salen
 * de un enum de zod y de este `Record` — nunca de texto suelto. Mismo patrón
 * que `listUsers` y `listFineDebtors`.
 */
const LIST_SORT_COLUMNS: Record<VehicleSortKey, string> = {
  plate: 'plate',
  owner: 'user_email',
  model: 'model_sort',
  odometer: 'odometer_km',
  vtv: 'vtv_expires_at',
  fineDebt: 'fine_debt_amount',
  fineCount: 'fine_count',
  tasksPending: 'tasks_pending',
  createdAt: 'created_at',
}

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

  if (search.q) {
    params.push(`%${search.q}%`)
    const p = `$${params.length}`
    outerWhere.push(
      `(plate ILIKE ${p} OR coalesce(alias, '') ILIKE ${p} OR user_email ILIKE ${p}
        OR coalesce(user_name, '') ILIKE ${p} OR model_sort ILIKE ${p})`,
    )
  }

  if (search.vtvExpired) {
    outerWhere.push('vtv_expires_at IS NOT NULL AND vtv_expires_at < current_date')
  }
  if (search.fineDebt) outerWhere.push('fine_debt_amount > 0')

  const sortColumn = LIST_SORT_COLUMNS[search.sort]

  const rows = await sql<ListRow>(
    `
    select * from (
      select
        v.id, v.plate, v.alias, v.color, v.archived,
        v.odometer_value as odometer_km, v.created_at,
        vc.brand, vc.model, vc.trim, vc.year,
        lower(vc.brand || ' ' || vc.model || ' ' || vc.trim) as model_sort,
        u.id as user_id, u.name as user_name, u.email as user_email,

        (select vi.expiration_date from vehicle_inspections vi
          where vi.vehicle_id = v.id
          order by vi.archived asc, vi.created_at desc limit 1) as vtv_expires_at,
        (select i.expiration_date from insurances i
          where i.vehicle_id = v.id
          order by i.archived asc, i.created_at desc limit 1) as insurance_expires_at,

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

        (select count(*) filter (
                  where d.status::text = 'completed' and coalesce(d.total_readings, 0) > 0)::int
           from driving_sessions d where d.vehicle_id = v.id) as scans_ok,
        (select count(*)::int from driving_sessions d where d.vehicle_id = v.id) as scans_total,

        (select count(*)::int from conversations c where c.vehicle_id = v.id) as diagnostic_chat_count,

        case when lds.vehicle_id is null then null
             else (select count(*)::int from diagnostic_dtcs dd where dd.session_id = lds.session_id)
        end as active_dtc_count,
        jsonb_array_length(dta.anomalies) as active_anomaly_count

      from vehicles v
      join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
      join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
      join users u on u.id = v.user_id
      left join vehicle_fine_syncs vfs on vfs.vehicle_id = v.id
      left join vehicle_last_dtc_scans lds on lds.vehicle_id = v.id
      left join driving_telemetry_analysis dta on dta.id = (
        select a.id from driving_telemetry_analysis a
         where a.vehicle_id = v.id order by a.created_at desc limit 1
      )
    ) s
    ${outerWhere.length ? `where ${outerWhere.join(' and ')}` : ''}
    order by ${sortColumn} ${search.dir} nulls last, plate
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
      userId: r.user_id,
      userName: r.user_name,
      userEmail: r.user_email,
      vtvExpiresAt: toIso(r.vtv_expires_at),
      insuranceExpiresAt: toIso(r.insurance_expires_at),
      fineConsultedAt: toIso(r.fine_consulted_at),
      fineCount: toInt(r.fine_count),
      fineDebtAmount: toIntOrNull(r.fine_debt_amount),
      taxDebtAmount: toIntOrNull(r.tax_debt_amount),
      tasksPast: toInt(r.tasks_past),
      tasksPending: toInt(r.tasks_pending),
      scansOk: toInt(r.scans_ok),
      scansTotal: toInt(r.scans_total),
      diagnosticChatCount: toInt(r.diagnostic_chat_count),
      activeDtcCount: toIntOrNull(r.active_dtc_count),
      activeAnomalyCount: toIntOrNull(r.active_anomaly_count),
    }),
  )
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
}

const FLEET_SORT_COLUMNS: Record<FleetSortKey, string> = {
  vehicles: 'vehicle_count',
  users: 'user_count',
  avgKm: 'avg_odometer',
  withFines: 'with_fines',
  fineDebt: 'fine_debt_total',
  scanned: 'scanned_ok',
  model: 'model_sort',
}

/**
 * La flota agrupada por MODELO del catálogo, no por spec.
 *
 * Es la misma decisión que `/escaneres` (`scanner-compatibility.md`): bajar al
 * spec parte el mismo auto en dos filas cuando dos specs difieren sólo en un
 * campo que el proveedor no devolvió. El grano es `vehicle_catalogs`.
 *
 * El `join lateral` cuenta todo lo del modelo en una pasada; `where
 * vs.vehicle_count > 0` deja fuera los catálogos que nadie cargó — no son
 * flota.
 */
export async function fleetMetrics(
  search: FleetSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<FleetMetricRow>> {
  void opts.signal

  const params: Array<unknown> = []
  const outerWhere: Array<string> = ['vehicle_count > 0']

  if (search.q) {
    params.push(`%${search.q}%`)
    outerWhere.push(`model_sort ILIKE $${params.length}`)
  }

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
        (select count(*)::int from vehicle_catalog_manuals m where m.catalog_id = c.id) as manual_count
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
    where ${outerWhere.join(' and ')}
    order by ${sortColumn} ${search.dir} nulls last, model_sort
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
    }),
  )
}

/**
 * Los tres números de arriba de la pestaña de métricas. Una sentencia, un
 * snapshot — mismo criterio que el censo de usuarios.
 */
export async function fleetSummary(
  opts: { signal?: AbortSignal } = {},
): Promise<FleetSummary> {
  void opts.signal

  const row = await sqlOne<{
    total_vehicles: number
    total_models: number
    users_with_vehicle: number
  }>(
    `select
       (select count(*)::int from vehicles) as total_vehicles,
       (select count(distinct s.vehicle_catalog_id)::int
          from vehicles v
          join vehicle_catalog_specs s on s.id = v.vehicle_catalog_spec_id) as total_models,
       (select count(distinct user_id)::int from vehicles) as users_with_vehicle`,
  )

  return {
    totalVehicles: toInt(row?.total_vehicles),
    totalModels: toInt(row?.total_models),
    usersWithVehicle: toInt(row?.users_with_vehicle),
  }
}
