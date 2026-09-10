import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { NOTIFICATION_DELAYED_AFTER_MIN } from '~/lib/notifications'
import { ADOPTION_FEATURES, OPS_WINDOW_HOURS, QUEUE_LABELS } from '~/lib/ops'
import type {
  AdoptionFeatureRow,
  AdoptionPulse,
  CatalogGap,
  ExcludedDomain,
  FailureReason,
  GrowthPoint,
  GrowthSeries,
  GrowthUnit,
  LeadFunnel,
  MarketplaceHealth,
  OpsWindow,
  QueueHealth,
  QueueKey,
  UsageAdoption,
  VehicleDistBucket,
  VehicleDistribution,
  VehicleDistSearch,
  VehicleDistSortKey,
} from '~/lib/ops'

/**
 * Operación — las consultas que reemplazan al DBeaver.
 *
 * ── De qué lado está el dueño de cada SQL ────────────────────────────────────
 *
 * `partners.repo.ts` invoca SQL del BACKEND (`approve_partner_application`,
 * `v_partner_application_queue`). `ai-usage.repo.ts` invoca SQL NUESTRO, que
 * vive en `migrations/`. Este archivo es el tercer caso y hay que decirlo:
 * **arma agregaciones a mano sobre tablas de `public`.**
 *
 * Por qué no son funciones en `ops`: una función en `ops` que lee `public` es
 * una dependencia de schema cruzada escrita en la base, invisible para las
 * migraciones de Drizzle del backend. El día que el backend renombre una
 * columna, la migración pasa y la función de `ops` se rompe en runtime, sin
 * que ningún build avise. Acá el mismo rename rompe `pnpm typecheck`… no —
 * rompe en runtime igual, pero al menos el SQL está en el repo, versionado, y
 * `rg` lo encuentra. Es el mal menor consciente, no un descuido.
 *
 * Corolario: **ninguna de estas consultas decide nada.** Cuentan, agrupan y
 * ordenan. Cualquier cosa que decida (aprobar, pausar, reintentar) es un caso
 * de uso del backend, no un SELECT de acá.
 */

// ── Conversión ───────────────────────────────────────────────────────────────

/**
 * `pg` devuelve `bigint` y `numeric` como STRING. Todas las consultas de este
 * archivo castean a `::int` en SQL, así que esto es la segunda red — pero se
 * mantiene, porque `percentile_cont` devuelve `double precision` y las columnas
 * calculadas se agregan sin que nadie revise el cast.
 *
 * Ver el comentario largo en `ai-usage.repo.ts`: `"14" + "3" === "143"`.
 */
const toInt = (value: unknown): number => Number(value ?? 0)

/** Preserva el null: "no sabemos" no es "cero". */
const toNum = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)

const toIso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value === null ? null : String(value)

/**
 * La ventana se resuelve UNA vez en JavaScript, no con `now() - interval` por
 * consulta.
 *
 * Es la misma razón que en `ai-usage.repo.ts`: si cada consulta calcula su
 * propio `now()`, dos tarjetas de la misma pantalla toman cortes separados por
 * milisegundos y un evento en el borde entra en una y no en la otra. Los
 * números dejan de cuadrar por un motivo que no se ve leyendo el SQL.
 */
export function windowStart(window: OpsWindow): Date | null {
  const hours = OPS_WINDOW_HOURS[window]
  if (hours === null) return null
  return new Date(Date.now() - hours * 60 * 60 * 1000)
}

/**
 * El predicado de "cuenta interna", en un solo lugar.
 *
 * Está copiado de `ops.v_ai_usage` a propósito y tiene que seguir igual: la
 * vista compara `split_part(lower(email), '@', 2)` contra la tabla de dominios.
 * Si acá se usara `email LIKE '%@'||domain`, un email `foo@sub.autolibre.app`
 * contaría como interno en esta pantalla y como externo en Costos de IA — dos
 * respuestas distintas a la misma pregunta, y ningún error para encontrarlo.
 *
 * Se exporta (server-only → server-only) para que `business.repo.ts` cuente
 * "usuarios reales" con el MISMO predicado en `/negocio`. Una tercera copia
 * sería exactamente el bug que este comentario describe. Asume el alias `u`
 * para `users` — el llamador tiene que respetarlo.
 */
export const INTERNAL_PREDICATE = `coalesce(
  split_part(lower(u.email), '@', 2) IN (SELECT d.domain FROM ops.excluded_email_domains d),
  false
)`

// ── Adopción ─────────────────────────────────────────────────────────────────

interface AdoptionRow {
  users_total: number
  users_internal: number
  users_last_7d: number
  users_last_30d: number
  admins: number
  legacy_native_admins: number
  vehicles_active: number
  vehicles_unique: number
  vehicles_archived: number
  vehicles_last_30d: number
}

