import { z } from 'zod'

/**
 * Vehículos cargados en el sistema — el listado total y las métricas de flota.
 *
 * ── Vocabulario ─────────────────────────────────────────────────────────────
 *
 * `Vehicle` es el aggregate del bounded context `vehicle-management`. Esto NO
 * es el catálogo (`vehicle_catalogs`, los MODELOS): son los autos concretos que
 * los usuarios cargaron, uno por fila, SIN deduplicar — el mismo auto cargado
 * por dos usuarios son dos filas, y así se muestra a propósito.
 *
 * ── Qué consulta reemplaza ──────────────────────────────────────────────────
 *
 * La vista por auto de `/usuarios` ya arma casi todo esto (`UserVehicleSummary`
 * en `~/lib/users`), pero SÓLO dentro de la ficha de un usuario. Acá es el
 * padrón entero de autos, con dueño, ordenable y filtrable.
 */

// ── Listado ────────────────────────────────────────────────────────────────

export const VEHICLE_SORT_KEYS = [
  'plate',
  'owner',
  'model',
  'odometer',
  'vtv',
  'fineDebt',
  'fineCount',
  'tasksPending',
  'createdAt',
] as const
export type VehicleSortKey = (typeof VEHICLE_SORT_KEYS)[number]

export const VEHICLE_STATE_FILTERS = ['all', 'active', 'archived'] as const
export type VehicleStateFilter = (typeof VEHICLE_STATE_FILTERS)[number]

export const VEHICLE_STATE_FILTER_LABELS: Record<VehicleStateFilter, string> = {
  all: 'Todos',
  active: 'Activos',
  archived: 'Archivados',
}

export const vehicleSearchSchema = z.object({
  /** Busca en patente, alias, modelo y dueño (email/nombre). */
  q: z.string().trim().max(80).optional(),
  /** "Listado total" ⇒ el default los muestra todos, archivados incluidos. */
  state: z.enum(VEHICLE_STATE_FILTERS).catch('all').default('all'),
  /** Sólo autos con VTV vencida (documento cargado y `expiration_date` pasada). */
  vtvExpired: z.coerce.boolean().catch(false).default(false),
  /** Sólo autos con deuda de multas pendiente. */
  fineDebt: z.coerce.boolean().catch(false).default(false),
  sort: z.enum(VEHICLE_SORT_KEYS).catch('createdAt').default('createdAt'),
  dir: z.enum(['asc', 'desc']).catch('desc').default('desc'),
})
export type VehicleSearch = z.infer<typeof vehicleSearchSchema>

export interface VehicleListRow {
  id: string
  plate: string
  alias: string | null
  color: string
  archived: boolean
  odometerKm: number
  createdAt: string

  brand: string
  model: string
  trim: string
  year: number

  userId: string
  userName: string | null
  userEmail: string

  /** VTV — `vehicle_inspections`, el documento. `null` = no cargado. */
  vtvExpiresAt: string | null
  /** Seguro — `insurances`, el documento. `null` = no cargado. */
  insuranceExpiresAt: string | null

  /**
   * Multas con `status = 'pending'` — mismo predicado que `fines.repo.ts` y
   * `users.repo.ts`. `fineConsultedAt = null` ⇒ nunca se consultaron, y
   * entonces `fineDebtAmount` también es `null` (no `0`).
   */
  fineConsultedAt: string | null
  fineCount: number
  fineDebtAmount: number | null

  /**
   * Deuda de patente — `vehicle_tax_debts`, monto sin saldar. `null` = sin
   * datos. Al 2026-09-06 la tabla está VACÍA en producción: la columna está
   * lista para cuando el backend la llene.
   */
  taxDebtAmount: number | null

  /** `maintenance_occurrences` de este auto. */
  tasksPast: number
  tasksPending: number

  /** Mismo predicado "sirvió" que el resto del repo: completed + ≥1 lectura. */
  scansOk: number
  scansTotal: number

  /** `conversations` de diagnóstico (con `vehicle_id`). */
  diagnosticChatCount: number

  /** DTCs del último escaneo / anomalías del último análisis. `null` = nunca. */
  activeDtcCount: number | null
  activeAnomalyCount: number | null
}

// ── Métricas de flota ──────────────────────────────────────────────────────

export const FLEET_SORT_KEYS = [
  'vehicles',
  'users',
  'avgKm',
  'withFines',
  'fineDebt',
  'scanned',
  'model',
] as const
export type FleetSortKey = (typeof FLEET_SORT_KEYS)[number]

export const fleetSearchSchema = z.object({
  q: z.string().trim().max(80).optional(),
  sort: z.enum(FLEET_SORT_KEYS).catch('vehicles').default('vehicles'),
  dir: z.enum(['asc', 'desc']).catch('desc').default('desc'),
})
export type FleetSearch = z.infer<typeof fleetSearchSchema>

export interface FleetMetricRow {
  catalogId: string
  brand: string
  model: string
  trim: string
  year: number
  vehicleType: string

  /** El contador principal: cuántos `vehicles` apuntan a este modelo. */
  vehicleCount: number
  /** Cuántos de esos están archivados (subconjunto de `vehicleCount`). */
  archivedCount: number
  /** Usuarios distintos que tienen un auto de este modelo. */
  userCount: number

  /** Odómetro promedio de los autos activos, en km. `null` si no hay activos. */
  avgOdometerKm: number | null

  /** Autos con VTV cargada / con seguro cargado. */
  withVtv: number
  withInsurance: number

  /** Autos con ≥1 multa pendiente, y la deuda total de multas del modelo. */
  withFines: number
  fineDebtTotal: number

  /** Autos con ≥1 sesión de escáner que trajo datos. */
  scannedOk: number

  /** Manuales cargados para este catálogo. */
  manualCount: number
}

export interface FleetSummary {
  totalVehicles: number
  totalModels: number
  usersWithVehicle: number
}
