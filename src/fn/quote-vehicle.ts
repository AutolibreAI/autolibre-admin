import { createServerFn } from '@tanstack/react-start'
import { applyQuoteVehicleSuggestionSchema } from '~/lib/quote-plate'
import { QUOTE_REQUESTS_UNAVAILABLE } from '~/lib/quote-requests'
import {
  quote036Available,
  quoteRequestsAvailability,
  readVehicleSuggestion,
  setQuoteRequestVehicleDescription,
} from '~/server/quote-requests.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'

/**
 * «Usar este vehículo»: reemplaza el vehículo escrito a mano por el
 * identificado (tarjeta T73NyHFN). El texto NO viaja del cliente: el servidor
 * lo vuelve a derivar (`readVehicleSuggestion`), así que sólo puede escribir lo
 * que de verdad se identificó. `expected` es lo que veía el operador: si
 * alguien lo cambió en el medio, el SP de la 036 no pisa
 * (`VEHICLE_DESCRIPTION_CHANGED`).
 */
export const applyQuoteVehicleSuggestionFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(applyQuoteVehicleSuggestionSchema)
  .handler(async ({ data, context }): Promise<{ vehicleDescription: string | null }> => {
    const signal = requestSignal()
    const availability = await quoteRequestsAvailability({ signal })
    if (!availability.available) throw new Error(`${QUOTE_REQUESTS_UNAVAILABLE}:${availability.reason}`)
    if (!(await quote036Available())) throw new Error('QUOTE_VEHICLE_FILL_UNAVAILABLE')
    const suggestion = await readVehicleSuggestion(data.quoteRequestId)
    if (!suggestion) throw new Error('NO_VEHICLE_SUGGESTION')
    const r = await setQuoteRequestVehicleDescription(data.quoteRequestId, context.user.id, suggestion.text, data.expected)
    return { vehicleDescription: r.vehicleDescription }
  })
