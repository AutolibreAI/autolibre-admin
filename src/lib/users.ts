import { z } from 'zod'
import type { UserRole } from './types'

/**
 * Usuarios — el contrato compartido entre servidor y cliente.
 *
 * ── Por qué esta pantalla existe ─────────────────────────────────────────────
 *
 * El CLAUDE.md pide que cada pantalla reemplace una consulta que hoy alguien
 * corre a mano. Ésta reemplaza la peor de todas: la que NO se corre. Para saber
 * qué tiene un usuario había que pegar su uuid en veintipico de `select` sueltos
 * en DBeaver, así que en la práctica nadie miraba más allá de `vehicles` y
 * `conversations`, y lo que estaba en cero no se descubría nunca.
 *
 * ── Por qué el censo es de 29 relaciones y no de 42 ──────────────────────────
 *
 * `users` tiene 24 FKs entrantes y `vehicles` otras 18, y la suma tienta. Pero
 * 15 de las 18 de `vehicles` (fines, insurances, notifications, leads,
 * registration_cards, …) TAMBIÉN cuelgan de `users` por `user_id`: contarlas por
 * los dos caminos las duplicaría en pantalla sin agregar una sola fila real.
 *
 * Las únicas alcanzables SÓLO por el vehículo son tres —
 * `driving_telemetry_analysis`, `vehicle_fine_syncs`, `vehicle_last_dtc_scans` —
 * y son justo las que se olvidan al auditar, porque no aparecen en un
 * `\d users`. Más dos de tercer nivel (`conversation_messages`,
 * `driving_session_chunks`). Total: 24 + 3 + 2 = 29.
 */

export type AuthProvider = 'clerk' | 'native'

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  user: 'Usuario',
  admin: 'Admin',
  /**
   * Legacy, y se etiqueta como tal. El enum `user_role` de Postgres todavía lo
   * lleva aunque el backend diga Partner — ver la nota en `~/lib/types`. Un
   * `Record` parcial acá renderizaría la celda vacía el día que aparezca uno.
   */
  provider: 'Provider (legacy)',
}

export const LEGAL_DOCUMENT_LABELS: Record<string, string> = {
  terms_of_service: 'Términos y condiciones',
  privacy_policy: 'Política de privacidad',
}

export const DOCUMENT_STATUS_LABELS: Record<string, string> = {
  active: 'Vigente',
  expired: 'Vencida',
  pending_renewal: 'A renovar',
}

/** `vehicle_data_query_status`: los cuatro valores del enum, no una adivinanza. */
export const VEHICLE_DATA_QUERY_STATUS_LABELS: Record<string, string> = {
  queued: 'en cola',
  processing: 'en curso',
  completed: 'consultada',
  failed: 'la consulta falló',
}

export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  document_expiration: 'Vencimiento de documento',
  maintenance_reminder: 'Recordatorio de mantenimiento',
  diagnostic_available: 'Diagnóstico disponible',
  fine_pending: 'Multa pendiente',
  dtc_active: 'DTC activo',
  vehicle_data_ready: 'Datos del vehículo listos',
}

// ── Censo ────────────────────────────────────────────────────────────────────

/**
 * Las claves del censo. El orden de este array ES el orden en pantalla, así que
 * se agrupa por lo que un operador pregunta junto, no por nombre de tabla.
 */
export const CENSUS_KEYS = [
  'vehicles',
  'driverLicenses',
  'legalAcceptances',
  'notificationPreferences',
  'pushTokens',
  'files',
  'conversations',
  'conversationMessages',
  'aiDiagnostics',
  'diagnosticDtcs',
  'assistantProposals',
  'drivingSessions',
  'drivingSessionChunks',
  'telemetryAnalysis',
  'lastDtcScans',
  'fines',
  'fineSyncs',
  'taxDebts',
  'insurances',
  'registrationCards',
  'inspections',
  'dataQueries',
  'maintenancePlans',
  'maintenanceOccurrences',
  'notifications',
  'leads',
  'ownedPartners',
  'feedback',
  'reviewedApplications',
] as const

export type CensusKey = (typeof CENSUS_KEYS)[number]

export type UserCensus = Record<CensusKey, number>

