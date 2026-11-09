import { createServerFn } from '@tanstack/react-start'
import { changeQuoteLocationSchema } from '~/lib/quote-location'
import { QUOTE_REQUESTS_UNAVAILABLE } from '~/lib/quote-requests'
import { changeQuoteRequestLocation } from '~/server/backend'
import { quoteRequestsAvailability } from '~/server/quote-requests.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'

/**
 * Corregir la ubicación de un pedido — por HTTP al backend, no por SQL
 * (`PUT /admin/quote-requests/:id/location`, séptima excepción a la
 * decisión 1). Es el ÚNICO camino de escritura de la ubicación: desde la 028,
 * `ops.update_quote_request` no la nombra.
 *
 * - `adminMiddleware`: un server function es un endpoint público, y la
 *   ubicación de una persona es dato personal.
 * - El guard de `quote_requests` corre ANTES del fetch, igual que el resto de
 *   las escrituras de pedidos: en una base sin la tabla no se le pide nada al
 *   backend.
 * - El validator es el mismo zod `.strict()` que usa el componente: un campo de
 *   más o un opcional en blanco no llegan al backend (sería un 400).
 * - El estado del pedido NO se re-chequea acá: lo hace el backend (400
 *   `INVALID_STATE_TRANSITION`), que es el único que lo ve atómico con la
 *   escritura. Chequearlo por SQL antes sería una carrera más, no una garantía.
 */
export const changeQuoteRequestLocationFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(changeQuoteLocationSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const signal = requestSignal()
    const availability = await quoteRequestsAvailability({ signal })
    if (!availability.available) throw new Error(`${QUOTE_REQUESTS_UNAVAILABLE}:${availability.reason}`)
    await changeQuoteRequestLocation(data.quoteRequestId, data.location, { signal })
    return { ok: true }
  })
