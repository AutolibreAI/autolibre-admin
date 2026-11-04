import { z } from 'zod'

/**
 * Efecto de cada notificación en usuarios existentes — tarjeta "Panel admin:
 * medir el efecto de cada notificación en usuarios existentes".
 *
 * Una fila por envío, con una acción objetivo elegible y la conversión a 24 h /
 * 72 h / 7 días contra una base: la MISMA audiencia, en una ventana del mismo
 * largo ANTES del envío. La audiencia es sólo de usuarios que ya existían al
 * momento del envío: las altas posteriores no entran.
 *
 * ── Desde el 2026-11-03 es REAL, sin backend nuevo ──────────────────────────
 *
 * Hasta acá los números salían de `~/mocks/notification-effect` porque se
 * asumía que faltaba "el registro de envíos con la audiencia congelada". No
 * falta para esto: las filas de `notifications` con `source_type = 'broadcast'`
 * y el mismo `source_id` SON la audiencia de cada envío, una por persona, con
 * su momento (`coalesce(sent_at, scheduled_at)`). Lo calcula
 * `notificationEffect()` en `~/server/campaigns.repo`, el mismo archivo que ya
 * mide "qué hizo después" en `/notificaciones/envios/:id`.
 *
 * Lo que SIGUE faltando del backend: guardar la acción objetivo de cada envío
 * (`targetAction`). Hoy se elige en pantalla y no se guarda.
 *
 * ── La base tiene un sesgo que la pantalla dice en voz alta ─────────────────
 *
 * Si la audiencia se armó con "no hizo X" (ej. "usuarios sin vehículo"), en la
 * ventana previa NADIE de esa audiencia pudo haber hecho X —si lo hubiera hecho,
 * no estaría en la audiencia—, así que la base da 0 por construcción y la
 * diferencia exagera el efecto. Se detecta por la forma del resultado
 * (`audienceLooksSelectedByAction`), no se adivina la condición: no está
 * guardada en ningún lado.
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

export const notificationEffectInputSchema = z.object({
  broadcastId: z.uuid(),
  action: z.enum(EFFECT_ACTIONS),
})

export interface EffectBaseline {
  /** De la audiencia, los que existían al EMPEZAR la ventana previa y no habían hecho la acción todavía. */
  eligible: number
  /** De ésos, cuántos la hicieron dentro de la ventana previa (que termina en el envío). */
  converted: number
}

/** Sólo conteos: ningún dato de persona sale de esta consulta. */
export interface NotificationEffect {
  /** Filas del envío (una por persona). */
  reached: number
  /** De los alcanzados, los que tenían cuenta antes del envío. */
  existed: number
  /** De ésos, los que NO habían hecho la acción antes del envío: el denominador. */
  eligible: number
  /** De los `eligible`, cuántos la hicieron dentro de cada ventana después del envío. */
  converted: Record<EffectWindowKey, number>
  /** La misma audiencia, en una ventana del mismo largo justo antes del envío. */
  baseline: Record<EffectWindowKey, EffectBaseline>
  /** Canales de las filas del envío (`notification_channel`). */
  channels: Array<string>
  /** `false` si la acción es «Crear pedido» y la base no tiene `quote_requests`. */
  available: boolean
}

export function rate(n: number, d: number): number | null {
  return d > 0 ? (n / d) * 100 : null
}

/** Puntos porcentuales sobre la base. `null` si alguno de los dos no está definido. */
export function lift(effect: NotificationEffect, w: EffectWindowKey): number | null {
  const after = rate(effect.converted[w], effect.eligible)
  const before = rate(effect.baseline[w].converted, effect.baseline[w].eligible)
  return after === null || before === null ? null : after - before
}

/**
 * Si casi todos los que existían NO habían hecho la acción antes del envío, lo
 * más probable es que la audiencia se haya armado con esa condición. Corte fijo:
 * el 95 %. Con eso la base da ~0 por construcción (ver la cabecera).
 */
export const AUDIENCE_SELECTED_SHARE = 0.95

export function audienceLooksSelectedByAction(effect: NotificationEffect): boolean {
  return effect.existed > 0 && effect.eligible / effect.existed >= AUDIENCE_SELECTED_SHARE
}

/** Una ventana todavía no cerrada no se muestra como un cero. */
export function windowClosed(sentAt: string, hours: number, now: Date): boolean {
  return now.getTime() - new Date(sentAt).getTime() >= hours * 3_600_000
}

const CHANNEL_LABELS: Record<string, string> = { push: 'Push', email: 'Mail', sms: 'SMS' }

export function effectChannelLabel(channels: ReadonlyArray<string>): string {
  return channels.length === 0 ? '—' : channels.map((c) => CHANNEL_LABELS[c] ?? c).join(' · ')
}