export type CensusGroup =
  | 'Identidad y flota'
  | 'Asistente e IA'
  | 'Manejo y telemetría'
  | 'Trámites del vehículo'
  | 'Mantenimiento'
  | 'Contacto y marketplace'
  | 'Como staff'

export interface CensusEntry {
  key: CensusKey
  label: string
  /** Nombre real de la tabla, para poder ir a DBeaver cuando el panel no alcanza. */
  table: string
  group: CensusGroup
  /**
   * Cómo se llega a la fila desde el usuario. Es lo que hace verificable al
   * censo: un número raro se audita sabiendo por qué columna se filtró.
   */
  via: 'user_id' | 'sus vehículos' | 'sus conversaciones' | 'sus sesiones' | 'reviewed_by_id'
}

/**
 * El mapa del censo. Es la única definición: el SQL, los títulos y los grupos
 * salen todos de acá, así que agregar una relación es una línea y no tres
 * lugares que se desincronizan.
 */
export const CENSUS_ENTRIES: ReadonlyArray<CensusEntry> = [
  { key: 'vehicles', label: 'Vehículos', table: 'vehicles', group: 'Identidad y flota', via: 'user_id' },
  { key: 'driverLicenses', label: 'Licencias de conducir', table: 'driver_licenses', group: 'Identidad y flota', via: 'user_id' },
  { key: 'legalAcceptances', label: 'Aceptaciones legales', table: 'legal_acceptances', group: 'Identidad y flota', via: 'user_id' },
  { key: 'notificationPreferences', label: 'Preferencias de notificación', table: 'user_notification_preferences', group: 'Identidad y flota', via: 'user_id' },
  { key: 'pushTokens', label: 'Tokens push', table: 'expo_push_tokens', group: 'Identidad y flota', via: 'user_id' },
  { key: 'files', label: 'Archivos subidos', table: 'files', group: 'Identidad y flota', via: 'user_id' },

  { key: 'conversations', label: 'Conversaciones', table: 'conversations', group: 'Asistente e IA', via: 'user_id' },
  { key: 'conversationMessages', label: 'Mensajes', table: 'conversation_messages', group: 'Asistente e IA', via: 'sus conversaciones' },
  { key: 'aiDiagnostics', label: 'Diagnósticos de IA', table: 'ai_diagnostics', group: 'Asistente e IA', via: 'user_id' },
  { key: 'diagnosticDtcs', label: 'Códigos DTC', table: 'diagnostic_dtcs', group: 'Asistente e IA', via: 'user_id' },
  { key: 'assistantProposals', label: 'Propuestas del asistente', table: 'assistant_proposals', group: 'Asistente e IA', via: 'user_id' },

  { key: 'drivingSessions', label: 'Sesiones de manejo', table: 'driving_sessions', group: 'Manejo y telemetría', via: 'user_id' },
  { key: 'drivingSessionChunks', label: 'Chunks subidos', table: 'driving_session_chunks', group: 'Manejo y telemetría', via: 'sus sesiones' },
  { key: 'telemetryAnalysis', label: 'Análisis de telemetría', table: 'driving_telemetry_analysis', group: 'Manejo y telemetría', via: 'sus vehículos' },
  { key: 'lastDtcScans', label: 'Último escaneo DTC', table: 'vehicle_last_dtc_scans', group: 'Manejo y telemetría', via: 'sus vehículos' },

  { key: 'fines', label: 'Multas', table: 'fines', group: 'Trámites del vehículo', via: 'user_id' },
  { key: 'fineSyncs', label: 'Sincronizaciones de multas', table: 'vehicle_fine_syncs', group: 'Trámites del vehículo', via: 'sus vehículos' },
  { key: 'taxDebts', label: 'Deudas de patente', table: 'vehicle_tax_debts', group: 'Trámites del vehículo', via: 'user_id' },
  { key: 'insurances', label: 'Seguros', table: 'insurances', group: 'Trámites del vehículo', via: 'user_id' },
  { key: 'registrationCards', label: 'Cédulas', table: 'registration_cards', group: 'Trámites del vehículo', via: 'user_id' },
  { key: 'inspections', label: 'VTV', table: 'vehicle_inspections', group: 'Trámites del vehículo', via: 'user_id' },
  { key: 'dataQueries', label: 'Consultas de datos', table: 'vehicle_data_queries', group: 'Trámites del vehículo', via: 'user_id' },

  { key: 'maintenancePlans', label: 'Planes de mantenimiento', table: 'maintenance_plans', group: 'Mantenimiento', via: 'user_id' },
  { key: 'maintenanceOccurrences', label: 'Service realizados', table: 'maintenance_occurrences', group: 'Mantenimiento', via: 'user_id' },

  { key: 'notifications', label: 'Notificaciones', table: 'notifications', group: 'Contacto y marketplace', via: 'user_id' },
  { key: 'leads', label: 'Leads enviados', table: 'leads', group: 'Contacto y marketplace', via: 'user_id' },
  { key: 'ownedPartners', label: 'Partners que administra', table: 'partners', group: 'Contacto y marketplace', via: 'user_id' },
  { key: 'feedback', label: 'Feedback enviado', table: 'feedback', group: 'Contacto y marketplace', via: 'user_id' },

  /**
   * Separado a propósito: `reviewed_by_id` NO es algo que el usuario TIENE, es
   * algo que HIZO revisando solicitudes ajenas. Meterlo entre sus datos haría
   * leer las solicitudes de otros talleres como si fueran suyas.
   */
  { key: 'reviewedApplications', label: 'Solicitudes que revisó', table: 'partner_applications', group: 'Como staff', via: 'reviewed_by_id' },
]

