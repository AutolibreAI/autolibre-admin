import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
  broadcastNotificationSchema,
  notificationSearchSchema,
  recipientSearchSchema,
} from '~/lib/notifications'
import { audienceSchema } from '~/lib/audience'
import { campaignSearchSchema } from '~/lib/campaigns'
import {
  broadcastResult,
  listNotificationFacets,
  listNotifications,
  searchRecipients,
} from '~/server/notifications.repo'
import { previewAudience } from '~/server/audience.repo'
import { findCampaign, listCampaigns } from '~/server/campaigns.repo'
import { broadcastNotification } from '~/server/backend'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type {
  BroadcastResult,
  NotificationFacets,
  NotificationListItem,
  NotificationRecipient,
} from '~/lib/notifications'
import type { AudiencePreview } from '~/lib/audience'
import type { CampaignDetail, CampaignListItem } from '~/lib/campaigns'

/**
 * El borde RPC de Notificaciones. Mismo guard que `users.ts` y `chats.ts`, y
 * acá pesa lo mismo: el cuerpo de una notificación incluye patente, vencimiento
 * de documentos y códigos de falla de personas reales. Un server function es un
 * endpoint HTTP público — sin `adminMiddleware` cualquier sesión válida de la
 * app se baja el historial de avisos de cualquiera con sólo saber el uuid.
 *
 * Y desde el 2026-09-14 pesa más: `sendBroadcastNotification` le manda un push
 * a quien el llamador elija. El backend lo vuelve a chequear con `AdminGuard`,
 * y no es redundante — son dos sistemas y cada uno responde por lo suyo.
 */

export const listAppNotifications = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(notificationSearchSchema)
  .handler(async ({ data }): Promise<Array<NotificationListItem>> =>
    listNotifications(data, { signal: requestSignal() }),
  )

export const listAppNotificationFacets = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<NotificationFacets> =>
    listNotificationFacets({ signal: requestSignal() }),
  )

// ── Envío ad-hoc ─────────────────────────────────────────────────────────────

/**
 * Candidatos del compositor. Devuelve email y nombre de personas reales — por
 * eso el mismo guard que el padrón de `/usuarios`.
 */
export const searchNotificationRecipients = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(recipientSearchSchema)
  .handler(async ({ data }): Promise<Array<NotificationRecipient>> =>
    searchRecipients(data.q, { signal: requestSignal() }),
  )

/**
 * Da de alta la campaña en el backend. NO escribe Postgres: va por HTTP, con el
 * token del admin logueado. → `broadcastNotification` en `~/server/backend`.
 *
 * El actor no viaja en `data` y no puede: sale del token. El `broadcastId` sí
 * viaja, y es a propósito que lo genere el cliente — es la clave de
 * idempotencia, y un id generado acá sería nuevo en cada reintento.
 */
export const sendBroadcastNotification = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(broadcastNotificationSchema)
  .handler(async ({ data }): Promise<void> => {
    await broadcastNotification(data)
  })

/**
 * Lo que quedó en `notifications` para un `broadcastId`. Es la cuenta que el 204
 * del backend no da.
 */
export const getBroadcastResult = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ broadcastId: z.uuid() }))
  .handler(async ({ data }): Promise<BroadcastResult> =>
    broadcastResult(data.broadcastId, { signal: requestSignal() }),
  )

// ── Audiencias ───────────────────────────────────────────────────────────────

/**
 * Cuántos usuarios cumplen las condiciones, y quiénes son los primeros 500.
 *
 * **POST y no GET**, a diferencia del resto de las lecturas de este archivo: el
 * payload es un array de condiciones, y serializarlo en una query string lo
 * dejaría a merced del tope de largo de la URL. La regla de la casa es que el
 * método siga a la FORMA del pedido, no a si escribe: `searchNotificationRecipients`
 * es GET porque manda un string.
 *
 * `adminMiddleware` pesa lo mismo que en `/usuarios`: la respuesta trae email y
 * nombre de personas reales, y la pregunta misma ("¿quiénes no cargaron el
 * auto?") ya es dato del padrón.
 */
