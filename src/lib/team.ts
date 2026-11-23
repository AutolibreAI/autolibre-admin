import { z } from 'zod'

/**
 * El equipo de AutoLibre y "Alta por" — client-safe: tipos, schemas, etiquetas
 * y traducción de errores. Migración 035 (`ops.team_member`,
 * `ops.partner_application_sourcer`). → `.claude/rules/team-sourcing.md`
 *
 * "Alta por" es QUIÉN DEL EQUIPO trajo a un proveedor. No es
 * `partner_applications.reviewed_by_id` (quién la revisó) ni `how_found` (lo
 * que declaró el proveedor): no se derivan de ahí ni se pisan.
 */

export const TEAM_ROLES = ['fundador', 'comercial', 'otro'] as const
export type TeamRole = (typeof TEAM_ROLES)[number]

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  fundador: 'Fundador',
  comercial: 'Comercial',
  otro: 'Otro',
}

export function teamRoleLabel(role: string): string {
  return (TEAM_ROLE_LABELS as Record<string, string>)[role] ?? role
}

export interface TeamMember {
  id: string
  name: string
  role: string
  active: boolean
  /** `YYYY-MM-DD`, día en hora de Buenos Aires. */
  activeSince: string
  inactiveSince: string | null
  /** Usuario del panel vinculado (opcional). */
  userId: string | null
  userLabel: string | null
  /** Solicitudes asignadas hoy a esta persona. */
  applicationCount: number
}

/** Lo mínimo para mostrar a quien trajo una solicitud. */
export interface SourcerRef {
  memberId: string
  name: string
  active: boolean
}

export interface SourcingHistoryEntry {
  id: string
  before: SourcerRef | null
  after: SourcerRef | null
  /** Quién hizo el cambio (usuario del panel). `null` = usuario borrado. */
  actorLabel: string | null
  at: string
}

export interface ApplicationSourcing {
  current: (SourcerRef & { assignedAt: string; assignedByLabel: string | null }) | null
  history: Array<SourcingHistoryEntry>
}

/** Usuario del panel que se puede vincular a una persona. */
export interface PanelUserOption {
  id: string
  label: string
  /** Persona a la que ya está vinculado, si alguna. */
  linkedMemberId: string | null
}

/** Lo que trae cualquier pantalla con el selector de "Alta por". */
export interface SourcingContext {
  /** ¿Está aplicada la 035? Sin ella no se muestra nada (ni un selector roto). */
  available: boolean
  /** Todas, activas e inactivas (las inactivas se ven en sus altas, no se ofrecen). */
  members: Array<TeamMember>
  /** La persona vinculada al usuario logueado, para "Es mío". */
  meMemberId: string | null
  /** Solicitudes no descartadas sin asignar / total no descartado (todas las fechas y estados). */
  progress: { unassigned: number; total: number } | null
}

// ── Search params (calificados: `applicationSourcer`, nunca `sourcer`) ──────

export const SOURCER_FILTER_NONE = 'none' as const

/** `none` = sin asignar; un uuid = esa persona; ausente = todas. */
export const applicationSourcerParam = z
  .union([z.literal(SOURCER_FILTER_NONE), z.uuid()])
  .optional()
  .catch(undefined)

export const SOURCING_UNITS = ['week', 'month'] as const
export type SourcingUnit = (typeof SOURCING_UNITS)[number]
export const sourcingUnitParam = z.enum(SOURCING_UNITS).catch('week').default('week')

// ── Entradas de los server functions ────────────────────────────────────────

export const memberNameSchema = z
  .string()
  .trim()
  .min(1, 'Escribí el nombre.')
  .max(120, 'Máximo 120 caracteres.')

export const createTeamMemberSchema = z.object({
  name: memberNameSchema,
  role: z.enum(TEAM_ROLES),
  userId: z.uuid().nullable().default(null),
})

