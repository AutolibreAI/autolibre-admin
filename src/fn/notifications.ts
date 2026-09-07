import { createServerFn } from '@tanstack/react-start'
import { notificationSearchSchema } from '~/lib/notifications'
import { listNotificationFacets, listNotifications } from '~/server/notifications.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { NotificationFacets, NotificationListItem } from '~/lib/notifications'

/**
 * El borde RPC de Notificaciones. Mismo guard que `users.ts` y `chats.ts`, y
 * acá pesa lo mismo: el cuerpo de una notificación incluye patente, vencimiento
 * de documentos y códigos de falla de personas reales. Un server function es un
 * endpoint HTTP público — sin `adminMiddleware` cualquier sesión válida de la
 * app se baja el historial de avisos de cualquiera con sólo saber el uuid.
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
