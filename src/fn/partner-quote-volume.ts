import { createServerFn } from '@tanstack/react-start'
import { PROPOSAL_COUNT_START } from '~/lib/partner-plans'
import { listPartnerProposalUsageMonthly, listPartnerQuoteVolume } from '~/server/partner-quote-volume.repo'
import { adminMiddleware } from './middleware'
import type { PartnerProposalUsageResult, PartnerQuoteVolumeResult } from '~/lib/partner-quote-volume'

/**
 * Las dos lecturas de la migración 025 — una definición para el panel y para
 * el conector MCP de los ejecutivos.
 *
 * `adminMiddleware`: un server function es un endpoint HTTP público, y esto
 * dice cuánto trabajo le dimos a cada taller, nombres de talleres de afuera
 * incluidos. Es dato comercial, no para cualquier sesión de la app.
 */

/** Presupuestos por proveedor desde el principio (`ops.partner_quote_volume()`). */
export const listPartnerQuoteVolumeFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async (): Promise<PartnerQuoteVolumeResult> => listPartnerQuoteVolume())

/** Uso del plan por proveedor y mes (`ops.partner_proposal_usage_monthly()`). */
export const listPartnerProposalUsageFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(
    async (): Promise<PartnerProposalUsageResult> => listPartnerProposalUsageMonthly(PROPOSAL_COUNT_START),
  )
