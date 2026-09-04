import { z } from 'zod'
import { DOCUMENT_STATUS_LABELS, NOTIFICATION_TYPE_LABELS } from './users'

/**
 * Vehículos — `/vehiculos`, `/vehiculos/:id`.
 *
 * ── Por qué esta pantalla existe ─────────────────────────────────────────────
 *
 * `/usuarios` ya tiene un vehículo adentro (`UserVehicle`, el toggle
 * `UserVehicleSummary`), pero las dos vistas están recortadas a lo que hace
 * falta para diagnosticar a la PERSONA. Acá la pregunta se invierte: no es
 * "qué tiene este usuario", es "qué le está pasando a este auto" — con el
 * dueño como una columna más, mismo criterio que ya usa `/chats` frente a
 * `/usuarios`.
 *
 * No reemplaza una única consulta de DBeaver: reemplaza la DOCENA de `select`
 * sueltos (uno por `vehicle_id`, contra `driving_sessions`, `conversations`,
 * `maintenance_occurrences`, `notifications`, `fines`, `insurances`,
 * `vehicle_inspections`, `registration_cards`, `diagnostic_dtcs`…) que hoy
 * hacen falta para contestar "¿qué tan sano está este vehículo?".
 *
 * ── Derivaciones que no son columnas, y de dónde salen ───────────────────────
 *
 * - **`lastActivityAt`** — mismo patrón que `UserListItem`: el `greatest()`
 *   entre su escaneo, su chat y su tarea más recientes. `null` = el vehículo
 *   se cargó y nunca pasó nada más.
 * - **`activeAlertsCount`** — `notifications` de este vehículo con
 *   `status <> 'read'`. Es una lectura NUESTRA de "activa" (el dominio no
 *   tiene un estado así para una notificación); `pending`/`sent` son las dos
 *   mitades de "todavía no se leyó".
 * - **DTCs activos / inactivos** — "activos" son los códigos del ÚLTIMO
 *   escaneo (`vehicle_last_dtc_scans` → `session_dtc_snapshots`), no un
 *   estado que el dominio afirme. "Inactivos" son códigos que aparecieron
 *   alguna vez en `diagnostic_dtcs` y NO están en ese último escaneo —
 *   verificado contra la base: el vehículo `24345106-…` tiene `P0171` en su
 *   historial y el último escaneo no lo trae, así que ese código se apagó en
 *   algún momento entre medio. → `.claude/rules/vehicles.md`
 * - **`scanMinutesTotal`** — la suma de duración de sus `driving_sessions`
 *   con `ended_at` cargado. Una sesión sin `ended_at` (`pending_chunks`)
 *   todavía no tiene duración que sumar.
 */

// ── Formas de fila ───────────────────────────────────────────────────────────

export interface VehicleListItem {
  id: string
  plate: string
  alias: string | null
  archived: boolean
  createdAt: string

  brand: string
  model: string
  year: number
  trim: string

  ownerId: string
  ownerName: string | null
  ownerEmail: string

  lastActivityAt: string | null

  /** Mismo predicado "sirvió" que en TODO el resto del repo. → scanner-compatibility.md */
  scansOk: number
  scansTotal: number
  lastScanAt: string | null
  /** Minutos totales, sumando sólo sesiones con `ended_at` cargado. */
  scanMinutesTotal: number

  /** `conversations` de este vehículo — todas son "de diagnóstico": `vehicle_id` no nulo lo define. */
  diagnosticChatCount: number

  pastTasksCount: number
  pendingTasksCount: number

  /** `notifications` de este vehículo con `status <> 'read'`. */
  activeAlertsCount: number

  insuranceStatus: string | null
  insuranceExpiresAt: string | null

  vtvStatus: string | null
  vtvExpiresAt: string | null

  registrationCardLoadedAt: string | null

  finesCount: number
  finesPendingCount: number

  odometerValue: number
  /** `vehicles.current_distance_since_dtc_clear_km` — ya viene calculado, no se deriva acá. */
  distanceSinceDtcClearKm: number | null

  /** `null` = nunca se escaneó por DTCs. `[]` = se escaneó y no encontró nada. */
  activeDtcCodes: Array<string> | null
  /** Códigos que aparecieron alguna vez y no están en el escaneo más reciente. Nunca `null`. */
  inactiveDtcCodes: Array<string>
  lastDtcScanAt: string | null
}

export interface VehicleDtc {
  code: string
  description: string | null
  lastSeenAt: string
}

export interface VehicleScan {
  id: string
  startedAt: string
  endedAt: string | null
  status: string
  scannerType: string
  scannerFirmware: string | null
  totalReadings: number
  distanceSinceDtcClearKm: number | null
}

export interface VehicleChat {
  id: string
  startedAt: string
  status: string
  title: string | null
  model: string | null
  userMessageCount: number
  aiMessageCount: number
}

