import { z } from 'zod'
import { multiSelectParam } from '~/lib/catalog'
import type { InteractionChannel, ProspectOwner, Reaction } from '~/lib/partner-prospects'

/**
 * API Chasis: las agencias a las que el equipo comercial les ofrece la API de
 * datos vehiculares (`ops.chasis_agency`, migración 031). Mismo patrón que los
 * contactos de proveedores (024/030): la ficha se autoguarda por PARCHE y las
 * charlas son append-only. → `.claude/rules/partner-prospects.md`, "API Chasis".
 *
 * Una agencia NO es un `Partner` ni un `PartnerProspect`: no se registra en el
 * marketplace ni recibe pedidos. "Chasis" es el sistema donde se carga el
 * referido para cobrar la comisión; el panel no habla con él.
 */

// ── Estados ────────────────────────────────────────────────────────────────

export const AGENCY_STATUSES = ['contacted', 'saw_sample', 'proposal_sent', 'client', 'discarded'] as const
export type AgencyStatus = (typeof AGENCY_STATUSES)[number]

export const AGENCY_STATUS_LABELS: Record<AgencyStatus, string> = {
  contacted: 'Contactada',
  saw_sample: 'Vio el informe de ejemplo',
  proposal_sent: 'Propuesta enviada',
  client: 'Cliente',
  discarded: 'Descartada',
}

/** Colores de tokens; "Propuesta enviada" en violeta (el design system no tiene azul). */
export const AGENCY_STATUS_CLASSES: Record<AgencyStatus, string> = {
  contacted: 'border-border bg-card text-foreground',
  saw_sample: 'border-status-yellow/30 bg-status-yellow-bg text-status-yellow',
  proposal_sent: 'border-status-violet/30 bg-status-violet-bg text-status-violet',
  client: 'border-status-green bg-status-green text-primary-foreground',
  discarded: 'border-status-red/30 bg-status-red-bg text-status-red',
}

/** Cliente y descartada no se siguen: fuera de "Hoy". Espejo de `idx_ops_ca_follow_up`. */
export const CLOSED_AGENCY_STATUSES: ReadonlyArray<AgencyStatus> = ['client', 'discarded']

// ── Ficha ──────────────────────────────────────────────────────────────────

export const DATA_INTERESTS = ['fines', 'debt', 'vtv', 'domain', 'other'] as const
export type DataInterest = (typeof DATA_INTERESTS)[number]
export const DATA_INTEREST_LABELS: Record<DataInterest, string> = {
  fines: 'Multas',
  debt: 'Deuda',
  vtv: 'VTV',
  domain: 'Dominio',
  other: 'Otros',
}

export const INTEGRATION_MODES = ['api', 'web'] as const
export type IntegrationMode = (typeof INTEGRATION_MODES)[number]
export const INTEGRATION_MODE_LABELS: Record<IntegrationMode, string> = {
  api: 'Integrado por API',
  web: 'Desde la web',
}

// ── Charlas ────────────────────────────────────────────────────────────────

export const AGENCY_OFFERED_MODELS = ['subscription', 'report_pack'] as const
export type AgencyOfferedModel = (typeof AGENCY_OFFERED_MODELS)[number]
export const AGENCY_OFFERED_MODEL_LABELS: Record<AgencyOfferedModel, string> = {
  subscription: 'Suscripción mensual',
  report_pack: 'Pack de informes',
}

export const AGENCY_OBJECTIONS = [
  'price',
  'has_provider',
  'low_volume',
  'tech_integration',
  'data_doubts',
  'not_now',
  'other',
] as const
export type AgencyObjection = (typeof AGENCY_OBJECTIONS)[number]
export const AGENCY_OBJECTION_LABELS: Record<AgencyObjection, string> = {
  price: 'Precio',
  has_provider: 'Ya tiene proveedor',
  low_volume: 'Poco volumen',
  tech_integration: 'Integración técnica',
  data_doubts: 'Dudas con los datos',
  not_now: 'No es el momento',
  other: 'Otra',
}

