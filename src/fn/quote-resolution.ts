import { createServerFn } from '@tanstack/react-start'
import {
  QUOTE_RESOLUTION_EXPORT_LIMIT,
  QUOTE_RESOLUTION_LIST_LIMIT,
  quoteResolutionSearchSchema,
  type QuoteResolutionResult,
  type QuoteResolutionRow,
} from '~/lib/quote-resolution'
import { QUOTE_REQUESTS_UNAVAILABLE } from '~/lib/quote-requests'
import { quoteRequestsAvailability } from '~/server/quote-requests.repo'
import { listQuoteResolution, listQuoteResolutionPartnerOptions } from '~/server/quote-resolution.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'

/**
 * «Resolución de pedidos» — el borde RPC. Sólo lectura, por SQL.
 * `adminMiddleware` en los dos: publica contacto (nombre y teléfono) de cada
 * pedido, y un server function es un endpoint público.
 */

export const listQuoteResolutionFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(quoteResolutionSearchSchema)
  .handler(async ({ data }): Promise<QuoteResolutionResult> => {
    const signal = requestSignal()
    const availability = await quoteRequestsAvailability({ signal })
    if (!availability.available) return { availability }

    const [listing, partnerOptions] = await Promise.all([
      listQuoteResolution(data, { limit: QUOTE_RESOLUTION_LIST_LIMIT, signal }),
      listQuoteResolutionPartnerOptions(),
    ])
    return { availability, partnerOptions, ...listing }
  })

/**
 * Lo filtrado ENTERO para el CSV (hasta `QUOTE_RESOLUTION_EXPORT_LIMIT`), no
 * sólo las 500 de la pantalla. Devuelve filas: el CSV lo arma el navegador con
 * `quoteResolutionCsv`, que es lo que baja el archivo.
 */
export const exportQuoteResolutionFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(quoteResolutionSearchSchema)
  .handler(async ({ data }): Promise<{ rows: Array<QuoteResolutionRow>; truncated: boolean }> => {
    const signal = requestSignal()
    const availability = await quoteRequestsAvailability({ signal })
    if (!availability.available) throw new Error(`${QUOTE_REQUESTS_UNAVAILABLE}:${availability.reason}`)
    const { rows, truncated } = await listQuoteResolution(data, { limit: QUOTE_RESOLUTION_EXPORT_LIMIT, signal })
    return { rows, truncated }
  })