export type VehicleTaskState = 'done' | 'overdue' | 'pending' | 'undated'

export interface VehicleTask {
  id: string
  name: string
  itemType: string
  dueDate: string | null
  dueKm: number | null
  performedAt: string | null
  odometerAtService: number | null
  workshop: string | null
  archived: boolean
  createdAt: string
  state: VehicleTaskState
}

export interface VehicleAlert {
  id: string
  type: string
  title: string
  status: string
  channel: string
  scheduledAt: string
  sentAt: string | null
}

export interface VehicleFine {
  id: string
  reason: string
  amount: number
  status: string
  jurisdiction: string | null
  infractionDate: string
  dueDate: string | null
}

export interface VehicleTaxDebt {
  id: string
  jurisdiction: string
  period: string
  amount: number
  clearedAt: string | null
  dueDate: string | null
}

/** Las 21 relaciones alcanzables desde un vehículo — ver `VEHICLE_CENSUS_ENTRIES`. */
export const VEHICLE_CENSUS_KEYS = [
  'drivingSessions',
  'drivingSessionChunks',
  'telemetryAnalysis',
  'sessionAnalysisSnapshots',
  'sessionDtcSnapshots',
  'lastDtcScans',
  'diagnosticDtcs',
  'aiDiagnostics',
  'conversations',
  'conversationMessages',
  'assistantProposals',
  'recommendationImpressions',
  'fines',
  'fineSyncs',
  'taxDebts',
  'insurances',
  'registrationCards',
  'inspections',
  'maintenancePlans',
  'maintenanceOccurrences',
  'notifications',
] as const

export type VehicleCensusKey = (typeof VEHICLE_CENSUS_KEYS)[number]
export type VehicleCensus = Record<VehicleCensusKey, number>

export type VehicleCensusGroup =
  | 'Manejo y telemetría'
  | 'Asistente e IA'
  | 'Trámites'
  | 'Mantenimiento'
  | 'Notificaciones'

export interface VehicleCensusEntry {
  key: VehicleCensusKey
  label: string
  table: string
  group: VehicleCensusGroup
  via: 'vehicle_id' | 'sus sesiones' | 'sus conversaciones'
}

/**
 * Mismo patrón que `CENSUS_ENTRIES` en `~/lib/users`: única fuente de verdad
 * para el SQL, los títulos y los grupos. Son 21 y no 19 porque
 * `driving_session_chunks` y `conversation_messages` son de segundo nivel —
 * cuelgan de las sesiones y conversaciones del vehículo, no directo de
 * `vehicle_id`.
 */
export const VEHICLE_CENSUS_ENTRIES: ReadonlyArray<VehicleCensusEntry> = [
  { key: 'drivingSessions', label: 'Sesiones de manejo', table: 'driving_sessions', group: 'Manejo y telemetría', via: 'vehicle_id' },
  { key: 'drivingSessionChunks', label: 'Chunks subidos', table: 'driving_session_chunks', group: 'Manejo y telemetría', via: 'sus sesiones' },
  { key: 'telemetryAnalysis', label: 'Análisis de telemetría', table: 'driving_telemetry_analysis', group: 'Manejo y telemetría', via: 'vehicle_id' },
  { key: 'sessionAnalysisSnapshots', label: 'Snapshots de análisis', table: 'session_analysis_snapshots', group: 'Manejo y telemetría', via: 'vehicle_id' },
  { key: 'sessionDtcSnapshots', label: 'Snapshots de DTC', table: 'session_dtc_snapshots', group: 'Manejo y telemetría', via: 'vehicle_id' },
  { key: 'lastDtcScans', label: 'Puntero al último escaneo DTC', table: 'vehicle_last_dtc_scans', group: 'Manejo y telemetría', via: 'vehicle_id' },
  { key: 'diagnosticDtcs', label: 'Códigos DTC leídos', table: 'diagnostic_dtcs', group: 'Manejo y telemetría', via: 'vehicle_id' },
  { key: 'aiDiagnostics', label: 'Diagnósticos de IA', table: 'ai_diagnostics', group: 'Manejo y telemetría', via: 'vehicle_id' },

  { key: 'conversations', label: 'Conversaciones', table: 'conversations', group: 'Asistente e IA', via: 'vehicle_id' },
  { key: 'conversationMessages', label: 'Mensajes', table: 'conversation_messages', group: 'Asistente e IA', via: 'sus conversaciones' },
  { key: 'assistantProposals', label: 'Propuestas del asistente', table: 'assistant_proposals', group: 'Asistente e IA', via: 'vehicle_id' },
  { key: 'recommendationImpressions', label: 'Impresiones de recomendación', table: 'recommendation_impressions', group: 'Asistente e IA', via: 'vehicle_id' },

  { key: 'fines', label: 'Multas', table: 'fines', group: 'Trámites', via: 'vehicle_id' },
  { key: 'fineSyncs', label: 'Sincronizaciones de multas', table: 'vehicle_fine_syncs', group: 'Trámites', via: 'vehicle_id' },
  { key: 'taxDebts', label: 'Deudas de patente', table: 'vehicle_tax_debts', group: 'Trámites', via: 'vehicle_id' },
  { key: 'insurances', label: 'Seguros', table: 'insurances', group: 'Trámites', via: 'vehicle_id' },
  { key: 'registrationCards', label: 'Cédulas', table: 'registration_cards', group: 'Trámites', via: 'vehicle_id' },
  { key: 'inspections', label: 'VTV', table: 'vehicle_inspections', group: 'Trámites', via: 'vehicle_id' },

  { key: 'maintenancePlans', label: 'Planes de mantenimiento', table: 'maintenance_plans', group: 'Mantenimiento', via: 'vehicle_id' },
  { key: 'maintenanceOccurrences', label: 'Tareas (pasadas y futuras)', table: 'maintenance_occurrences', group: 'Mantenimiento', via: 'vehicle_id' },

  { key: 'notifications', label: 'Notificaciones', table: 'notifications', group: 'Notificaciones', via: 'vehicle_id' },
]

