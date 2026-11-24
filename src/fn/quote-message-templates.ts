import { createServerFn } from '@tanstack/react-start'
import {
  QUOTE_MESSAGE_TEMPLATES_UNAVAILABLE,
  listQuoteMessageTemplateVersionsSchema,
  saveQuoteMessageTemplateSchema,
} from '~/lib/quote-templates'
import {
  listQuoteMessageTemplateVersions,
  listQuoteMessageTemplates,
  quoteMessageTemplatesAvailable,
  saveQuoteMessageTemplate,
} from '~/server/quote-message-templates.repo'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import {
  proposalToMessageEntry,
  type QuoteMessageEntry,
  type QuoteMessageTemplate,
  type QuoteMessageTemplateVersion,
} from '~/lib/quote-templates'
import type { QuoteRequestDetail } from '~/lib/quote-requests'
import { parseQuoteCode, quoteCodeLookupSchema } from '~/lib/partner-prospects'
import { findQuoteRequestIdByNumber } from '~/server/partner-prospects.repo'
import { findQuoteRequestDetail, quoteRequestsAvailability } from '~/server/quote-requests.repo'
import { listQuoteProposals, quoteProposalsAvailability } from '~/server/quote-proposals.repo'

/**
 * Plantillas de mensaje editables — el borde RPC.
 *
 * `adminMiddleware` en lectura y escritura: el contenido de una plantilla no
 * es sensible por sí solo, pero el historial trae el email de quién editó
 * cada versión, y un server function es un endpoint HTTP público — mismo
 * criterio que el resto del panel.
 */

export const listQuoteMessageTemplatesFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Array<QuoteMessageTemplate>> =>
    listQuoteMessageTemplates({ signal: requestSignal() }),
  )

export const listQuoteMessageTemplateVersionsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(listQuoteMessageTemplateVersionsSchema)
  .handler(async ({ data }): Promise<Array<QuoteMessageTemplateVersion>> => {
    const signal = requestSignal()
    if (!(await quoteMessageTemplatesAvailable({ signal }))) return []
    return listQuoteMessageTemplateVersions(data.templateKey, { signal })
  })

export const saveQuoteMessageTemplateFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(saveQuoteMessageTemplateSchema)
  .handler(async ({ data, context }): Promise<QuoteMessageTemplate> => {
    const signal = requestSignal()
    if (!(await quoteMessageTemplatesAvailable({ signal })))
      throw new Error(QUOTE_MESSAGE_TEMPLATES_UNAVAILABLE)
    return saveQuoteMessageTemplate(data, context.user.id, { signal })
  })

/**
 * La vista previa del editor con OTRO pedido real, elegido por su `AL-n`
 * (tarjeta bMtiAAQZ): el pedido abierto no siempre tiene los datos que la
 * plantilla usa. Lectura pura, con los mismos guards que la ficha.
 */
export const getQuoteTemplatePreviewFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(quoteCodeLookupSchema)
  .handler(async ({ data }): Promise<{ detail: QuoteRequestDetail; entries: Array<QuoteMessageEntry> } | null> => {
    const signal = requestSignal()
    const n = parseQuoteCode(data.code)
    if (n === null) return null
    const availability = await quoteRequestsAvailability({ signal })
    if (!availability.available) return null
    const id = await findQuoteRequestIdByNumber(n)
    if (!id) return null
    const detail = await findQuoteRequestDetail(id, { signal })
    if (!detail) return null
    const entries = (await quoteProposalsAvailability({ signal }))
      ? (await listQuoteProposals(id, { signal })).active.map(proposalToMessageEntry)
      : []
    return { detail, entries }
  })
