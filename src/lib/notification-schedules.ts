import { z } from 'zod'
import { AUDIENCE_MAX_CONDITIONS, audienceConditionSchema, type AudienceCondition } from './audience'
import { BROADCAST_BODY_MAX, BROADCAST_TITLE_MAX } from './notifications'

/**
 * Reglas de notificación — envíos automáticos recurrentes.
 * `.claude/plans/notificaciones-automaticas.md` es el plan completo; este
 * archivo es su Fase 2 (§11 de ese plan).
 *
 * ── Lo que ESTO no hace todavía ──────────────────────────────────────────────
 *
 * Una regla guardada acá no le manda un push a nadie. El motor que las evalúa
 * y dispara (Fase 4 del plan) está bloqueado por una decisión de
 * autenticación que el plan deja abierta a propósito (§3: `auth()` de Clerk no
 * existe adentro de un cron, y `POST /notifications/broadcast` exige un admin
 * logueado). Las reglas se crean, se editan, se pausan/reaniman y se borran —
 * eso es todo lo que hay hasta que esa decisión se tome.
 *
 * ── El catálogo de condiciones es el MISMO que el envío ad-hoc ──────────────
 *
 * `conditions` es literal `Array<AudienceCondition>` de `~/lib/audience`: el
 * mismo catálogo cerrado de 29 campos, los mismos operadores, la misma regla
 * de "sólo Y, nunca O". No hay un lenguaje de condiciones nuevo — lo único
 * nuevo acá es CUÁNDO se evalúa esa audiencia (la recurrencia) y que se
 * guarde en vez de resolverse una sola vez.
 *
 * ── La recurrencia es un catálogo cerrado, nunca un cron string ─────────────
 *
 * Dos motivos, del plan (§4):
 *
 *  1. Lo que viaja por HTTP tiene que ser un enum cerrado con enteros
 *     validados, no una expresión que el servidor interpreta — mismo
 *     argumento que `AUDIENCE_SQL`.
 *  2. El paso "cada 2" en día-del-mes de un cron NO es "día por medio": es
 *     "los días 1, 3, 5 … 31", y el 31 al 1 son DOS días seguidos.
 *     `everyNDays` evita esa trampa contando desde un ancla (`startsOn`), no
 *     desde el calendario.
 *
 * La zona horaria es Buenos Aires, fija y no configurable — "19hs" es 19hs
 * acá. Eso se aplica del lado del servidor (Fase 4), nunca acá.
 */

// ── Recurrencia ──────────────────────────────────────────────────────────────

export const NOTIFICATION_SCHEDULE_KINDS = ['daily', 'everyNDays', 'weekly', 'monthlyDay'] as const
export type NotificationScheduleKind = (typeof NOTIFICATION_SCHEDULE_KINDS)[number]

export const NOTIFICATION_SCHEDULE_KIND_LABELS: Record<NotificationScheduleKind, string> = {
  daily: 'Todos los días',
  everyNDays: 'Cada N días',
  weekly: 'Días de la semana',
  monthlyDay: 'Un día del mes',
}

/** `atMinute` sólo admite cuartos — nadie necesita las 19:07. */
export const NOTIFICATION_SCHEDULE_MINUTES = [0, 15, 30, 45] as const

export const NOTIFICATION_SCHEDULE_N_MIN = 2
export const NOTIFICATION_SCHEDULE_N_MAX = 90

/** Nunca 29–31: no todos los meses los tienen. */
export const NOTIFICATION_SCHEDULE_MONTH_DAY_MAX = 28

export const WEEKDAY_LABELS: ReadonlyArray<string> = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
]
export const WEEKDAY_SHORT_LABELS: ReadonlyArray<string> = ['D', 'L', 'M', 'M', 'J', 'V', 'S']

const timeFields = {
  atHour: z.number().int().min(0).max(23),
  atMinute: z.number().int().refine((v) => (NOTIFICATION_SCHEDULE_MINUTES as ReadonlyArray<number>).includes(v), {
    message: 'Tiene que ser 0, 15, 30 o 45.',
  }),
}

/**
 * Unión discriminada por `kind`. Cada rama trae sólo los campos que ese tipo
 * de recurrencia necesita — un `everyNDays` sin `n` o un `weekly` sin
 * `weekdays` no compila, en vez de fallar recién contra el SP.
 */
export const notificationScheduleRecurrenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), ...timeFields }),
  z.object({
    kind: z.literal('everyNDays'),
    n: z.number().int().min(NOTIFICATION_SCHEDULE_N_MIN).max(NOTIFICATION_SCHEDULE_N_MAX),
    ...timeFields,
  }),
  z.object({
    kind: z.literal('weekly'),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1, 'Elegí al menos un día.'),
    ...timeFields,
  }),
  z.object({
    kind: z.literal('monthlyDay'),
    day: z.number().int().min(1).max(NOTIFICATION_SCHEDULE_MONTH_DAY_MAX),
    ...timeFields,
  }),
])

export type NotificationScheduleRecurrence = z.infer<typeof notificationScheduleRecurrenceSchema>