export const CENSUS_GROUPS: ReadonlyArray<CensusGroup> = [
  'Identidad y flota',
  'Asistente e IA',
  'Manejo y telemetría',
  'Trámites del vehículo',
  'Mantenimiento',
  'Contacto y marketplace',
  'Como staff',
]

// ── Formas de fila ───────────────────────────────────────────────────────────

export interface UserListItem {
  id: string
  email: string
  name: string | null
  phone: string | null
  role: UserRole
  authProvider: AuthProvider
  createdAt: string
  vehicleCount: number
  /**
   * Última señal de vida derivada: el `max()` entre su vehículo más nuevo, su
   * última conversación y su última sesión de manejo.
   *
   * `users` no tiene `last_seen_at` y no se va a inventar una: es `null` cuando
   * el usuario se registró y no hizo nada más, que es un dato — no un cero.
   */
  lastActivityAt: string | null
  /**
   * Escaneos: sesiones del escáner OBD que TRAJERON DATOS, sobre el total de
   * intentos.
   *
   * Son dos números y no uno a propósito. Contar sólo las sesiones sería
   * repetir el error que `/escaneres` existe para no cometer: al 2026-09-04, de
   * las 17 sesiones de la base, **6 quedaron marcadas como `completed` con cero
   * lecturas y cero minutos de duración** — el escáner nunca enganchó. Un
   * usuario con "4 escaneos" que en realidad son 4 fracasos es exactamente el
   * que va a llamar a soporte, y la lista tiene que dejarlo ver.
   *
   * El predicado es el MISMO que el de `scanners.repo.ts`. Si divergen, el
   * panel dice dos verdades distintas sobre la misma palabra.
   * → `.claude/rules/scanner-compatibility.md`
   */
  scansOk: number
  scansTotal: number

  /**
   * "El registro" — la licencia de conducir, la de `driver_licenses`, no la
   * cédula (eso es `registration_cards` y es del auto). Sale de la fila NO
   * archivada más reciente; si no hay ninguna, de la archivada más reciente —
   * mismo criterio que `insurances`/`registration_cards` en el resto del repo.
   *
   * `driverLicenseDaysUntilExpiration` viene YA CALCULADO por Postgres
   * (`expiration_date - current_date`) y no por `new Date()` en el
   * componente: esta pantalla es SSR completo, y una resta contra el reloj
   * del NAVEGADOR puede diferir de la del SERVIDOR en el instante justo que
   * cruza medianoche UTC entre el render y la hidratación — el mismo tipo de
   * mismatch que `format.ts` fija con `timeZone: 'UTC'` para las fechas. Acá
   * el número ya es un dato, no un cálculo que el cliente repite.
   */
  driverLicenseExpiresAt: string | null
  driverLicenseDaysUntilExpiration: number | null
}

