import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import type { FollowupOrder } from '~/lib/quote-followup'
import type { PartnerOption } from '~/lib/partners'
import { sqlOne } from '~/server/db'
import { listPartnerOptions } from '~/server/partners.repo'
import { listFollowupOrders, setFollowupSent } from '~/server/quote-followup.repo'
import { adminMiddleware } from './middleware'

/**
 * Seguimiento de pedidos — el borde RPC. Publica nombre y teléfono de cada
 * persona: `adminMiddleware`. Cargar el resultado NO pasa por acá: reusa los
 * server functions de la ficha (declarar / elegir en nombre de la persona) y
 * la atribución de Liquidaciones.
 */

export interface FollowupData {
  rows: Array<FollowupOrder>
  sendsAvailable: boolean
  partnerOptions: Array<PartnerOption>
  /** Hoy en Buenos Aires, del servidor (la pantalla es SSR). */
  today: string
}

export const getFollowupFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<FollowupData> => {
    const [list, partnerOptions, today] = await Promise.all([
      listFollowupOrders(),
      listPartnerOptions(),
      sqlOne<{ d: string }>(`select to_char(now() at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD') as d`),
    ])
    return { ...list, partnerOptions, today: today?.d ?? '' }
  })

export const setFollowupSentFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ quoteRequestIds: z.array(z.string().uuid()).min(1).max(100), sent: z.boolean() }))
  .handler(async ({ data, context }) => ({ changed: await setFollowupSent(data.quoteRequestIds, data.sent, context.user.id) }))