export const updateTeamMemberSchema = z.object({
  memberId: z.uuid(),
  patch: z
    .object({
      name: memberNameSchema.optional(),
      role: z.enum(TEAM_ROLES).optional(),
      active: z.boolean().optional(),
      userId: z.uuid().nullable().optional(),
    })
    .refine((p) => Object.keys(p).length > 0, 'Nada que guardar.'),
})

export const setApplicationSourcerSchema = z.object({
  applicationId: z.uuid(),
  /** `null` = quitar. */
  memberId: z.uuid().nullable(),
  /** Lo que el operador vio: si cambió, el SP contesta `SOURCER_CHANGED`. */
  expectedMemberId: z.uuid().nullable(),
})

export const applicationIdSchema = z.object({ applicationId: z.uuid() })
export const partnerIdSchema = z.object({ partnerId: z.uuid() })

// ── Conteo ──────────────────────────────────────────────────────────────────

export interface SourcingCountRow {
  /** `YYYY-MM-DD`: lunes de la semana o día 1 del mes, en hora de Buenos Aires. */
  period: string
  /** memberId → altas. La clave `none` = sin asignar. */
  counts: Record<string, number>
  total: number
}

export interface SourcingCounts {
  available: boolean
  unit: SourcingUnit
  periods: Array<SourcingCountRow>
  /** Personas que aparecen en el período, más las activas (en cero también). */
  members: Array<SourcerRef>
  /** Solicitudes (no descartadas) sin asignar, de todos los tiempos. */
  unassigned: number
  totalApplications: number
}

/** Cuántos períodos hacia atrás mira el conteo. */
export const SOURCING_PERIODS: Record<SourcingUnit, number> = { week: 8, month: 6 }

// ── Errores ─────────────────────────────────────────────────────────────────

export const TEAM_UNAVAILABLE = 'TEAM_UNAVAILABLE'

/** Traduce las sentinelas de la 035 a castellano. Lo desconocido sale crudo. */
export function readableTeamError(raw: string, members: ReadonlyArray<{ id: string; name: string }> = []): string {
  if (raw.startsWith(TEAM_UNAVAILABLE)) {
    return 'Falta aplicar la migración 035 (Alta por) en esta base.'
  }
  if (raw.startsWith('SOURCER_CHANGED')) {
    const id = raw.split(':')[1]?.trim()
    const who = id && id !== 'none' ? members.find((m) => m.id === id)?.name : null
    return who
      ? `Mientras tanto alguien la asignó a ${who}. Revisá y volvé a intentar.`
      : 'Mientras tanto alguien cambió la asignación. Revisá y volvé a intentar.'
  }
  if (raw.startsWith('MEMBER_INACTIVE')) return 'Esa persona está inactiva: no se le asignan altas nuevas.'
  if (raw.startsWith('MEMBER_NOT_FOUND')) return 'Esa persona ya no existe. Recargá.'
  if (raw.startsWith('APPLICATION_NOT_FOUND')) return 'La solicitud ya no existe. Recargá.'
  if (raw.startsWith('MEMBER_NAME_TAKEN')) return 'Ya hay una persona con ese nombre.'
  if (raw.startsWith('MEMBER_NAME_REQUIRED')) return 'Escribí el nombre.'
  if (raw.startsWith('MEMBER_NAME_TOO_LONG')) return 'El nombre es demasiado largo (máx. 120).'
  if (raw.startsWith('INVALID_MEMBER_ROLE')) return 'Rol inválido.'
  if (raw.startsWith('USER_ALREADY_LINKED')) return 'Ese usuario ya está vinculado a otra persona.'
  if (raw.startsWith('USER_NOT_FOUND')) return 'Ese usuario ya no existe.'
  if (raw === 'UNAUTHENTICATED') return 'Tu sesión venció. Volvé a entrar.'
  if (raw === 'FORBIDDEN') return 'Tu usuario no es admin.'
  return raw
}

/** Etiqueta de una persona en una lista: el nombre, y "(inactivo)" si corresponde. */
export function sourcerLabel(ref: { name: string; active: boolean }): string {
  return ref.active ? ref.name : `${ref.name} (inactivo)`
}
