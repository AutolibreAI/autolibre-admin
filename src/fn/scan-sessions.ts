import { createServerFn } from '@tanstack/react-start'
import { scanSessionSearchSchema } from '~/lib/scan-sessions'
import { listScanSessions } from '~/server/scan-sessions.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { ScanSessionRow } from '~/lib/scan-sessions'

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
