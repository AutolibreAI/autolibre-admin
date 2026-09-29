import '@tanstack/react-start/server-only'

import { sql } from './db'
import type { NotificationRule } from '~/lib/notification-rules'

/**
 * Las reglas de aviso por vencimiento (`public.notification_rules`, del
 * backend). SÓLO LECTURA.
 *
 * Reemplaza el `select * from notification_rules` + el `count(*) … group by
 * rule_id` contra `notifications` que nadie corría: hasta acá no había forma de
 * saber qué avisos estaban prendidos ni cuántas veces sonó cada uno.
 *
 * ── Ni un `UPDATE`/`INSERT` acá ─────────────────────────────────────────────
 *
 * La tabla es del backend, y la excepción de `ops-write-actions.md` (escribir
 * `public` desde un SP de `ops`) se gana con un `grep` que todavía no se pudo
 * correr. Además hay una mina concreta: si el seed del backend reactiva las
 * reglas en cada deploy, una pausa desde el panel se deshace sola. Pedido al
 * backend → `.claude/plans/reglas-de-vencimiento.md`, §8.
 */

interface NotificationRuleRow {
  id: string
  source_type: string
  channel: string
  offset_unit: string
  offset_direction: string
  offset_value: number | string
  active: boolean
  created_at: Date | string
  updated_at: Date | string
  notification_count: number | string
  last_notification_at: Date | string | null
  sample_title: string | null
  sample_body: string | null
}

const toIso = (v: Date | string) => (v instanceof Date ? v.toISOString() : String(v))

/**
 * Una sola sentencia: la regla y su conteo salen del mismo snapshot.
 *
 * - El conteo es subconsulta ESCALAR y el ejemplo un `lateral … limit 1`: un
 *   `left join notifications` + `group by` multiplicaría la fila
 *   (`users.md`, trampa 2).
 * - `idx_notifications_rule_source_unique (rule_id, source_id)` es el índice
 *   que usan las dos — son 22 reglas y ~80 filas con `rule_id`, pero no hace
 *   falta un barrido de `notifications` por regla.
 * - Orden: por documento, días antes que km, y de más lejos a más cerca (30,
 *   15, 7…), que es como se lee un calendario de avisos.
 */
export async function listNotificationRules(
  opts: { signal?: AbortSignal } = {},
): Promise<Array<NotificationRule>> {
  void opts.signal // `pg` no acepta AbortSignal; queda documentado el hueco.

  const rows = await sql<NotificationRuleRow>(
    `
    select
      r.id,
      r.source_type::text as source_type,
      r.channel::text as channel,
      r.offset_unit::text as offset_unit,
      r.offset_direction::text as offset_direction,
      r.offset_value,
      r.active,
      r.created_at,
      r.updated_at,
      (select count(*)::int from notifications n where n.rule_id = r.id) as notification_count,
      last.created_at as last_notification_at,
      last.title as sample_title,
      last.body as sample_body
    from notification_rules r
    left join lateral (
      select n.created_at, n.title, n.body
        from notifications n
       where n.rule_id = r.id
       order by n.created_at desc
       limit 1
    ) last on true
    order by r.source_type, r.offset_unit, r.offset_direction, r.offset_value desc, r.id
    `,
  )

  // Explícito, campo por campo (`mapCensus`): un `notification_count` mal
  // mapeado se vería como "0 avisos", que acá se lee "esta regla nunca sonó".
  return rows.map(
    (r): NotificationRule => ({
      id: r.id,
      sourceType: r.source_type,
      channel: r.channel,
      offsetUnit: r.offset_unit,
      offsetDirection: r.offset_direction,
      offsetValue: Number(r.offset_value),
      active: r.active,
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
      notificationCount: Number(r.notification_count),
      lastNotificationAt: r.last_notification_at === null ? null : toIso(r.last_notification_at),
      sampleTitle: r.sample_title,
      sampleBody: r.sample_body,
    }),
  )
}
