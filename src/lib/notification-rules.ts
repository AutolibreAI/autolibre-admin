import { z } from 'zod'
import { NOTIFICATION_SOURCE_LABELS } from './notifications'

/**
 * Las reglas de aviso por vencimiento — `public.notification_rules`, del
 * BACKEND. No confundir con `~/lib/notification-schedules`, que son las reglas
 * que crea el panel (`ops.notification_schedule`, migración 014): son dos
 * motores distintos y el código no los mezcla. En la UI se llaman
 * "Recordatorios de vencimiento" y "Envíos programados".
 *
 * Una regla es un offset contra la fecha de un documento ("7 días antes de que
 * venza la VTV"): el backend corre cada hora y crea la notificación cuando el
 * offset se cumple. El TEXTO no está en la tabla — lo arma el backend en
 * código —, así que acá sólo se lee.
 *
 * Desde el 2026-11-19 se crean, pausan y reactivan por HTTP
 * (`POST /admin/notification-rules`, `PATCH /admin/notification-rules/:id`,
 * `AdminGuard`). El backend contestó la duda del plan (§8): el seed es un
 * script manual que falla ante una tupla existente, así que una pausa desde el
 * panel sobrevive a los deploys. Ni un `INSERT`/`UPDATE` por SQL.
 */

export interface NotificationRule {
  id: string
  /** `notification_source_type` crudo: `insurance`, `vehicle_inspection`, … */
  sourceType: string
  /** `push | email | sms`. Hoy todas son `push`. */
  channel: string
  /** `days | km`. */
  offsetUnit: string
  /** `before | after`. Hoy todas son `before`. */
  offsetDirection: string
  offsetValue: number
  active: boolean
  createdAt: string
  updatedAt: string
  /** Cuántas notificaciones generó esta regla (`notifications.rule_id`). */
  notificationCount: number
  /** La última que generó. `null` con 0 avisos — nunca sonó, no es un error. */
  lastNotificationAt: string | null
  /** Título y cuerpo REALES de esa última: el ejemplo del texto que arma el backend. */
  sampleTitle: string | null
  sampleBody: string | null
}

/**
 * El orden de las tarjetas: lo que más suena primero. Un `source_type` que no
 * esté acá (una regla nueva de cédula, de multas…) va al final, no se esconde.
 */
export const NOTIFICATION_RULE_SOURCE_ORDER: ReadonlyArray<string> = [
  'insurance',
  'vehicle_inspection',
  'driver_license',
  'maintenance_occurrence',
]

/** Misma tabla de etiquetas que el Historial; un valor sin label sale CRUDO. */
export const ruleSourceLabel = (sourceType: string) =>
  NOTIFICATION_SOURCE_LABELS[sourceType] ?? sourceType

const UNIT_LABELS: Record<string, [singular: string, plural: string]> = {
  days: ['día', 'días'],
  km: ['km', 'km'],
}

const DIRECTION_LABELS: Record<string, string> = {
  before: 'antes',
  after: 'después',
}

/**
 * "30 días antes", "100 km antes", "3 días después". `0 días` es "el día que
 * vence": el CHECK de la tabla es `>= 0`, así que es representable. Un valor de
 * enum sin label se muestra crudo en vez de inventarle una traducción.
 */
export function describeOffset(rule: Pick<NotificationRule, 'offsetUnit' | 'offsetDirection' | 'offsetValue'>) {
  if (rule.offsetUnit === 'days' && rule.offsetValue === 0) return 'El día que vence'
  const units = UNIT_LABELS[rule.offsetUnit]
  const unit = units ? (rule.offsetValue === 1 ? units[0] : units[1]) : rule.offsetUnit
  const direction = DIRECTION_LABELS[rule.offsetDirection] ?? rule.offsetDirection
  return `${rule.offsetValue} ${unit} ${direction}`
}

