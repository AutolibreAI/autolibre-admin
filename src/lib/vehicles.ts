import { z } from 'zod'
import { multiSelectParam } from './catalog'
import { vehicleLocationSearchShape, type VehicleLocation } from './vehicle-location'
import type { NotificationState } from './notifications'
import type { SessionBucket } from './scanners'
import type { UserMaintenanceTask } from './users'

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

/**
 * Una entrada por columna ordenable de la tabla. Desde el 2026-09-28 son
 * TODAS las columnas: es el pedido que traía la rama `listado-vehiculos`
 * (2026-09-04), portado sobre este listado. Si se agrega una columna, ésta es
 * la primera lista que se toca — si no, queda una columna que no ordena y
 * nadie lo nota hasta que alguien la necesita.
 */
export const VEHICLE_SORT_KEYS = [
  'plate',
  'owner',
  'model',
  'year',
  'type',
  'odometer',
  'dtcClearKm',
  'vtv',
  'insurance',
  'registrationCard',
  'fineDebt',
  'fineCount',
  'taxDebt',
  'tasksPast',
  'tasksPending',
  'scans',
  'lastScanAt',
  'scanMinutes',
  'activeDtc',
  'inactiveDtc',
  'anomalies',
  'chats',
  'alerts',
  'lastActivity',
  'createdAt',
  'location',
] as const
export type VehicleSortKey = (typeof VEHICLE_SORT_KEYS)[number]

/** `ok` = ≥1 escaneo con datos. `failures` = lo intentó y ninguno sirvió. `never` = nunca. */
export const VEHICLE_SCAN_FILTERS = ['all', 'ok', 'failures', 'never'] as const
export type VehicleScanFilter = (typeof VEHICLE_SCAN_FILTERS)[number]

export const VEHICLE_SCAN_FILTER_LABELS: Record<VehicleScanFilter, string> = {
  all: 'Todos',
  ok: 'Con datos',
  failures: 'Sólo fallidos',
  never: 'Nunca',
}

/**
 * Seguro y VTV comparten forma: vigente / vencido / no cargado.
 *
 * **Se decide por `expiration_date`, NUNCA por `status`.** La rama original
 * filtraba por `document_status`, y eso es justo lo que `leads.md` (Seguros)
 * prohíbe: hay pólizas `active` a días de vencer y `pending_renewal` vigentes —
 * a `status` lo mueve un proceso del backend y no es un reloj confiable. Mismo
 * corte que `ExpiryCell`: "vencido" es `expiration_date < hoy`.
 */
export const VEHICLE_DOCUMENT_FILTERS = ['all', 'valid', 'expired', 'missing'] as const
export type VehicleDocumentFilter = (typeof VEHICLE_DOCUMENT_FILTERS)[number]

export const VEHICLE_DOCUMENT_FILTER_LABELS: Record<VehicleDocumentFilter, string> = {
  all: 'Todos',
  valid: 'Vigente',
  expired: 'Vencido',
  missing: 'No cargado',
}

export const VEHICLE_PRESENCE_FILTERS = ['all', 'loaded', 'missing'] as const
export type VehiclePresenceFilter = (typeof VEHICLE_PRESENCE_FILTERS)[number]

export const VEHICLE_PRESENCE_FILTER_LABELS: Record<VehiclePresenceFilter, string> = {
  all: 'Todos',
  loaded: 'Cargada',
  missing: 'No cargada',
}

/** `YYYY-MM-DD`, el formato de `<input type="date">`. Basura → sin filtro, no error. */
const dateParam = () =>
  z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined)
