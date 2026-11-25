import { createServerFn } from '@tanstack/react-start'
import { QUOTE_ORIGIN_WEEKS, type QuoteOriginWeekly } from '~/lib/quote-origins'
import { quoteOriginWeekly } from '~/server/quote-origins.repo'
import { adminMiddleware } from './middleware'

/** Sólo conteos agregados, pero detrás de `adminMiddleware` como el resto de Métricas. */
export const getQuoteOriginWeeklyFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<QuoteOriginWeekly> => quoteOriginWeekly(QUOTE_ORIGIN_WEEKS))
