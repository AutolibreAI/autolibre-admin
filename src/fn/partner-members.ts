import { createServerFn } from '@tanstack/react-start'
import {
  PARTNER_MEMBERS_UNAVAILABLE,
  PARTNER_MEMBER_NOT_IN_PARTNER,
  partnerMembersSchema,
  revokePartnerMemberSchema,
} from '~/lib/partner-members'
import {
  CLAIM_CODE_PARTNER_ARCHIVED,
  CLAIM_CODE_PARTNER_HAS_OWNER,
  CLAIM_CODE_PARTNER_NOT_FOUND,
  PARTNER_CLAIM_CODES_UNAVAILABLE,
  issuePartnerClaimCodeSchema,
} from '~/lib/partner-claim-codes'
import {
  claimCodePreconditions,
  listPartnerClaimCodes,
  listPartnerMembers,
  memberBelongsToPartner,
  partnerClaimCodesAvailability,
  partnerMembersAvailability,
} from '~/server/partner-members.repo'
import { issuePartnerClaimCode, revokePartnerMember } from '~/server/backend'
import { requestSignal } from '~/server/request'
import { adminMiddleware } from './middleware'
import type { PartnerMembersResult } from '~/lib/partner-members'
import type { PartnerClaimCodesResult } from '~/lib/partner-claim-codes'

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

/**
 * Códigos para reclamar el taller (0144). Lectura por SQL con su propio guard:
 * sin la 0144 vuelve `{ available: false }` y la parte de miembros sigue igual.
 * Nunca trae `code_hash`.
 */
export const listPartnerClaimCodesFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(partnerMembersSchema)
  .handler(async ({ data }): Promise<PartnerClaimCodesResult> => {
    const signal = requestSignal()
    if (!(await partnerClaimCodesAvailability({ signal }))) return { available: false }
    return { available: true, codes: await listPartnerClaimCodes(data.partnerId, { signal }) }
  })

/**
 * Emitir un código. Antes del fetch: el guard de la 0144 y las dos condiciones
 * que el backend rechazaría con 409 (archivado, dueño activo), leídas por SQL —
 * así el caso conocido se explica con su motivo exacto y el 409 queda sólo para
 * la carrera con otro admin.
 *
 * Devuelve el código en claro: es la ÚNICA vez que existe fuera del backend.
 * No se loguea ni se guarda; va a estado de componente y nada más.
 */
export const issuePartnerClaimCodeFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(issuePartnerClaimCodeSchema)
  .handler(async ({ data }): Promise<{ code: string; expiresAt: string }> => {
    if (!(await partnerClaimCodesAvailability({ signal: requestSignal() })))
      throw new Error(PARTNER_CLAIM_CODES_UNAVAILABLE)
    const pre = await claimCodePreconditions(data.partnerId)
    if (!pre) throw new Error(CLAIM_CODE_PARTNER_NOT_FOUND)
    if (pre.status === 'archived') throw new Error(CLAIM_CODE_PARTNER_ARCHIVED)
    if (pre.hasActiveOwner) throw new Error(CLAIM_CODE_PARTNER_HAS_OWNER)
    const issued = await issuePartnerClaimCode(data.partnerId)
    return { code: issued.code, expiresAt: issued.expiresAt }
  })
