import '@tanstack/react-start/server-only'

import { sql } from './db'
import { DERIVED_STATE } from './notifications.repo'
import { NOTIFICATION_DELAYED_AFTER_MIN } from '~/lib/notifications'
import { CAMPAIGN_OUTCOMES, outcomeExistsSql } from '~/lib/campaigns'
import type {
  CampaignDetail,
  CampaignListItem,
  CampaignOutcomeSummary,
  CampaignRecipientRow,
  CampaignSearch,
  CampaignSortKey,
  CampaignStateCount,
} from '~/lib/campaigns'
import type { NotificationState } from '~/lib/notifications'

/**
 * Envíos ad-hoc, agrupados — la lectura de `/notificaciones/envios`.
 *
 * ── No hay tabla de campañas: hay un `group by source_id` ───────────────────
 *
 * Una campaña no es una entidad de ningún schema. Es el conjunto de filas de
 * `notifications` con `source_type = 'broadcast'` y el mismo `source_id`, que es
 * el `broadcastId` que el compositor genera como clave de idempotencia
 * (`.claude/rules/notifications.md`). Todo lo de acá se deriva de esas filas.
 *
 * Lo bueno de que sea así: **un envío aparece en la lista aunque el panel se
 * haya caído justo después de mandarlo.** La verdad la tiene Postgres, no un
 * registro nuestro.
 *
 * Lo que se paga: no se puede saber con qué condición se eligió la audiencia,
 * porque eso no se persiste en ningún lado. Guardarlo sería una tabla en `ops`
 * —posible, el panel es dueño de ese schema— y es una decisión aparte con su
 * migración. → `~/lib/campaigns`
 *
 * ── El estado se IMPORTA, no se recopia ─────────────────────────────────────
 *
 * `DERIVED_STATE` viene de `notifications.repo.ts`, que es su única definición.
 * Una segunda copia del `CASE` acá haría que el mismo envío se lea distinto en
 * la lista y en el detalle, sin ningún error que lo delate — misma familia que
 * `INTERNAL_PREDICATE` entre `ops.repo.ts` y `ops.v_ai_usage`. Consecuencia
 * mecánica: **`$1` es siempre el umbral de `atrasada`**, en toda consulta de
 * este archivo.
 *
 * ── Ni una escritura ────────────────────────────────────────────────────────
 *
 * Un envío que ya salió es un hecho. Las filas las crea el backend hex por
 * `POST /notifications/broadcast`. Si aparece un `UPDATE`/`INSERT` acá, está mal.
 */

const toInt = (value: unknown): number => Number(value ?? 0)

const toIso = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString()
    : value === null || value === undefined
      ? null
      : String(value)

const toIsoRequired = (value: unknown): string => toIso(value) ?? ''

/**
 * Mapa cerrado `CampaignSortKey → columna`. Lo único que hace seguro interpolar
 * la columna en el `ORDER BY` — mismo patrón que `SORT_COLUMNS` de
 * `notifications.repo.ts`.
 *
 * `read` va como `read_count`: el alias crudo funcionaría, pero `read` es una
 * palabra clave no reservada de Postgres y una columna que se llama como una
 * palabra clave es una trampa esperando a que alguien la use sin comillas.
 */
const CAMPAIGN_SORT_COLUMNS: Record<CampaignSortKey, string> = {
  sentAt: 'scheduled_at',
  recipients: 'recipients',
  read: 'read_count',
  title: 'title',
}

interface CampaignRow {
  broadcast_id: string
  title: string
  body: string
  recipients: number | string
  read_count: number | string
  undelivered: number | string
  states: Array<{ state: NotificationState; count: number | string }> | null
  scheduled_at: Date | string
  sent_at: Date | string | null
  created_at: Date | string
}

const mapCampaign = (r: CampaignRow): CampaignListItem => ({
  broadcastId: r.broadcast_id,
  title: r.title,
  body: r.body,
  recipients: toInt(r.recipients),
  read: toInt(r.read_count),
  undelivered: toInt(r.undelivered),
  states: (r.states ?? []).map(
    (s): CampaignStateCount => ({ state: s.state, count: toInt(s.count) }),
  ),
  scheduledAt: toIsoRequired(r.scheduled_at),
  sentAt: toIso(r.sent_at),
  createdAt: toIsoRequired(r.created_at),
})