/** Entero opcional. `''` y basura → sin tope, nunca `0` (ver `RangeFilter`). */
const intParam = () => z.coerce.number().int().min(0).optional().catch(undefined)

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
  /** Sólo autos con deuda de multas pendiente. */
  fineDebt: z.coerce.boolean().catch(false).default(false),

  /*
   * ── Los filtros que vinieron de la rama `listado-vehiculos` ────────────────
   *
   * TODOS calificados con `vehicle*`. La rama los tenía pelados (`brand`,
   * `model`, `vtv`, `scans`…) y `model` ya lo usa `/chats` con otro tipo: el
   * merge de `FullSearchSchema` habría roto el typecheck de `/chats`, una
   * pantalla que no tiene nada que ver. → `.claude/rules/notifications.md`
   *
   * `vtvExpired` (un chip booleano) se reemplazó por `vehicleVtv`: eran dos
   * controles para la misma pregunta.
   */

  /** Marca y modelo, multiselect. Las opciones salen de la base (`listVehicleFacets`). */
  vehicleBrands: multiSelectParam(z.string().trim().min(1).max(80)),
  vehicleModels: multiSelectParam(z.string().trim().min(1).max(80)),
  vehicleYearMin: intParam(),
  vehicleYearMax: intParam(),

  vehicleCreatedFrom: dateParam(),
  vehicleCreatedTo: dateParam(),

  /** "Nunca pasó nada desde que se cargó" — `lastActivityAt IS NULL`. */
  vehicleNeverActive: z.coerce.boolean().catch(false).default(false),
  vehicleActivityFrom: dateParam(),
  vehicleActivityTo: dateParam(),

  vehicleScans: z.enum(VEHICLE_SCAN_FILTERS).catch('all').default('all'),
  vehicleLastScanFrom: dateParam(),
  vehicleLastScanTo: dateParam(),
  vehicleScanMinutesMin: intParam(),
  vehicleScanMinutesMax: intParam(),

  vehicleChatsMin: intParam(),
  vehicleChatsMax: intParam(),
  vehiclePastTasksMin: intParam(),
  vehiclePastTasksMax: intParam(),
  vehiclePendingTasksMin: intParam(),
  vehiclePendingTasksMax: intParam(),

  /** Con ≥1 aviso sin leer. */
  vehicleWithAlerts: z.coerce.boolean().catch(false).default(false),

  vehicleInsurance: z.enum(VEHICLE_DOCUMENT_FILTERS).catch('all').default('all'),
  vehicleVtv: z.enum(VEHICLE_DOCUMENT_FILTERS).catch('all').default('all'),
  vehicleRegistrationCard: z.enum(VEHICLE_PRESENCE_FILTERS).catch('all').default('all'),

  vehicleOdometerMin: intParam(),
  vehicleOdometerMax: intParam(),
  vehicleDtcClearKmMin: intParam(),
  vehicleDtcClearKmMax: intParam(),

  vehicleWithActiveDtc: z.coerce.boolean().catch(false).default(false),
  vehicleWithInactiveDtc: z.coerce.boolean().catch(false).default(false),

  /**
   * Radicación: región y provincia, multiselect (`vehicleRegions` /
   * `vehicleProvinces`). Definidos en `~/lib/vehicle-location`.
   */
  ...vehicleLocationSearchShape,
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

  /** Del último intento de escaneo, sirviera o no. `null` = nunca. */
  lastScanAt: string | null
  /** Minutos sumados de las sesiones con `ended_at` cargado. */
  scanMinutesTotal: number

  /**
   * `conversations` de diagnóstico (con `vehicle_id`) CON al menos un mensaje.
   * Una vacía no es uso — mismo corte que `/chats` y `/actividad` (`chats.md`).
   */
  diagnosticChatCount: number

  /**
   * Avisos sin leer (`notifications.status <> 'read'`). Lectura NUESTRA: el
   * dominio no tiene un estado "activa" para una notificación.
   */
  unreadAlertCount: number

  /** Cédula — `registration_cards`, la más reciente. `null` = no cargada. */
  registrationCardLoadedAt: string | null

  /** `vehicles.current_distance_since_dtc_clear_km`, crudo. `null` = sin dato. */
  distanceSinceDtcClearKm: number | null

  /**
   * DTCs "activos": los del snapshot del ÚLTIMO escaneo
   * (`vehicle_last_dtc_scans` → `session_dtc_snapshots.codes`). `null` = nunca
   * se escaneó; `[]` = se escaneó y no trajo códigos.
   *
   * Antes esta columna contaba `diagnostic_dtcs` de esa sesión, que son sólo
   * los códigos que alguien BUSCÓ — el mismo error que ya se corrigió en
   * `/usuarios` y en `/escaneres/detecciones`.
   */
  activeDtcCodes: Array<string> | null
  /**
   * DTCs "inactivos": aparecieron en ALGÚN snapshot de este auto y no están en
   * el último. Nunca `null`: sin escaneos es `[]`.
   */
  inactiveDtcCodes: Array<string>
  /** Anomalías del último análisis de telemetría. `null` = nunca. */
  activeAnomalyCount: number | null

  /**
   * Lo último que pasó con ESTE auto: el `greatest()` de su último escaneo,
   * su último chat con mensajes y su última tarea. `null` = se cargó y nunca
   * pasó nada más. No es `lastSignalSql` (esa es del USUARIO, no del auto).
   */
  lastActivityAt: string | null

  /** Radicación según el registro (`vehicle_plate_lookups`). → `~/lib/vehicle-location` */
  location: VehicleLocation
}

