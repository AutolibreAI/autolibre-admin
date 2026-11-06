import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { listPartnerPlans } from '~/server/partner-plans.repo'
import { adminMiddleware } from './middleware'
import type { PartnerPlansResult } from '~/lib/partner-plans'

/**
 * El plan de cada proveedor, de sólo lectura (billing del backend).
 *
 * `adminMiddleware`: un server function es un endpoint HTTP público, y esto
 * dice qué paga cada taller. Es dato comercial, no para cualquier sesión.
 */
export const listPartnerPlansFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  // Un id que no es uuid cae a "todos" en vez de tirar: la ficha responde 404
  // por su cuenta, y un 400 acá se llevaría puesta esa respuesta.
  .validator(z.object({ partnerId: z.string().uuid().optional().catch(undefined) }).optional())
  .handler(async ({ data }): Promise<PartnerPlansResult> => listPartnerPlans({ partnerId: data?.partnerId }))
