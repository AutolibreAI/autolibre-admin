import { createServerFn } from '@tanstack/react-start'
import {
  advanceQuoteRequestSchema,
  createQuoteRequestSchema,
  quoteRequestIdSchema,
  quoteRequestSearchSchema,
} from '~/lib/quote-requests'
import {
  advanceQuoteRequest,
  createQuoteRequest,
  findQuoteRequestDetail,
  listQuoteRequests,
  quoteRequestStatusSummary,
  quoteRequestsAvailability,
} from '~/server/quote-requests.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { QuoteRequestDetailResult, QuoteRequestsListResult } from '~/lib/quote-requests'

/**
 * Pedidos de presupuesto — el borde RPC.
 *
 * ── `adminMiddleware` en las dos lecturas ──────────────────────────────────
 *
 * Un pedido trae teléfono, email y nombre de una persona real —muchas veces sin
 * cuenta en AutoLibre, o sea que ni siquiera aceptó nuestros términos en la
 * app— más una descripción en texto libre de qué le pasa al auto. Es dato
 * personal, no una métrica. Un server function es un endpoint HTTP público: el
 * guard de `_authed` modela la UI, esto es lo que el servidor acepta.
 *
 * ── La disponibilidad se chequea ACÁ, no sólo en el loader ─────────────────
 *
 * Si el loader fuera el único guard, un `fetch` directo a este endpoint contra
 * producción (donde `quote_requests` no existe) sería un 500 con el texto de
 * Postgres. Chequearlo en el handler cuesta una consulta al catálogo y deja una
 * sola RPC por pantalla: la respuesta ya dice "no desplegado" o trae los datos.
 */

export const listQuoteRequestsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(quoteRequestSearchSchema)
  .handler(async ({ data }): Promise<QuoteRequestsListResult> => {
    const signal = requestSignal()
    const availability = await quoteRequestsAvailability({ signal })
    if (!availability.available) return { availability }

    const [rows, summary] = await Promise.all([
      listQuoteRequests(data, { signal }),
      quoteRequestStatusSummary({ signal }),
    ])
    return { availability, rows, summary }
  })

export const getQuoteRequestFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(quoteRequestIdSchema)
  .handler(async ({ data }): Promise<QuoteRequestDetailResult> => {
    const signal = requestSignal()
    const availability = await quoteRequestsAvailability({ signal })
    if (!availability.available) return { availability }

    const detail = await findQuoteRequestDetail(data.quoteRequestId, { signal })
    if (!detail) throw new Error(`NOT_FOUND:${data.quoteRequestId}`)
    return { availability, detail }
  })

/**
 * Mover el estado del pedido. El actor sale de la sesión, NUNCA del payload —
 * mismo criterio que `advanceMarketplaceLead` y `approvePartnerApplication`:
 * `ops.action_log` es el único registro de quién lo movió, y un actor por
 * parámetro es una firma que cualquiera puede falsificar.
 *
 * Chequea disponibilidad antes de llamar al SP por el mismo motivo que las
 * lecturas: un POST directo contra una base sin `quote_requests` tiene que
 * volver "no desplegado", no el texto crudo de Postgres.
 */
export const advanceQuoteRequestFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(advanceQuoteRequestSchema)
  .handler(async ({ data, context }): Promise<{ id: string; status: string }> => {
    const signal = requestSignal()
    const availability = await quoteRequestsAvailability({ signal })
    if (!availability.available) {
      throw new Error(`QUOTE_REQUESTS_UNAVAILABLE:${availability.reason}`)
    }
    return advanceQuoteRequest(data, context.user.id, { signal })
  })

/**
 * Cargar un pedido a mano — llegó por teléfono, en persona, o referido, así
 * que nunca pasó por el POST público de app/web/whatsapp. El actor sale de la
 * sesión, NUNCA del payload, mismo criterio que `advanceQuoteRequestFn`.
 */
export const createQuoteRequestFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(createQuoteRequestSchema)
  .handler(async ({ data, context }): Promise<{ id: string; publicNumber: number }> => {
    const signal = requestSignal()
    const availability = await quoteRequestsAvailability({ signal })
    if (!availability.available) {
      throw new Error(`QUOTE_REQUESTS_UNAVAILABLE:${availability.reason}`)
    }
    return createQuoteRequest(data, context.user.id, { signal })
  })
