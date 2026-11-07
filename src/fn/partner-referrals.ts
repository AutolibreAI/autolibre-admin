import { createServerFn } from '@tanstack/react-start'
import { partnerReferralsSearchSchema } from '~/lib/partner-referrals'
import { partnerReferrals } from '~/server/partner-referrals.repo'
import { adminMiddleware } from './middleware'
import type { PartnerReferralsResult } from '~/lib/partner-referrals'

/**
 * Taller de cabecera: conteos por proveedor y código. `adminMiddleware`: un
 * server function es un endpoint HTTP público, y esto es dato comercial.
 * Nunca devuelve ids ni datos de personas.
 */
export const getPartnerReferralsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(partnerReferralsSearchSchema)
  .handler(async ({ data }): Promise<PartnerReferralsResult> => partnerReferrals(data.referralUnit))