/**
 * El SELECT agrupado, compartido por el listado y por el detalle.
 *
 * Es una función y no dos consultas parecidas a propósito: si el detalle contara
 * los estados con un `CASE` propio, un envío podría mostrar «3 entregadas» en la
 * lista y «2 entregadas» al abrirlo.
 *
 * `extraWhere` va sobre las filas crudas de `notifications` (alias `n`), antes
 * de agrupar: acotar el barrido a un `source_id` es mucho más barato que
 * agrupar la tabla entera y quedarse con un grupo.
 */
function campaignSelect(extraWhere: string, orderBy: string, limit: string): string {
  return `
    with rows as (
      select
        n.source_id,
        n.title,
        n.body,
        n.status::text as status,
        n.scheduled_at,
        n.sent_at,
        n.created_at,
        (${DERIVED_STATE}) as state
      from notifications n
      where n.source_type = 'broadcast'
        and n.source_id is not null
        ${extraWhere}
    ),
    per_state as (
      select source_id, state, count(*)::int as count
      from rows
      group by 1, 2
    )
    select
      r.source_id as broadcast_id,
      -- Todas las filas de un envío comparten título y cuerpo. Se toma el de la
      -- fila más vieja (con desempate) en vez de un min() alfabético: si alguien
      -- reusó el mismo broadcastId con otro texto, lo que vale es el original.
      (array_agg(r.title order by r.created_at, r.title))[1] as title,
      (array_agg(r.body order by r.created_at, r.body))[1] as body,
      count(*)::int as recipients,
      count(*) filter (where r.status = 'read')::int as read_count,
      -- Las que no le van a llegar a nadie. «Sin token» reintenta para siempre y
      -- «Rechazada» es terminal: se ven parecido y son opuestas, pero para el
      -- resultado de un envío las dos significan lo mismo — no llegó.
      count(*) filter (where r.state in ('sin_token', 'rechazada'))::int as undelivered,
      min(r.scheduled_at) as scheduled_at,
      min(r.sent_at) as sent_at,
      min(r.created_at) as created_at,
      (select jsonb_agg(jsonb_build_object('state', p.state, 'count', p.count) order by p.count desc)
         from per_state p where p.source_id = r.source_id) as states
    from rows r
    group by r.source_id
    ${orderBy}
    ${limit}
  `
}

/**
 * Los envíos ad-hoc, uno por fila.
 *
 * `q` filtra sobre `title`/`body`, que son columnas crudas: va adentro, antes de
 * agrupar. No busca por destinatario a propósito — "los envíos que le llegaron a
 * fulano" ya es el listado de `/notificaciones?userId=…`, que es otra pregunta y
 * ya tiene pantalla.
 */
