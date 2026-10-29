import type { EffectAction, NotificationEffect } from '~/lib/notification-effect'

/**
 * ⚠ MOCK — conversiones inventadas.
 *
 * Reemplaza a: el registro de envíos (`notification_sends`, con la audiencia
 * congelada y la acción objetivo) + `GET /admin/notification-sends/:id/effect`.
 * Tarjeta "Panel admin: medir el efecto de cada notificación en usuarios
 * existentes".
 *
 * El envío, la fecha, el mensaje y los alcanzados que muestra la pantalla son
 * REALES; esto sólo inventa la conversión, a partir de un hash del id del envío
 * y la acción (estable entre recargas).
 */
export async function fetchNotificationEffectMock(
  broadcastId: string,
  action: EffectAction,
  reached: number,
): Promise<NotificationEffect> {
  let h = action.length * 7919
  for (let i = 0; i < broadcastId.length; i++) h = (h * 31 + broadcastId.charCodeAt(i)) >>> 0
  const r = (k: number) => ((h >>> k) % 100) / 100
  const eligible = Math.round(reached * (0.4 + r(1) * 0.5))
  const c7 = Math.round(eligible * (0.04 + r(3) * 0.12))
  const c72 = Math.round(c7 * (0.6 + r(5) * 0.3))
  const c24 = Math.round(c72 * (0.4 + r(7) * 0.4))
  const b7 = Math.round(eligible * (0.02 + r(9) * 0.06))
  return {
    eligible,
    converted: { h24: c24, h72: c72, d7: c7 },
    baselineEligible: eligible,
    baselineConverted: { h24: Math.round(b7 * 0.3), h72: Math.round(b7 * 0.6), d7: b7 },
  }
}
