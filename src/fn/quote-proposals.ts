import { createServerFn } from '@tanstack/react-start'
import {
  QUOTE_PROPOSALS_NO_FREE_SLOTS,
  QUOTE_PROPOSALS_UNAVAILABLE,
  MAX_QUOTE_PROPOSAL_SLOTS,
  closeQuoteProposalsSearchSchema,
  correctQuoteProposalSchema,
  sendQuoteProposalsSchema,
  withdrawQuoteProposalSchema,
} from '~/lib/quote-proposals'
import { quoteRequestIdSchema } from '~/lib/quote-requests'
import {
  activeProposalCount,
  listQuoteProposals,
  quoteProposalsAvailability,
} from '~/server/quote-proposals.repo'
import {
  closeQuoteProposalsSearch,
  correctQuoteProposal,
  sendQuoteProposals,
  withdrawQuoteProposal,
} from '~/server/backend'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { QuoteProposalsResult } from '~/lib/quote-proposals'

/**
 * «Propuestas en la app» — el borde RPC. Lee por SQL, escribe por HTTP.
 *
 * ── `adminMiddleware` en todo, lecturas incluidas ─────────────────────────
 *
 * Un server function es un endpoint HTTP público. La lectura trae precios y el
 * contacto de talleres de terceros colgados de un pedido de una persona real;
 * las escrituras le mandan un push a esa persona. Sin el guard, cualquier
 * sesión válida de la app haría las dos cosas. El backend vuelve a chequear el
 * rol (`AdminGuard`) con el token del admin: son dos sistemas y cada uno
 * responde por lo suyo.
 *
 * ── El guard de disponibilidad corre ANTES de cada fetch ──────────────────
 *
 * Producción no tiene 0120–0122. Sin este chequeo, un POST directo llegaría a
 * un backend que no tiene la ruta (404 «Cannot POST») o, peor, a uno que sí la
 * tiene contra una base que no. `QUOTE_PROPOSALS_UNAVAILABLE` sale SIN tocar el
 * backend.
 *
 * El actor es el token de Clerk: ningún schema lleva quién envía.
 */

async function assertAvailable(signal: AbortSignal | undefined): Promise<void> {
  if (!(await quoteProposalsAvailability({ signal }))) throw new Error(QUOTE_PROPOSALS_UNAVAILABLE)
}

export const listQuoteProposalsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(quoteRequestIdSchema)
  .handler(async ({ data }): Promise<QuoteProposalsResult> => {
    const signal = requestSignal()
    if (!(await quoteProposalsAvailability({ signal }))) return { available: false }
    return listQuoteProposals(data.quoteRequestId, { signal })
  })

/**
 * Re-lee los lugares libres justo antes del fetch. La UI ya limita a
 * `freeSlots`, pero entre que se abrió el formulario y se apretó Enviar otra
 * pestaña pudo mandar; el backend rechazaría el exceso con un 400 sin code.
 */
export const sendQuoteProposalsFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(sendQuoteProposalsSchema)
  .handler(async ({ data }): Promise<{ proposalIds: Array<string>; proposalsCount: number | null }> => {
    const signal = requestSignal()
    await assertAvailable(signal)
    const freeSlots = MAX_QUOTE_PROPOSAL_SLOTS - (await activeProposalCount(data.quoteRequestId))
    if (data.proposals.length > freeSlots) throw new Error(QUOTE_PROPOSALS_NO_FREE_SLOTS)

    const result = await sendQuoteProposals({
      quoteRequestId: data.quoteRequestId,
      sendId: data.sendId,
      closesSearch: data.closesSearch,
      proposals: data.proposals,
    })
    return { proposalIds: result.proposals.map((p) => p.id), proposalsCount: result.proposalsCount }
  })

export const correctQuoteProposalFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(correctQuoteProposalSchema)
  .handler(async ({ data }): Promise<void> => {
    await assertAvailable(requestSignal())
    await correctQuoteProposal({ proposalId: data.proposalId, content: data.content })
  })

export const withdrawQuoteProposalFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(withdrawQuoteProposalSchema)
  .handler(async ({ data }): Promise<void> => {
    await assertAvailable(requestSignal())
    await withdrawQuoteProposal(data.proposalId)
  })

export const closeQuoteProposalsSearchFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(closeQuoteProposalsSearchSchema)
  .handler(async ({ data }): Promise<void> => {
    await assertAvailable(requestSignal())
    await closeQuoteProposalsSearch({ quoteRequestId: data.quoteRequestId, closureId: data.closureId })
  })
