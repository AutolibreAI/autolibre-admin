import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { scanSessionSearchSchema } from '~/lib/scan-sessions'
import { getScanSessionDetail, listScanSessions } from '~/server/scan-sessions.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { ScanSessionDetail, ScanSessionRow } from '~/lib/scan-sessions'

/**
 * Sesiones de escáner — el borde RPC.
 *
 * `adminMiddleware` con el mismo peso que `users.ts` y `chats.ts`: una fila
 * trae email y nombre de una persona real, la patente y el VIN de su auto, y los
 * códigos de falla que tiró el escaneo. Es dato personal, no una métrica
 * agregada. Un server function es un endpoint HTTP público — el guard de
 * `_authed` modela lo que la UI ofrece, esto es lo que el servidor acepta.
 */
export const listScanSessionsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(scanSessionSearchSchema)
  .handler(async ({ data }): Promise<Array<ScanSessionRow>> =>
    listScanSessions(data, { signal: requestSignal() }),
  )

/**
 * El detalle de una sesión (`/escaneres/sesiones/:sessionId`). El uuid entra
 * por `z.uuid()` y no como string suelto — mismo motivo que `getAppUser`: un id
 * basura tiene que dar el 404 de la ruta, no el `errorComponent` genérico de
 * Postgres rechazando un `invalid input syntax for type uuid`.
 */
export const getScanSessionDetailFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ sessionId: z.uuid() }))
  .handler(async ({ data }): Promise<ScanSessionDetail> => {
    const found = await getScanSessionDetail(data.sessionId, { signal: requestSignal() })
    if (!found) throw new Error(`NOT_FOUND:${data.sessionId}`)
    return found
  })
