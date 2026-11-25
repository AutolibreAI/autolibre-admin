import { createServerFn } from '@tanstack/react-start'
import { QUOTE_REQUESTS_UNAVAILABLE, quoteRequestIdSchema } from '~/lib/quote-requests'
import {
  declareQuoteUserOutcomeOnBehalfSchema,
  selectQuoteProposalOnBehalfSchema,
  type QuoteUserFlowProvenance,
} from '~/lib/quote-user-flow'
import { declareQuoteUserOutcomeOnBehalf, selectQuoteProposalOnBehalf } from '~/server/backend'
import { quoteRequestsAvailability } from '~/server/quote-requests.repo'
import { getQuoteUserFlowProvenance } from '~/server/quote-user-flow.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'

/**
 * Completar el flujo de la persona en su nombre — el borde RPC. Lee por SQL
 * (la procedencia), escribe por HTTP (el backend). → `~/lib/quote-user-flow`
 *
 * Mismos guards que «Corregir ubicación» / «Identificar vehículo»:
 * `adminMiddleware` (un server function es un endpoint público, y esto escribe
 * a nombre de una persona) y el guard de `quote_requests` ANTES del fetch.
 *
 * Ni la cuenta, ni el estado, ni `answered_at` se re-chequean acá: los decide
 * el backend atómico con la escritura (400 `INVALID_STATE_TRANSITION`; sin cuenta, 404 `NOT_FOUND`). La UI ni ofrece lo que rebota
 * (`canSelectProposalOnBehalf` / `canDeclareOutcomeOnBehalf`), pero chequearlo
 * de nuevo por SQL sería una carrera más, no una garantía.
 *
 * El actor es el token de Clerk: ningún schema lleva quién carga.
 */

async function assertQuoteRequestsAvailable(signal: AbortSignal | undefined): Promise<void> {
  const availability = await quoteRequestsAvailability({ signal })
  if (!availability.available) throw new Error(`${QUOTE_REQUESTS_UNAVAILABLE}:${availability.reason}`)
}

export const getQuoteUserFlowProvenanceFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(quoteRequestIdSchema)
  .handler(async ({ data }): Promise<QuoteUserFlowProvenance> => getQuoteUserFlowProvenance(data.quoteRequestId))

export const selectQuoteProposalOnBehalfFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(selectQuoteProposalOnBehalfSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const signal = requestSignal()
    await assertQuoteRequestsAvailable(signal)
    await selectQuoteProposalOnBehalf(data.quoteRequestId, data.proposalId, { signal })
    return { ok: true }
  })

export const declareQuoteUserOutcomeOnBehalfFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(declareQuoteUserOutcomeOnBehalfSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const signal = requestSignal()
    await assertQuoteRequestsAvailable(signal)
    await declareQuoteUserOutcomeOnBehalf(data, { signal })
    return { ok: true }
  })
