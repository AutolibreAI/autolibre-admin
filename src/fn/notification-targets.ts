import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { EFFECT_ACTIONS, type EffectAction } from '~/lib/notification-effect'
import {
  notificationTargetsAvailable,
  scheduleTarget,
  setNotificationTarget,
  targetsForBroadcasts,
  type SendTarget,
} from '~/server/notification-targets.repo'
import { adminMiddleware } from './middleware'

/** El «Objetivo» de los envíos (040). El actor sale de la sesión. */

export const setNotificationTargetFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(
    z.object({
      kind: z.enum(['envio', 'programado']),
      refId: z.string().uuid(),
      action: z.enum(EFFECT_ACTIONS).nullable(),
    }),
  )
  .handler(async ({ data, context }) => {
    await setNotificationTarget(data.kind, data.refId, data.action, context.user.id)
    return { ok: true as const }
  })

export const getScheduleTargetFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ scheduleId: z.string().uuid() }))
  .handler(async ({ data }): Promise<{ available: boolean; action: EffectAction | null }> => ({
    available: await notificationTargetsAvailable(),
    action: await scheduleTarget(data.scheduleId),
  }))

export const getSendTargetsFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ broadcastIds: z.array(z.string().uuid()).max(2000) }))
  .handler(async ({ data }): Promise<{ available: boolean; targets: Record<string, SendTarget> }> => ({
    available: await notificationTargetsAvailable(),
    targets: await targetsForBroadcasts(data.broadcastIds),
  }))
