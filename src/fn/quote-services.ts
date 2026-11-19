import { createServerFn } from '@tanstack/react-start'
import { QUOTE_REQUESTS_UNAVAILABLE } from '~/lib/quote-requests'
import {
  correctQuoteServicesSchema,
  familiesOfServices,
  type CorrectQuoteServicesResult,
} from '~/lib/quote-services'
import { correctQuoteRequestServices } from '~/server/backend'
import { loadCatalog } from '~/server/partners.repo'
import { quoteRequestsAvailability, setQuoteRequestRubros } from '~/server/quote-requests.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'

/**
 * «Guardar clasificación» — corrige los SERVICIOS del pedido en el BACKEND
 * (`PUT /admin/quote-requests/:id/services`, 0155): es lo que lee el despacho
 * por WhatsApp. → `~/lib/quote-services`
 *
 * Dos escrituras, en este orden y no al revés:
 *
 *  1. El backend (la fuente). Si falla, no se toca nada más y el error sube.
 *  2. El espejo en familias de `ops.set_quote_request_rubros` (016), que
 *     siguen leyendo la ficha (los rubros con los que se buscan candidatos) y
 *     `/partners/estudio`. Las familias se DERIVAN de los servicios con el
 *     catálogo. Si este paso falla, la corrección ya vale para el despacho:
 *     no se tira, se devuelve `legacySynced: false` y la UI lo dice.
 *
 * `adminMiddleware` y el guard de `quote_requests` ANTES del fetch, igual que
 * «Corregir ubicación».
 */
export const correctQuoteRequestServicesFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(correctQuoteServicesSchema)
  .handler(async ({ data, context }): Promise<CorrectQuoteServicesResult> => {
    const signal = requestSignal()
    const availability = await quoteRequestsAvailability({ signal })
    if (!availability.available) throw new Error(`${QUOTE_REQUESTS_UNAVAILABLE}:${availability.reason}`)

    await correctQuoteRequestServices(data.quoteRequestId, data.serviceSlugs, { signal })

    try {
      const categorySlugs = familiesOfServices(await loadCatalog(), data.serviceSlugs)
      await setQuoteRequestRubros({ quoteRequestId: data.quoteRequestId, categorySlugs }, context.user.id, { signal })
      return { ok: true, legacySynced: true }
    } catch {
      return { ok: true, legacySynced: false }
    }
  })