export const previewNotificationAudience = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(audienceSchema)
  .handler(async ({ data }): Promise<AudiencePreview> =>
    previewAudience(data, { signal: requestSignal() }),
  )

// ── Envíos ───────────────────────────────────────────────────────────────────

/**
 * Los envíos ad-hoc agrupados por `source_id`. No hay tabla de campañas: es un
 * `group by` sobre `notifications`. → `~/lib/campaigns`
 */
export const listNotificationCampaigns = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(campaignSearchSchema)
  .handler(async ({ data }): Promise<Array<CampaignListItem>> =>
    listCampaigns(data, { signal: requestSignal() }),
  )

/**
 * Un envío: quién lo recibió, en qué estado quedó, y qué hizo cada uno después.
 *
 * Devuelve `null` —y no una excepción— cuando el uuid no corresponde a ningún
 * envío: un link viejo a una campaña que nunca existió es un 404 de pantalla,
 * no un error de servidor.
 */
export const getNotificationCampaign = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ broadcastId: z.uuid() }))
  .handler(async ({ data }): Promise<CampaignDetail | null> =>
    findCampaign(data.broadcastId, { signal: requestSignal() }),
  )

/**
 * Traduce las sentinelas del envío a castellano de operador.
 *
 * Vive al lado de quien las tira (este archivo y `~/server/backend`), mismo
 * criterio que `readableManualError`. Se exporta para el cliente: no toca nada
 * de `~/server`, así que cruzar el borde es seguro.
 *
 * Varios mensajes repiten "el mismo envío no duplica" y no es relleno: es lo
 * que le dice al operador que REINTENTAR es seguro, que es la duda que tiene
 * justo cuando algo falló.
 */
export function readableBroadcastError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)

  if (raw.startsWith('BROADCAST_REJECTED:')) {
    const detail = raw.slice('BROADCAST_REJECTED:'.length).trim()
    return (
      'El backend rechazó el envío entero (400) y no creó ninguna notificación. ' +
      'Lo más probable: uno de los destinatarios ya no existe — un solo id ' +
      'inválido tira el lote completo. Sacalo y volvé a enviar.' +
      (detail ? ` Detalle del backend: ${detail}` : '')
    )
  }

  if (raw === 'BACKEND_UNAUTHENTICATED')
    return 'El backend no aceptó tu sesión. Cerrá sesión, volvé a entrar y reintentá: el mismo envío no duplica.'
  if (raw === 'BACKEND_FORBIDDEN')
    return 'El backend dice que tu usuario no es admin. El backend lee el rol de SU base: si el panel apunta a otra base (desarrollo contra producción), los roles no tienen por qué coincidir.'

  if (raw.startsWith('BACKEND_ERROR:')) {
    const [, status, ...rest] = raw.split(':')
    return `El backend respondió ${status}: ${rest.join(':')}`
  }

  if (raw === 'UNAUTHENTICATED') return 'Tu sesión expiró. Volvé a iniciar sesión.'
  if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'

  if (raw.includes('AUTOLIBRE_BACKEND_URL'))
    return 'El panel no sabe a qué backend hablarle: falta configurar AUTOLIBRE_BACKEND_URL.'

  // `AbortSignal.timeout` tira un DOMException llamado TimeoutError. Acá el
  // envío PUDO haberse creado: el backend puede terminar el INSERT después de
  // que dejamos de esperar.
  if (raw.includes('timed out') || raw.includes('TimeoutError'))
    return 'El backend tardó demasiado y no sabemos si llegó a crear el envío. Reintentá sin cambiar nada: el mismo envío no duplica.'

  // `fetch` de Node tira `TypeError: fetch failed` cuando ni conecta.
  if (raw.includes('fetch failed') || raw.includes('ECONNREFUSED'))
    return 'El panel no pudo conectarse con el backend. Fijate que esté arriba y que AUTOLIBRE_BACKEND_URL apunte bien.'

  return raw
}