/** "Seguro · 30 días antes" — la etiqueta de UNA regla fuera de su tarjeta (el Historial). */
export const describeRule = (
  rule: Pick<NotificationRule, 'sourceType' | 'offsetUnit' | 'offsetDirection' | 'offsetValue'>,
) => `${ruleSourceLabel(rule.sourceType)} · ${describeOffset(rule).toLowerCase()}`

export interface NotificationRuleGroup {
  sourceType: string
  rules: Array<NotificationRule>
  notificationCount: number
  /** El ejemplo de texto de la tarjeta: el de la notificación más reciente del grupo. */
  sample: { title: string; body: string; at: string } | null
}

/**
 * Agrupa por documento, en el orden de `NOTIFICATION_RULE_SOURCE_ORDER`. Dentro
 * de cada tarjeta el orden lo trae el SQL (días antes que km, de más lejos a más
 * cerca). Se hace en JS y no en SQL porque es presentación: el grano de la
 * consulta sigue siendo la regla.
 */
export function groupNotificationRules(rules: Array<NotificationRule>): Array<NotificationRuleGroup> {
  const bySource = new Map<string, Array<NotificationRule>>()
  for (const r of rules) {
    const list = bySource.get(r.sourceType)
    if (list) list.push(r)
    else bySource.set(r.sourceType, [r])
  }

  const rank = (s: string) => {
    const i = NOTIFICATION_RULE_SOURCE_ORDER.indexOf(s)
    return i === -1 ? NOTIFICATION_RULE_SOURCE_ORDER.length : i
  }

  return [...bySource.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([sourceType, list]) => {
      let sample: NotificationRuleGroup['sample'] = null
      for (const r of list) {
        if (r.lastNotificationAt && r.sampleTitle !== null && r.sampleBody !== null) {
          if (!sample || r.lastNotificationAt > sample.at) {
            sample = { title: r.sampleTitle, body: r.sampleBody, at: r.lastNotificationAt }
          }
        }
      }
      return {
        sourceType,
        rules: list,
        notificationCount: list.reduce((acc, r) => acc + r.notificationCount, 0),
        sample,
      }
    })
}

// ── Escrituras (HTTP, backend feat/notifications-admin-rules) ───────────────

/**
 * Los `source_type` que el backend deja crear y pausar: los que tienen un cron
 * de detección. Otro (las 5 filas viejas de `registration_card`, multas…) da
 * 400, así que esas filas NO muestran el control.
 */
export const MANAGEABLE_RULE_SOURCES = [
  'insurance',
  'vehicle_inspection',
  'driver_license',
  'maintenance_occurrence',
] as const
export type ManageableRuleSource = (typeof MANAGEABLE_RULE_SOURCES)[number]

export const isManageableRuleSource = (s: string): s is ManageableRuleSource =>
  (MANAGEABLE_RULE_SOURCES as ReadonlyArray<string>).includes(s)

export const RULE_OFFSET_UNITS = ['days', 'km'] as const
export type RuleOffsetUnit = (typeof RULE_OFFSET_UNITS)[number]

/** Los km sólo existen para mantenimiento: es el único vencimiento por kilometraje. */
export const unitsForSource = (s: ManageableRuleSource): ReadonlyArray<RuleOffsetUnit> =>
  s === 'maintenance_occurrence' ? RULE_OFFSET_UNITS : ['days']

export const RULE_OFFSET_MAX = 10_000

/**
 * Espejo del DTO del backend. Canal (`push`) y dirección (`before`) no viajan:
 * el backend los fija, porque los crons sólo evalúan "antes" y push es el único
 * proveedor.
 */
export const createNotificationRuleSchema = z
  .object({
    sourceType: z.enum(MANAGEABLE_RULE_SOURCES),
    offsetUnit: z.enum(RULE_OFFSET_UNITS),
    offsetValue: z.number().int().min(0).max(RULE_OFFSET_MAX),
  })
  .refine((v) => v.offsetUnit === 'days' || v.sourceType === 'maintenance_occurrence', {
    message: 'Los km sólo valen para mantenimiento.',
    path: ['offsetUnit'],
  })
export type CreateNotificationRuleInput = z.infer<typeof createNotificationRuleSchema>

