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
 * Por qué no hay escrituras todavía: `.claude/plans/reglas-de-vencimiento.md`
 * (§3 y §8). Hasta que el backend conteste si su seed reactiva las reglas en
 * cada deploy, una pausa desde el panel podría deshacerse sola.
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
