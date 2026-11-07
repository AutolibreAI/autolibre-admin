import type { EffectAction } from '~/lib/notification-effect'

/**
 * ⚠ MOCK — el objetivo (acción buscada) de cada envío no tiene dónde
 * guardarse.
 *
 * Reemplaza a: `notification_sends.targetAction` (envío puntual y programado)
 * y el campo equivalente del modelo único de reglas del backend. Ninguno de
 * los dos existe al 2026-11-06 (relevado: `to_regclass('public.notification_sends')`
 * es NULL en producción y no hay nada en el backend). Pedido en
 * `docs/necesidades-backend-admin.md` y `docs/pedido-backend-notificaciones.md`.
 *
 * En memoria del navegador, como el resto de `~/mocks`: se pierde al recargar.
 * Nada en `localStorage`. Las automatizaciones guardan su objetivo en su propio
 * mock (`notification-automations.ts`), adentro de la automatización.
 *
 * Clave: `envio:<broadcastId>` o `programado:<scheduleId>`.
 */
const store = new Map<string, EffectAction>()

const sendKey = (broadcastId: string) => `envio:${broadcastId}`
const scheduleKey = (scheduleId: string) => `programado:${scheduleId}`

export function setSendTargetMock(broadcastId: string, action: EffectAction | null): void {
  if (action) store.set(sendKey(broadcastId), action)
  else store.delete(sendKey(broadcastId))
}

export function getSendTargetMock(broadcastId: string): EffectAction | null {
  return store.get(sendKey(broadcastId)) ?? null
}

export function setScheduleTargetMock(scheduleId: string, action: EffectAction | null): void {
  if (action) store.set(scheduleKey(scheduleId), action)
  else store.delete(scheduleKey(scheduleId))
}

export function getScheduleTargetMock(scheduleId: string): EffectAction | null {
  return store.get(scheduleKey(scheduleId)) ?? null
}
