import { createServerFn } from '@tanstack/react-start'
import { growthSearchSchema } from '~/lib/ops'
import {
  QUOTE_REQUESTS_UNAVAILABLE,
  addQuoteRequestInternalNoteSchema,
  closeQuoteRequestSchema,
  createQuoteRequestSchema,
  markQuoteRequestAnsweredSchema,
  markQuoteRequestContactedSchema,
  quoteRequestIdSchema,
  quoteRequestSearchSchema,
  setQuoteRequestRubrosSchema,
} from '~/lib/quote-requests'
import {
  addQuoteRequestInternalNote,
  closeQuoteRequest,
  createQuoteRequest,
  findQuoteRequestDetail,
  listQuoteRequests,
  markQuoteRequestAnswered,
  markQuoteRequestContacted,
  quoteRequestSeries,
  quoteRequestStatusSummary,
  quoteRequestsAvailability,
  setQuoteRequestRubros,
} from '~/server/quote-requests.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type {
  QuoteRequestDetailResult,
  QuoteRequestSeries,
  QuoteRequestWriteResult,
  QuoteRequestsListResult,
} from '~/lib/quote-requests'

/**
 * Pedidos de presupuesto — el borde RPC.
 *
 * ── `adminMiddleware` en todo ──────────────────────────────────────────────
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
 *
 * Las escrituras lo chequean ANTES del SP por lo mismo, con más razón: la 011
 * se aplica aunque la tabla no exista (parámetros `text`), así que la función
 * está y recién revienta al ejecutar su `SELECT … FOR UPDATE`.
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

/**
 * La sección Pedidos de `/metricas`: cuatro series sobre el mismo universo
 * (cohorte por creación, sin duplicados). Mismo `adminMiddleware` que el resto
 * — publica volumen y velocidad de una línea de captación real, no una métrica
 * cualquiera. La disponibilidad va DENTRO del resultado (no como excepción):
 * `quoteRequestSeries()` ya resuelve los dos niveles de guard.
 */
export const getQuoteRequestSeriesFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(growthSearchSchema)
  .handler(async ({ data }): Promise<QuoteRequestSeries> =>
    quoteRequestSeries(data.unit, { signal: requestSignal() }),
  )

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

// ── Escrituras ───────────────────────────────────────────────────────────────
//
// El actor sale de `context.user.id`, NUNCA del payload — ningún schema lo
// tiene. Mismo criterio que `advanceMarketplaceLead`.

async function assertQuoteRequestsAvailable(signal: AbortSignal | undefined): Promise<void> {
  const availability = await quoteRequestsAvailability({ signal })
  if (!availability.available) {
    throw new Error(`${QUOTE_REQUESTS_UNAVAILABLE}:${availability.reason}`)
  }
}

export const markQuoteRequestContactedFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(markQuoteRequestContactedSchema)
  .handler(async ({ data, context }): Promise<QuoteRequestWriteResult> => {
    const signal = requestSignal()
    await assertQuoteRequestsAvailable(signal)
    return markQuoteRequestContacted(data, context.user.id, { signal })
  })

export const markQuoteRequestAnsweredFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(markQuoteRequestAnsweredSchema)
  .handler(async ({ data, context }): Promise<QuoteRequestWriteResult> => {
    const signal = requestSignal()
    await assertQuoteRequestsAvailable(signal)
    return markQuoteRequestAnswered(data, context.user.id, { signal })
  })

export const closeQuoteRequestFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(closeQuoteRequestSchema)
  .handler(async ({ data, context }): Promise<QuoteRequestWriteResult> => {
    const signal = requestSignal()
    await assertQuoteRequestsAvailable(signal)
    return closeQuoteRequest(data, context.user.id, { signal })
  })

export const addQuoteRequestInternalNoteFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(addQuoteRequestInternalNoteSchema)
  .handler(async ({ data, context }): Promise<QuoteRequestWriteResult> => {
    const signal = requestSignal()
    await assertQuoteRequestsAvailable(signal)
    return addQuoteRequestInternalNote(data, context.user.id, { signal })
  })

/**
 * Clasificar los rubros de un pedido (migración 016, reemplaza a la 013 de un
 * solo rubro) — para el panel de candidatos de
 * `.claude/plans/partners-derivacion.md`. El SP mismo valida que el pedido
 * exista, pero esa validación es un `SELECT` crudo sobre `quote_requests`: en
 * una base sin esa tabla explotaría con el error de Postgres, no con la
 * sentinela legible. Se chequea acá antes, igual que las cuatro escrituras de
 * la 011.
 */
export const setQuoteRequestRubrosFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(setQuoteRequestRubrosSchema)
  .handler(async ({ data, context }): Promise<{ categorySlugs: Array<string> }> => {
    const signal = requestSignal()
    await assertQuoteRequestsAvailable(signal)
    return setQuoteRequestRubros(data, context.user.id, { signal })
  })

/**
 * Cargar un pedido a mano (migración 012) — llegó por teléfono, en persona, o
 * referido, así que nunca pasó por el POST público de app/web/whatsapp. El
 * actor sale de la sesión, NUNCA del payload, igual que las transiciones.
 */
export const createQuoteRequestFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(createQuoteRequestSchema)
  .handler(async ({ data, context }): Promise<{ id: string; publicNumber: number }> => {
    const signal = requestSignal()
    await assertQuoteRequestsAvailable(signal)
    return createQuoteRequest(data, context.user.id, { signal })
  })
