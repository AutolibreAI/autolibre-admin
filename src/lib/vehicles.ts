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

// ── Tipo de vehículo (enum `vehicle_type` del backend) ─────────────────────
//
// Vivía en `~/lib/manuals`. Se movió acá cuando el Listado y las Métricas lo
// necesitaron: `~/lib/manuals` ahora lo re-exporta, así que sus consumidores no
// cambian. Mismo criterio que el comentario de `scanners.ts` sobre no copiar un
// mapa de etiquetas.

export const VEHICLE_TYPES = ['car', 'motorcycle'] as const
export type VehicleType = (typeof VEHICLE_TYPES)[number]

export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  car: 'Auto',
  motorcycle: 'Moto',
}

/** Tolerante a un valor nuevo del enum del backend: lo muestra crudo. */
export function vehicleTypeLabel(value: string): string {
  return (VEHICLE_TYPE_LABELS as Record<string, string>)[value] ?? value
}

// ── Listado ────────────────────────────────────────────────────────────────

export const VEHICLE_SORT_KEYS = [
  'plate',
  'owner',
  'model',
  'type',
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
  /**
   * Auto / moto. Ausente = ambos.
   *
   * Se llama `vehicleType` y NO `type` a propósito: `/chats` ya usa `type` como
   * search param con otro enum, y TanStack unifica los nombres de search params
   * entre rutas para el spread `{...prev}` de los updaters — dos `type` con
   * enums distintos rompen el typecheck de una pantalla que no tiene nada que
   * ver.
   */
  vehicleType: z.enum(VEHICLE_TYPES).optional(),
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

  /** `car` | `motorcycle` (crudo del enum del backend). */
  vehicleType: string

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
  'manuals',
  'model',
  'type',
] as const
export type FleetSortKey = (typeof FLEET_SORT_KEYS)[number]

/**
 * Search params de `/vehiculos/catalogo` — el catálogo entero y su flota,
 * unificados el 2026-09-17 (antes eran dos pantallas: el listado del catálogo
 * y `/vehiculos/metricas`, "Flota"). Ver `.claude/plans/vehiculos-catalogo-flota.md`.
 */
export const fleetSearchSchema = z.object({
  /** Busca en marca, modelo y versión. */
  q: z.string().trim().max(80).optional(),
  /** Auto / moto. Ausente = ambos. `vehicleType` y no `type` — ver `vehicleSearchSchema`. */
  vehicleType: z.enum(VEHICLE_TYPES).optional(),
  /** Modelos con ≥1 auto cargado. Era el `where` implícito de la vieja Flota. */
  onlyWithVehicles: z.coerce.boolean().catch(false).default(false),
  /**
   * Modelos SIN ningún auto — hoy el mismo conjunto que `onlyWithoutSpecs`
   * (ver el comentario de `fleetMetrics` en `vehicles.repo.ts`), pero es una
   * pregunta distinta y se mantiene aparte a propósito.
   */
  onlyWithoutVehicles: z.coerce.boolean().catch(false).default(false),
  /** Modelos sin ninguna variante de powertrain — no se les puede colgar un auto. */
  onlyWithoutSpecs: z.coerce.boolean().catch(false).default(false),
  /** El filtro que motivó la pantalla original: modelos sin manual. */
  onlyWithoutManual: z.coerce.boolean().catch(false).default(false),
  /**
   * `.catch('model')`: un `?sort=banana` de un favorito viejo cae al default.
   * Es el de la pantalla de entrada (antes Catálogo), no el `vehicles desc`
   * de la vieja Flota — con 166 de 210 modelos empatados en 1 auto, ordenar
   * por flota da un orden arbitrario a partir de la fila 15.
   */
  sort: z.enum(FLEET_SORT_KEYS).catch('model').default('model'),
  dir: z.enum(['asc', 'desc']).catch('asc').default('asc'),
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

  /** Variantes de powertrain (`vehicle_catalog_specs`). Cero ⇒ no se le puede colgar un auto. */
  specCount: number
}

export interface FleetSummary {
  /** Vehículos cargados, archivados incluidos. */
  totalVehicles: number
  /** Subconjunto de `totalVehicles` que está archivado. */
  archivedVehicles: number
  /** Todos los modelos del catálogo, tengan o no un auto cargado. */
  totalModels: number
  /** Subconjunto de `totalModels` con ≥1 auto — antes era el total de la vieja Flota. */
  modelsWithVehicles: number
  usersWithVehicle: number
}
