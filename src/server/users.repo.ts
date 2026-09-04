import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import type {
  AuthProvider,
  UserCensus,
  UserDetail,
  UserDriverLicense,
  UserLegalAcceptance,
  UserListItem,
  UserNotificationPreference,
  UserOwnedPartner,
  UserPushToken,
  UserSearch,
  UserVehicle,
} from '~/lib/users'
import type { UserRole } from '~/lib/types'

/**
 * Usuarios — el expediente que hoy nadie arma.
 *
 * Mismo dueño de SQL que `ops.repo.ts`: **nosotros, pero sobre tablas de
 * `public`**. Se aplica la misma regla y por el mismo motivo — una función de
 * `ops` que lee 29 tablas de `public` sería una dependencia cruzada escrita
 * adentro de la base, invisible para las migraciones de Drizzle del backend. Con
 * el SQL acá, un rename del backend igual rompe en runtime, pero `rg` lo
 * encuentra y el diff queda versionado.
 *
 * Corolario, y es literal: **ninguna consulta de este archivo escribe nada.**
 * El detalle de usuario se decidió de solo lectura a propósito. Antes de agregar
 * la primera escritura hay que leer `.claude/rules/ops-write-actions.md` — un
 * `UPDATE users SET role` sin stored procedure ni `ops.action_log` es la
 * escritura más peligrosa del sistema, porque quien la tiene se da acceso al
 * panel a sí mismo y no queda registro de quién fue.
 */

// ── Conversión ───────────────────────────────────────────────────────────────

/**
 * `pg` devuelve `bigint` y `numeric` como STRING — `"14" + "3" === "143"`. Todas
 * las consultas de acá castean a `::int` en SQL; esto es la segunda red, igual
 * que en `ops.repo.ts`.
 */
const toInt = (value: unknown): number => Number(value ?? 0)

const toIso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value)

/** Para columnas NOT NULL: el `null` no es representable, así que no se propaga. */
const toIsoRequired = (value: unknown): string => toIso(value) ?? ''

// ── Listado ──────────────────────────────────────────────────────────────────

interface UserListRow {
  id: string
  email: string
  name: string | null
  phone: string | null
  role: UserRole
  auth_provider: AuthProvider
  created_at: Date | string
  vehicle_count: number | string
  last_activity_at: Date | string | null
}

/**
 * El listado. Reemplaza el `select * from users where email ilike '%…%'` con el
 * que hoy se busca a alguien antes de poder mirarle nada.
 *
 * Dos decisiones que se ven en el SQL:
 *
 *  1. **`vehicle_count` y `last_activity_at` son subconsultas escalares, no
 *     JOINs.** Un `left join vehicles` más `count(*)` obliga a un `group by`
 *     sobre las nueve columnas de `users`, y en cuanto se agregue la segunda
 *     métrica (las conversaciones) el `count` de la primera se multiplica. Es el
 *     bug clásico del fan-out y no avisa: da un número más grande, no un error.
 *
 *  2. **`last_activity_at` es el `greatest()` de tres señales derivadas.**
 *     `users` no tiene `last_seen_at`. Inventar una columna acá sería inventar
 *     dominio (regla dura 8); derivarla del dato que sí existe, no. Queda `null`
 *     para el que se registró y nunca hizo nada — que es exactamente lo que se
 *     quiere ver.
 */