export interface UserVehicle {
  id: string
  plate: string
  alias: string | null
  color: string
  odometerValue: number
  archived: boolean
  createdAt: string
  registeredAt: string | null
  brand: string
  model: string
  year: number
  trim: string
  vehicleType: string
  engine: string | null
  fuelType: string | null
  transmission: string | null

  /**
   * "¿Consultaron VTV/multas de este auto?" — y es una pregunta DISTINTA de
   * "¿tiene la VTV cargada?" (eso ya está en el censo, tabla
   * `vehicle_inspections`, y es el disco/documento). Acá es la consulta
   * automática contra el proveedor:
   *
   * - VTV sale de `vehicle_data_queries` con `'vtv' = any(requested_modules)`.
   *   `vtvQueryStatus` es `null` cuando nunca se pidió, y si no es `null`
   *   siempre viene acompañado del intento más reciente.
   * - Multas sale de `vehicle_fine_syncs`, que tiene UNA fila por vehículo y
   *   sólo existe si alguna vez se sincronizó — su sola presencia (`finesSyncedAt`
   *   no nulo) ES la respuesta.
   *
   * `finesCount` es cuántas multas quedaron encontradas, para no confundir
   * "nunca se consultó" con "se consultó y no había ninguna".
   *
   * `vtvQueryStatus` es texto libre y no un union: `vehicle_data_query_status`
   * tiene CUATRO valores (`queued | processing | completed | failed`), y como
   * acá se toma el intento más reciente sin filtrar por estado, puede caer
   * cualquiera de los cuatro — inventar un union de dos lo haría renderizar en
   * blanco el día que la fila más nueva esté todavía en curso.
   */
  vtvQueryStatus: string | null
  vtvQueryCompletedAt: string | null
  vtvQueryCreatedAt: string | null
  finesSyncedAt: string | null
  finesCount: number

  /** Documentos cargados para este auto — presencia, no consulta. */
  insuranceStatus: string | null
  insuranceExpiresAt: string | null
  registrationCardLoadedAt: string | null
}

export type MaintenanceTaskState = 'done' | 'overdue' | 'pending' | 'undated'

export interface UserMaintenanceTask {
  id: string
  vehiclePlate: string
  name: string
  itemType: string
  dueDate: string | null
  performedAt: string | null
  archived: boolean
  createdAt: string
  /**
   * Derivado, no una columna. `done` es lo único que el dominio afirma
   * (`performed_at` está cargado); `overdue` / `pending` / `undated` son una
   * lectura NUESTRA del reloj contra `due_date` — misma familia que `stuck` en
   * `/operacion` y `noData` en `/escaneres`: útil, pero hay que decirlo en voz
   * alta porque no lo escribió el backend.
   */
  state: MaintenanceTaskState
}

/**
 * La fila por vehículo del toggle del LISTADO — `/usuarios`, no la ficha.
 *
 * Es un tipo aparte de `UserVehicle` a propósito, aunque las dos describan al
 * mismo vehículo: `UserVehicle` contesta "¿qué trámites tiene cargados?"
 * (seguro, cédula, si se consultó VTV/multas) para la ficha completa.
 * `UserVehicleSummary` contesta "¿qué está HACIENDO con este auto?" — uso del
 * asistente, escaneos, DTCs, tareas, anomalías — para una vista operativa que
 * se abre por fila y se pide bajo demanda (nunca en el `loader` del listado:
 * son hasta 500 usuarios, y traer esto para todos en cada carga sería el
 * mismo error de fan-out que el resto del repo evita).
 *
 * Los campos vienen en pares deliberados de "cuándo" + "cuánto", igual que
 * `scansOk`/`scansTotal` en el resto del archivo: un número solo no dice si
 * está bien o mal, y las fechas de vencimiento se muestran crudas — el cálculo
 * de "cuántos días faltan" es de la UI, no de acá, porque esta pantalla sólo
 * se renderiza del lado del cliente (aparece después de un click, nunca en
 * SSR) y ahí `new Date()` no tiene el riesgo de mismatch que tiene en una
 * pantalla que si se manda por SSR.
 */
export interface UserVehicleSummary {
  id: string
  plate: string
  alias: string | null
  archived: boolean
  brand: string
  model: string
  year: number