/**
 * Reemplaza: el `select count(*) from users` suelto, más el censo por
 * `(role, auth_provider)` que el CLAUDE.md dejó anotado a mano en una tabla.
 *
 * `legacy_native_admins` está separado del resto porque es el riesgo abierto del
 * repo: cuentas `admin` + `native`, herencia de la era pre-Clerk. Hoy no pueden
 * entrar — el lookup de sesión exige `auth_provider = 'clerk'`.
 *
 * Este comentario decía que el número había que vigilarlo "para que el día que
 * alguien migre una cuenta native a Clerk se note". **Corregido el 2026-09-04:
 * esa migración no puede pasar sola.** `idx_users_email_unique` impide la
 * segunda fila y los dos caminos de provisioning del backend rechazan en vez de
 * migrar. El número sigue valiendo, pero por otro motivo: cada fila native es
 * una persona **cuyo registro por Clerk falla en silencio**, porque su email ya
 * está tomado. → `CLAUDE.md`, sección del riesgo.
 */
export async function adoptionPulse(
  opts: { signal?: AbortSignal } = {},
): Promise<AdoptionPulse> {
  void opts.signal // `pg` no acepta AbortSignal; queda documentado el hueco.

  const row = await sqlOne<AdoptionRow>(`
    WITH flagged AS (
      SELECT u.role, u.auth_provider, u.created_at, ${INTERNAL_PREDICATE} AS internal
      FROM users u
    )
    SELECT
      count(*) FILTER (WHERE NOT internal)::int AS users_total,
      count(*) FILTER (WHERE internal)::int     AS users_internal,
      count(*) FILTER (WHERE NOT internal AND created_at >= now() - interval '7 days')::int  AS users_last_7d,
      count(*) FILTER (WHERE NOT internal AND created_at >= now() - interval '30 days')::int AS users_last_30d,
      count(*) FILTER (WHERE NOT internal AND role = 'admin')::int AS admins,
      count(*) FILTER (WHERE role = 'admin' AND auth_provider = 'native')::int AS legacy_native_admins,
      (SELECT count(*) FROM vehicles WHERE NOT archived)::int AS vehicles_active,
      -- Deduplicado por patente: mas de un usuario puede cargar el mismo auto.
      -- upper(btrim(...)) normaliza aunque hoy las patentes ya vienen limpias
      -- (0 en minuscula, 0 en blanco al 2026-09-06); nullif(...,'') deja una
      -- patente vacia fuera del distinct si algun dia aparece.
      (SELECT count(DISTINCT nullif(btrim(upper(plate)), ''))
         FROM vehicles WHERE NOT archived)::int AS vehicles_unique,
      (SELECT count(*) FROM vehicles WHERE archived)::int      AS vehicles_archived,
      (SELECT count(*) FROM vehicles WHERE created_at >= now() - interval '30 days')::int AS vehicles_last_30d
    FROM flagged
  `)

  const usersTotal = toInt(row?.users_total)
  const vehiclesActive = toInt(row?.vehicles_active)

  return {
    usersTotal,
    usersInternal: toInt(row?.users_internal),
    usersLast7d: toInt(row?.users_last_7d),
    usersLast30d: toInt(row?.users_last_30d),
    admins: toInt(row?.admins),
    legacyNativeAdmins: toInt(row?.legacy_native_admins),
    vehiclesActive,
    vehiclesUnique: toInt(row?.vehicles_unique),
    vehiclesArchived: toInt(row?.vehicles_archived),
    vehiclesLast30d: toInt(row?.vehicles_last_30d),
    // Sin usuarios reales la razón es indefinida, no cero. Cero se leería como
    // "tienen cuenta y no cargaron el auto", que es una afirmación distinta.
    vehiclesPerUser: usersTotal === 0 ? null : vehiclesActive / usersTotal,
  }
}

// ── Serie de adopción (pantalla /metricas) ──────────────────────────────────

/**
 * `GrowthUnit → unidad de Postgres`. Viaja como PARÁMETRO en la consulta, nunca
 * interpolado: `date_trunc()` acepta text como primer argumento, así que no hace
 * falta meterlo en el string.
 */
const PG_UNIT: Record<GrowthUnit, string> = {
  dia: 'day',
  semana: 'week',
  mes: 'month',
  anio: 'year',
}

interface SeriesRow {
  bucket: string
  added: number | string
  total: number | string
}

/**
 * Una serie de altas por período. `tsColumn` y `fromWhere` son literales del
 * código (`'u.created_at'` / `'v.created_at'`, y el FROM con su WHERE), nunca
 * entrada de usuario — la única variable que viene de afuera es `unit`, y va
 * parametrizada.
 *
 * `generate_series` entre el primer y el último bucket rellena los períodos
 * vacíos con 0. Sin eso, una semana sin altas DESAPARECE del eje y la curva
 * miente por omisión — un hueco se lee como "no hay dato", no como "no entró
 * nadie". (`ai_usage_daily` no rellena y su chart lo tolera porque es consumo,
 * no crecimiento acumulado; acá no se tolera.)
 *
 * En UTC (`at time zone 'UTC'`) por el mismo motivo que `ai_usage_daily`: los
 * formatters del panel pinean UTC, y agrupar en otra zona haría que el último
 * bucket no cierre con el total.
 */
