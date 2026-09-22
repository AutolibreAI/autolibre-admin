import { createServerFn } from '@tanstack/react-start'
import {
  QUOTE_RESPONSES_UNAVAILABLE,
  addQuoteResponseSchema,
  deleteQuoteResponseSchema,
  reorderQuoteResponsesSchema,
  updateQuoteResponseSchema,
} from '~/lib/quote-responses'
import { quoteRequestIdSchema } from '~/lib/quote-requests'
import {
  addQuoteResponse,
  deleteQuoteResponse,
  listQuoteResponses,
  quoteResponsesAvailable,
  reorderQuoteResponses,
  updateQuoteResponse,
} from '~/server/quote-responses.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { QuoteResponse, QuoteResponsesResult } from '~/lib/quote-responses'

/**
 * Respuestas de talleres a un pedido — el borde RPC.
 *
 * ── `adminMiddleware` en todo, lecturas incluidas ─────────────────────────
 *
 * Una respuesta trae el nombre, la dirección y el teléfono de un taller, y el
 * precio que pasó para un trabajo puntual. Es información comercial de un
 * tercero que nunca aceptó que la publiquemos, colgada de un pedido con el
 * teléfono de una persona real. Un server function es un endpoint HTTP
 * público: el guard de `_authed` modela lo que la UI ofrece, esto es lo que el
 * servidor acepta. Mismo criterio que `quote-requests.ts` y `partners.ts`.
 *
 * ── La disponibilidad se chequea ACÁ, no sólo en el loader ────────────────
 *
 * `ops.quote_request_response` no existe hasta que se corre `pnpm db:migrate`
 * en esa base. Sin este chequeo, un `fetch` directo sería un 500 con el texto
 * de Postgres. En las escrituras corre ANTES del SP con más razón: la función
 * tampoco existe, y el error crudo de "function does not exist" no le dice
 * nada a quien opera.
 */

async function assertAvailable(signal: AbortSignal | undefined): Promise<void> {
  if (!(await quoteResponsesAvailable({ signal }))) throw new Error(QUOTE_RESPONSES_UNAVAILABLE)
}

export const listQuoteResponsesFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(quoteRequestIdSchema)
  .handler(async ({ data }): Promise<QuoteResponsesResult> => {
    const signal = requestSignal()
    if (!(await quoteResponsesAvailable({ signal }))) return { available: false }
    return { available: true, rows: await listQuoteResponses(data.quoteRequestId, { signal }) }
  })

// ── Escrituras ──────────────────────────────────────────────────────────────
//
// El actor sale de `context.user.id`, NUNCA del payload — ningún schema lo
// tiene. `ops.action_log` es la única respuesta posible a "¿quién cargó este
// precio?": la tabla no tiene columna de autor.

export const addQuoteResponseFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(addQuoteResponseSchema)
  .handler(async ({ data, context }): Promise<QuoteResponse> => {
    const signal = requestSignal()
    await assertAvailable(signal)
    return addQuoteResponse(data, context.user.id, { signal })
  })

export const updateQuoteResponseFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(updateQuoteResponseSchema)
  .handler(async ({ data, context }): Promise<QuoteResponse> => {
    const signal = requestSignal()
    await assertAvailable(signal)
    return updateQuoteResponse(data, context.user.id, { signal })
  })

export const deleteQuoteResponseFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(deleteQuoteResponseSchema)
  .handler(async ({ data, context }): Promise<QuoteResponse> => {
    const signal = requestSignal()
    await assertAvailable(signal)
    return deleteQuoteResponse(data, context.user.id, { signal })
  })

export const reorderQuoteResponsesFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(reorderQuoteResponsesSchema)
  .handler(async ({ data, context }): Promise<Array<QuoteResponse>> => {
    const signal = requestSignal()
    await assertAvailable(signal)
    return reorderQuoteResponses(data, context.user.id, { signal })
  })
