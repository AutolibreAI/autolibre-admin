import { z } from 'zod'

/**
 * Miembros de un partner — las cuentas de la app vinculadas a un taller
 * (`public.partner_members`, migración 0141 del backend).
 *
 * Lee por SQL (`~/server/partner-members.repo`), escribe SÓLO por HTTP
 * (`POST /admin/partner-members/:id/revoke`, `~/server/backend`). Nunca un
 * `INSERT`/`UPDATE` a `partner_members` desde el panel. → `.claude/rules/partner-members.md`
 *
 * Activo = `revoked_at IS NULL`. No hay columna de estado.
 */

/** Sin la 0141 en la base: la tarjeta lo dice y no ofrece botones. */
export const PARTNER_MEMBERS_UNAVAILABLE = 'PARTNER_MEMBERS_UNAVAILABLE'
/** El miembro no es de ESTE partner (o no existe): no se revoca desde esta pantalla. */
export const PARTNER_MEMBER_NOT_IN_PARTNER = 'PARTNER_MEMBER_NOT_IN_PARTNER'

export const PARTNER_MEMBER_ROLE_LABELS: Record<string, string> = {
  owner: 'Dueño',
  staff: 'Staff',
}

/**
 * `partner_membership_verification` es un enum ABIERTO: hoy `admin_code` y
 * `application_approval` (0150), mañana `whatsapp_otp`. Un valor sin etiqueta se muestra CRUDO
 * (`verificationLabel`), nunca se esconde.
 */
export const PARTNER_MEMBERSHIP_VERIFICATION_LABELS: Record<string, string> = {
  admin_code: 'código del equipo',
  /** 0150: lo asigna el backend al aprobar la solicitud que esa cuenta registró logueada. */
  application_approval: 'aprobación de la solicitud',
}

export const memberRoleLabel = (role: string): string => PARTNER_MEMBER_ROLE_LABELS[role] ?? role
export const verificationLabel = (via: string): string =>
  PARTNER_MEMBERSHIP_VERIFICATION_LABELS[via] ?? via

export interface PartnerMember {
  id: string
  userId: string
  userEmail: string
  userName: string | null
  /** `owner` | `staff`, crudo: un valor nuevo del enum se muestra tal cual. */
  memberRole: string
  verifiedVia: string
  createdAt: string
  revokedAt: string | null
  revokedById: string | null
  /** `null` con `revokedAt` cargado = lo revocó un admin cuya cuenta se borró (FK `ON DELETE SET NULL`). */
  revokedByEmail: string | null
}

export type PartnerMembersResult =
  | { available: false }
  | { available: true; members: Array<PartnerMember> }

export const partnerMembersSchema = z.object({ partnerId: z.uuid() })

export const revokePartnerMemberSchema = z.object({
  partnerId: z.uuid(),
  memberId: z.uuid(),
})

export function readablePartnerMemberError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)

  if (raw === PARTNER_MEMBERS_UNAVAILABLE)
    return 'Falta desplegar la migración 0141 del backend (partner_members) en esta base.'
  if (raw === PARTNER_MEMBER_NOT_IN_PARTNER)
    return 'Ese miembro no pertenece a este taller (o ya no existe). Recargá la pantalla.'
  if (raw === 'BACKEND_UNAUTHENTICATED' || raw === 'UNAUTHENTICATED')
    return 'Tu sesión expiró o el backend no la aceptó. Cerrá sesión y volvé a entrar.'
  if (raw === 'BACKEND_FORBIDDEN') return 'Tu usuario no es admin en el backend.'
  if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'
  if (raw.startsWith('BACKEND_UNREACHABLE:')) {
    const url = raw.slice('BACKEND_UNREACHABLE:'.length)
    return `El panel no llega al backend en ${url}. En producción es la variable AUTOLIBRE_BACKEND_URL de Vercel; en desarrollo, si no está en el .env, el panel usa localhost:3005 y el backend tiene que estar corriendo ahí.`
  }
  if (raw.startsWith('BACKEND_NOT_FOUND:')) {
    const detail = raw.slice('BACKEND_NOT_FOUND:'.length)
    // Nest contesta "Cannot POST …" cuando la RUTA no existe.
    if (detail.includes('Cannot POST'))
      return 'El backend al que le habla el panel no tiene `/admin/partner-members/:id/revoke` todavía — falta desplegarlo.'
    return 'Ese miembro ya no existe; recargá.'
  }
  if (raw.startsWith('BACKEND_BAD_REQUEST:')) {
    const detail = raw.split(':').slice(2).join(':')
    return `El backend rechazó el pedido: «${detail}».`
  }
  if (raw.startsWith('BACKEND_ERROR:')) {
    const [, status, ...rest] = raw.split(':')
    return `El backend respondió ${status}: ${rest.join(':')}`
  }
  if (raw.includes('AUTOLIBRE_BACKEND_URL')) return 'Falta configurar AUTOLIBRE_BACKEND_URL.'
  if (raw.includes('timed out') || raw.includes('TimeoutError')) return 'El backend tardó demasiado. Probá de nuevo.'
  return raw
}
