import { createServerFn } from '@tanstack/react-start'
import { listNotificationRules } from '~/server/notification-rules.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { NotificationRule } from '~/lib/notification-rules'

/**
 * El borde RPC de las reglas de aviso por vencimiento. Sólo lectura.
 *
 * `adminMiddleware` aunque sean 22 reglas globales: el ejemplo de texto de cada
 * tarjeta es una notificación REAL ("El seguro de tu vehículo (Allianz, póliza
 * 2600…) vence el …"), con la aseguradora y la póliza de una persona. Un server
 * function es un endpoint HTTP público.
 */
export const listNotificationRulesFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<NotificationRule>> =>
    listNotificationRules({ signal: requestSignal() }),
  )
