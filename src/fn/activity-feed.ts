import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { ACTIVITY_DETAIL_KINDS, activitySearchSchema } from '~/lib/activity-feed'
import { findActivityEvent, listActivity } from '~/server/activity-feed.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { ActivityEvent, ActivityEventDetail } from '~/lib/activity-feed'

/**
 * El borde RPC del feed de actividad.
 *
 * `adminMiddleware` en las dos, y acá pesa tanto como en `/usuarios`: **esto es
 * el padrón entero cruzado con lo que cada persona hizo y cuándo**. Email,
 * nombre, patente, la primera línea de lo que le escribió al asistente, la
 * ciudad y la IP desde donde entró. Un server function es un endpoint HTTP
 * público y el guard de `_authed` no lo cubre —ese modela lo que la UI ofrece—,
 * así que sin esta línea cualquier sesión válida de la app se baja el
 * movimiento completo de la aplicación con un `fetch`.
 *
 * Que sea sólo lectura lo hace MÁS grave, no menos.
 */

export const listAppActivity = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(activitySearchSchema)
  .handler(
    async ({ data }): Promise<Array<ActivityEvent>> =>
      listActivity(data, { signal: requestSignal() }),
  )

export const getAppActivityEvent = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(
    z.object({
      /**
       * Sólo los tipos que TIENEN ficha propia. Los demás (un chat, un escaneo,
       * un documento) viven en la pantalla dueña de esa entidad y nunca llegan
       * acá — el enum es lo que lo garantiza, no un `if` en el componente.
       */
      activityKind: z.enum(ACTIVITY_DETAIL_KINDS),
      activityId: z.uuid(),
    }),
  )
  .handler(async ({ data }): Promise<ActivityEventDetail> => {
    const found = await findActivityEvent(data.activityKind, data.activityId, {
      signal: requestSignal(),
    })
    if (!found) throw new Error(`NOT_FOUND:${data.activityId}`)
    return found
  })
