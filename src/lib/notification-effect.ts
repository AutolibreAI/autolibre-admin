/**
 * Efecto de cada notificación en usuarios existentes — tarjeta "Panel admin:
 * medir el efecto de cada notificación en usuarios existentes".
 *
 * Una fila por envío, con una acción objetivo elegible y la conversión a 24 h /
 * 72 h / 7 días contra una base: la MISMA audiencia, en un período del mismo
 * largo ANTES del envío. La audiencia es sólo de usuarios que ya existían al
 * momento del envío.
 *
 * `/notificaciones/envios/:id` ya mide seis acciones "después", sin ventanas ni
 * base. Lo que falta para esto (ventanas, base, acción objetivo, audiencia
 * congelada) es del backend; hoy los números salen de `~/mocks/notification-effect`.
 * Los % y la diferencia contra la base se calculan acá.
 */

export const EFFECT_ACTIONS = ['vehicle', 'document', 'quote_request'] as const
export type EffectAction = (typeof EFFECT_ACTIONS)[number]

export const EFFECT_ACTION_LABELS: Record<EffectAction, string> = {
  vehicle: 'Cargar vehículo',
  document: 'Cargar documento',
  quote_request: 'Crear pedido',
}

export const EFFECT_WINDOWS = [
  { key: 'h24', label: '24 h', hours: 24 },
  { key: 'h72', label: '72 h', hours: 72 },
  { key: 'd7', label: '7 días', hours: 168 },
] as const
export type EffectWindowKey = (typeof EFFECT_WINDOWS)[number]['key']

/** `GET /admin/notification-sends/:id/effect?action=` — sólo conteos. */
export interface NotificationEffect {
  /** Alcanzados que existían al enviar y NO habían hecho la acción antes. */
  eligible: number
  /** De ésos, cuántos la hicieron dentro de cada ventana. */
  converted: Record<EffectWindowKey, number>
  /** La misma audiencia, en una ventana del mismo largo justo antes del envío. */
  baselineEligible: number
  baselineConverted: Record<EffectWindowKey, number>
}

export function rate(n: number, d: number): number | null {
  return d > 0 ? (n / d) * 100 : null
}

/** Puntos porcentuales sobre la base. `null` si alguno de los dos no está definido. */
export function lift(effect: NotificationEffect, w: EffectWindowKey): number | null {
  const after = rate(effect.converted[w], effect.eligible)
  const before = rate(effect.baselineConverted[w], effect.baselineEligible)
  return after === null || before === null ? null : after - before
}

/** Una ventana todavía no cerrada no se muestra como un cero. */
export function windowClosed(sentAt: string, hours: number, now: Date): boolean {
  return now.getTime() - new Date(sentAt).getTime() >= hours * 3_600_000
}
