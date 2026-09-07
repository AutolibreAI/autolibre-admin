import { createServerFn } from '@tanstack/react-start'
import { scannerSearchSchema } from '~/lib/scanners'
import { compatibilityMatrix, scannerSessions } from '~/server/scanners.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { CompatibilityMatrix, ScannerSessionsView } from '~/lib/scanners'

/**
 * Compatibilidad de escáneres — el borde RPC.
 *
 * Pasa por `adminMiddleware` aunque la matriz no traiga ni un dato personal:
 * son marcas, modelos y contadores. El motivo no es la sensibilidad del dato,
 * es la simetría.
 *
 * Un server function es un endpoint HTTP público — cualquiera con una sesión
 * válida de la app mobile lo llama con `fetch`, y el guard de `_authed` no lo
 * cubre porque sólo modela lo que la UI OFRECE. Si algunas lecturas llevan
 * guard y otras no, alguien tiene que decidir caso por caso cuál era la
 * delicada, y esa decisión se toma mal exactamente una vez. Mismo criterio ya
 * escrito en `fn/manuals.ts`.
 *
 * Y hay un motivo de negocio además: esta tabla es, literalmente, con qué
 * hardware anda cada auto de la flota de clientes. No es secreto de estado,
 * pero tampoco se le contesta a cualquiera.
 */
export const getScannerCompatibility = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(scannerSearchSchema)
  .handler(
    async ({ data }): Promise<CompatibilityMatrix> =>
      compatibilityMatrix(data, { signal: requestSignal() }),
  )

/**
 * El historial detrás de una celda. Mismo schema y mismo guard que la matriz —
 * son marcas, modelos, y ahora también el email de quien hizo cada conexión y
 * el VIN que detectó el escáner, así que el guard pesa un poco más que antes.
 * Devuelve `null` si el schema no trae por dónde acotar (`catalogId` ni
 * `scanner`), y ahí la ruta simplemente no muestra el panel.
 */
export const getScannerSessions = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(scannerSearchSchema)
  .handler(
    async ({ data }): Promise<ScannerSessionsView | null> =>
      scannerSessions(data, { signal: requestSignal() }),
  )
