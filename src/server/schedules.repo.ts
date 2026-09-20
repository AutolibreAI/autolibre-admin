import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import type {
  CreateNotificationScheduleInput,
  DeleteNotificationScheduleInput,
  NotificationScheduleDetail,
  NotificationScheduleListItem,
  NotificationScheduleSearch,
  SetNotificationScheduleActiveInput,
  UpdateNotificationScheduleInput,
} from '~/lib/notification-schedules'
import type { AudienceCondition } from '~/lib/audience'
import type { NotificationScheduleRecurrence } from '~/lib/notification-schedules'

/**
 * Reglas de notificación — Fase 2 de
 * `.claude/plans/notificaciones-automaticas.md`.
 *
 * ── Todo pasa por los SP de la migración 014 ────────────────────────────────
 *
 * `ops.notification_schedule` es una tabla PROPIA de `ops` (no de `public`),
 * pero igual se escribe sólo vía stored procedure: son ellos los que validan
 * la forma de `conditions`/`recurrence`, escriben `ops.action_log` con
 * `before`/`after`, y lockean con `FOR UPDATE` antes de editar. Un
 * `UPDATE ops.notification_schedule` suelto acá dejaría la fila sin
 * auditoría — mismo motivo que el resto de `ops-write-actions.md`, aplicado a
 * una tabla que el panel es dueño de crear.
 *
 * ── Ni una fila de `ops.notification_schedule_run` sale de acá ─────────────
 *
 * Esa tabla la escribe el cron (Fase 4, no implementada), sin actor y sin
 * sesión de Clerk — es la pieza que el plan deja abierta en su §3. Este
 * archivo sólo lee y escribe la DEFINICIÓN de la regla.
 */

const toInt = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v))
const toIsoDate = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v))
const toIsoDateOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : toIsoDate(v)

interface ScheduleRow {
  id: string
  name: string
  title: string
  body: string
  conditions: Array<AudienceCondition>
  recurrence: NotificationScheduleRecurrence
  starts_on: Date | string
  ends_on: Date | string | null
  max_per_user: number | string | null
  require_device: boolean
  exclude_internal: boolean
  active: boolean
  created_at: Date | string
  updated_at: Date | string
}

function mapSchedule(r: ScheduleRow): NotificationScheduleListItem {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    body: r.body,
    conditions: r.conditions,
    recurrence: r.recurrence,
    startsOn: toIsoDate(r.starts_on),
    endsOn: toIsoDateOrNull(r.ends_on),
    maxPerUser: toInt(r.max_per_user),
    requireDevice: r.require_device,
    excludeInternal: r.exclude_internal,
    active: r.active,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  }
}

const SELECT_COLUMNS = `
  id, name, title, body, conditions, recurrence, starts_on, ends_on,
  max_per_user, require_device, exclude_internal, active, created_at, updated_at
`

/**
 * El listado. `q` busca sobre `name` (columna cruda: no hace falta el
 * envoltorio `select * from (...) s` que otros repos necesitan para filtrar
 * sobre agregados — acá no hay ninguno).
 */
export async function listNotificationSchedules(
  search: NotificationScheduleSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<NotificationScheduleListItem>> {
  void opts.signal

  const params: Array<unknown> = []
  const where: Array<string> = []

  if (search.q) {
    params.push(`%${search.q}%`)
    where.push(`name ilike $${params.length}`)
  }
  if (search.scheduleState === 'active') where.push('active')
  if (search.scheduleState === 'paused') where.push('not active')

  const rows = await sql<ScheduleRow>(
    `select ${SELECT_COLUMNS}
       from ops.notification_schedule
       ${where.length ? `where ${where.join(' and ')}` : ''}
      order by created_at desc`,
    params,
  )

  return rows.map(mapSchedule)
}

export async function findNotificationSchedule(
  scheduleId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<NotificationScheduleDetail | null> {
  void opts.signal

  const row = await sqlOne<ScheduleRow>(
    `select ${SELECT_COLUMNS} from ops.notification_schedule where id = $1`,
    [scheduleId],
  )
  return row ? mapSchedule(row) : null
}

// ── Escrituras: sólo llamadas a los SP de la 014 ─────────────────────────────

interface SpRow {
  s: ScheduleRow | null
}

export async function createNotificationSchedule(
  input: CreateNotificationScheduleInput,
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<NotificationScheduleDetail> {
  void opts.signal

  const row = await sqlOne<SpRow>(
    `select ops.create_notification_schedule(
       p_name             => $1,
       p_title            => $2,
       p_body             => $3,
       p_conditions       => $4::jsonb,
       p_recurrence       => $5::jsonb,
       p_starts_on        => $6::date,
       p_actor_id         => $7,
       p_ends_on          => $8::date,
       p_max_per_user     => $9,
       p_require_device   => $10,
       p_exclude_internal => $11
     ) as s`,
    [
      input.name,
      input.title,
      input.body,
      JSON.stringify(input.conditions),
      JSON.stringify(input.recurrence),
      input.startsOn,
      actorId,
      input.endsOn ?? null,
      input.maxPerUser ?? null,
      input.requireDevice,
      input.excludeInternal,
    ],
  )
  if (!row?.s) throw new Error('SCHEDULE_CREATE_FAILED')
  return mapSchedule(row.s)
}

export async function updateNotificationSchedule(
  input: UpdateNotificationScheduleInput,
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<NotificationScheduleDetail> {
  void opts.signal

  const row = await sqlOne<SpRow>(
    `select ops.update_notification_schedule(
       p_schedule_id      => $1,
       p_name             => $2,
       p_title            => $3,
       p_body             => $4,
       p_conditions       => $5::jsonb,
       p_recurrence       => $6::jsonb,
       p_starts_on        => $7::date,
       p_actor_id         => $8,
       p_ends_on          => $9::date,
       p_max_per_user     => $10,
       p_require_device   => $11,
       p_exclude_internal => $12
     ) as s`,
    [
      input.scheduleId,
      input.name,
      input.title,
      input.body,
      JSON.stringify(input.conditions),
      JSON.stringify(input.recurrence),
      input.startsOn,
      actorId,
      input.endsOn ?? null,
      input.maxPerUser ?? null,
      input.requireDevice,
      input.excludeInternal,
    ],
  )
  if (!row?.s) throw new Error(`SCHEDULE_NOT_FOUND:${input.scheduleId}`)
  return mapSchedule(row.s)
}

export async function setNotificationScheduleActive(
  input: SetNotificationScheduleActiveInput,
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<NotificationScheduleDetail> {
  void opts.signal

  const row = await sqlOne<SpRow>(
    `select ops.set_notification_schedule_active(
       p_schedule_id => $1,
       p_active      => $2,
       p_actor_id    => $3,
       p_note        => $4
     ) as s`,
    [input.scheduleId, input.active, actorId, input.auditNote ?? null],
  )
  if (!row?.s) throw new Error(`SCHEDULE_NOT_FOUND:${input.scheduleId}`)
  return mapSchedule(row.s)
}

/** Devuelve `void`: tras borrarla no hay una fila que mostrar. */
export async function deleteNotificationSchedule(
  input: DeleteNotificationScheduleInput,
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  void opts.signal

  await sqlOne(
    `select ops.delete_notification_schedule(
       p_schedule_id => $1,
       p_actor_id    => $2,
       p_note        => $3
     ) as s`,
    [input.scheduleId, actorId, input.auditNote ?? null],
  )
}
