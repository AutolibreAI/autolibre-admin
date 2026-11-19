import { createServerFn } from '@tanstack/react-start'
import { findNotificationRuleSource, listNotificationRules } from '~/server/notification-rules.repo'
import { createNotificationRule, setNotificationRuleActive } from '~/server/backend'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import {
  NOTIFICATION_RULE_NOT_FOUND,
  NOTIFICATION_RULE_NOT_MANAGEABLE,
  createNotificationRuleSchema,
  isManageableRuleSource,
  setNotificationRuleActiveSchema,
  type NotificationRule,
} from '~/lib/notification-rules'

/**
 * El borde RPC de las reglas de aviso por vencimiento. Lee por SQL; crea, pausa
 * y reactiva por HTTP contra el backend (`/admin/notification-rules`).
 *
 * `adminMiddleware` aunque sean reglas globales: el ejemplo de texto de cada
 * tarjeta es una notificación REAL ("El seguro de tu vehículo (Allianz, póliza
 * 2600…) vence el …"), con la aseguradora y la póliza de una persona. Un server
 * function es un endpoint HTTP público.
 */
export const listNotificationRulesFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<NotificationRule>> =>
    listNotificationRules({ signal: requestSignal() }),
  )

/** Alta. Un 409 vuelve como `NOTIFICATION_RULE_ERROR:` con la regla existente. */
export const createNotificationRuleFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(createNotificationRuleSchema)
  .handler(async ({ data }): Promise<{ id: string }> => createNotificationRule(data))

/**
 * Pausa o reactiva. Antes del fetch se mira el tipo por SQL: las filas viejas de
 * `registration_card` darían 400, y una inexistente 404.
 */
export const setNotificationRuleActiveFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(setNotificationRuleActiveSchema)
  .handler(async ({ data }): Promise<void> => {
    const source = await findNotificationRuleSource(data.ruleId)
    if (source === null) throw new Error(NOTIFICATION_RULE_NOT_FOUND)
    if (!isManageableRuleSource(source)) throw new Error(NOTIFICATION_RULE_NOT_MANAGEABLE)
    await setNotificationRuleActive(data.ruleId, data.active)
  })
