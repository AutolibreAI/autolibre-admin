import { createServerFn } from '@tanstack/react-start'
import { detectionSearchSchema } from '~/lib/detections'
import { listDetections } from '~/server/detections.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { DetectionsView } from '~/lib/detections'

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