async function growthSeries(
  tsColumn: string,
  fromWhere: string,
  unit: GrowthUnit,
): Promise<Array<GrowthPoint>> {
  const rows = await sql<SeriesRow>(
    `
    with counts as (
      select date_trunc($1, ${tsColumn} at time zone 'UTC') as bucket, count(*)::int as added
      ${fromWhere}
      group by 1
    ),
    span as (select min(bucket) as lo, max(bucket) as hi from counts),
    buckets as (
      select generate_series(span.lo, span.hi, ('1 ' || $1)::interval) as bucket from span
    )
    select
      to_char(b.bucket, 'YYYY-MM-DD') as bucket,
      coalesce(c.added, 0) as added,
      (sum(coalesce(c.added, 0)) over (order by b.bucket))::int as total
    from buckets b
    left join counts c using (bucket)
    order by b.bucket
    `,
    [PG_UNIT[unit]],
  )

  return rows.map((r) => ({ bucket: r.bucket, added: toInt(r.added), total: toInt(r.total) }))
}

/**
 * Las dos series que pide `/metricas`: altas de `users` y de `vehicles` por
 * período.
 *
 * Vive acá y no en un repo nuevo porque es la misma data de adopción que
 * `adoptionPulse`, sobre las mismas tablas de `public`, y usa
 * `INTERNAL_PREDICATE` — que es privado de este archivo a propósito
 * (`ops-metrics.md`: el predicado de "cuenta interna" no se duplica).
 *
 * ── Dos diferencias con `adoptionPulse`, las dos deliberadas ─────────────────
 *
 *  1. VEHÍCULOS también se filtran por cuenta interna. `adoptionPulse` cuenta
 *     los vehículos crudos; acá el gráfico es "crecimiento real", así que un
 *     auto cuyo dueño es una cuenta de test no cuenta. Se join a `users` por
 *     `user_id` y se aplica el mismo predicado.
 *  2. Se cuenta por `created_at` sin mirar `archived`. Un vehículo que después
 *     se archivó fue un registro real en su momento; la curva de crecimiento no
 *     lo borra hacia atrás. Consecuencia: el último `total` de la serie de
 *     vehículos = activos + archivados, NO el "Vehículos activos" de Inicio.
 */
export async function adoptionSeries(
  unit: GrowthUnit,
  opts: { signal?: AbortSignal } = {},
): Promise<GrowthSeries> {
  void opts.signal

  const [users, vehicles] = await Promise.all([
    growthSeries('u.created_at', `from users u where not ${INTERNAL_PREDICATE}`, unit),
    growthSeries(
      'v.created_at',
      `from vehicles v join users u on u.id = v.user_id where not ${INTERNAL_PREDICATE}`,
      unit,
    ),
  ])

  return { unit, users, vehicles }
}

// ── Distribución de vehículos por usuario ───────────────────────────────────

/**
 * `sortKey → cómo se ordena`. `pctUsers` y `pctFleet` ordenan por su columna
 * base (`users` / `segmentVehicles`): el % es una reescala monotónica, así que
 * el orden es idéntico y no hace falta comparar floats. La clave sale de un
 * enum de zod, nunca es texto suelto.
 */
const DIST_SORT_VALUE: Record<VehicleDistSortKey, (b: VehicleDistBucket) => number> = {
  vehicles: (b) => b.vehicles,
  users: (b) => b.users,
  pctUsers: (b) => b.users,
  segmentVehicles: (b) => b.segmentVehicles,
  pctFleet: (b) => b.segmentVehicles,
}

/**
 * Reemplaza: el `select vc, count(*) from (select count(v.*) ... group by u.id)
 * group by vc` que contesta "cuántos usuarios tienen 1 auto, cuántos 2, …" y que
 * hoy nadie corre.
 *
 * ── Decisiones ──────────────────────────────────────────────────────────────
 *
 *  - Excluye cuentas internas con `INTERNAL_PREDICATE`, igual que
 *    `adoptionSeries`: la tabla es sobre adopción real.
 *  - `fleetScope` elige si un auto archivado cuenta. El fragmento
 *    (`and not v.archived`) es un literal de un conjunto cerrado, nunca entrada
 *    de usuario — mismo criterio que los umbrales de `fines.repo.ts`.
 *  - Los buckets vacíos NO se rellenan (al revés que `growthSeries`): "ningún
 *    usuario tiene exactamente 3 autos" no miente en una tabla como sí lo haría
 *    un hueco en una curva. Se muestran sólo las cantidades que existen.
 *  - El orden se resuelve en JS: son un puñado de filas y dos claves ordenan por
 *    una columna derivada que no está en el SELECT.
 */
