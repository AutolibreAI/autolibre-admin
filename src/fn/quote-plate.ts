import { createServerFn } from '@tanstack/react-start'
import { identifyQuotePlateSchema, type QuotePlateResult } from '~/lib/quote-plate'
import { QUOTE_REQUESTS_UNAVAILABLE } from '~/lib/quote-requests'
import { identifyQuoteRequestVehicleByPlate } from '~/server/backend'
import { quoteRequestsAvailability } from '~/server/quote-requests.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'

/**
 * Identificar el vehículo de un pedido por la patente — por HTTP al backend
 * (`PUT /admin/quote-requests/:id/plate`), no por SQL: el backend consulta al
 * proveedor de patentes y resuelve el catálogo que pide el despacho.
 *
 * Mismos guards que «Corregir ubicación»: `adminMiddleware` (la patente
 * identifica a su titular) y el de `quote_requests` antes del fetch. Ni el
 * estado ni "ya tiene catálogo" se re-chequean acá: los decide el backend
 * atómico con la escritura (400 `INVALID_STATE_TRANSITION`).
 */
export const identifyQuoteRequestVehicleFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(identifyQuotePlateSchema)
  .handler(async ({ data }): Promise<QuotePlateResult> => {
    const signal = requestSignal()
    const availability = await quoteRequestsAvailability({ signal })
    if (!availability.available) throw new Error(`${QUOTE_REQUESTS_UNAVAILABLE}:${availability.reason}`)
    return identifyQuoteRequestVehicleByPlate(data.quoteRequestId, data.plate, { signal })
  })
