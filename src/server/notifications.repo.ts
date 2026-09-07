import '@tanstack/react-start/server-only'

import { sql } from './db'
import { NOTIFICATION_DELAYED_AFTER_MIN } from '~/lib/notifications'
import type {
  NotificationFacets,
  NotificationListItem,
  NotificationSearch,
  NotificationSortKey,
  NotificationState,
} from '~/lib/notifications'

/**
 * Notificaciones — solo lectura, mismo dueño de SQL que `ops.repo.ts` y
 * `users.repo.ts`: **nosotros, sobre tablas de `public`**. Una función de `ops`
 * que leyera `notifications` sería una dependencia cruzada invisible para las
 * migraciones del backend; con el SQL acá, un rename rompe en runtime igual
 * pero `rg` lo encuentra y el diff queda versionado.
 *
 * Corolario literal: **ninguna consulta de este archivo escribe nada.** Una
 * notificación es un hecho que pasó, no un estado que el admin mueva — mismo
 * criterio que `driving_sessions` y `conversations`. Y `ops-write-actions.md`
 * ya descartó explícitamente reintentar o cortar el loop desde el panel: el
 * backend ya reintenta solo, y "cancelar" necesita un estado terminal que el
 * enum `notification_status` no tiene. Si aparece un `UPDATE`/`INSERT` acá,
 * está mal.
 */

// ── Conversión ───────────────────────────────────────────────────────────────

/** `pg` devuelve `bigint` como STRING — `"14" + "3" === "143"`. */
const toInt = (value: unknown): number => Number(value ?? 0)

const toIso = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString()
    : value === null || value === undefined
      ? null
      : String(value)

const toIsoRequired = (value: unknown): string => toIso(value) ?? ''

// ── El estado derivado, en un solo lugar ─────────────────────────────────────

/**
 * `status` + `delivery_status` + el reloj → un estado legible.
 *
 * Es una única expresión reusada por el SELECT (para mostrarlo) y por el WHERE
 * (para filtrar por él) — mismo patrón que `INTERNAL_PREDICATE` en
 * `ops.repo.ts`. El orden de los `WHEN` importa: `read` gana sobre todo,
 * después mandan las marcas del proveedor, y recién al final el reloj.
 *
 * `$1` es el umbral de `atrasada` en minutos. Va por parámetro y no interpolado
 * aunque sea un número nuestro: un `interval` armado con concatenación es la
 * puerta por la que después entra el primero que sí venga de la URL (misma
 * razón que `ops.repo.ts`). El `now()` es estable dentro de la sentencia, así
 * que el SELECT y el WHERE ven el mismo corte.
 */
const DERIVED_STATE = `
  case
    when n.status = 'read'                                          then 'leida'
    when n.delivery_status = 'sent'                                 then 'entregada'
    when n.delivery_status = 'failed'                               then 'rechazada'
    when n.delivery_status = 'no_token'                             then 'sin_token'
    when n.status = 'pending' and n.delivery_status is null
         and n.scheduled_at < now() - make_interval(mins => $1::int) then 'atrasada'
    when n.status = 'pending' and n.delivery_status is null         then 'programada'
    when n.status = 'sent'                                          then 'enviada'
    else 'desconocida'
  end`

/**
 * Mapa cerrado `NotificationSortKey → expresión SQL`. Seguro de interpolar en
 * el `ORDER BY` porque sale de un `Record` que los tipos obligan a cubrir,
 * nunca de texto suelto — igual que `SORT_COLUMNS` en `users.repo.ts`. Todas
 * son columnas del SELECT interno (o alias suyos), así que el `order by` de
 * afuera las ve.
 */
const SORT_COLUMNS: Record<NotificationSortKey, string> = {
  user: 'user_email',
  type: 'type',
  vehicle: 'vehicle_plate',
  state: 'state',
  scheduledAt: 'scheduled_at',
  sentAt: 'sent_at',
}

// ── Listado ──────────────────────────────────────────────────────────────────

interface NotificationListRow {
  id: string
  user_id: string
  user_email: string
  user_name: string | null
  type: string
  source_type: string | null
  vehicle_id: string | null
  vehicle_plate: string | null
  vehicle_brand: string | null
  vehicle_model: string | null
  vehicle_year: number | string | null
  channel: string
  title: string
  body: string
  state: NotificationState
  delivery_error: string | null
  scheduled_at: Date | string
  sent_at: Date | string | null
  created_at: Date | string
}

