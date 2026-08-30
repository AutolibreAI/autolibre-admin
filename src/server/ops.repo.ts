import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { OPS_WINDOW_HOURS, QUEUE_LABELS } from '~/lib/ops'
import type {
  AdoptionPulse,
  CatalogGap,
  ExcludedDomain,
  FailureReason,
  LeadFunnel,
  MarketplaceHealth,
  OpsWindow,
  QueueHealth,
  QueueKey,
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
 */
const INTERNAL_PREDICATE = `coalesce(
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
  vehicles_archived: number
  vehicles_last_30d: number
}

/**
 * Reemplaza: el `select count(*) from users` suelto, más el censo por
 * `(role, auth_provider)` que el CLAUDE.md dejó anotado a mano en una tabla.
 *
 * `legacy_native_admins` está separado del resto porque es el riesgo abierto del
 * repo: cuentas `admin` + `native`, herencia de la era pre-Clerk. Hoy no pueden
 * entrar — el lookup de sesión exige `auth_provider = 'clerk'` — pero eso es un
 * efecto colateral, no una salvaguarda. El número tiene que estar a la vista
 * para que el día que alguien migre una cuenta native a Clerk se note.
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
    vehiclesArchived: toInt(row?.vehicles_archived),
    vehiclesLast30d: toInt(row?.vehicles_last_30d),
    // Sin usuarios reales la razón es indefinida, no cero. Cero se leería como
    // "tienen cuenta y no cargaron el auto", que es una afirmación distinta.
    vehiclesPerUser: usersTotal === 0 ? null : vehiclesActive / usersTotal,
  }
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
  notifications: 30,
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