export async function vehicleDistribution(
  search: VehicleDistSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<VehicleDistribution> {
  void opts.signal // `pg` no acepta AbortSignal; queda documentado el hueco.

  const archivedClause = search.fleetScope === 'active' ? 'and not v.archived' : ''

  const rows = await sql<{ vehicles: number | string; users: number | string }>(`
    WITH flagged AS (
      SELECT u.id, ${INTERNAL_PREDICATE} AS internal
      FROM users u
    ),
    per_user AS (
      SELECT (
        SELECT count(*) FROM vehicles v
        WHERE v.user_id = flagged.id ${archivedClause}
      )::int AS vc
      FROM flagged
      WHERE NOT internal
    )
    SELECT vc AS vehicles, count(*)::int AS users
    FROM per_user
    GROUP BY vc
  `)

  const raw = rows.map((r) => ({ vehicles: toInt(r.vehicles), users: toInt(r.users) }))
  const totalUsers = raw.reduce((sum, r) => sum + r.users, 0)
  const totalFleet = raw.reduce((sum, r) => sum + r.vehicles * r.users, 0)

  const buckets: Array<VehicleDistBucket> = raw.map((r) => {
    const segmentVehicles = r.vehicles * r.users
    return {
      vehicles: r.vehicles,
      users: r.users,
      pctUsers: totalUsers === 0 ? 0 : (r.users / totalUsers) * 100,
      segmentVehicles,
      pctFleet: totalFleet === 0 ? 0 : (segmentVehicles / totalFleet) * 100,
    }
  })

  const pick = DIST_SORT_VALUE[search.sort]
  const factor = search.dir === 'asc' ? 1 : -1
  buckets.sort((a, b) => {
    const primary = (pick(a) - pick(b)) * factor
    return primary !== 0 ? primary : a.vehicles - b.vehicles
  })

  return { scope: search.fleetScope, totalUsers, totalFleet, buckets }
}

// ── Adopción por función ────────────────────────────────────────────────────

interface UsageRow {
  total: number
  vehicle: number
  push: number
  fine_sync: number
  chat: number
  insurance: number
  vtv: number
  reg_card: number
  scan: number
  maintenance_done: number
  notified: number
  license: number
  maintenance_plan: number
}

/**
 * Reemplaza: nada, y ése es el punto. Para saber "qué % de los usuarios cargó su
 * seguro / consultó multas / usó el chat" hoy habría que correr una docena de
 * `select count(distinct user_id)` sueltos y dividir a mano. Nadie lo hace.
 *
 * ── Por qué UNA sola sentencia ──────────────────────────────────────────────
 *
 * Las doce subconsultas comparten el snapshot de Postgres, igual que el censo de
 * `users.repo.ts` y el `UNION ALL` de `queueHealth`. Con doce consultas
 * separadas, una fila insertada en el medio del barrido entra en un contador y
 * no en otro, y los % dejan de ser comparables entre sí.
 *
 * ── Los predicados, y por qué éstos ─────────────────────────────────────────
 *
 *  - "Usuario real" = `INTERNAL_PREDICATE` negado. El MISMO que `adoptionPulse`
 *    y `ops.v_ai_usage`. Si divergen, el denominador de esta tabla y el número
 *    de "Usuarios reales" de Inicio dejan de coincidir.
 *  - `chat`: conversación CON al menos un mensaje. Una conversación vacía no es
 *    uso (48 de 70 en prod no tienen ningún mensaje — ver `chats.md`).
 *  - `vtv`: sólo `file_id IS NOT NULL`. Las filas `source = 'provider'` son un
 *    lookup a una API por patente, no algo que el usuario cargó — mismo criterio
 *    que `documents.md`.
 *  - `maintenance_done`: ocurrencia con `performed_at` — una tarea REGISTRADA
 *    como hecha, no una pendiente autogenerada por el plan.
 *  - `notified`: `delivery_status = 'sent'` — le llegó de verdad, no que se haya
 *    encolado.
 *  - `fine_sync` y `scan` se alcanzan por el vehículo (`vehicle_fine_syncs` /
 *    `driving_sessions`), así que se joinea `vehicles` → `user_id`.
 *
 * ── Sin ventana temporal ────────────────────────────────────────────────────
 *
 * La pregunta es acumulativa ("¿alguna vez usó X?"), igual que la matriz de
 * `/escaneres`. Una ventana de 30 días vaciaría la tabla y se leería como "nadie
 * usa nada".
 */
export async function usageAdoption(
  opts: { signal?: AbortSignal } = {},
): Promise<UsageAdoption> {
  void opts.signal // `pg` no acepta AbortSignal; queda documentado el hueco.

  const row = await sqlOne<UsageRow>(`
    WITH real_users AS (
      SELECT u.id FROM users u WHERE NOT ${INTERNAL_PREDICATE}
    )
    SELECT
      (SELECT count(*) FROM real_users)::int AS total,
      (SELECT count(DISTINCT v.user_id)
         FROM vehicles v JOIN real_users r ON r.id = v.user_id)::int AS vehicle,
      (SELECT count(DISTINCT t.user_id)
         FROM expo_push_tokens t JOIN real_users r ON r.id = t.user_id)::int AS push,
      (SELECT count(DISTINCT v.user_id)
         FROM vehicle_fine_syncs vfs
         JOIN vehicles v ON v.id = vfs.vehicle_id
         JOIN real_users r ON r.id = v.user_id)::int AS fine_sync,
      (SELECT count(DISTINCT c.user_id)
         FROM conversations c JOIN real_users r ON r.id = c.user_id
         WHERE EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id))::int AS chat,
      (SELECT count(DISTINCT i.user_id)
         FROM insurances i JOIN real_users r ON r.id = i.user_id)::int AS insurance,
      (SELECT count(DISTINCT vi.user_id)
         FROM vehicle_inspections vi JOIN real_users r ON r.id = vi.user_id
         WHERE vi.file_id IS NOT NULL)::int AS vtv,
      (SELECT count(DISTINCT rc.user_id)
         FROM registration_cards rc JOIN real_users r ON r.id = rc.user_id)::int AS reg_card,
      (SELECT count(DISTINCT ds.user_id)
         FROM driving_sessions ds JOIN real_users r ON r.id = ds.user_id)::int AS scan,
      (SELECT count(DISTINCT mo.user_id)
         FROM maintenance_occurrences mo JOIN real_users r ON r.id = mo.user_id
         WHERE mo.performed_at IS NOT NULL)::int AS maintenance_done,
      (SELECT count(DISTINCT n.user_id)
         FROM notifications n JOIN real_users r ON r.id = n.user_id
         WHERE n.delivery_status = 'sent')::int AS notified,
      (SELECT count(DISTINCT dl.user_id)
         FROM driver_licenses dl JOIN real_users r ON r.id = dl.user_id)::int AS license,
      (SELECT count(DISTINCT mp.user_id)
         FROM maintenance_plans mp JOIN real_users r ON r.id = mp.user_id)::int AS maintenance_plan
  `)

  const total = toInt(row?.total)

  // El mapeo es explícito, key por key: un `Object.entries` snake→camel compila
  // igual el día que se renombre una columna del SELECT y devuelve 0 en
  // silencio, que en esta tabla se lee como "nadie usa esa función". Mismo
  // criterio que `mapCensus` en `users.repo.ts`.
  const counts: Record<(typeof ADOPTION_FEATURES)[number]['key'], number> = {
    vehicle: toInt(row?.vehicle),
    push: toInt(row?.push),
    fineSync: toInt(row?.fine_sync),
    chat: toInt(row?.chat),
    insurance: toInt(row?.insurance),
    vtv: toInt(row?.vtv),
    regCard: toInt(row?.reg_card),
    scan: toInt(row?.scan),
    maintenanceDone: toInt(row?.maintenance_done),
    notified: toInt(row?.notified),
    license: toInt(row?.license),
    maintenancePlan: toInt(row?.maintenance_plan),
  }

  const features: Array<AdoptionFeatureRow> = ADOPTION_FEATURES.map((f) => {
    const users = counts[f.key]
    return {
      key: f.key,
      label: f.label,
      users,
      pct: total === 0 ? 0 : (users / total) * 100,
    }
  })

  return { totalUsers: total, features }
}

// ── Marketplace ──────────────────────────────────────────────────────────────

interface MarketplaceRow {
  total: number
  active: number
  paused: number
  archived: number
  active_without_services: number
  active_without_geo: number
  active_without_contact: number
  founding: number
  from_sheet: number
  from_application: number
}

/**
 * Reemplaza: la consulta 6 del runbook de aprobación
 * (`autolibre-backend-hex/scripts/sql/aprobar-partner-application.sql`), que
 * busca partners publicados con cero rubros DESPUÉS del hecho.
 *
 * `withTransaction` en `db.ts` ya hace ese caso irrepresentable para las
 * aprobaciones nuevas. Esta consulta cubre lo otro: las 34 filas que entraron
 * por `legacy_sheet` sin pasar nunca por la función de aprobación.
 *
 * El `coalesce(x,'') = ''` en vez de `x IS NULL` no es paranoia: el import del
 * sheet escribió strings vacíos donde no había dato, así que `IS NULL` cuenta
 * de menos y el problema queda invisible.
 */
export async function marketplaceHealth(
  opts: { signal?: AbortSignal } = {},
): Promise<MarketplaceHealth> {
  void opts.signal

  const row = await sqlOne<MarketplaceRow>(`
    SELECT
      count(*)::int                                       AS total,
      count(*) FILTER (WHERE p.status = 'active')::int    AS active,
      count(*) FILTER (WHERE p.status = 'paused')::int    AS paused,
      count(*) FILTER (WHERE p.status = 'archived')::int  AS archived,
      count(*) FILTER (
        WHERE p.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM partner_services ps WHERE ps.partner_id = p.id)
      )::int AS active_without_services,
      count(*) FILTER (WHERE p.status = 'active' AND p.latitude IS NULL)::int AS active_without_geo,
      count(*) FILTER (
        WHERE p.status = 'active'
          AND coalesce(p.whatsapp, '') = ''
          AND coalesce(p.email, '') = ''
          AND coalesce(p.redirect_link, '') = ''
      )::int AS active_without_contact,
      count(*) FILTER (WHERE p.tier = 'founding')::int        AS founding,
      count(*) FILTER (WHERE p.source = 'legacy_sheet')::int  AS from_sheet,
      count(*) FILTER (WHERE p.source = 'application')::int   AS from_application
    FROM partners p
  `)

  return {
    total: toInt(row?.total),
    active: toInt(row?.active),
    paused: toInt(row?.paused),
    archived: toInt(row?.archived),
    activeWithoutServices: toInt(row?.active_without_services),
    activeWithoutGeo: toInt(row?.active_without_geo),
    activeWithoutContact: toInt(row?.active_without_contact),
    founding: toInt(row?.founding),
    fromSheet: toInt(row?.from_sheet),
    fromApplication: toInt(row?.from_application),
  }
}

// ── Leads ────────────────────────────────────────────────────────────────────

interface LeadRow {
  total: number
  fresh: number
  contacted: number
  won: number
  lost: number
  stale_uncontacted: number
  median_hours_to_contact: string | null
}

/**
 * Reemplaza: el `select status, count(*) from leads group by 1` del embudo.
 *
 * La mediana y no el promedio: un lead olvidado tres semanas mueve el promedio
 * a un número que no describe a ningún lead real. La mediana contesta "¿cuánto
 * tarda un caso típico?", que es la pregunta que alguien va a accionar.
 */
export async function leadFunnel(
  opts: { signal?: AbortSignal } = {},
): Promise<LeadFunnel> {
  void opts.signal

  const row = await sqlOne<LeadRow>(`
    SELECT
      count(*)::int                                    AS total,
      count(*) FILTER (WHERE status = 'new')::int      AS fresh,
      count(*) FILTER (WHERE status = 'contacted')::int AS contacted,
      count(*) FILTER (WHERE status = 'won')::int      AS won,
      count(*) FILTER (WHERE status = 'lost')::int     AS lost,
      count(*) FILTER (
        WHERE status = 'new' AND created_at < now() - interval '48 hours'
      )::int AS stale_uncontacted,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY extract(epoch FROM (contacted_at - created_at)) / 3600.0
      ) FILTER (WHERE contacted_at IS NOT NULL) AS median_hours_to_contact
    FROM leads
  `)

  return {
    total: toInt(row?.total),
    fresh: toInt(row?.fresh),
    contacted: toInt(row?.contacted),
    won: toInt(row?.won),
    lost: toInt(row?.lost),
    staleUncontacted: toInt(row?.stale_uncontacted),
    medianHoursToContact: toNum(row?.median_hours_to_contact),
  }
}

// ── Colas ────────────────────────────────────────────────────────────────────

/**
 * Cuántos minutos puede estar un ítem EN VUELO antes de contar como colgado.
 *
 * Son distintos porque los procesos son distintos, no por gusto:
 *  - Una notificación con `scheduled_at` vencido debería salir en el próximo
 *    tick del scheduler. Media hora ya es raro.
 *  - Una consulta VTV depende de un proveedor externo lento.
 *  - Una sesión de manejo espera que el teléfono termine de subir los chunks, y
 *    el teléfono puede estar sin señal un rato largo.
 *  - Una imagen de catálogo es una llamada a un modelo de generación.
 */
const STUCK_AFTER_MINUTES: Record<QueueKey, number> = {
  // `notification-delivery.cron` corre CADA MINUTO. Media hora sin un solo
  // intento registrado no es lentitud: es el cron caído.
  //
  // El número se importa de `~/lib/notifications` — `/notificaciones` lo usa
  // para marcar una fila como `atrasada`, y las dos pantallas TIENEN que decir
  // lo mismo sobre la misma notificación. Una sola definición, no dos que
  // divergen. → `.claude/rules/notifications.md`
  notifications: NOTIFICATION_DELAYED_AFTER_MIN,
  // `vehicle-data-query-reconciliation.cron` barre cada 5 min lo no sellado.
  // Una hora sin sellar ya pasó por doce barridos.
  vehicle_data_queries: 60,
  // NO hay cron. Sale de `pending_chunks` sólo si el teléfono vuelve.
  driving_sessions: 180,
  catalog_images: 60,
}

interface QueueRow {
  key: QueueKey
  total: number
  ok: number
  failed: number
  stuck: number
  retrying: number
  last_at: Date | null
}

/**
 * Reemplaza: los cuatro `select status, count(*) ... group by 1` sueltos que
 * hoy hay que correr uno por uno para saber si algo se colgó.
 *
 * Un solo UNION ALL y no cuatro consultas: así las cuatro filas comparten el
 * mismo `now()` de Postgres, y "colgado hace 61 minutos" significa lo mismo en
 * las cuatro. Con consultas separadas, cada una toma su propio reloj.
 *
 * Los umbrales entran por parámetro (`$1..$4`) en vez de interpolarse: son
 * números nuestros, no entrada de usuario, pero un `interval` armado con
 * concatenación de strings es la puerta por la que después entra el primero que
 * sí venga de la URL.
 */
export async function queueHealth(
  opts: { signal?: AbortSignal } = {},
): Promise<Array<QueueHealth>> {
  void opts.signal

  const rows = await sql<QueueRow>(
    `
    /*
      NOTIFICACIONES — stuck y retrying son DOS cosas distintas.

      El backend (notification-delivery.cron, cada minuto) levanta
      status = 'pending' AND scheduled_at <= now(). Y ni markAsFailed() ni
      markAsNoToken() tocan status: sólo escriben delivery_status.

      O sea que una fila fallida SIGUE siendo elegible y se reintenta cada 60
      segundos, sin tope. Contarla como "colgada" fue el bug de la primera
      versión de esta consulta: mezclaba "el cron no corre" con "el cron corre y
      falla siempre", que se arreglan de maneras opuestas.

      - stuck   → pendiente, vencida y delivery_status IS NULL: nunca se
                    intentó. El cron no está corriendo o no llega.
      - retrying→ pendiente con marca de falla: se va a reintentar para
                    siempre. Nadie va a cortar ese loop solo.
    */
    SELECT 'notifications' AS key,
      count(*)::int AS total,
      count(*) FILTER (WHERE delivery_status = 'sent')::int AS ok,
      count(*) FILTER (WHERE delivery_status IN ('failed', 'no_token'))::int AS failed,
      count(*) FILTER (
        WHERE status = 'pending'
          AND delivery_status IS NULL
          AND scheduled_at < now() - make_interval(mins => $1::int)
      )::int AS stuck,
      count(*) FILTER (
        WHERE status = 'pending' AND delivery_status IN ('failed', 'no_token')
      )::int AS retrying,
      max(created_at) AS last_at
    FROM notifications
    UNION ALL
    /*
      CONSULTAS VTV / DEUDA — "en vuelo" es settled_at IS NULL, NO la lista de
      estados.

      Es la definición del propio backend: findUnsettledOlderThan() y el índice
      idx_vehicle_data_queries_unsettled son parciales sobre settled_at IS
      NULL, porque cubren con una sola condición tanto "sigue en curso" como
      "terminó pero el import falló después de guardar el resultado".

      Filtrar por status IN ('queued','processing') — lo que hacía la primera
      versión — deja afuera justo ese segundo caso: filas marcadas completed
      que nunca se sellaron. El cron de reconciliación (cada 5 min) SÍ las ve, y
      el panel no las veía.
    */
    SELECT 'vehicle_data_queries',
      count(*)::int,
      count(*) FILTER (WHERE status = 'completed')::int,
      count(*) FILTER (WHERE status = 'failed')::int,
      count(*) FILTER (
        WHERE settled_at IS NULL
          AND created_at < now() - make_interval(mins => $2::int)
      )::int,
      0,
      max(created_at)
    FROM vehicle_data_queries
    UNION ALL
    /*
      SESIONES DE MANEJO — acá stuck es literal y definitivo.

      No hay ningún cron que cierre pending_chunks: la sesión sale de ese
      estado sólo cuando el teléfono termina de subir los chunks. Si el teléfono
      no vuelve, la fila se queda ahí PARA SIEMPRE y nadie la va a tocar.
      Por eso el umbral es el más largo de las cuatro (3 h): un teléfono sin
      señal es normal, uno que no volvió en tres horas no.
    */
    SELECT 'driving_sessions',
      count(*)::int,
      count(*) FILTER (WHERE status = 'completed')::int,
      count(*) FILTER (WHERE status = 'failed')::int,
      count(*) FILTER (
        WHERE status = 'pending_chunks'
          AND created_at < now() - make_interval(mins => $3::int)
      )::int,
      0,
      max(created_at)
    FROM driving_sessions
    UNION ALL
    SELECT 'catalog_images',
      count(*)::int,
      count(*) FILTER (WHERE status = 'completed')::int,
      count(*) FILTER (WHERE status = 'failed')::int,
      count(*) FILTER (
        WHERE status IN ('pending', 'generating')
          AND created_at < now() - make_interval(mins => $4::int)
      )::int,
      0,
      max(created_at)
    FROM vehicle_catalog_images
    `,
    [
      STUCK_AFTER_MINUTES.notifications,
      STUCK_AFTER_MINUTES.vehicle_data_queries,
      STUCK_AFTER_MINUTES.driving_sessions,
      STUCK_AFTER_MINUTES.catalog_images,
    ],
  )

  // El orden lo fija el módulo compartido, no el ORDER BY: así la pantalla
  // muestra siempre las mismas cuatro filas en el mismo lugar aunque una quede
  // en cero, y "no está" se distingue de "está en cero".
  const byKey = new Map(rows.map((r) => [r.key, r]))

  return (Object.keys(QUEUE_LABELS) as Array<QueueKey>).map((key) => {
    const row = byKey.get(key)
    return {
      key,
      total: toInt(row?.total),
      ok: toInt(row?.ok),
      failed: toInt(row?.failed),
      stuck: toInt(row?.stuck),
      retrying: toInt(row?.retrying),
      stuckAfterMinutes: STUCK_AFTER_MINUTES[key],
      lastEventAt: toIso(row?.last_at ?? null),
    }
  })
}

interface FailureRow {
  queue: QueueKey
  reason: string
  count: number
  last_at: Date | null
}

/**
 * Reemplaza: `select failure_reason, count(*) ... where status='failed'`, que
 * es lo primero que alguien escribe cuando la tarjeta de arriba muestra rojo.
 *
 * Agrupar por texto es lo que distingue "un proveedor caído" de "veinte
 * problemas distintos". Un listado de filas crudas no contesta eso.
 *
 * `delivery_status::text` como fallback en notificaciones: `no_token` no deja
 * `delivery_error`, y sin el fallback esas filas caerían todas en
 * "(sin motivo registrado)" mezcladas con fallas reales del proveedor push.
 */
export async function failureReasons(
  window: OpsWindow,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<FailureReason>> {
  void opts.signal

  const from = windowStart(window)

  const rows = await sql<FailureRow>(
    `
    SELECT 'vehicle_data_queries' AS queue,
      coalesce(nullif(btrim(failure_reason), ''), '(sin motivo registrado)') AS reason,
      count(*)::int AS count,
      max(created_at) AS last_at
    FROM vehicle_data_queries
    WHERE status = 'failed' AND ($1::timestamptz IS NULL OR created_at >= $1)
    GROUP BY 1, 2
    UNION ALL
    SELECT 'notifications',
      coalesce(nullif(btrim(delivery_error), ''), delivery_status::text),
      count(*)::int,
      max(created_at)
    FROM notifications
    WHERE delivery_status IN ('failed', 'no_token')
      AND ($1::timestamptz IS NULL OR created_at >= $1)
    GROUP BY 1, 2
    ORDER BY 3 DESC, 4 DESC NULLS LAST
    LIMIT 12
    `,
    [from],
  )

  return rows.map((r) => ({
    queue: r.queue,
    reason: r.reason,
    count: toInt(r.count),
    lastAt: toIso(r.last_at),
  }))
}

// ── Huecos de catálogo ───────────────────────────────────────────────────────

interface GapRow {
  plate: string
  state: string | null
  times: number
  last_at: Date
}

/**
 * Reemplaza: nada, y ese es el punto — hoy NADIE corre esta consulta.
 *
 * `vehicle_plate_lookup_misses` se llena sola cada vez que un usuario busca una
 * patente que el catálogo no sabe resolver. Es la única métrica del panel que
 * es literalmente una lista de trabajo: cada fila es un auto que alguien quiso
 * cargar y no pudo, con cuántas veces lo intentó.
 *
 * `times DESC` primero y `last_at DESC` después: un modelo que falló 40 veces
 * importa más que uno que falló ayer una vez.
 */
export async function catalogGaps(
  window: OpsWindow,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<CatalogGap>> {
  void opts.signal

  const from = windowStart(window)

  const rows = await sql<GapRow>(
    `
    SELECT plate,
      nullif(btrim(coalesce(state, '')), '') AS state,
      count(*)::int AS times,
      max(missed_at) AS last_at
    FROM vehicle_plate_lookup_misses
    WHERE $1::timestamptz IS NULL OR missed_at >= $1
    GROUP BY 1, 2
    ORDER BY 3 DESC, 4 DESC
    LIMIT 25
    `,
    [from],
  )

  return rows.map((r) => ({
    plate: r.plate,
    state: r.state,
    times: toInt(r.times),
    lastAt: toIso(r.last_at) as string,
  }))
}

// ── Dominios excluidos: la acción del panel ──────────────────────────────────

interface DomainRow {
  domain: string
  note: string | null
  users: number
  created_at: Date
}

/**
 * `users` es la columna que hace útil esta tabla.
 *
 * Un dominio que oculta 0 usuarios está mal escrito, o la base se reseteó. Sin
 * ese número la lista es una declaración de intenciones que nadie puede
 * verificar; con él, se lee de un vistazo si el filtro está haciendo algo.
 */
export async function excludedDomains(
  opts: { signal?: AbortSignal } = {},
): Promise<Array<ExcludedDomain>> {
  void opts.signal

  const rows = await sql<DomainRow>(`
    SELECT d.domain, d.note, d.created_at,
      (
        SELECT count(*) FROM users u
        WHERE split_part(lower(u.email), '@', 2) = d.domain
      )::int AS users
    FROM ops.excluded_email_domains d
    ORDER BY d.domain
  `)

  return rows.map((r) => ({
    domain: r.domain,
    note: r.note,
    users: toInt(r.users),
    createdAt: toIso(r.created_at) as string,
  }))
}

/**
 * Alta o edición de la nota. `ON CONFLICT` en vez de un INSERT que explota:
 * volver a agregar un dominio ya excluido es una operación idempotente desde el
 * punto de vista del operador, y fallar ahí sería castigar un doble click.
 *
 * `created_at` NO se toca en el UPDATE: cuándo se decidió excluir el dominio es
 * el dato con valor, y pisarlo con cada corrección de la nota lo borra.
 */
export async function upsertExcludedDomain(
  input: { domain: string; note?: string },
  opts: { signal?: AbortSignal } = {},
): Promise<ExcludedDomain> {
  void opts.signal

  await sql(
    `
    INSERT INTO ops.excluded_email_domains (domain, note)
    VALUES ($1, $2)
    ON CONFLICT (domain) DO UPDATE SET note = EXCLUDED.note
    `,
    [input.domain, input.note ?? null],
  )

  const all = await excludedDomains()
  const saved = all.find((d) => d.domain === input.domain)
  // No debería pasar nunca — acabamos de escribirla en la misma conexión lógica.
  // Si pasa, es una señal real (permisos, replica de lectura) y no un caso a tapar.
  if (!saved) throw new Error(`NOT_FOUND:${input.domain}`)
  return saved
}

/** `false` cuando el dominio no estaba. El llamador decide si eso es un error. */
export async function removeExcludedDomain(
  domain: string,
  opts: { signal?: AbortSignal } = {},
): Promise<boolean> {
  void opts.signal

  const rows = await sql<{ domain: string }>(
    'DELETE FROM ops.excluded_email_domains WHERE domain = $1 RETURNING domain',
    [domain],
  )
  return rows.length > 0
}