export const setNotificationRuleActiveSchema = z.object({
  ruleId: z.uuid(),
  active: z.boolean(),
})

/** La regla no se puede manejar desde el panel (tipo viejo). Se corta ANTES del fetch. */
export const NOTIFICATION_RULE_NOT_MANAGEABLE = 'NOTIFICATION_RULE_NOT_MANAGEABLE'
export const NOTIFICATION_RULE_NOT_FOUND = 'NOTIFICATION_RULE_NOT_FOUND'

/** Sentinela del modo `notificationRule` de `backendError`: `NOTIFICATION_RULE_ERROR:` + JSON. */
export const NOTIFICATION_RULE_ERROR = 'NOTIFICATION_RULE_ERROR'

export interface NotificationRuleError {
  status: number
  code: string
  message: string
  /** Sólo en el 409 del alta: la regla que ya existe con esa tupla. */
  existingRuleId: string | null
  existingRuleActive: boolean | null
  /** 404 «Cannot POST/PATCH»: el backend desplegado no tiene la ruta. */
  cannotRoute: boolean
}

export function parseNotificationRuleError(cause: unknown): NotificationRuleError | null {
  const raw = cause instanceof Error ? cause.message : String(cause)
  if (!raw.startsWith(`${NOTIFICATION_RULE_ERROR}:`)) return null
  try {
    const j = JSON.parse(raw.slice(NOTIFICATION_RULE_ERROR.length + 1)) as Partial<NotificationRuleError>
    return {
      status: typeof j.status === 'number' ? j.status : 0,
      code: typeof j.code === 'string' ? j.code : '',
      message: typeof j.message === 'string' ? j.message : '',
      existingRuleId: typeof j.existingRuleId === 'string' ? j.existingRuleId : null,
      existingRuleActive: typeof j.existingRuleActive === 'boolean' ? j.existingRuleActive : null,
      cannotRoute: j.cannotRoute === true,
    }
  } catch {
    return null
  }
}

/** El texto de un error de alta / pausa / reactivación. */
export function readableNotificationRuleError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  if (raw === NOTIFICATION_RULE_NOT_MANAGEABLE)
    return 'Este tipo de recordatorio no se puede pausar ni reactivar: el backend ya no lo conoce.'
  if (raw === NOTIFICATION_RULE_NOT_FOUND) return 'Esa regla ya no existe; recargá.'
  if (raw === 'UNAUTHENTICATED') return 'Tu sesión expiró. Cerrá sesión y volvé a entrar.'
  if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'
  if (raw.startsWith('BACKEND_UNREACHABLE:')) {
    const url = raw.slice('BACKEND_UNREACHABLE:'.length)
    return `El panel no llega al backend en ${url}. En producción es la variable AUTOLIBRE_BACKEND_URL de Vercel; en desarrollo, si no está en el .env, el panel usa localhost:3005 y el backend tiene que estar corriendo ahí.`
  }
  if (raw.includes('AUTOLIBRE_BACKEND_URL')) return 'Falta configurar AUTOLIBRE_BACKEND_URL.'
  const e = parseNotificationRuleError(cause)
  if (e) {
    if (e.status === 401) return 'El backend no aceptó tu sesión. Cerrá sesión y volvé a entrar.'
    if (e.status === 403) return 'Tu usuario no es admin en el backend.'
    if (e.cannotRoute)
      return 'El backend al que le habla el panel no tiene todavía la gestión de recordatorios (`/admin/notification-rules`): falta desplegarla.'
    if (e.status === 404) return 'Esa regla ya no existe; recargá.'
    if (e.status === 409)
      return e.existingRuleActive === false
        ? 'Ya existe ese recordatorio, pausado. Reactivalo en vez de crear otro.'
        : 'Ya existe ese recordatorio y está activo.'
    if (e.status === 400) return `El backend rechazó el pedido: «${e.message}».`
    return `El backend respondió ${e.status}: ${e.message}`
  }
  return raw || 'Falló sin explicación.'
}
