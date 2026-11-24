import { createServerFn } from '@tanstack/react-start'
import { identifyQuotePlateSchema, type QuotePlateResult, type QuoteVehicleFill } from '~/lib/quote-plate'
import { QUOTE_REQUESTS_UNAVAILABLE } from '~/lib/quote-requests'
import { identifyQuoteRequestVehicleByPlate } from '~/server/backend'
import { quoteRequestsAvailability } from '~/server/quote-requests.repo'
import { requestSignal } from '~/server/request'
import { fillVehicleDescription } from '~/server/quote-vehicle-fill'
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
  .handler(async ({ data, context }): Promise<QuotePlateResult & { vehicleFill: QuoteVehicleFill }> => {
    const signal = requestSignal()
    const availability = await quoteRequestsAvailability({ signal })
    if (!availability.available) throw new Error(`${QUOTE_REQUESTS_UNAVAILABLE}:${availability.reason}`)
    const result = await identifyQuoteRequestVehicleByPlate(data.quoteRequestId, data.plate, { signal })
    // Tarjeta T73NyHFN: lo identificado entra a `vehicle_description` si estaba
    // vacío; si tenía algo escrito a mano, no se pisa (`kept`). Nunca tira.
    const vehicleFill = await fillVehicleDescription(data.quoteRequestId, context.user.id)
    return { ...result, vehicleFill }
  })