export const VEHICLE_CENSUS_GROUPS: ReadonlyArray<VehicleCensusGroup> = [
  'Manejo y telemetría',
  'Asistente e IA',
  'Trámites',
  'Mantenimiento',
  'Notificaciones',
]

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
  odometerValue: number
  engineNumber: string | null
  distanceSinceDtcClearBaselineKm: number | null
  distanceSinceDtcClearKm: number | null
  dtcClearReadingAt: string | null

  catalogId: string
  brand: string
  model: string
  year: number
  trim: string
  vehicleType: string
  engine: string | null
  fuelType: string | null
  transmission: string | null

  owner: { id: string; name: string | null; email: string; phone: string | null }

  insurance: { status: string; expiresAt: string; insurer: string } | null
  vtv: { status: string; expiresAt: string; facility: string | null } | null
  registrationCard: { loadedAt: string; registrationNumber: string | null; holderName: string | null } | null

  census: VehicleCensus

  activeDtcs: Array<VehicleDtc>
  inactiveDtcs: Array<VehicleDtc>
  lastDtcScanAt: string | null

  scans: Array<VehicleScan>
  chats: Array<VehicleChat>
  tasks: Array<VehicleTask>
  alerts: Array<VehicleAlert>
  fines: Array<VehicleFine>
  taxDebts: Array<VehicleTaxDebt>
}

export const VEHICLE_TYPE_LABELS: Record<string, string> = {
  car: 'Auto',
  motorcycle: 'Moto',
}

export const FINE_STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  paid: 'Pagada',
  appealed: 'Apelada',
}

export { DOCUMENT_STATUS_LABELS, NOTIFICATION_TYPE_LABELS }

// ── Search params ────────────────────────────────────────────────────────────

/**
 * Cada columna del listado se puede ordenar Y filtrar — es el pedido
 * explícito que reemplazó al recorte inicial (unos pocos `sort` y cuatro
 * chips booleanos). Con 22 columnas visibles eso son muchos parámetros, y
 * quedan agrupados abajo por el TIPO de control que les corresponde, no por
 * columna: texto libre (`q`, ya cubre patente/alias/marca/modelo/versión/
 * dueño), exacto de una lista que sale de los datos (`brand`, `model` — ver
 * `listDistinctVehicleBrands`/`listDistinctVehicleModels`), rango numérico o
 * de fecha (`xMin`/`xMax`, `xFrom`/`xTo`), o estado categórico (los cuatro
 * `enum` de abajo).
 *
 * Simplificaciones deliberadas en los filtros de documento:
 *
 * - **Seguro y VTV** comparten `document_status` (`active | expired |
 *   pending_renewal`). El filtro no expone las tres: agrupa `expired` y
 *   `pending_renewal` en un solo "vencido" porque para un operador buscando
 *   "qué autos tienen el papel vencido" la distinción entre las dos no
 *   cambia la acción a tomar. `missing` es la ausencia del documento
 *   (`insurance_status is null`), y es un estado que la columna no tiene —
 *   es la fila entera sin ninguna insurance cargada.
 * - **Multas** es de tres estados (`pending`/`none`/`all`) y no dos: un auto
 *   puede tener multas y ninguna pendiente (todas pagadas o apeladas). Ese
 *   caso queda representado sólo por `all` menos `pending` menos `none` — no
 *   tiene su propio filtro porque no es la pregunta que un operador hace
 *   ("¿debe algo?" / "¿nunca tuvo?"), y agregarle un cuarto estado por
 *   completitud sería una opción que nadie va a clickear.
 */