export async function listCampaigns(
  search: CampaignSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<CampaignListItem>> {
  void opts.signal

  // $1 es SIEMPRE el umbral de `atrasada` — lo consume `DERIVED_STATE`.
  const params: Array<unknown> = [NOTIFICATION_DELAYED_AFTER_MIN]
  let extraWhere = ''

  if (search.q) {
    params.push(`%${search.q}%`)
    extraWhere = `and (n.title ilike $${params.length} or n.body ilike $${params.length})`
  }

  const column = CAMPAIGN_SORT_COLUMNS[search.campaignSort]

  const rows = await sql<CampaignRow>(
    campaignSelect(
      extraWhere,
      `order by ${column} ${search.campaignDir} nulls last, broadcast_id`,
      'limit 200',
    ),
    params,
  )

  return rows.map(mapCampaign)
}

// ── Detalle: quién recibió y qué hizo después ────────────────────────────────

/**
 * Las columnas de resultado se llaman `had_0` / `did_0`, por índice.
 *
 * Los `key` del catálogo son camelCase (`pushToken`) y Postgres pliega a
 * minúscula todo identificador sin comillas: `had_pushToken` volvería como
 * `had_pushtoken` y el mapeo de vuelta fallaría en silencio, devolviendo
 * `undefined` — que en esta tabla se lee como "no lo hizo", la mentira más cara
 * que puede decir la pantalla (mismo criterio que `mapCensus` en
 * `users.repo.ts`). El índice no tiene mayúsculas y no tiene ese problema.
 */
const outcomeColumns = (): string =>
  CAMPAIGN_OUTCOMES.map(
    (o, i) =>
      `(${outcomeExistsSql(o, '<=', 'r.user_id', 'r.ref')}) as had_${i},\n` +
      `      (${outcomeExistsSql(o, '>', 'r.user_id', 'r.ref')}) as did_${i}`,
  ).join(',\n      ')

interface RecipientRow {
  notification_id: string
  user_id: string
  email: string
  name: string | null
  state: NotificationState
  sent_at: Date | string | null
  [key: string]: unknown
}

/**
 * Un envío: la cabecera agrupada, quién lo recibió, y qué hizo cada uno después.
 *
 * ── El momento de referencia es por PERSONA ─────────────────────────────────
 *
 * `coalesce(sent_at, scheduled_at)`, fila por fila, no el `min()` del lote. Casi
 * siempre coinciden —el cron manda todo el lote en el mismo tick— pero si una
 * fila quedó pendiente tres días, medir "lo hizo después" contra el envío del
 * resto le atribuiría a una notificación que todavía no salió todo lo que esa
 * persona hizo mientras tanto.
 *
 * Y para las que NUNCA salieron, `scheduled_at` es lo más honesto que hay: la
 * fila dice igual «Sin token» o «Atrasada», así que el número se lee con esa
 * salvedad a la vista.
 *
 * ── `hadBefore` es el denominador, y por eso viaja ──────────────────────────
 *
 * "12 de 48 cargaron un auto" no significa nada si 30 de esos 48 ya tenían uno.
 * Por cada persona se traen las DOS preguntas —¿lo había hecho antes?, ¿lo hizo
 * después?— y el resumen se arma sobre quienes NO lo habían hecho. Se agrega en
 * JS y no en SQL porque las dos vistas (el resumen y la fila por persona) tienen
 * que salir del MISMO snapshot: con dos consultas, los totales de arriba podrían
 * no cuadrar con las filas de abajo.
 */
export async function findCampaign(
  broadcastId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<CampaignDetail | null> {
  void opts.signal

  const params = [NOTIFICATION_DELAYED_AFTER_MIN, broadcastId]

  const [campaigns, recipients] = await Promise.all([
    sql<CampaignRow>(
      campaignSelect(`and n.source_id = $2`, 'order by broadcast_id', 'limit 1'),
      params,
    ),
    sql<RecipientRow>(
      `
      select
        r.notification_id,
        r.user_id,
        r.email,
        r.name,
        r.state,
        r.sent_at,
        ${outcomeColumns()}
      from (
        select
          n.id as notification_id,
          n.user_id,
          u.email,
          u.name,
          n.sent_at,
          coalesce(n.sent_at, n.scheduled_at) as ref,
          (${DERIVED_STATE}) as state
        from notifications n
        join users u on u.id = n.user_id
        where n.source_type = 'broadcast' and n.source_id = $2
      ) r
      order by r.email
      `,
      params,
    ),
  ])

  const campaign = campaigns[0]
  if (!campaign) return null

  const rows: Array<CampaignRecipientRow> = recipients.map((r) => ({
    notificationId: r.notification_id,
    userId: r.user_id,
    email: r.email,
    name: r.name,
    state: r.state,
    sentAt: toIso(r.sent_at),
    outcomes: CAMPAIGN_OUTCOMES.map((o, i) => ({
      key: o.key,
      hadBefore: r[`had_${i}`] === true,
      didAfter: r[`did_${i}`] === true,
    })),
  }))

  const outcomes: Array<CampaignOutcomeSummary> = CAMPAIGN_OUTCOMES.map((o) => {
    const eligible = rows.filter((row) => {
      const found = row.outcomes.find((x) => x.key === o.key)
      return found !== undefined && !found.hadBefore
    })
    return {
      key: o.key,
      pendingBefore: eligible.length,
      converted: eligible.filter((row) => row.outcomes.some((x) => x.key === o.key && x.didAfter))
        .length,
    }
  })

  return { campaign: mapCampaign(campaign), outcomes, recipients: rows }
}