/**
 * El listado. Reemplaza el `select * from notifications where user_id = '…'`.
 *
 * Va envuelto en `select * from (...) s`, mismo motivo que `listUsers` y
 * `listChats`: `state` es una expresión calculada y `q` necesita buscar sobre
 * `title`/`body`/`vehicle_plate` — que no son columnas de `notifications` (son
 * el join, o el CASE) y no existen todavía en el nivel del WHERE interno. Todos
 * los filtros van en el WHERE de afuera menos `user_id`, que sí es una columna
 * cruda y acota el barrido antes de calcular nada.
 *
 * El join al vehículo es LEFT en las tres patas: `n.vehicle_id` es nullable
 * (una notificación de licencia de conducir no tiene auto), y la FK sólo
 * garantiza el spec, no el catálogo. Un `join` haría desaparecer del listado a
 * las notificaciones sin vehículo — mismo error que documenta `chats.md`.
 */
export async function listNotifications(
  search: NotificationSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<NotificationListItem>> {
  void opts.signal // `pg` no acepta AbortSignal; queda documentado el hueco.

  // $1 es SIEMPRE el umbral de `atrasada` — lo consume `DERIVED_STATE`.
  const params: Array<unknown> = [NOTIFICATION_DELAYED_AFTER_MIN]
  const innerWhere: Array<string> = []
  const outerWhere: Array<string> = []

  if (search.userId) {
    params.push(search.userId)
    innerWhere.push(`n.user_id = $${params.length}`)
  }

  if (search.q) {
    params.push(`%${search.q}%`)
    const p = `$${params.length}`
    outerWhere.push(
      `(user_email ilike ${p} or coalesce(user_name, '') ilike ${p} ` +
        `or coalesce(vehicle_plate, '') ilike ${p} or title ilike ${p} or body ilike ${p})`,
    )
  }

  if (search.notificationType) {
    params.push(search.notificationType)
    outerWhere.push(`type = $${params.length}`)
  }

  if (search.channel) {
    params.push(search.channel)
    outerWhere.push(`channel = $${params.length}`)
  }

  if (search.notificationState) {
    params.push(search.notificationState)
    outerWhere.push(`state = $${params.length}`)
  }

  const sortColumn = SORT_COLUMNS[search.sort]

  const rows = await sql<NotificationListRow>(
    `
    select * from (
      select
        n.id,
        n.user_id,
        u.email as user_email,
        u.name as user_name,
        n.type::text as type,
        n.source_type::text as source_type,
        n.vehicle_id,
        v.plate as vehicle_plate,
        vc.brand as vehicle_brand,
        vc.model as vehicle_model,
        vc.year as vehicle_year,
        n.channel::text as channel,
        n.title,
        n.body,
        (${DERIVED_STATE}) as state,
        -- El error crudo del proveedor: sólo tiene sentido cuando un receipt la
        -- rechazó. En cualquier otro estado es ruido, así que se anula.
        case when n.delivery_status = 'failed'
             then nullif(btrim(coalesce(n.delivery_error, '')), '')
        end as delivery_error,
        n.scheduled_at,
        n.sent_at,
        n.created_at
      from notifications n
      join users u on u.id = n.user_id
      left join vehicles v on v.id = n.vehicle_id
      left join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
      left join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
      ${innerWhere.length ? `where ${innerWhere.join(' and ')}` : ''}
    ) s
    ${outerWhere.length ? `where ${outerWhere.join(' and ')}` : ''}
    order by ${sortColumn} ${search.dir} nulls last, id
    limit 500
    `,
    params,
  )

  return rows.map(
    (r): NotificationListItem => ({
      id: r.id,
      userId: r.user_id,
      userEmail: r.user_email,
      userName: r.user_name,
      type: r.type,
      sourceType: r.source_type,
      vehicleId: r.vehicle_id,
      vehiclePlate: r.vehicle_plate,
      vehicleBrand: r.vehicle_brand,
      vehicleModel: r.vehicle_model,
      vehicleYear: r.vehicle_year === null ? null : toInt(r.vehicle_year),
      channel: r.channel,
      title: r.title,
      body: r.body,
      state: r.state,
      deliveryError: r.delivery_error,
      scheduledAt: toIsoRequired(r.scheduled_at),
      sentAt: toIso(r.sent_at),
      createdAt: toIsoRequired(r.created_at),
    }),
  )
}

/**
 * Los valores presentes en la base para los chips de filtro — `type` y
 * `channel`. Nunca hardcodeado: un valor nuevo del enum aparece solo, mismo
 * criterio que `listDistinctChatModels` en `chats.repo.ts`. El `state` NO sale
 * de acá: es vocabulario nuestro y su lista es cerrada en `~/lib/notifications`.
 */
export async function listNotificationFacets(
  opts: { signal?: AbortSignal } = {},
): Promise<NotificationFacets> {
  void opts.signal

  const rows = await sql<{ kind: string; value: string }>(`
    select 'type' as kind, type::text as value from notifications where type is not null
    union
    select 'channel', channel::text from notifications where channel is not null
  `)

  return {
    types: rows.filter((r) => r.kind === 'type').map((r) => r.value).sort(),
    channels: rows.filter((r) => r.kind === 'channel').map((r) => r.value).sort(),
  }
}
