import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
  getPartnerFreePlanNotice,
  listFreePlanNotices,
  setFreePlanNotice,
} from '~/server/partner-free-plan-notice.repo'
import {
  setFreePlanNoticeSchema,
  type FreePlanNotice,
  type FreePlanNoticeList,
} from '~/lib/partner-free-plan-notice'
import { adminMiddleware } from './middleware'

/**
 * Aviso del cambio del plan gratis (migración 042) — el borde RPC.
 * `adminMiddleware` en todo (el WhatsApp de cada proveedor y quién del equipo
 * le avisó no son para cualquier sesión), y el actor de la escritura sale de
 * la sesión, nunca del payload (guardrail 4).
 */

export const listFreePlanNoticesFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<FreePlanNoticeList> => listFreePlanNotices())

export const getPartnerFreePlanNoticeFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ partnerId: z.string().uuid() }))
  .handler(
    async ({ data }): Promise<{ available: boolean; notice: FreePlanNotice | null }> =>
      getPartnerFreePlanNotice(data.partnerId),
  )

export const setFreePlanNoticeFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(setFreePlanNoticeSchema)
  .handler(async ({ data, context }) => setFreePlanNotice(data, context.user.id))