  /** VTV — el documento (`vehicle_inspections`), no la consulta. */
  vtvExpiresAt: string | null

  /** `conversations` de este auto — el chat con el asistente de diagnóstico. */
  diagnosticChatCount: number

  /**
   * La consulta de deuda de patente — `vehicle_data_queries`, módulo
   * `tax_debt`. Mismo texto libre que `UserVehicle.vtvQueryStatus` y por la
   * misma razón: el enum tiene cuatro valores y acá se toma el más reciente
   * sin filtrar por estado.
   */
  taxDebtQueryStatus: string | null
  taxDebtQueryAt: string | null

  /**
   * Multas — la última CONSULTA (`vehicle_fine_syncs.last_synced_at`, 1:1 por
   * vehículo), y el monto adeudado que esa consulta dejó en `fines`.
   *
   * El par cuándo/cuánto respeta el mismo criterio de null-vs-0 que
   * `activeDtcCount`:
   *  - `fineQueryAt = null` ⇒ nunca se consultaron las multas de este auto.
   *  - `fineDebtAmount = null` ⇒ lo mismo: no hay consulta, no hay respuesta.
   *  - `fineDebtAmount = 0` ⇒ SÍ se consultó y no hay nada adeudado. Distinto
   *    de `null`, y confundirlos diría "sin deuda" sobre un auto que nadie
   *    miró.
   *
   * "Adeudado" = suma de `fines.amount` con `status = 'pending'` (una multa
   * `paid` está saldada; una `appealed` está en disputa — ninguna es deuda a
   * cobrar). En pesos, entero.
   */
  fineQueryAt: string | null
  fineDebtAmount: number | null

  /** Seguro — el documento (`insurances`), no la consulta. */
  insuranceExpiresAt: string | null

  /** Mismo predicado que en todo el resto del repo: completed + al menos una lectura. */
  scansOk: number
  scansTotal: number

  /**
   * `null` = nunca se escaneó este auto. `0` = se escaneó y no había ningún
   * código. Son respuestas DISTINTAS y confundirlas es el bug que
   * `scanner-compatibility.md` documenta para `/escaneres` — acá aplica
   * igual. Se toma del ÚLTIMO escaneo (`vehicle_last_dtc_scans`): no hay un
   * estado "resuelto" en el dominio, así que "activo" es una lectura NUESTRA
   * de "encontrado en el escaneo más reciente".
   */
  activeDtcCount: number | null
  lastDtcScanAt: string | null

  /** `maintenance_occurrences` de este auto: hechas vs. sin hacer. */
  pastTasksCount: number
  pendingTasksCount: number

  /**
   * Cantidad de anomalías del análisis de telemetría MÁS RECIENTE de este
   * auto (`driving_telemetry_analysis.anomalies`, un array jsonb). `null` =
   * nunca se analizó. Mismo criterio que `activeDtcCount`: no hay "resuelto"
   * en el dominio, "activa" es "apareció en el último análisis".
   */
  activeAnomalyCount: number | null
  lastTelemetryAnalysisAt: string | null
}

export interface UserLegalAcceptance {
  document: string
  version: string
  acceptedAt: string
}

export interface UserDriverLicense {
  id: string
  licenseNumber: string
  category: string | null
  status: string
  expirationDate: string
  archived: boolean
  firstName: string | null
  lastName: string | null
}

export interface UserPushToken {
  id: string
  platform: string | null
  deviceId: string | null
  createdAt: string
  updatedAt: string
}

export interface UserNotificationPreference {
  notificationType: string
  channel: string
}

export interface UserOwnedPartner {
  id: string
  name: string
  status: string
  coverageZone: string
}

export interface UserDetail {
  id: string
  email: string
  name: string | null
  phone: string | null
  role: UserRole
  authProvider: AuthProvider
  externalAuthId: string
  createdAt: string
  updatedAt: string
  census: UserCensus
  vehicles: Array<UserVehicle>
  legalAcceptances: Array<UserLegalAcceptance>
  driverLicenses: Array<UserDriverLicense>
  pushTokens: Array<UserPushToken>
  notificationPreferences: Array<UserNotificationPreference>
  ownedPartners: Array<UserOwnedPartner>
  /** `maintenance_occurrences` de todos sus vehículos — las tareas, pasadas y futuras. */
  tasks: Array<UserMaintenanceTask>
}

