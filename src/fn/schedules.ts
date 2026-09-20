import { createServerFn } from '@tanstack/react-start'
import {
  createNotificationScheduleSchema,
  deleteNotificationScheduleSchema,
  notificationScheduleIdSchema,
  notificationScheduleSearchSchema,
  setNotificationScheduleActiveSchema,
  updateNotificationScheduleSchema,
} from '~/lib/notification-schedules'
import {
  createNotificationSchedule,
  deleteNotificationSchedule,
  findNotificationSchedule,
  listNotificationSchedules,
  setNotificationScheduleActive,
  updateNotificationSchedule,
} from '~/server/schedules.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type {
  NotificationScheduleDetail,
  NotificationScheduleListItem,
} from '~/lib/notification-schedules'

/**
 * El borde RPC de las reglas de notificación. Mismo guard que el resto de
 * `/notificaciones`: `conditions` describe a QUIÉN se le va a hablar (patente,
 * documentos, deuda), así que es tan sensible como el resto del padrón — un
 * server function es un endpoint HTTP público.
 *
 * El actor sale de `context.user.id`, NUNCA del payload — ningún schema de
 * `~/lib/notification-schedules` lo incluye. Mismo criterio que
 * `p_actor_id` en los SP de `ops` (`.claude/rules/ops-write-actions.md`).
 */

export const listNotificationSchedulesFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(notificationScheduleSearchSchema)
  .handler(async ({ data }): Promise<Array<NotificationScheduleListItem>> =>
    listNotificationSchedules(data, { signal: requestSignal() }),
  )

export const getNotificationScheduleFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(notificationScheduleIdSchema)
  .handler(async ({ data }): Promise<NotificationScheduleDetail> => {
    const detail = await findNotificationSchedule(data.scheduleId, { signal: requestSignal() })
    if (!detail) throw new Error(`SCHEDULE_NOT_FOUND:${data.scheduleId}`)
    return detail
  })

export const createNotificationScheduleFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(createNotificationScheduleSchema)
  .handler(({ data, context }): Promise<NotificationScheduleDetail> => {
    const signal = requestSignal()
    return createNotificationSchedule(data, context.user.id, { signal })
  })

export const updateNotificationScheduleFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(updateNotificationScheduleSchema)
  .handler(({ data, context }): Promise<NotificationScheduleDetail> => {
    const signal = requestSignal()
    return updateNotificationSchedule(data, context.user.id, { signal })
  })

export const setNotificationScheduleActiveFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(setNotificationScheduleActiveSchema)
  .handler(({ data, context }): Promise<NotificationScheduleDetail> => {
    const signal = requestSignal()
    return setNotificationScheduleActive(data, context.user.id, { signal })
  })

export const deleteNotificationScheduleFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(deleteNotificationScheduleSchema)
  .handler(({ data, context }): Promise<void> => {
    const signal = requestSignal()
    return deleteNotificationSchedule(data, context.user.id, { signal })
  })

/**
 * Traduce las sentinelas de los SP de la 014 a castellano de operador. Mismo
 * criterio que `readableBroadcastError` / `readableQuoteRequestError`: vive al
 * lado de quien las tira y se exporta para el cliente.
 */
export function readableScheduleError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)

  if (raw.startsWith('SCHEDULE_NOT_FOUND'))
    return 'Esta regla ya no existe — puede que otra persona la haya borrado.'
  if (raw.startsWith('SCHEDULE_HAS_RUNS'))
    return 'Ya mandó al menos un envío: para no perder el historial, pausala en vez de borrarla.'
  if (raw.startsWith('NAME_REQUIRED')) return 'Ponele un nombre a la regla.'
  if (raw.startsWith('INVALID_TITLE')) return 'El título tiene que tener entre 1 y 100 caracteres.'
  if (raw.startsWith('INVALID_BODY')) return 'El mensaje tiene que tener entre 1 y 500 caracteres.'
  if (raw.startsWith('INVALID_CONDITIONS_COUNT')) return 'Tiene que haber entre 1 y 8 condiciones.'
  if (raw.startsWith('INVALID_CONDITIONS')) return 'Las condiciones no tienen una forma válida.'
  if (raw.startsWith('INVALID_RECURRENCE_TIME'))
    return 'La hora tiene que estar entre 0 y 23, y los minutos ser 0, 15, 30 o 45.'
  if (raw.startsWith('INVALID_RECURRENCE_N')) return 'Los días tienen que estar entre 2 y 90.'
  if (raw.startsWith('INVALID_RECURRENCE_WEEKDAYS')) return 'Elegí al menos un día de la semana.'
  if (raw.startsWith('INVALID_RECURRENCE_DAY'))
    return 'El día del mes tiene que estar entre 1 y 28 — nunca 29-31, por febrero.'
  if (raw.startsWith('INVALID_RECURRENCE')) return 'La recurrencia no tiene una forma válida.'
  if (raw.startsWith('INVALID_ENDS_ON')) return 'La fecha de corte tiene que ser posterior a la de inicio.'
  if (raw.startsWith('INVALID_MAX_PER_USER')) return 'Si se pone un tope, tiene que ser 1 o más.'
  if (raw === 'UNAUTHENTICATED') return 'Tu sesión expiró. Volvé a iniciar sesión.'
  if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'

  return raw
}
