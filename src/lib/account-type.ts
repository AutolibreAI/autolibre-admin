import { z } from 'zod'

/**
 * Tipo de cuenta — la ÚNICA definición de quién cuenta como usuario de la app
 * y quién es un proveedor. → `.claude/rules/account-types.md`
 *
 * Decidido el 2026-11-26: los proveedores nuevos crean una cuenta y después
 * dan de alta el taller, así que también quedan en `users`. Hasta acá todos se
 * contaban como usuarios.
 *
 * - **Partner**: cuenta con al menos una membresía ACTIVA en
 *   `partner_members` (`revoked_at IS NULL`). NO se mira `users.role`: es un
 *   solo valor y puede quedar desactualizado (la cola «Revisar cuentas» lo
 *   muestra).
 * - **Uso como dueño**: tiene un vehículo no archivado, o un pedido propio
 *   (`quote_requests.user_id`) que no es duplicado/prueba, o un registro de
 *   conducir no archivado.
 * - **Admin**: `users.role = 'admin'`. Fuera de todos los conteos.
 *
 * Tipos: Usuario (no partner, no admin) · Partner (partner sin uso como dueño)
 * · Partner + dueño (partner con uso como dueño) · Admin. Un admin que además
 * es partner sigue siendo Admin.
 *
 * Conteo de usuarios = Usuario + Partner + dueño. Un partner puro nunca cuenta.
 * Las cuentas internas (`ops.excluded_email_domains`) siguen fuera de los
 * conteos aparte, como siempre: es otro eje.
 *
 * Sin imports de `~/`: lo prueba `node --test`.
 */

export const ACCOUNT_TYPES = ['usuario', 'partner', 'partner_dueno', 'admin'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  usuario: 'Usuario',
  partner: 'Partner',
  partner_dueno: 'Partner + dueño',
  admin: 'Admin',
}

export const accountTypeLabel = (t: string): string =>
  (ACCOUNT_TYPE_LABELS as Record<string, string>)[t] ?? t

/** Los tipos que suman al conteo de usuarios de la app. */
export const USER_COUNTED_TYPES: ReadonlyArray<AccountType> = ['usuario', 'partner_dueno']

export const countsAsUser = (t: AccountType): boolean => USER_COUNTED_TYPES.includes(t)

/** La regla, en JS: el espejo exacto de `accountTypeSql()` del repo. */
export function accountType(f: { role: string; isPartner: boolean; ownerUse: boolean }): AccountType {
  if (f.role === 'admin') return 'admin'
  if (f.isPartner) return f.ownerUse ? 'partner_dueno' : 'partner'
  return 'usuario'
}

/** Cuántas cuentas hay de cada tipo, contra la base a la que está conectado el panel. */
export interface AccountTypeCensus {
  /** `false` si la base no tiene `partner_members` (0141): nadie sale Partner. */
  membersAvailable: boolean
  total: number
  byType: Record<AccountType, number>
  /** Partners (los dos tipos) cuyo `users.role` no es `partner` (rol desactualizado). */
  partnersWithStaleRole: number
}

/** Filtro de `/usuarios`, calificado (`notifications.md`): `type`/`kind` pelados chocan. */
export const USER_ACCOUNT_TYPE_FILTERS = ['all', ...ACCOUNT_TYPES, 'counted'] as const
export type UserAccountTypeFilter = (typeof USER_ACCOUNT_TYPE_FILTERS)[number]
export const userAccountTypeParam = z.enum(USER_ACCOUNT_TYPE_FILTERS).catch('all').default('all')

export const USER_ACCOUNT_TYPE_FILTER_LABELS: Record<UserAccountTypeFilter, string> = {
  all: 'Todas',
  usuario: 'Usuario',
  partner: 'Partner',
  partner_dueno: 'Partner + dueño',
  admin: 'Admin',
  counted: 'Cuentan como usuario',
}

// ── Cola «Revisar cuentas» ───────────────────────────────────────────────────

export const ACCOUNT_REVIEW_KINDS = ['possible_partner', 'stale_role'] as const
export type AccountReviewKind = (typeof ACCOUNT_REVIEW_KINDS)[number]

export const ACCOUNT_REVIEW_KIND_LABELS: Record<AccountReviewKind, string> = {
  possible_partner: 'Posible partner sin vincular',
  stale_role: 'Rol desactualizado',
}

/** Por qué una cuenta coincide con un taller. */
export const ACCOUNT_MATCH_FIELDS = ['partner_email', 'application_email', 'partner_whatsapp', 'member'] as const
export type AccountMatchField = (typeof ACCOUNT_MATCH_FIELDS)[number]

export const ACCOUNT_MATCH_FIELD_LABELS: Record<AccountMatchField, string> = {
  partner_email: 'Mail del taller',
  application_email: 'Mail de la solicitud',
  partner_whatsapp: 'Teléfono = WhatsApp del taller',
  member: 'Vinculada al taller',
}

export interface AccountMatch {
  field: AccountMatchField
  partnerId: string | null
  partnerName: string | null
  applicationId: string | null
  applicationName: string | null
}

export interface AccountReviewRow {
  kind: AccountReviewKind
  userId: string
  /** Mail y teléfono: SÓLO en esta cola (admins). */
  email: string
  phone: string | null
  name: string | null
  role: string
  createdAt: string
  vehicleCount: number
  quoteCount: number
  /** (a) con qué taller coincide; (b) a qué taller está vinculada. */
  matches: Array<AccountMatch>
  review: { at: string; byLabel: string | null; note: string | null } | null
}

export interface AccountReviewQueue {
  /** ¿Está aplicada la 043 (marcas de revisado)? */
  reviewsAvailable: boolean
  membersAvailable: boolean
  rows: Array<AccountReviewRow>
}

export const accountReviewSearchSchema = z.object({
  reviewKind: z.enum(['all', ...ACCOUNT_REVIEW_KINDS]).catch('all').default('all'),
  /** Mostrar también las ya revisadas. */
  reviewShowDone: z.coerce.boolean().catch(false).default(false),
})

export const markAccountReviewedSchema = z.object({
  userId: z.uuid(),
  kind: z.enum(ACCOUNT_REVIEW_KINDS),
  /** `false` = volver a pendiente. */
  reviewed: z.boolean(),
  note: z.string().trim().max(1000, 'Hasta 1000 caracteres.').optional(),
})
export type MarkAccountReviewedInput = z.infer<typeof markAccountReviewedSchema>

export const ACCOUNT_REVIEW_UNAVAILABLE = 'ACCOUNT_REVIEW_UNAVAILABLE'

export function readableAccountReviewError(raw: string): string {
  const code = raw.match(/[A-Z_]{6,}/)?.[0]
  switch (code) {
    case ACCOUNT_REVIEW_UNAVAILABLE:
      return 'Falta aplicar la migración 043 (revisión de cuentas) en esta base.'
    case 'USER_NOT_FOUND':
      return 'Esa cuenta ya no existe. Recargá.'
    case 'INVALID_REVIEW_KIND':
      return 'Tipo de revisión inválido.'
    case 'REVIEW_NOTE_TOO_LONG':
      return 'La nota pasa de 1000 caracteres.'
    default:
      return `No se pudo guardar: ${raw}`
  }
}

/** Últimos 10 dígitos de un teléfono (`null` si tiene menos). Espejo de `right(…, 10)` del SQL. */
export function lastTenDigits(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '')
  return d.length >= 10 ? d.slice(-10) : null
}