/** Las opciones de los multiselect de marca y modelo — salen de los autos cargados. */
export interface VehicleFacets {
  brands: Array<string>
  models: Array<string>
}

// ── Ficha (`/vehiculos/:vehicleId`) ────────────────────────────────────────

/**
 * Las relaciones alcanzables desde un vehículo. Mismo patrón que
 * `CENSUS_ENTRIES` de `~/lib/users`: única fuente de verdad para el SQL, los
 * títulos y los grupos.
 *
 * La rama original (2026-09-04) tenía 21. Relevado el 2026-09-28 contra
 * `pg_constraint` / `information_schema`: hoy son 27 — se sumaron `leads`,
 * `quote_requests`, `vehicle_data_queries`, `vehicle_audit_logs` y los
 * `knowledge_documents` (+ sus fragmentos). Dos siguen siendo de segundo
 * nivel (`driving_session_chunks`, `conversation_messages`).
 *
 * `table` es además la clave del guard de existencia: una relación cuya tabla
 * no existe en la base conectada (`quote_requests` en una base sin migrar)
 * sale como `null`, no rompe el censo entero.
 */
export type VehicleCensusGroup =
  | 'Manejo y telemetría'
  | 'Asistente e IA'
  | 'Trámites'
  | 'Mantenimiento'
  | 'Marketplace'
  | 'Notificaciones'

export const VEHICLE_CENSUS_GROUPS: ReadonlyArray<VehicleCensusGroup> = [
  'Manejo y telemetría',
  'Asistente e IA',
  'Trámites',
  'Mantenimiento',
  'Marketplace',
  'Notificaciones',
]

export interface VehicleCensusEntry {
  key: string
  label: string
  table: string
  group: VehicleCensusGroup
  /** Cómo se llega: directo por `vehicle_id`, o por las sesiones/conversaciones del auto. */
  via: 'vehicle_id' | 'sus sesiones' | 'sus conversaciones'
}