export const AGENCY_NEXT_STEP_SUGGESTIONS = [
  'Mandar el informe de ejemplo',
  'Mandar la propuesta',
  'Volver a llamar',
  'Cargar el referido en Chasis',
] as const

// ── Lo que viaja ───────────────────────────────────────────────────────────

export interface ChasisAgency {
  id: string
  name: string
  contactName: string | null
  phone: string | null
  phoneDigits: string | null
  locality: string | null
  talkedToDecider: boolean | null
  usesCarbufy: boolean | null
  useCase: string | null
  dataInterests: Array<DataInterest>
  dataInterestsOther: string | null
  monthlyVolume: number | null
  currentSolution: string | null
  currentProvider: string | null
  integrationMode: IntegrationMode | null
  otherInterest: string | null
  hasWorkshop: boolean | null
  status: AgencyStatus
  discardReason: string | null
  referralLoaded: boolean
  ownerId: string | null
  nextStep: string | null
  /** `YYYY-MM-DD`, armado en SQL. */
  lastContactOn: string | null
  nextFollowUpOn: string | null
  /** Días al próximo seguimiento contra hoy en Buenos Aires; lo calcula Postgres. */
  followUpInDays: number | null
  notes: string | null
  /** El contacto de proveedor que salió de esta agencia ("Crear contacto de proveedor"). */
  prospectId: string | null
  prospectName: string | null
  interactionCount: number
  createdAt: string
  updatedAt: string
}

export interface AgencyInteraction {
  id: string
  occurredAt: string
  channel: InteractionChannel
  answered: boolean | null
  talkedToDecider: boolean | null
  offeredModel: AgencyOfferedModel | null
  offeredAmount: string | null
  reaction: Reaction | null
  questionsAnswers: string | null
  objection: AgencyObjection | null
  objectionOther: string | null
  pitchNotes: string | null
  statusAfter: AgencyStatus
  discardReason: string | null
  nextStep: string
  nextFollowUpOn: string | null
  actorName: string | null
}

/**
 * El resumen de arriba. Sigue a todos los filtros menos el de estado (es el
 * desglose por estado), igual que los contadores de Contactos.
 */
export interface AgencySummary {
  total: number
  byStatus: Record<AgencyStatus, number>
  /** Agencias con "Referido cargado en Chasis". */
  referralsLoaded: number
  /** Clientes SIN el referido cargado: sin eso no se cobra la comisión. */
  clientsWithoutReferral: number
  /** Autos o consultas por mes de las agencias abiertas (no cliente, no descartada). */
  pipelineVolume: number
  /** Cuántas agencias abiertas tienen el volumen cargado. */
  pipelineVolumeN: number
  /** Lo mismo, de las que ya son clientes. */
  clientVolume: number
  objections: Array<{ objection: AgencyObjection; agencies: number; interactions: number }>
  otherObjections: Array<{ text: string; count: number }>
  interactions: number
}

export interface AgencyFacets {
  owners: Array<ProspectOwner>
  localities: Array<string>
}

export type AgenciesMissing = '024' | '030' | '031'

export type AgencyListResult =
  | { available: false; missing: AgenciesMissing }
  | {
      available: true
      rows: Array<ChasisAgency>
      matched: number
      summary: AgencySummary
      facets: AgencyFacets
    }

export type AgencyDetailResult =
  | { available: false; missing: AgenciesMissing }
  | { available: true; agency: ChasisAgency; interactions: Array<AgencyInteraction>; facets: AgencyFacets }

export const AGENCY_LIST_LIMIT = 300

// ── Search params ──────────────────────────────────────────────────────────

/** Calificados `agency*` (`notifications.md`); `q` se comparte. */
export const agencySearchSchema = z.object({
  q: z.string().trim().max(200).optional().catch(undefined),
  agencyStatus: z.enum(AGENCY_STATUSES).optional().catch(undefined),
  agencyZones: multiSelectParam(z.string().trim().max(200)),
  agencyOwner: z.union([z.uuid(), z.literal('none')]).optional().catch(undefined),
})
export type AgencySearch = z.infer<typeof agencySearchSchema>