/** El default de cada `kind`, para que cambiar de tipo en el formulario deje una recurrencia VÁLIDA. */
export function defaultRecurrence(kind: NotificationScheduleKind): NotificationScheduleRecurrence {
  switch (kind) {
    case 'daily':
      return { kind: 'daily', atHour: 19, atMinute: 0 }
    case 'everyNDays':
      return { kind: 'everyNDays', n: 2, atHour: 19, atMinute: 0 }
    case 'weekly':
      return { kind: 'weekly', weekdays: [0], atHour: 18, atMinute: 0 }
    case 'monthlyDay':
      return { kind: 'monthlyDay', day: 1, atHour: 9, atMinute: 0 }
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** La recurrencia en castellano — para el listado y la ficha. */
export function describeRecurrence(r: NotificationScheduleRecurrence): string {
  const at = `a las ${pad2(r.atHour)}:${pad2(r.atMinute)}`
  switch (r.kind) {
    case 'daily':
      return `Todos los días, ${at}`
    case 'everyNDays':
      return `Cada ${r.n} días, ${at}`
    case 'weekly':
      return `${r.weekdays
        .slice()
        .sort((a, b) => a - b)
        .map((d) => WEEKDAY_LABELS[d])
        .join(', ')}, ${at}`
    case 'monthlyDay':
      return `El día ${r.day} de cada mes, ${at}`
  }
}

// ── Condiciones (reusa el catálogo de audiencias) ───────────────────────────

export const notificationScheduleConditionsSchema = z
  .array(audienceConditionSchema)
  .min(1, 'Agregá al menos una condición.')
  .max(AUDIENCE_MAX_CONDITIONS, `Hasta ${AUDIENCE_MAX_CONDITIONS} condiciones.`)

// ── Fechas (date, no timestamp) ──────────────────────────────────────────────

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido (AAAA-MM-DD).')

// ── El payload compartido por alta y edición ────────────────────────────────

const scheduleFields = {
  name: z.string().trim().min(1, 'Ponele un nombre — es lo que el equipo va a ver en la lista.').max(120),
  title: z
    .string()
    .trim()
    .min(1, 'El título no puede quedar vacío.')
    .max(BROADCAST_TITLE_MAX, `El título admite hasta ${BROADCAST_TITLE_MAX} caracteres.`),
  body: z
    .string()
    .trim()
    .min(1, 'El mensaje no puede quedar vacío.')
    .max(BROADCAST_BODY_MAX, `El mensaje admite hasta ${BROADCAST_BODY_MAX} caracteres.`),
  conditions: notificationScheduleConditionsSchema,
  recurrence: notificationScheduleRecurrenceSchema,
  startsOn: isoDate,
  endsOn: isoDate.optional(),
  maxPerUser: z.number().int().min(1).optional(),
  requireDevice: z.boolean().default(true),
  excludeInternal: z.boolean().default(true),
}

export const createNotificationScheduleSchema = z.object(scheduleFields)
export type CreateNotificationScheduleInput = z.infer<typeof createNotificationScheduleSchema>

export const updateNotificationScheduleSchema = z.object({
  scheduleId: z.uuid(),
  ...scheduleFields,
})
export type UpdateNotificationScheduleInput = z.infer<typeof updateNotificationScheduleSchema>

export const notificationScheduleIdSchema = z.object({ scheduleId: z.uuid() })

export const setNotificationScheduleActiveSchema = z.object({
  scheduleId: z.uuid(),
  active: z.boolean(),
  auditNote: z.string().trim().max(500).optional(),
})
export type SetNotificationScheduleActiveInput = z.infer<typeof setNotificationScheduleActiveSchema>

export const deleteNotificationScheduleSchema = z.object({
  scheduleId: z.uuid(),
  auditNote: z.string().trim().max(500).optional(),
})
export type DeleteNotificationScheduleInput = z.infer<typeof deleteNotificationScheduleSchema>

// ── Search params ────────────────────────────────────────────────────────────

export const NOTIFICATION_SCHEDULE_STATE_FILTERS = ['all', 'active', 'paused'] as const
export type NotificationScheduleStateFilter = (typeof NOTIFICATION_SCHEDULE_STATE_FILTERS)[number]

/**
 * `scheduleState`, calificado por dominio: `state` ya lo usan
 * `/vehiculos/listado` y `/usuarios` con sus propios enums, y el merge de
 * `FullSearchSchema` de TanStack rompe el typecheck en la ruta AJENA.
 * → `.claude/rules/notifications.md`
 */
export const notificationScheduleSearchSchema = z.object({
  q: z.string().trim().max(120).optional(),
  scheduleState: z.enum(NOTIFICATION_SCHEDULE_STATE_FILTERS).catch('all').default('all'),
})
export type NotificationScheduleSearch = z.infer<typeof notificationScheduleSearchSchema>

// ── Forma de fila ────────────────────────────────────────────────────────────

export interface NotificationScheduleListItem {
  id: string
  name: string
  title: string
  body: string
  conditions: Array<AudienceCondition>
  recurrence: NotificationScheduleRecurrence
  startsOn: string
  endsOn: string | null
  maxPerUser: number | null
  requireDevice: boolean
  excludeInternal: boolean
  active: boolean
  createdAt: string
  updatedAt: string
}

export type NotificationScheduleDetail = NotificationScheduleListItem