export async function listUsers(
  search: UserSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<UserListItem>> {
  void opts.signal // `pg` no acepta AbortSignal; queda documentado el hueco.

  const params: Array<unknown> = []
  const where: Array<string> = []

  if (search.q) {
    params.push(`%${search.q}%`)
    where.push(`(u.email ilike $${params.length} or coalesce(u.name, '') ilike $${params.length})`)
  }

  if (search.role !== 'all') {
    params.push(search.role)
    where.push(`u.role = $${params.length}::user_role`)
  }

  /**
   * El filtro de los `native` heredados.
   *
   * NO es un chequeo de "puede entrar al panel": el lookup de sesión ya está
   * acotado a `auth_provider = 'clerk'`, así que un native nunca matchea una
   * identidad de Clerk.
   *
   * Y NO es "posibles admins heredados" — eso se corrigió el 2026-09-04. La
   * herencia automática de rol no puede pasar: `idx_users_email_unique` impide
   * la segunda fila, y los dos caminos de provisioning del backend rechazan en
   * vez de migrar, sin tocar nunca `auth_provider`, `external_auth_id` ni
   * `role`.
   *
   * Lo que esta lista es de verdad: **los emails cuyo registro por Clerk falla
   * en silencio**, porque el email ya está tomado por su propia fila native.
   * Terminan con sesión de Clerk y sin usuario de AutoLibre. → `CLAUDE.md`.
   */
  if (search.onlyLegacyNative) {
    where.push(`u.auth_provider = 'native'`)
  }

  const rows = await sql<UserListRow>(
    `
    select
      u.id,
      u.email,
      u.name,
      u.phone,
      u.role,
      u.auth_provider,
      u.created_at,
      (select count(*) from vehicles v where v.user_id = u.id)::int as vehicle_count,
      greatest(
        (select max(v.created_at) from vehicles v where v.user_id = u.id),
        (select max(c.created_at) from conversations c where c.user_id = u.id),
        (select max(d.created_at) from driving_sessions d where d.user_id = u.id)
      ) as last_activity_at
    from users u
    ${where.length ? `where ${where.join(' and ')}` : ''}
    order by u.created_at desc
    limit 500
    `,
    params,
  )

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    phone: r.phone,
    role: r.role,
    authProvider: r.auth_provider,
    createdAt: toIsoRequired(r.created_at),
    vehicleCount: toInt(r.vehicle_count),
    lastActivityAt: toIso(r.last_activity_at),
  }))
}

// ── Detalle ──────────────────────────────────────────────────────────────────

interface UserRow {
  id: string
  email: string
  name: string | null
  phone: string | null
  role: UserRole
  auth_provider: AuthProvider
  external_auth_id: string
  created_at: Date | string
  updated_at: Date | string
}

type CensusRow = Record<string, number | string>

/**
 * El censo: las 29 relaciones alcanzables desde un usuario, en UNA sentencia.
 *
 * Que sea una sola no es prolijidad — es que las 29 compartan el mismo snapshot
 * de Postgres. Con 29 consultas separadas, una fila insertada en el medio del
 * barrido aparece en un contador y no en el otro, y el operador ve un expediente
 * que nunca existió. Mismo argumento que el `UNION ALL` de las colas en
 * `ops.repo.ts`.
 *
 * Los tres CTEs (`v`, `c`, `s`) existen para las relaciones de segundo nivel:
 * `conversation_messages` no tiene `user_id`, se llega por las conversaciones
 * del usuario. Sin ellos habría que repetir la subconsulta en cada línea.
 *
 * Por qué son 29 y no 42 está explicado en `~/lib/users` — resumen: 15 de las 18
 * tablas que cuelgan de `vehicles` también cuelgan de `users`, y contarlas por
 * los dos caminos las duplicaría.
 */
const CENSUS_SQL = `
with v as (select id from vehicles where user_id = $1),
     c as (select id from conversations where user_id = $1),
     s as (select id from driving_sessions where user_id = $1)
select
  (select count(*) from vehicles where user_id = $1)::int as vehicles,
  (select count(*) from driver_licenses where user_id = $1)::int as driver_licenses,
  (select count(*) from legal_acceptances where user_id = $1)::int as legal_acceptances,
  (select count(*) from user_notification_preferences where user_id = $1)::int as notification_preferences,
  (select count(*) from expo_push_tokens where user_id = $1)::int as push_tokens,
  (select count(*) from files where user_id = $1)::int as files,
  (select count(*) from conversations where user_id = $1)::int as conversations,
  (select count(*) from conversation_messages where conversation_id in (select id from c))::int as conversation_messages,
  (select count(*) from ai_diagnostics where user_id = $1)::int as ai_diagnostics,
  (select count(*) from diagnostic_dtcs where user_id = $1)::int as diagnostic_dtcs,
  (select count(*) from assistant_proposals where user_id = $1)::int as assistant_proposals,
  (select count(*) from driving_sessions where user_id = $1)::int as driving_sessions,
  (select count(*) from driving_session_chunks where session_id in (select id from s))::int as driving_session_chunks,
  (select count(*) from driving_telemetry_analysis where vehicle_id in (select id from v))::int as telemetry_analysis,
  (select count(*) from vehicle_last_dtc_scans where vehicle_id in (select id from v))::int as last_dtc_scans,
  (select count(*) from fines where user_id = $1)::int as fines,
  (select count(*) from vehicle_fine_syncs where vehicle_id in (select id from v))::int as fine_syncs,
  (select count(*) from vehicle_tax_debts where user_id = $1)::int as tax_debts,
  (select count(*) from insurances where user_id = $1)::int as insurances,
  (select count(*) from registration_cards where user_id = $1)::int as registration_cards,
  (select count(*) from vehicle_inspections where user_id = $1)::int as inspections,
  (select count(*) from vehicle_data_queries where user_id = $1)::int as data_queries,
  (select count(*) from maintenance_plans where user_id = $1)::int as maintenance_plans,
  (select count(*) from maintenance_occurrences where user_id = $1)::int as maintenance_occurrences,
  (select count(*) from notifications where user_id = $1)::int as notifications,
  (select count(*) from leads where user_id = $1)::int as leads,
  (select count(*) from partners where user_id = $1)::int as owned_partners,
  (select count(*) from feedback where user_id = $1)::int as feedback,
  (select count(*) from partner_applications where reviewed_by_id = $1)::int as reviewed_applications
`

