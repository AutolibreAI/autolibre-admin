import { createServerFn } from '@tanstack/react-start'
import { growthSearchSchema } from '~/lib/ops'
import {
  QUOTE_EDIT_UNAVAILABLE,
  QUOTE_REQUESTS_UNAVAILABLE,
  addQuoteRequestInternalNoteSchema,
  closeQuoteRequestSchema,
  createQuoteRequestSchema,
  markQuoteRequestAnsweredSchema,
  markQuoteRequestContactedSchema,
  quoteRequestIdSchema,
  quoteRequestRubrosInputSchema,
  quoteRequestSearchSchema,
  setQuoteRequestRubrosSchema,
  updateQuoteRequestSchema,
} from '~/lib/quote-requests'
import {
  addQuoteRequestInternalNote,
  closeQuoteRequest,
  createQuoteRequest,
  findQuoteRequestDetail,
  listQuoteRequestRubros,
  listQuoteRequests,
  markQuoteRequestAnswered,
  markQuoteRequestContacted,
  quoteRequestSeries,
  quoteRequestStatusSummary,
  quoteEditAvailable,
  quoteRequestsAvailability,
  setQuoteRequestRubros,
  updateQuoteRequest,
} from '~/server/quote-requests.repo'
import { classifyQuoteRequest, requestQuoteRequestGeocode } from '~/server/backend'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type {
  QuoteRequestDetailResult,
  QuoteRequestRubros,
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

/**
 * El rubro de cada pedido, para «Propuestas por rubro» del Estudio de
 * proveedores. Sólo slugs y la fuente (operador o IA). → `listQuoteRequestRubros`
 */
export const listQuoteRequestRubrosFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(quoteRequestRubrosInputSchema)
  .handler(async ({ data }): Promise<Array<QuoteRequestRubros>> => {
    const signal = requestSignal()
    const availability = await quoteRequestsAvailability({ signal })
    if (!availability.available) return []
    return listQuoteRequestRubros(data.quoteRequestIds, { signal })
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
 * El alta y la edición llaman a las firmas de la 018. Sin esa migración
 * aplicada, `ops.create_quote_request` todavía tiene la firma de la 012 y
 * `update_quote_request` no existe: sin este chequeo, la llamada volvería con
 * el texto de Postgres ("function … does not exist").
 */
async function assertQuoteEditAvailable(signal: AbortSignal | undefined): Promise<void> {
  if (!(await quoteEditAvailable({ signal }))) throw new Error(QUOTE_EDIT_UNAVAILABLE)
}

/**
 * Cargar un pedido a mano (migración 012, firma de la 018) — llegó por
 * teléfono, en persona, o referido, así que nunca pasó por el POST público de
 * app/web/whatsapp. El actor sale de la sesión, NUNCA del payload, igual que
 * las transiciones.
 */
export const createQuoteRequestFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(createQuoteRequestSchema)
  .handler(
    async ({ data, context }): Promise<{ id: string; publicNumber: number; geocodeRequested: boolean | null }> => {
      const signal = requestSignal()
      await assertQuoteRequestsAvailable(signal)
      await assertQuoteEditAvailable(signal)
      const created = await createQuoteRequest(data, context.user.id, { signal })
      // Con zona tipeada, el backend la geocodifica sólo si se lo pedimos: el
      // alta por SQL no pasa por su caso de uso. Sin zona no hay nada que pedir.
      const geocodeRequested = (data.locationAddress ?? '').trim() === '' ? null : await requestGeocodeQuietly(created.id)
      await classifyQuietly(created.id)
      return { ...created, geocodeRequested }
    },
  )

/**
 * Editar los datos de un pedido ya creado (migración 018, sin ubicación desde
 * la 028): contacto, patente, vehículo escrito, descripción y monto. La
 * ubicación va por `changeQuoteRequestLocationFn` (HTTP). Mismos dos guards que
 * el alta.
 */
export const updateQuoteRequestFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(updateQuoteRequestSchema)
  .handler(async ({ data, context }): Promise<QuoteRequestWriteResult> => {
    const signal = requestSignal()
    await assertQuoteRequestsAvailable(signal)
    await assertQuoteEditAvailable(signal)
    return updateQuoteRequest(data, context.user.id, { signal })
  })

/**
 * Pedirle al backend que geocodifique un pedido recién cargado a mano
 * (`POST /admin/quote-requests/:id/geocode`, 0140). Es un extra: el pedido ya
 * quedó escrito, así que un fallo acá NO convierte el alta en error — devuelve
 * `false` y el compositor avisa que se use «Geocodificar» en la ficha. Se
 * ESPERA (no se suelta la promesa) por el mismo motivo que `classifyQuietly`.
 *
 * El panel ya no tiene geocoder propio: `src/server/geocode.ts`,
 * `geocodeQuietly` y `geocodeQuoteRequestFn` («Ubicar en el mapa») se
 * borraron el 2026-11-09. → `.claude/rules/leads.md`, "Geocodificación".
 */
async function requestGeocodeQuietly(quoteRequestId: string): Promise<boolean> {
  try {
    await requestQuoteRequestGeocode(quoteRequestId)
    return true
  } catch (error) {
    console.warn(
      `quote request ${quoteRequestId}: geocode not requested — ${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
}

/**
 * Lo mismo para la clasificación por IA: el SP inserta directo en `public`, así
 * que el backend nunca la encola sola y hay que pedírsela. Si falla, el pedido
 * queda «sin clasificación automática» y se clasifica a mano, como antes.
 *
 * Se ESPERA, igual que el geocode, aunque al operador no le cambie nada: en el
 * entry serverless de Vercel una promesa suelta puede quedar congelada cuando
 * sale la respuesta, y el pedido no se clasificaría nunca. Es un 202 que sólo
 * encola, con timeout corto (`classifyQuoteRequest`).
 */
async function classifyQuietly(quoteRequestId: string): Promise<void> {
  try {
    await classifyQuoteRequest(quoteRequestId)
  } catch (error) {
    console.warn(
      `quote request ${quoteRequestId}: classification not requested — ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
