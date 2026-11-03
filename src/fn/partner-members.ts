import { createServerFn } from '@tanstack/react-start'
import {
  PARTNER_MEMBERS_UNAVAILABLE,
  PARTNER_MEMBER_NOT_IN_PARTNER,
  partnerMembersSchema,
  revokePartnerMemberSchema,
} from '~/lib/partner-members'
import {
  listPartnerMembers,
  memberBelongsToPartner,
  partnerMembersAvailability,
} from '~/server/partner-members.repo'
import { revokePartnerMember } from '~/server/backend'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { PartnerMembersResult } from '~/lib/partner-members'

/**
 * Miembros de un partner — lee por SQL, revoca por HTTP.
 *
 * `adminMiddleware` en las dos: la lectura trae emails de personas reales y la
 * escritura le saca el acceso al taller a alguien. Un server function es un
 * endpoint HTTP público.
 */

export const listPartnerMembersFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(partnerMembersSchema)
  .handler(async ({ data }): Promise<PartnerMembersResult> => {
    const signal = requestSignal()
    if (!(await partnerMembersAvailability({ signal }))) return { available: false }
    return { available: true, members: await listPartnerMembers(data.partnerId, { signal }) }
  })

/**
 * El guard de disponibilidad y la pertenencia al partner corren ANTES del
 * fetch: sin la 0141 no se toca el backend, y un `memberId` de otro taller no
 * se revoca desde esta ficha.
 */
export const revokePartnerMemberFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(revokePartnerMemberSchema)
  .handler(async ({ data }): Promise<void> => {
    if (!(await partnerMembersAvailability({ signal: requestSignal() })))
      throw new Error(PARTNER_MEMBERS_UNAVAILABLE)
    if (!(await memberBelongsToPartner(data.memberId, data.partnerId)))
      throw new Error(PARTNER_MEMBER_NOT_IN_PARTNER)
    await revokePartnerMember(data.memberId)
  })