interface VehicleRow {
  id: string
  plate: string
  alias: string | null
  color: string
  odometer_value: number | string
  archived: boolean
  created_at: Date | string
  registered_at: Date | string | null
  brand: string
  model: string
  year: number | string
  trim: string
  vehicle_type: string
  engine: string | null
  fuel_type: string | null
  transmission: string | null
}

interface LegalRow {
  document: string
  version: string
  accepted_at: Date | string
}

interface LicenseRow {
  id: string
  license_number: string
  category: string | null
  status: string
  expiration_date: Date | string
  archived: boolean
  first_name: string | null
  last_name: string | null
}

interface PushRow {
  id: string
  platform: string | null
  device_id: string | null
  created_at: Date | string
  updated_at: Date | string
}

interface PreferenceRow {
  notification_type: string
  channel: string
}

interface OwnedPartnerRow {
  id: string
  name: string
  status: string
  coverage_zone: string
}

/**
 * El expediente. `null` cuando el uuid no existe — el borde de arriba lo
 * traduce a un 404, no a un error.
 *
 * Las siete consultas van en paralelo con `Promise.all` y no en secuencia: son
 * independientes entre sí y el pool tiene `max: 5`, así que serializarlas sólo
 * suma latencia. Ojo con agregar una octava — a partir de ahí compiten por
 * conexiones con el resto del panel.
 */