export const VEHICLE_CENSUS_ENTRIES = [
  { key: 'drivingSessions', label: 'Sesiones de escaneo', table: 'driving_sessions', group: 'Manejo y telemetría', via: 'vehicle_id' },
  { key: 'drivingSessionChunks', label: 'Chunks subidos', table: 'driving_session_chunks', group: 'Manejo y telemetría', via: 'sus sesiones' },
  { key: 'telemetryAnalysis', label: 'Análisis de telemetría', table: 'driving_telemetry_analysis', group: 'Manejo y telemetría', via: 'vehicle_id' },
  { key: 'sessionAnalysisSnapshots', label: 'Snapshots de análisis', table: 'session_analysis_snapshots', group: 'Manejo y telemetría', via: 'vehicle_id' },
  { key: 'sessionDtcSnapshots', label: 'Snapshots de DTC', table: 'session_dtc_snapshots', group: 'Manejo y telemetría', via: 'vehicle_id' },
  { key: 'lastDtcScans', label: 'Puntero al último escaneo DTC', table: 'vehicle_last_dtc_scans', group: 'Manejo y telemetría', via: 'vehicle_id' },
  { key: 'diagnosticDtcs', label: 'Códigos DTC buscados', table: 'diagnostic_dtcs', group: 'Manejo y telemetría', via: 'vehicle_id' },
  { key: 'aiDiagnostics', label: 'Diagnósticos de IA', table: 'ai_diagnostics', group: 'Manejo y telemetría', via: 'vehicle_id' },

  { key: 'conversations', label: 'Conversaciones', table: 'conversations', group: 'Asistente e IA', via: 'vehicle_id' },
  { key: 'conversationMessages', label: 'Mensajes', table: 'conversation_messages', group: 'Asistente e IA', via: 'sus conversaciones' },
  { key: 'assistantProposals', label: 'Propuestas del asistente', table: 'assistant_proposals', group: 'Asistente e IA', via: 'vehicle_id' },
  { key: 'recommendationImpressions', label: 'Impresiones de recomendación', table: 'recommendation_impressions', group: 'Asistente e IA', via: 'vehicle_id' },
  { key: 'knowledgeDocuments', label: 'Documentos de conocimiento', table: 'knowledge_documents', group: 'Asistente e IA', via: 'vehicle_id' },
  { key: 'knowledgeDocumentChunks', label: 'Fragmentos indexados', table: 'knowledge_document_chunks', group: 'Asistente e IA', via: 'vehicle_id' },

  { key: 'fines', label: 'Multas', table: 'fines', group: 'Trámites', via: 'vehicle_id' },
  { key: 'fineSyncs', label: 'Consulta de multas', table: 'vehicle_fine_syncs', group: 'Trámites', via: 'vehicle_id' },
  { key: 'taxDebts', label: 'Deudas de patente', table: 'vehicle_tax_debts', group: 'Trámites', via: 'vehicle_id' },
  { key: 'dataQueries', label: 'Consultas de datos', table: 'vehicle_data_queries', group: 'Trámites', via: 'vehicle_id' },
  { key: 'insurances', label: 'Seguros', table: 'insurances', group: 'Trámites', via: 'vehicle_id' },
  { key: 'registrationCards', label: 'Cédulas', table: 'registration_cards', group: 'Trámites', via: 'vehicle_id' },
  { key: 'inspections', label: 'VTV', table: 'vehicle_inspections', group: 'Trámites', via: 'vehicle_id' },

  { key: 'maintenancePlans', label: 'Planes de mantenimiento', table: 'maintenance_plans', group: 'Mantenimiento', via: 'vehicle_id' },
  { key: 'maintenanceOccurrences', label: 'Tareas', table: 'maintenance_occurrences', group: 'Mantenimiento', via: 'vehicle_id' },
  { key: 'auditLogs', label: 'Cambios registrados', table: 'vehicle_audit_logs', group: 'Mantenimiento', via: 'vehicle_id' },

  { key: 'leads', label: 'Leads a talleres', table: 'leads', group: 'Marketplace', via: 'vehicle_id' },
  { key: 'quoteRequests', label: 'Pedidos de presupuesto', table: 'quote_requests', group: 'Marketplace', via: 'vehicle_id' },

  { key: 'notifications', label: 'Notificaciones', table: 'notifications', group: 'Notificaciones', via: 'vehicle_id' },
] as const satisfies ReadonlyArray<VehicleCensusEntry>

export type VehicleCensusKey = (typeof VEHICLE_CENSUS_ENTRIES)[number]['key']
/** `null` = la tabla no existe en la base conectada. `0` = existe y no hay filas. */
export type VehicleCensus = Record<VehicleCensusKey, number | null>

export interface VehicleDtc {
  code: string
  /** Título de `src/server/dtc-codes.json` (`lookupDtc`). `null` = no cargado ahí. */
  title: string | null
  /** El último escaneo que lo trajo. */
  lastSeenAt: string
  /** En cuántos escaneos apareció. */
  sessions: number
}