// ── Lo que no cierra ─────────────────────────────────────────────────────────

export interface UserFlag {
  key: string
  title: string
  /** Qué significa operativamente. Sin esto es un número más. */
  detail: string
}

/**
 * Las contradicciones del expediente, derivadas de lo que ya está en pantalla.
 *
 * ── Por qué esto existe ──────────────────────────────────────────────────────
 *
 * El censo contesta "qué tiene". Nadie abre una ficha de soporte para eso: se
 * abre porque **algo no anda**, y lo que no anda casi nunca está en un número
 * suelto — está en el CRUCE de dos. "Cargó preferencias de notificación" no dice
 * nada; "cargó preferencias y no tiene ningún token push" dice que pidió que le
 * avisen y no le puede llegar nada. Cruzar 29 contadores a ojo es exactamente lo
 * que el operador no va a hacer, así que lo hace la pantalla.
 *
 * ── La regla de contenido, y es dura ─────────────────────────────────────────
 *
 * **Cada flag es una co-ocurrencia verificable, nunca un diagnóstico.** El texto
 * puede decir "tiene A y no tiene B" y qué se rompe si eso es cierto; no puede
 * decir por qué pasó. La causa está en logs que este panel no lee, y una
 * pantalla que adivina causas manda a arreglar lo que no estaba roto.
 *
 * Misma regla de visibilidad que `ActionList` en Inicio: **una fila sólo aparece
 * si aplica.** Siete renglones diciendo "todo bien" entrenan a no leer la
 * tarjeta, y el día que uno importe nadie lo nota.
 */
export function deriveUserFlags(user: UserDetail): Array<UserFlag> {
  const c = user.census
  const flags: Array<UserFlag> = []

  const activeVehicles = user.vehicles.filter((v) => !v.archived)
  const hasActivity = c.vehicles > 0 || c.conversations > 0 || c.drivingSessions > 0

  if (c.notificationPreferences > 0 && c.pushTokens === 0) {
    flags.push({
      key: 'prefs-sin-push',
      title: 'Pidió notificaciones y no le pueden llegar',
      detail: `${c.notificationPreferences} preferencia(s) cargada(s) y ningún token push registrado. Todo lo que se le encole se va a intentar enviar a un dispositivo que no existe.`,
    })
  }

  if (c.conversations > 0 && c.conversationMessages === 0) {
    flags.push({
      key: 'conv-sin-mensajes',
      title: 'Conversaciones vacías',
      detail: `${c.conversations} conversación(es) abiertas sin un solo mensaje. Abrió el asistente y no quedó nada escrito.`,
    })
  }

  if (c.drivingSessions > 0 && c.drivingSessionChunks === 0) {
    flags.push({
      key: 'sesiones-sin-chunks',
      title: 'Sesiones de manejo sin datos subidos',
      detail: `${c.drivingSessions} sesión(es) registradas y cero chunks. La sesión arrancó y la telemetría nunca llegó al servidor.`,
    })
  }

  if (c.legalAcceptances === 0 && hasActivity) {
    flags.push({
      key: 'sin-legales',
      title: 'Usa la app sin haber aceptado nada',
      detail: 'Tiene actividad registrada y cero filas en legal_acceptances. O el gate legal no se le mostró, o se le mostró y no se grabó.',
    })
  }

  const withoutOdometer = activeVehicles.filter((v) => v.odometerValue === 0)
  if (withoutOdometer.length > 0) {
    flags.push({
      key: 'sin-odometro',
      title: `${withoutOdometer.length} vehículo(s) sin odómetro`,
      detail: `${withoutOdometer.map((v) => v.plate).join(', ')}. Un plan de mantenimiento se dispara por kilometraje: en cero, no dispara nunca.`,
    })
  }

  const badLicenses = user.driverLicenses.filter((l) => !l.archived && l.status !== 'active')
  if (badLicenses.length > 0) {
    flags.push({
      key: 'licencia',
      title: 'Licencia de conducir no vigente',
      detail: badLicenses
        .map((l) => `${l.licenseNumber}: ${DOCUMENT_STATUS_LABELS[l.status] ?? l.status}`)
        .join(' · '),
    })
  }

  const vehiclesWithNoPaperwork = activeVehicles.filter(
    (v) =>
      v.vtvQueryStatus === null &&
      v.finesSyncedAt === null &&
      v.insuranceStatus === null &&
      v.registrationCardLoadedAt === null,
  )
  if (vehiclesWithNoPaperwork.length > 0) {
    flags.push({
      key: 'vehiculo-sin-tramites',
      title: `${vehiclesWithNoPaperwork.length} vehículo(s) sin ningún trámite`,
      detail: `${vehiclesWithNoPaperwork.map((v) => v.plate).join(', ')}. Nunca se consultó VTV ni multas, y no tiene seguro ni cédula cargados — cero filas en las cuatro tablas.`,
    })
  }

  if (c.vehicles === 0 && (c.conversations > 0 || c.fines > 0 || c.drivingSessions > 0)) {
    flags.push({
      key: 'actividad-sin-vehiculo',
      title: 'Actividad sin ningún vehículo',
      detail: 'Casi toda la app cuelga del vehículo. Con cero filas en vehicles —ni siquiera archivadas— hay actividad que no debería haber podido existir.',
    })
  }

  return flags
}

