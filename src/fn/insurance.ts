import { createServerFn } from '@tanstack/react-start'
import { insuranceSearchSchema } from '~/lib/insurance'
import { insuranceSummary, listExpiringInsurances } from '~/server/insurance.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { ExpiringInsurance, InsuranceSummary } from '~/lib/insurance'

/**
 * Seguros — el borde RPC.
 *
 * `adminMiddleware` en las dos, y el motivo de la LECTURA es tan fuerte como en
 * `leads.ts` o `users.ts`: `listExpiringInsurances` devuelve email y nombre de
 * personas reales, el nombre del asegurado, y la patente / VIN / número de
 * motor de su auto. Es dato personal, no una métrica agregada.
 *
 * Un server function es un endpoint HTTP público: cualquiera con una sesión
 * válida de la app mobile lo llama con un `fetch`. El guard de `_authed` modela
 * lo que la UI OFRECE; esto es lo que el servidor ACEPTA.
 */

export const listExpiringInsurancesFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(insuranceSearchSchema)
  .handler(async ({ data }): Promise<Array<ExpiringInsurance>> =>
    listExpiringInsurances(data.within, { signal: requestSignal() }),
  )

export const insuranceSummaryFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<InsuranceSummary> =>
    insuranceSummary({ signal: requestSignal() }),
  )