export async function findUserDetail(
  userId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<UserDetail | null> {
  void opts.signal

  const user = await sqlOne<UserRow>(
    `select id, email, name, phone, role, auth_provider, external_auth_id, created_at, updated_at
     from users where id = $1`,
    [userId],
  )
  if (!user) return null

  const [census, vehicles, legal, licenses, push, preferences, partners] = await Promise.all([
    sqlOne<CensusRow>(CENSUS_SQL, [userId]),

    /**
     * `join` y no `left join` sobre el catálogo: `vehicle_catalog_spec_id` es
     * NOT NULL con FK, así que un vehículo sin spec no es representable. Un
     * `left join` acá escondería una corrupción de datos detrás de celdas
     * vacías en vez de dejar que se note.
     */
    sql<VehicleRow>(
      `select v.id, v.plate, v.alias, v.color, v.odometer_value, v.archived,
              v.created_at, v.registered_at,
              vc.brand, vc.model, vc.year, vc.trim, vc.vehicle_type::text as vehicle_type,
              vcs.engine, vcs.fuel_type::text as fuel_type, vcs.transmission::text as transmission
       from vehicles v
       join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
       join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
       where v.user_id = $1
       order by v.archived, v.created_at desc`,
      [userId],
    ),

    sql<LegalRow>(
      `select document::text as document, version, accepted_at
       from legal_acceptances where user_id = $1
       order by accepted_at desc`,
      [userId],
    ),

    sql<LicenseRow>(
      `select id, license_number, category, status::text as status, expiration_date,
              archived, first_name, last_name
       from driver_licenses where user_id = $1
       order by archived, expiration_date desc`,
      [userId],
    ),

    sql<PushRow>(
      `select id, platform, device_id, created_at, updated_at
       from expo_push_tokens where user_id = $1
       order by updated_at desc`,
      [userId],
    ),

    sql<PreferenceRow>(
      `select notification_type::text as notification_type, channel::text as channel
       from user_notification_preferences where user_id = $1
       order by notification_type, channel`,
      [userId],
    ),

    sql<OwnedPartnerRow>(
      `select id, name, status::text as status, coverage_zone
       from partners where user_id = $1
       order by name`,
      [userId],
    ),
  ])

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    role: user.role,
    authProvider: user.auth_provider,
    externalAuthId: user.external_auth_id,
    createdAt: toIsoRequired(user.created_at),
    updatedAt: toIsoRequired(user.updated_at),

    census: mapCensus(census),

    vehicles: vehicles.map(
      (r): UserVehicle => ({
        id: r.id,
        plate: r.plate,
        alias: r.alias,
        color: r.color,
        odometerValue: toInt(r.odometer_value),
        archived: r.archived,
        createdAt: toIsoRequired(r.created_at),
        registeredAt: toIso(r.registered_at),
        brand: r.brand,
        model: r.model,
        year: toInt(r.year),
        trim: r.trim,
        vehicleType: r.vehicle_type,
        engine: r.engine,
        fuelType: r.fuel_type,
        transmission: r.transmission,
      }),
    ),

    legalAcceptances: legal.map(
      (r): UserLegalAcceptance => ({
        document: r.document,
        version: r.version,
        acceptedAt: toIsoRequired(r.accepted_at),
      }),
    ),

    driverLicenses: licenses.map(
      (r): UserDriverLicense => ({
        id: r.id,
        licenseNumber: r.license_number,
        category: r.category,
        status: r.status,
        expirationDate: toIsoRequired(r.expiration_date),
        archived: r.archived,
        firstName: r.first_name,
        lastName: r.last_name,
      }),
    ),

    pushTokens: push.map(
      (r): UserPushToken => ({
        id: r.id,
        platform: r.platform,
        deviceId: r.device_id,
        createdAt: toIsoRequired(r.created_at),
        updatedAt: toIsoRequired(r.updated_at),
      }),
    ),

    notificationPreferences: preferences.map(
      (r): UserNotificationPreference => ({
        notificationType: r.notification_type,
        channel: r.channel,
      }),
    ),

    ownedPartners: partners.map(
      (r): UserOwnedPartner => ({
        id: r.id,
        name: r.name,
        status: r.status,
        coverageZone: r.coverage_zone,
      }),
    ),
  }
}

/**
 * `snake_case` de Postgres → `camelCase` del contrato.
 *
 * Se escribe explícito, campo por campo, en vez de con un `Object.entries` que
 * transforme las claves. Un mapeo automático compila igual el día que alguien
 * renombre una columna del SELECT y devuelve `undefined` en silencio — que en
 * un censo se ve como un cero, o sea como "el usuario no tiene nada", que es la
 * mentira más cara que puede decir esta pantalla.
 */
function mapCensus(row: CensusRow | null): UserCensus {
  const n = (key: string) => toInt(row?.[key])
  return {
    vehicles: n('vehicles'),
    driverLicenses: n('driver_licenses'),
    legalAcceptances: n('legal_acceptances'),
    notificationPreferences: n('notification_preferences'),
    pushTokens: n('push_tokens'),
    files: n('files'),
    conversations: n('conversations'),
    conversationMessages: n('conversation_messages'),
    aiDiagnostics: n('ai_diagnostics'),
    diagnosticDtcs: n('diagnostic_dtcs'),
    assistantProposals: n('assistant_proposals'),
    drivingSessions: n('driving_sessions'),
    drivingSessionChunks: n('driving_session_chunks'),
    telemetryAnalysis: n('telemetry_analysis'),
    lastDtcScans: n('last_dtc_scans'),
    fines: n('fines'),
    fineSyncs: n('fine_syncs'),
    taxDebts: n('tax_debts'),
    insurances: n('insurances'),
    registrationCards: n('registration_cards'),
    inspections: n('inspections'),
    dataQueries: n('data_queries'),
    maintenancePlans: n('maintenance_plans'),
    maintenanceOccurrences: n('maintenance_occurrences'),
    notifications: n('notifications'),
    leads: n('leads'),
    ownedPartners: n('owned_partners'),
    feedback: n('feedback'),
    reviewedApplications: n('reviewed_applications'),
  }
}
