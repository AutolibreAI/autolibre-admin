import { createServerFn } from '@tanstack/react-start'
import { fineSearchSchema } from '~/lib/fines'
import { listFineDebtors, listFineJurisdictions } from '~/server/fines.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { FineDebtorRow } from '~/lib/fines'

/**
 * Multas — el borde RPC.
 *
 * `adminMiddleware` en las dos, y el motivo de la LECTURA es tan fuerte como en
 * `leads.ts`, `users.ts` o `insurance.ts`: `listFineDebtors` devuelve email y
 * nombre de personas reales, la patente de su auto, y cuánto deben en multas.
 * Es dato personal sensible, no una métrica agregada.
 *
 * Un server function es un endpoint HTTP público: el guard de `_authed` modela
 * lo que la UI ofrece, esto es lo que el servidor acepta.
 */

export const listFineDebtorsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(fineSearchSchema)
  .handler(async ({ data }): Promise<Array<FineDebtorRow>> =>
    listFineDebtors(data, { signal: requestSignal() }),
  )

export const listFineJurisdictionsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<string>> =>
    listFineJurisdictions({ signal: requestSignal() }),
  )
