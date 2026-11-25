import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import type { EffectAction } from '~/lib/notification-effect'
import { EFFECT_ACTIONS } from '~/lib/notification-effect'

/**
 * El «Objetivo» de un envío o una regla — migración 040, `ops.notification_target`.
 * Reemplazó al mock en memoria (`~/mocks/notification-targets`). Los envíos de
 * una regla lo heredan por `ops.notification_target_for` (corrida → regla).
 */

let seen = false
export async function notificationTargetsAvailable(): Promise<boolean> {
  if (seen) return true
  const row = await sqlOne<{ ok: boolean }>(`select to_regclass('ops.notification_target') is not null as ok`)
  seen = row?.ok === true
  return seen
}

const asAction = (v: string | null): EffectAction | null =>
  v !== null && (EFFECT_ACTIONS as ReadonlyArray<string>).includes(v) ? (v as EffectAction) : null

export interface SendTarget {
  action: EffectAction
  /** `envio` = elegido para este envío; `programado` = heredado de la regla. */
  source: 'envio' | 'programado'
}

/** Los objetivos de varios envíos por `broadcastId`. Sin la 040, vacío. */
export async function targetsForBroadcasts(ids: ReadonlyArray<string>): Promise<Record<string, SendTarget>> {
  if (ids.length === 0 || !(await notificationTargetsAvailable())) return {}
  const rows = await sql<{ id: string; action: string | null; source: string | null }>(
    `select b.id::text as id, t.action, t.source
       from unnest($1::uuid[]) as b(id)
       cross join lateral ops.notification_target_for(b.id) t`,
    [ids],
  )
  const out: Record<string, SendTarget> = {}
  for (const r of rows) {
    const action = asAction(r.action)
    if (action) out[r.id] = { action, source: r.source === 'programado' ? 'programado' : 'envio' }
  }
  return out
}

export async function scheduleTarget(scheduleId: string): Promise<EffectAction | null> {
  if (!(await notificationTargetsAvailable())) return null
  const row = await sqlOne<{ action: string }>(
    `select action from ops.notification_target where kind = 'programado' and ref_id = $1`,
    [scheduleId],
  )
  return asAction(row?.action ?? null)
}

export async function setNotificationTarget(
  kind: 'envio' | 'programado',
  refId: string,
  action: EffectAction | null,
  actorId: string,
): Promise<void> {
  if (!(await notificationTargetsAvailable())) throw new Error('NOTIFICATION_TARGETS_UNAVAILABLE')
  await sql(
    `select ops.set_notification_target(p_kind => $1, p_ref_id => $2, p_action => $3, p_actor_id => $4)`,
    [kind, refId, action, actorId],
  )
}
