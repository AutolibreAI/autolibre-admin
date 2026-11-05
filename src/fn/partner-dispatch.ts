import { createServerFn } from '@tanstack/react-start'
import {
  PARTNER_DISPATCH_UNAVAILABLE,
  approvePartnerDispatchSchema,
  type ApprovedDispatch,
  type DispatchFetchResult,
  type PartnerDispatchResult,
} from '~/lib/partner-dispatch'
import { quoteRequestIdSchema } from '~/lib/quote-requests'
import { approvePartnerDispatch, getPartnerDispatchDraft, listQuoteRequestOutreach } from '~/server/backend'
import { partnerDispatchAvailability } from '~/server/partner-dispatch.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'

/**
 * «Despacho por WhatsApp» — el borde RPC. Lee y escribe por HTTP contra el
 * backend hex; el único SQL es el guard de la 0142.
 *
 * `adminMiddleware` en todo: el borrador trae el texto que va a recibir un
 * taller (con la descripción de una persona real) y la aprobación le manda un
 * WhatsApp a terceros. El backend vuelve a chequear el rol con el token.
 * → `.claude/rules/partner-dispatch.md`
 */

const settle = async <T,>(p: Promise<T>): Promise<DispatchFetchResult<T>> => {
  try {
    return { ok: true, data: await p }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Borrador y seguimiento EN PARALELO, cada uno como resultado propio: si uno
 * falla (kill switch, backend sin la ruta) el otro se muestra igual, y la
 * ficha nunca da 500 por esta tarjeta.
 */
export const getPartnerDispatchFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(quoteRequestIdSchema)
  .handler(async ({ data }): Promise<PartnerDispatchResult> => {
    const signal = requestSignal()
    const available = await partnerDispatchAvailability({ signal }).catch(() => false)
    if (!available) return { available: false }
    const [draft, outreach] = await Promise.all([
      settle(getPartnerDispatchDraft(data.quoteRequestId, { signal })),
      settle(listQuoteRequestOutreach(data.quoteRequestId, { signal })),
    ])
    return { available: true, draft, outreach }
  })

export const approvePartnerDispatchFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(approvePartnerDispatchSchema)
  .handler(async ({ data }): Promise<ApprovedDispatch> => {
    if (!(await partnerDispatchAvailability({ signal: requestSignal() }))) throw new Error(PARTNER_DISPATCH_UNAVAILABLE)
    return approvePartnerDispatch(data.quoteRequestId, { dispatchId: data.dispatchId, partnerIds: data.partnerIds })
  })
