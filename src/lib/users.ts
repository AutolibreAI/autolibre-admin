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
})

export type UserSearch = z.infer<typeof userSearchSchema>