export const VEHICLE_ARCHIVED_FILTERS = ['active', 'archived', 'all'] as const
export type VehicleArchivedFilter = (typeof VEHICLE_ARCHIVED_FILTERS)[number]

/** `ok` = trajo al menos un escaneo con datos. `failures` = lo intentó y ninguno sirvió. `never` = nunca lo intentó. */
export const VEHICLE_SCAN_FILTERS = ['all', 'ok', 'failures', 'never'] as const
export type VehicleScanFilter = (typeof VEHICLE_SCAN_FILTERS)[number]

/** Comparte forma entre Seguro y VTV — los dos son `document_status` + "no cargado". */
export const VEHICLE_DOCUMENT_FILTERS = ['all', 'valid', 'expired', 'missing'] as const
export type VehicleDocumentFilter = (typeof VEHICLE_DOCUMENT_FILTERS)[number]

export const VEHICLE_REGISTRATION_CARD_FILTERS = ['all', 'loaded', 'missing'] as const
export type VehicleRegistrationCardFilter = (typeof VEHICLE_REGISTRATION_CARD_FILTERS)[number]

export const VEHICLE_FINES_FILTERS = ['all', 'pending', 'none'] as const
export type VehicleFinesFilter = (typeof VEHICLE_FINES_FILTERS)[number]

/** Una entrada por columna visible de la tabla — las 22, sin excepción. */
export const VEHICLE_SORT_KEYS = [
  'plate',
  'brand',
  'model',
  'year',
  'trim',
  'owner',
  'createdAt',
  'lastActivity',
  'scans',
  'lastScanAt',
  'scanMinutes',
  'chats',
  'pastTasks',
  'pendingTasks',
  'alerts',
  'insurance',
  'vtv',
  'registrationCard',
  'fines',
  'odometer',
  'dtcClearKm',
  'activeDtc',
  'inactiveDtc',
] as const
export type VehicleSortKey = (typeof VEHICLE_SORT_KEYS)[number]

export const VEHICLE_SORT_DIRS = ['asc', 'desc'] as const
export type VehicleSortDir = (typeof VEHICLE_SORT_DIRS)[number]

/** `YYYY-MM-DD`, el formato de `<input type="date">` — se valida el patrón, no que sea una fecha real (Postgres lo hace al castear). */
const dateParam = () => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
const intParam = () => z.coerce.number().int().optional()

export const vehicleSearchSchema = z.object({
  /** Busca en patente, alias, marca, modelo, versión y email/nombre del dueño. */
  q: z.string().trim().max(120).optional(),
  archived: z.enum(VEHICLE_ARCHIVED_FILTERS).catch('active').default('active'),

  /** Exacto, de una lista que sale de los datos — nunca hardcodeada. */
  brand: z.string().trim().max(80).optional(),
  model: z.string().trim().max(80).optional(),
  yearMin: intParam(),
  yearMax: intParam(),

  createdFrom: dateParam(),
  createdTo: dateParam(),

  onlyNeverActive: z.coerce.boolean().catch(false).default(false),
  activityFrom: dateParam(),
  activityTo: dateParam(),

  scans: z.enum(VEHICLE_SCAN_FILTERS).catch('all').default('all'),
  lastScanFrom: dateParam(),
  lastScanTo: dateParam(),
  scanMinutesMin: intParam(),
  scanMinutesMax: intParam(),

  chatsMin: intParam(),
  chatsMax: intParam(),

  pastTasksMin: intParam(),
  pastTasksMax: intParam(),
  pendingTasksMin: intParam(),
  pendingTasksMax: intParam(),

  onlyWithAlerts: z.coerce.boolean().catch(false).default(false),

  insurance: z.enum(VEHICLE_DOCUMENT_FILTERS).catch('all').default('all'),
  vtv: z.enum(VEHICLE_DOCUMENT_FILTERS).catch('all').default('all'),
  registrationCard: z.enum(VEHICLE_REGISTRATION_CARD_FILTERS).catch('all').default('all'),
  fines: z.enum(VEHICLE_FINES_FILTERS).catch('all').default('all'),

  odometerMin: intParam(),
  odometerMax: intParam(),
  dtcClearKmMin: intParam(),
  dtcClearKmMax: intParam(),

  onlyWithActiveDtc: z.coerce.boolean().catch(false).default(false),
  onlyWithInactiveDtc: z.coerce.boolean().catch(false).default(false),

  sort: z.enum(VEHICLE_SORT_KEYS).catch('createdAt').default('createdAt'),
  dir: z.enum(VEHICLE_SORT_DIRS).catch('desc').default('desc'),
})

export type VehicleSearch = z.infer<typeof vehicleSearchSchema>