// ── Escrituras ─────────────────────────────────────────────────────────────

const text = (max: number) => z.string().max(max)
const optionalDate = z.union([z.iso.date(), z.literal('')])

const agencyFieldsSchema = z.object({
  name: text(200),
  contactName: text(200),
  phone: text(60),
  locality: text(200),
  talkedToDecider: z.boolean().nullable(),
  usesCarbufy: z.boolean().nullable(),
  useCase: text(1000),
  dataInterests: z.array(z.enum(DATA_INTERESTS)).max(DATA_INTERESTS.length),
  dataInterestsOther: text(300),
  monthlyVolume: z.number().int().min(0).max(10_000_000).nullable(),
  currentSolution: text(1000),
  currentProvider: text(200),
  integrationMode: z.enum(INTEGRATION_MODES).nullable(),
  otherInterest: text(1000),
  hasWorkshop: z.boolean().nullable(),
  status: z.enum(AGENCY_STATUSES),
  discardReason: text(500),
  referralLoaded: z.boolean(),
  ownerId: z.uuid().nullable(),
  nextStep: text(300),
  lastContactOn: optionalDate,
  nextFollowUpOn: optionalDate,
  notes: text(5000),
})
export type AgencyFields = z.infer<typeof agencyFieldsSchema>
export type AgencyPatch = Partial<AgencyFields>

/** camelCase → clave del SP. Explícito: una clave mal mapeada sería un campo que no se guarda. */
const AGENCY_PATCH_KEYS: Record<keyof AgencyFields, string> = {
  name: 'name',
  contactName: 'contact_name',
  phone: 'phone',
  locality: 'locality',
  talkedToDecider: 'talked_to_decider',
  usesCarbufy: 'uses_carbufy',
  useCase: 'use_case',
  dataInterests: 'data_interests',
  dataInterestsOther: 'data_interests_other',
  monthlyVolume: 'monthly_volume',
  currentSolution: 'current_solution',
  currentProvider: 'current_provider',
  integrationMode: 'integration_mode',
  otherInterest: 'other_interest',
  hasWorkshop: 'has_workshop',
  status: 'status',
  discardReason: 'discard_reason',
  referralLoaded: 'referral_loaded',
  ownerId: 'owner_id',
  nextStep: 'next_step',
  lastContactOn: 'last_contact_on',
  nextFollowUpOn: 'next_follow_up_on',
  notes: 'notes',
}

export function toSpAgencyPatch(patch: AgencyPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(AGENCY_PATCH_KEYS) as Array<keyof AgencyFields>) {
    if (patch[key] !== undefined) out[AGENCY_PATCH_KEYS[key]] = patch[key]
  }
  return out
}

export const createAgencySchema = agencyFieldsSchema
  .partial()
  .extend({ name: z.string().trim().min(1, 'Falta el nombre').max(200) })
export type CreateAgencyInput = z.infer<typeof createAgencySchema>

export const updateAgencySchema = z.object({
  id: z.uuid(),
  patch: agencyFieldsSchema.partial().refine((p) => Object.keys(p).length > 0, 'Parche vacío'),
})

export const agencyIdSchema = z.object({ id: z.uuid() })

