import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import type {
  AuthProvider,
  MaintenanceTaskState,
  UserCensus,
  UserDetail,
  UserDriverLicense,
  UserLegalAcceptance,
  UserListItem,
  UserMaintenanceTask,
  UserNotificationPreference,
  UserOwnedPartner,
  UserPushToken,
  UserSearch,
  UserSortKey,
  UserVehicle,
  UserVehicleSummary,
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

/**
 * Como `toInt`, pero preserva `null`. Hace falta donde el cero y el "nunca
 * pasó" son respuestas DISTINTAS — `activeDtcCount` y `activeAnomalyCount`: un
 * auto sin escanear no es lo mismo que un auto escaneado y limpio, y
 * `toInt` los aplastaría a los dos en `0`.
 */
const toIntOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)

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
  scans_ok: number | string
  scans_total: number | string
  last_activity_at: Date | string | null
  driver_license_expires_at: Date | string | null
  driver_license_days_until_expiration: number | string | null
}

/**
 * Mapa cerrado `UserSortKey → expresión SQL`. Es lo que hace seguro
 * interpolar `dir`/columna directo en el `ORDER BY`: los dos valores salen de
 * un enum de zod y de un `Record` que los propios TIPOS obligan a cubrir —
 * nunca de texto suelto del usuario. Un `ORDER BY $1` con parámetro no
 * existe en `pg`; el nombre de columna no es un valor, así que no hay forma
 * de parametrizarlo.
 */
const SORT_COLUMNS: Record<UserSortKey, string> = {
  name: 'name',
  role: 'role',
  vehicles: 'vehicle_count',
  scans: 'scans_total',
  createdAt: 'created_at',
  lastActivity: 'last_activity_at',
  license: 'driver_license_days_until_expiration',
}