export interface VehicleScan {
  id: string
  startedAt: string
  endedAt: string | null
  bucket: SessionBucket
  scannerType: string
  scannerFirmware: string | null
  totalReadings: number
  dtcCount: number | null
  distanceSinceDtcClearKm: number | null
}

export interface VehicleChat {
  id: string
  startedAt: string
  title: string | null
  model: string | null
  userMessageCount: number
  aiMessageCount: number
}

export interface VehicleAlert {
  id: string
  type: string
  title: string
  state: NotificationState
  scheduledAt: string
}

export interface VehicleFine {
  id: string
  reason: string
  amount: number
  status: string
  jurisdiction: string | null
  infractionDate: string
}

export interface VehicleTaxDebt {
  id: string
  jurisdiction: string
  period: string
  amount: number
  clearedAt: string | null
  dueDate: string | null
}

export interface VehicleDetail {
  id: string
  plate: string
  vin: string | null
  alias: string | null
  color: string
  archived: boolean
  createdAt: string
  updatedAt: string
  registeredAt: string | null
  odometerKm: number
  engineNumber: string | null
  distanceSinceDtcClearKm: number | null
  dtcClearReadingAt: string | null

  catalogId: string
  brand: string
  model: string
  trim: string
  year: number
  vehicleType: string
  engine: string | null
  fuelType: string | null
  transmission: string | null

  owner: { id: string; name: string | null; email: string; phone: string | null }

  /**
   * Los tres documentos, el más reciente no archivado. `null` = no cargado.
   *
   * `docId` es el id para linkear a `/documentos/:tipo/:id`, y es `null` cuando
   * el documento NO pasó por OCR (sin archivo, o una VTV `source = 'provider'`):
   * `/documentos` sólo muestra los de OCR (`documents.md`), así que el link
   * daría una ficha vacía.
   */
  insurance: { expiresAt: string | null; insurer: string | null; docId: string | null } | null
  vtv: { expiresAt: string | null; facility: string | null; docId: string | null; fromProvider: boolean } | null
  registrationCard: {
    loadedAt: string
    registrationNumber: string | null
    holderName: string | null
    docId: string | null
  } | null

  location: VehicleLocation

  census: VehicleCensus

  activeDtcs: Array<VehicleDtc>
  inactiveDtcs: Array<VehicleDtc>
  /** `null` = nunca se escaneó por DTC. */
  lastDtcScanAt: string | null

  scans: Array<VehicleScan>
  chats: Array<VehicleChat>
  tasks: Array<UserMaintenanceTask>
  alerts: Array<VehicleAlert>
  /** `null` = multas nunca consultadas (no hay fila en `vehicle_fine_syncs`). */
  fineConsultedAt: string | null
  fines: Array<VehicleFine>
  taxDebts: Array<VehicleTaxDebt>
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

/**
 * El desplegable de `/vehiculos/catalogo`: "este modelo, ¿quién lo tiene?" —
 * el espejo del toggle de `/usuarios` ("este usuario, ¿qué autos tiene?").
 *
 * Grano usuario × vehículo, como el listado de `/vehiculos/listado`: una
 * persona con dos autos del mismo modelo son DOS filas, no una. `count(*)`
 * de este array tiene que dar exactamente `vehicleCount` de la fila del
 * catálogo — mismo corte (archivados incluidos).
 */
export interface CatalogUserRow {
  vehicleId: string
  userId: string
  userEmail: string
  userName: string | null
  plate: string
  alias: string | null
  archived: boolean
  odometerKm: number
  scansOk: number
  scansTotal: number
  vtvExpiresAt: string | null
  insuranceExpiresAt: string | null
  /** `null` = multas nunca consultadas para este auto. Predicado `pending` compartido. */
  fineDebtAmount: number | null
  /** `lastSignalSql` de `~/lib/activity` — la MISMA señal que `/usuarios`. */
  lastActivityAt: string | null
  /** Radicación — la misma columna que `/vehiculos/listado`. */
  location: VehicleLocation
}