/** Una charla: obligatorios canal, estado y próximo paso, como la de proveedores. */
export const addAgencyInteractionSchema = z
  .object({
    agencyId: z.uuid(),
    occurredAt: z.string().max(40).optional(),
    channel: z.enum(['call', 'whatsapp', 'visit'], 'Elegí el canal'),
    answered: z.boolean().nullable().optional(),
    talkedToDecider: z.boolean().nullable().optional(),
    offeredModel: z.enum(AGENCY_OFFERED_MODELS).nullable().optional(),
    offeredAmount: text(120).optional(),
    reaction: z.enum(['positive', 'neutral', 'negative']).nullable().optional(),
    questionsAnswers: text(5000).optional(),
    objection: z.enum(AGENCY_OBJECTIONS).nullable().optional(),
    objectionOther: text(300).optional(),
    pitchNotes: text(5000).optional(),
    statusAfter: z.enum(AGENCY_STATUSES, 'Elegí el estado'),
    discardReason: text(500).optional(),
    nextStep: z.string().trim().min(1, 'Falta el próximo paso').max(300),
    nextFollowUpOn: optionalDate.optional(),
  })
  .refine((d) => d.statusAfter !== 'discarded' || (d.discardReason ?? '').trim() !== '', {
    path: ['discardReason'],
    message: 'Falta el motivo del descarte',
  })
  .refine((d) => d.objection !== 'other' || (d.objectionOther ?? '').trim() !== '', {
    path: ['objectionOther'],
    message: 'Escribí cuál es la objeción',
  })
export type AddAgencyInteractionInput = z.infer<typeof addAgencyInteractionSchema>

const AGENCY_INTERACTION_KEYS: Record<Exclude<keyof AddAgencyInteractionInput, 'agencyId'>, string> = {
  occurredAt: 'occurred_at',
  channel: 'channel',
  answered: 'answered',
  talkedToDecider: 'talked_to_decider',
  offeredModel: 'offered_model',
  offeredAmount: 'offered_amount',
  reaction: 'reaction',
  questionsAnswers: 'questions_answers',
  objection: 'objection',
  objectionOther: 'objection_other',
  pitchNotes: 'pitch_notes',
  statusAfter: 'status_after',
  discardReason: 'discard_reason',
  nextStep: 'next_step',
  nextFollowUpOn: 'next_follow_up_on',
}

export function toSpAgencyInteraction(input: AddAgencyInteractionInput): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(AGENCY_INTERACTION_KEYS) as Array<keyof typeof AGENCY_INTERACTION_KEYS>) {
    const v = input[key]
    if (v !== undefined && v !== '') out[AGENCY_INTERACTION_KEYS[key]] = v
  }
  return out
}

// ── Errores ────────────────────────────────────────────────────────────────

export const AGENCIES_UNAVAILABLE = 'AGENCIES_UNAVAILABLE'

export function readableAgencyError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  if (msg.includes(AGENCIES_UNAVAILABLE))
    return 'Falta aplicar la migración 031 en esta base: las agencias no se pueden guardar todavía.'
  if (msg.includes('DUPLICATE_PHONE')) return 'Ya hay otra agencia con ese teléfono.'
  if (msg.includes('NAME_REQUIRED')) return 'El nombre no puede quedar vacío.'
  if (msg.includes('DISCARD_REASON_REQUIRED')) return 'Para descartarla hace falta el motivo.'
  if (msg.includes('NEXT_STEP_REQUIRED')) return 'Falta el próximo paso.'
  if (msg.includes('OBJECTION_OTHER_REQUIRED')) return 'Con la objeción "Otra", escribí cuál.'
  if (msg.includes('INTERACTION_IN_FUTURE')) return 'La fecha de la charla no puede ser futura.'
  if (msg.includes('INVALID_MONTHLY_VOLUME')) return 'Los autos o consultas por mes tienen que ser un número entero.'
  if (msg.includes('AGENCY_ALREADY_LINKED')) return 'Esta agencia ya tiene su contacto de proveedor.'
  if (msg.includes('AGENCY_NOT_FOUND')) return 'La agencia ya no existe. Recargá la página.'
  if (msg.includes('OWNER_NOT_FOUND')) return 'Ese usuario ya no existe.'
  if (msg.includes('INVALID_DATE')) return 'Fecha inválida.'
  if (msg.includes('FORBIDDEN') || msg.includes('UNAUTHENTICATED'))
    return 'Tu sesión no tiene permisos de admin. Volvé a entrar.'
  return 'No se pudo guardar. Probá de nuevo.'
}