// ── Search params ────────────────────────────────────────────────────────────

export const USER_ROLE_FILTERS = ['all', 'user', 'admin', 'provider'] as const
export type UserRoleFilter = (typeof USER_ROLE_FILTERS)[number]

/**
 * Las columnas por las que se puede ordenar el listado. Un `Record` en
 * `users.repo.ts` mapea cada una a su expresión SQL — la lista de acá es el
 * contrato con la URL, no con la base.
 */
export const USER_SORT_KEYS = [
  'name',
  'role',
  'vehicles',
  'scans',
  'createdAt',
  'lastActivity',
  'license',
] as const
export type UserSortKey = (typeof USER_SORT_KEYS)[number]

export const USER_SORT_DIRS = ['asc', 'desc'] as const
export type UserSortDir = (typeof USER_SORT_DIRS)[number]

export const USER_VEHICLE_FILTERS = ['all', 'yes', 'no'] as const
export type UserVehicleFilter = (typeof USER_VEHICLE_FILTERS)[number]

/**
 * Vigente / vencido / sin cargar — los tres estados que ya usa `ExpiryCell`
 * en el toggle de vehículos, acá como filtro. `vencido` incluye "vence hoy":
 * de este lado de la pantalla no hace falta la precisión del día exacto que
 * sí tiene esa celda.
 */
export const USER_LICENSE_FILTERS = ['all', 'valid', 'expired', 'missing'] as const
export type UserLicenseFilter = (typeof USER_LICENSE_FILTERS)[number]

/**
 * Ver la nota sobre los dos modos de falla de zod en `~/lib/search`. Acá todo
 * degrada con `.catch()`: un filtro guardado en un favorito que ya no existe
 * tiene que mostrar la lista completa, no una pantalla de error.
 */
export const userSearchSchema = z.object({
  /** Busca en email y nombre. */
  q: z.string().trim().max(120).optional(),
  role: z.enum(USER_ROLE_FILTERS).catch('all').default('all'),
  /**
   * Los `native` heredados. El CLAUDE.md documenta que en una base había 876 y
   * en otra cero — por eso es un filtro y no una constante: el número se mira,
   * no se recuerda.
   */
  onlyLegacyNative: z.coerce.boolean().catch(false).default(false),

  /** El orden por defecto es el de siempre: alta descendente. */
  sort: z.enum(USER_SORT_KEYS).catch('createdAt').default('createdAt'),
  dir: z.enum(USER_SORT_DIRS).catch('desc').default('desc'),

  hasVehicles: z.enum(USER_VEHICLE_FILTERS).catch('all').default('all'),
  /** `scansOk = 0` con `scansTotal > 0` — el escáner se usó y nunca sirvió. */
  onlyScanFailures: z.coerce.boolean().catch(false).default(false),
  /** `lastActivityAt` nulo — se registró y no hizo nada más. */
  onlyNeverActive: z.coerce.boolean().catch(false).default(false),
  license: z.enum(USER_LICENSE_FILTERS).catch('all').default('all'),
})

export type UserSearch = z.infer<typeof userSearchSchema>