/**
 * El listado. Reemplaza el `select * from users where email ilike '%…%'` con el
 * que hoy se busca a alguien antes de poder mirarle nada.
 *
 * Va envuelto en un `select * from (...) s` — no por gusto: `vehicle_count`,
 * `scans_ok`, `last_activity_at` y el registro son subconsultas escalares del
 * SELECT, y filtrar u ordenar por ellas en la MISMA consulta obligaría a
 * repetir cada subconsulta en el `where`/`order by` (Postgres no deja usar un
 * alias del SELECT en su propio nivel). Envolver una vez y referenciar el
 * alias en la consulta de afuera es más simple que duplicar seis
 * subconsultas, y el plan que arma Postgres es el mismo.
 *
 * Tres decisiones que se ven en el SQL interno:
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
 *
 *  3. **`driver_license_days_until_expiration` se calcula acá, no en React.**
 *     Esta pantalla es SSR completo — si el "cuántos días faltan" se calculara
 *     en el componente con `new Date()`, el servidor y el cliente podrían
 *     calcularlo en momentos distintos y, cruzando medianoche UTC en el medio,
 *     devolver números distintos: mismatch de hidratación por construcción.
 *     `expiration_date - current_date` en Postgres se calcula UNA vez, contra
 *     UN reloj, y viaja como dato.
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

  // ── Filtros que sí pueden ir en el nivel interno (son columnas de `users`) ──
  // Los que dependen de una subconsulta del SELECT (vehículos, escaneos,
  // actividad, registro) van en el `where` de AFUERA, sobre el alias.

  const outerWhere: Array<string> = []

  if (search.hasVehicles !== 'all') {
    outerWhere.push(search.hasVehicles === 'yes' ? 'vehicle_count > 0' : 'vehicle_count = 0')
  }

  if (search.onlyScanFailures) {
    outerWhere.push('scans_total > 0 and scans_ok = 0')
  }

  if (search.onlyNeverActive) {
    outerWhere.push('last_activity_at is null')
  }

  if (search.license === 'valid') {
    outerWhere.push('driver_license_days_until_expiration is not null and driver_license_days_until_expiration >= 0')
  } else if (search.license === 'expired') {
    outerWhere.push('driver_license_days_until_expiration is not null and driver_license_days_until_expiration < 0')
  } else if (search.license === 'missing') {
    outerWhere.push('driver_license_expires_at is null')
  }

  const sortColumn = SORT_COLUMNS[search.sort]

  const rows = await sql<UserListRow>(
    `
    select * from (
      select
        u.id,
        u.email,
        u.name,
        u.phone,
        u.role,
        u.auth_provider,
        u.created_at,
        (select count(*) from vehicles v where v.user_id = u.id)::int as vehicle_count,
        -- Escaneos que sirvieron, sobre intentos.
        --
        -- El predicado de "sirvio" es el MISMO que el de scanners.repo.ts:
        -- completed Y con al menos una lectura. Una sesion completed con cero
        -- lecturas es un pareo que fallo, no un escaneo — 6 de las 17 de la base
        -- al 2026-09-04. Contar solo el total presentaria esos fracasos como uso.
        --
        -- Si este predicado y el de /escaneres divergen, el panel dice dos
        -- verdades distintas sobre la misma palabra y nada lo delata.
        (select count(*) filter (
                  where d.status::text = 'completed'
                    and coalesce(d.total_readings, 0) > 0)::int
           from driving_sessions d where d.user_id = u.id) as scans_ok,
        (select count(*)::int
           from driving_sessions d where d.user_id = u.id) as scans_total,
        greatest(
          (select max(v.created_at) from vehicles v where v.user_id = u.id),
          (select max(c.created_at) from conversations c where c.user_id = u.id),
          (select max(d.created_at) from driving_sessions d where d.user_id = u.id)
        ) as last_activity_at,
        -- El registro: la fila NO archivada más reciente y, si no hay
        -- ninguna, la archivada más reciente — mismo criterio que
        -- insurances/registration_cards en findUserDetail.
        (select l.expiration_date from driver_licenses l where l.user_id = u.id
           order by l.archived asc, l.created_at desc limit 1) as driver_license_expires_at,
        (select (l.expiration_date - current_date) from driver_licenses l where l.user_id = u.id
           order by l.archived asc, l.created_at desc limit 1) as driver_license_days_until_expiration
      from users u
      ${where.length ? `where ${where.join(' and ')}` : ''}
    ) s
    ${outerWhere.length ? `where ${outerWhere.join(' and ')}` : ''}
    order by ${sortColumn} ${search.dir} nulls last, id
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
    scansOk: toInt(r.scans_ok),
    scansTotal: toInt(r.scans_total),
    lastActivityAt: toIso(r.last_activity_at),
    driverLicenseExpiresAt: toIso(r.driver_license_expires_at),
    driverLicenseDaysUntilExpiration: toIntOrNull(r.driver_license_days_until_expiration),
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
  vtv_query_status: string | null
  vtv_query_completed_at: Date | string | null
  vtv_query_created_at: Date | string | null
  fines_synced_at: Date | string | null
  fines_count: number | string
  insurance_status: string | null
  insurance_expires_at: Date | string | null
  registration_card_loaded_at: Date | string | null
}

interface TaskRow {
  id: string
  vehicle_plate: string
  name: string
  item_type: string
  due_date: Date | string | null
  performed_at: Date | string | null
  archived: boolean
  created_at: Date | string
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
 * Las ocho consultas van en paralelo con `Promise.all` y no en secuencia: son
 * independientes entre sí y el pool tiene `max: 5`, así que serializarlas sólo
 * suma latencia. Ojo con agregar una novena — a partir de ahí compiten por
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

  const [census, vehicles, legal, licenses, push, preferences, partners, tasks] = await Promise.all([
    sqlOne<CensusRow>(CENSUS_SQL, [userId]),

    /**
     * `join` y no `left join` sobre el catálogo: `vehicle_catalog_spec_id` es
     * NOT NULL con FK, así que un vehículo sin spec no es representable. Un
     * `left join` acá escondería una corrupción de datos detrás de celdas
     * vacías en vez de dejar que se note.
     *
     * Las columnas de trámites son subconsultas escalares, mismo criterio que
     * el resto del archivo: un `left join` a `insurances`/`registration_cards`
     * puede traer más de una fila por vehículo y multiplica el resultado sin
     * avisar.
     *
     * VTV y multas son la CONSULTA, no el documento — por eso no salen de
     * `vehicle_inspections` (eso ya está en el censo, es el disco cargado).
     * `vehicle_fine_syncs` tiene una fila por vehículo y sólo existe si se
     * sincronizó, así que su presencia sola alcanza. `vehicle_data_queries`
     * puede tener varios intentos; se toma el más reciente por `created_at`
     * para que `vtv_query_status` sea el ÚLTIMO estado y no cualquiera.
     */
    sql<VehicleRow>(
      `select v.id, v.plate, v.alias, v.color, v.odometer_value, v.archived,
              v.created_at, v.registered_at,
              vc.brand, vc.model, vc.year, vc.trim, vc.vehicle_type::text as vehicle_type,
              vcs.engine, vcs.fuel_type::text as fuel_type, vcs.transmission::text as transmission,
              (select q.status::text from vehicle_data_queries q
                where q.vehicle_id = v.id and 'vtv' = any(q.requested_modules)
                order by q.created_at desc limit 1) as vtv_query_status,
              (select q.completed_at from vehicle_data_queries q
                where q.vehicle_id = v.id and 'vtv' = any(q.requested_modules)
                order by q.created_at desc limit 1) as vtv_query_completed_at,
              (select q.created_at from vehicle_data_queries q
                where q.vehicle_id = v.id and 'vtv' = any(q.requested_modules)
                order by q.created_at desc limit 1) as vtv_query_created_at,
              (select fs.last_synced_at from vehicle_fine_syncs fs
                where fs.vehicle_id = v.id) as fines_synced_at,
              (select count(*)::int from fines f where f.vehicle_id = v.id) as fines_count,
              (select i.status::text from insurances i where i.vehicle_id = v.id
                order by i.archived asc, i.created_at desc limit 1) as insurance_status,
              (select i.expiration_date from insurances i where i.vehicle_id = v.id
                order by i.archived asc, i.created_at desc limit 1) as insurance_expires_at,
              (select r.created_at from registration_cards r where r.vehicle_id = v.id
                order by r.archived asc, r.created_at desc limit 1) as registration_card_loaded_at
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

    /**
     * Las tareas — `maintenance_occurrences` de todos sus vehículos. Se filtra
     * por `o.user_id` y no por `v.user_id in (…)`: son la misma columna en la
     * práctica (una occurrence siempre es del dueño del vehículo), pero filtrar
     * por la FK directa evita un `IN` sobre la lista de vehículos que ya se
     * pidió aparte.
     *
     * El `join` a `vehicles` es sólo para la patente que se muestra en la
     * lista — no decide nada y no puede fan-outear: `vehicle_id` es NOT NULL
     * con FK a una fila única.
     */
    sql<TaskRow>(
      `select o.id, v.plate as vehicle_plate, o.name, o.item_type::text as item_type,
              o.due_date, o.performed_at, o.archived, o.created_at
       from maintenance_occurrences o
       join vehicles v on v.id = o.vehicle_id
       where o.user_id = $1
       order by coalesce(o.performed_at, o.due_date, o.created_at) desc`,
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
        vtvQueryStatus: r.vtv_query_status,
        vtvQueryCompletedAt: toIso(r.vtv_query_completed_at),
        vtvQueryCreatedAt: toIso(r.vtv_query_created_at),
        finesSyncedAt: toIso(r.fines_synced_at),
        finesCount: toInt(r.fines_count),
        insuranceStatus: r.insurance_status,
        insuranceExpiresAt: toIso(r.insurance_expires_at),
        registrationCardLoadedAt: toIso(r.registration_card_loaded_at),
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

    tasks: tasks.map(
      (r): UserMaintenanceTask => ({
        id: r.id,
        vehiclePlate: r.vehicle_plate,
        name: r.name,
        itemType: r.item_type,
        dueDate: toIso(r.due_date),
        performedAt: toIso(r.performed_at),
        archived: r.archived,
        createdAt: toIsoRequired(r.created_at),
        state: deriveTaskState(r),
      }),
    ),
  }
}

/**
 * `done` es lo único que afirma el dominio (`performed_at` cargado). El resto
 * es una lectura nuestra del reloj contra `due_date` y se escribe como tal —
 * misma familia que `stuck` en `ops.repo.ts` y `noData` en `scanners.repo.ts`:
 * ninguna de las tres la escribe el backend, las tres son la señal que nadie
 * ve si no se calcula.
 *
 * `new Date()` y no `Date.now()` comparado con un string: `due_date` llega acá
 * ya convertido a `Date` por `pg`. Comparar contra "hoy" y no contra el
 * `now()` de Postgres es aceptable porque el umbral es de DÍAS, no de
 * minutos — a diferencia de `stuck`, un desfasaje de reloj de unos segundos
 * nunca mueve una tarea de bucket.
 */
function deriveTaskState(row: TaskRow): MaintenanceTaskState {
  if (row.performed_at) return 'done'
  if (!row.due_date) return 'undated'
  const due = row.due_date instanceof Date ? row.due_date : new Date(row.due_date)
  return due.getTime() < Date.now() ? 'overdue' : 'pending'
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

// ── Resumen por vehículo, para el toggle del listado ────────────────────────

interface VehicleSummaryRow {
  id: string
  plate: string
  alias: string | null
  archived: boolean
  brand: string
  model: string
  year: number | string
  vtv_expires_at: Date | string | null
  diagnostic_chat_count: number | string
  tax_debt_query_status: string | null
  tax_debt_query_at: Date | string | null
  insurance_expires_at: Date | string | null
  scans_ok: number | string
  scans_total: number | string
  active_dtc_count: number | string | null
  last_dtc_scan_at: Date | string | null
  past_tasks_count: number | string
  pending_tasks_count: number | string
  active_anomaly_count: number | string | null
  last_telemetry_analysis_at: Date | string | null
}

/**
 * El "qué está haciendo" por auto, para el toggle de cada fila en `/usuarios`.
 *
 * A propósito NO vive en `findUserDetail`: es una consulta cara (dos LEFT JOIN
 * más ocho subconsultas por vehículo) que sólo tiene sentido pedir cuando un
 * operador abre esa fila puntual — no en el `loader` del listado, que puede
 * traer 500 usuarios, ni en la ficha, que ya tiene su propia noción de
 * "vehículo" (`UserVehicle`, trámites) y no necesita ésta también.
 *
 * `lds` y la subconsulta de `dta` son LEFT JOIN y no subconsultas escalares
 * —única excepción al estilo del resto del archivo—, y es a propósito: los
 * dos son 1:1 garantizados (`vehicle_last_dtc_scans` tiene PK `vehicle_id`; la
 * subconsulta de `dta` elige un único `id`), así que no hay riesgo de
 * fan-out, y unirlos evita repetir la misma subconsulta dos veces para sacar
 * "el estado" y "cuándo" del mismo evento.
 */
export async function listUserVehicleSummaries(
  userId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<UserVehicleSummary>> {
  void opts.signal

  const rows = await sql<VehicleSummaryRow>(
    `select
       v.id, v.plate, v.alias, v.archived,
       vc.brand, vc.model, vc.year,

       -- VTV: el documento (vehicle_inspections), no la consulta al proveedor.
       (select vi.expiration_date from vehicle_inspections vi where vi.vehicle_id = v.id
          order by vi.archived asc, vi.created_at desc limit 1) as vtv_expires_at,

       -- Chats de IA de diagnóstico: conversations cuelga del vehículo directo.
       (select count(*)::int from conversations c where c.vehicle_id = v.id) as diagnostic_chat_count,

       -- Deuda de patente: la consulta (vehicle_data_queries, módulo tax_debt),
       -- la más reciente sin filtrar por estado — mismo criterio que VTV en
       -- findUserDetail.
       (select q.status::text from vehicle_data_queries q
          where q.vehicle_id = v.id and 'tax_debt' = any(q.requested_modules)
          order by q.created_at desc limit 1) as tax_debt_query_status,
       (select coalesce(q.completed_at, q.created_at) from vehicle_data_queries q
          where q.vehicle_id = v.id and 'tax_debt' = any(q.requested_modules)
          order by q.created_at desc limit 1) as tax_debt_query_at,

       -- Seguro: el documento, no la consulta.
       (select i.expiration_date from insurances i where i.vehicle_id = v.id
          order by i.archived asc, i.created_at desc limit 1) as insurance_expires_at,

       -- Escaneos: mismo predicado "sirvió" que en TODO el resto del repo —
       -- completed y con al menos una lectura.
       (select count(*) filter (
                 where d.status::text = 'completed' and coalesce(d.total_readings, 0) > 0)::int
          from driving_sessions d where d.vehicle_id = v.id) as scans_ok,
       (select count(*)::int from driving_sessions d where d.vehicle_id = v.id) as scans_total,

       -- DTCs "activos": los del ÚLTIMO escaneo. Se chequea lds.vehicle_id
       -- (y no session_id) porque es la columna de la FK del join: es la
       -- que dice de forma inequívoca "no hubo fila", nunca un dato del
       -- dominio que casualmente sea null.
       case when lds.vehicle_id is null then null
            else (select count(*)::int from diagnostic_dtcs dd where dd.session_id = lds.session_id)
       end as active_dtc_count,
       lds.scanned_at as last_dtc_scan_at,

       -- Tareas: hechas vs. sin hacer, de este auto.
       (select count(*)::int from maintenance_occurrences o
          where o.vehicle_id = v.id and o.performed_at is not null) as past_tasks_count,
       (select count(*)::int from maintenance_occurrences o
          where o.vehicle_id = v.id and o.performed_at is null) as pending_tasks_count,

       -- Anomalías "activas": el tamaño del array del análisis de telemetría
       -- MÁS RECIENTE. jsonb_array_length(null) da null en Postgres, así que
       -- "nunca se analizó" sale gratis del LEFT JOIN sin un CASE aparte.
       jsonb_array_length(dta.anomalies) as active_anomaly_count,
       dta.created_at as last_telemetry_analysis_at

     from vehicles v
     join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
     join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
     left join vehicle_last_dtc_scans lds on lds.vehicle_id = v.id
     left join driving_telemetry_analysis dta on dta.id = (
       select a.id from driving_telemetry_analysis a
        where a.vehicle_id = v.id order by a.created_at desc limit 1
     )
     where v.user_id = $1
     order by v.archived, v.created_at desc`,
    [userId],
  )

  return rows.map(
    (r): UserVehicleSummary => ({
      id: r.id,
      plate: r.plate,
      alias: r.alias,
      archived: r.archived,
      brand: r.brand,
      model: r.model,
      year: toInt(r.year),
      vtvExpiresAt: toIso(r.vtv_expires_at),
      diagnosticChatCount: toInt(r.diagnostic_chat_count),
      taxDebtQueryStatus: r.tax_debt_query_status,
      taxDebtQueryAt: toIso(r.tax_debt_query_at),
      insuranceExpiresAt: toIso(r.insurance_expires_at),
      scansOk: toInt(r.scans_ok),
      scansTotal: toInt(r.scans_total),
      activeDtcCount: toIntOrNull(r.active_dtc_count),
      lastDtcScanAt: toIso(r.last_dtc_scan_at),
      pastTasksCount: toInt(r.past_tasks_count),
      pendingTasksCount: toInt(r.pending_tasks_count),
      activeAnomalyCount: toIntOrNull(r.active_anomaly_count),
      lastTelemetryAnalysisAt: toIso(r.last_telemetry_analysis_at),
    }),
  )
}
