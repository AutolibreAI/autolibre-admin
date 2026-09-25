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
import type { QuoteMessageTemplate, QuoteMessageTemplateVersion } from '~/lib/quote-templates'

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
