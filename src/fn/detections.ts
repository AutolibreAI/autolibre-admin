import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { detectionSearchSchema } from '~/lib/detections'
import { detectionSessions, listDetections } from '~/server/detections.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { DetectionsView, DetectionSessionsView } from '~/lib/detections'

/**
 * Detecciones de escáner — el borde RPC.
 *
 * `adminMiddleware` con el mismo criterio que `scanners.ts`: la tabla en sí son
 * códigos y contadores agregados, sin un dato personal, pero un server function
 * es un endpoint HTTP público y el guard va por simetría con el resto de
 * `/escaneres`. Además, "qué le falla a la flota de clientes" no se le contesta
 * a cualquiera con una sesión de la app.
 */
export const listDetectionsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(detectionSearchSchema)
  .handler(
    async ({ data }): Promise<DetectionsView> =>
      listDetections(data, { signal: requestSignal() }),
  )

/**
 * Las sesiones donde apareció una detección puntual — el panel debajo de la
 * tabla. Mismo `adminMiddleware` que `listDetectionsFn`: trae usuario, patente
 * y catálogo del vehículo, y un server function es un endpoint HTTP público.
 */
export const getDetectionSessionsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ of: z.enum(['dtc', 'anomaly']), key: z.string().trim().min(1).max(80) }))
  .handler(
    async ({ data }): Promise<DetectionSessionsView> =>
      detectionSessions(data, { signal: requestSignal() }),
  )
