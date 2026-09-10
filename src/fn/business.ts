import { createServerFn } from '@tanstack/react-start'
import { businessSearchSchema, type BusinessMetrics } from '~/lib/business'
import { businessMetrics } from '~/server/business.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'

/**
 * Negocio — el borde RPC.
 *
 * `adminMiddleware`, y no por simetría: `/negocio` publica el tamaño y la forma
 * del negocio entero —cuántos usuarios reales hay, cuántos churnean, cuántos
 * partners— que es exactamente lo que no se le contesta a cualquiera con una
 * sesión de la app mobile. Un server function es un endpoint HTTP público; el
 * guard de `_authed` modela lo que la UI ofrece, esto es lo que el servidor
 * acepta. Mismo criterio que `ops.ts` y `users.ts`.
 */
export const getBusinessMetrics = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(businessSearchSchema)
  .handler(async ({ data }): Promise<BusinessMetrics> =>
    businessMetrics(data.businessMonths, { signal: requestSignal() }),
  )
