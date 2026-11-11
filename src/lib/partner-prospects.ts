import { z } from 'zod'
import { multiSelectParam, normalizeForMatch } from '~/lib/catalog'
import type { ChasisAgency } from '~/lib/chasis-agencies'

/**
 * Seguimiento comercial: los proveedores que el equipo sale a buscar
 * (`ops.partner_prospect`, migración 024). → `.claude/rules/partner-prospects.md`
 *
 * ── Vocabulario ────────────────────────────────────────────────────────────
 *
 * En el código es `PartnerProspect` (regla dura 7: `Partner`, nunca
 * `Provider`). En la UI es "contacto" y "proveedor", que es como habla el
 * equipo — gomerías, lavaderos, gestorías y grúas también, no sólo talleres.
 */

// ── Estados ────────────────────────────────────────────────────────────────

/**
 * El embudo (migración 030). El orden es el del embudo, y es el de los chips y
 * el del selector; `discarded` es la salida, con motivo obligatorio.
 */
export const PROSPECT_STATUSES = [
  'to_contact',
  'contacted',
  'interested',
  'registered',
  'first_order',
  'job_confirmed',
  'discarded',
] as const
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number]

export const PROSPECT_STATUS_LABELS: Record<ProspectStatus, string> = {
  to_contact: 'Por contactar',
  contacted: 'Contactado',
  interested: 'Interesado',
  registered: 'Registrado',
  first_order: 'Recibió su primer pedido',
  job_confirmed: 'Trabajo confirmado',
  discarded: 'Descartado',
}

/**
 * Clases de color por estado, todas de tokens (`design-system.md`).
 *
 * **"Interesado" va en VIOLETA, no en azul**: el design system de mobile no
 * tiene azul, a propósito (`tokens.ts`: "Esta app NO TIENE azul a propósito —
 * la marca migró de #007AFF a verde"). El violeta es el único color de estado
 * que queda libre. Si se quiere azul, se agrega primero en mobile.
 */
export const PROSPECT_STATUS_CLASSES: Record<ProspectStatus, string> = {
  to_contact: 'border-border bg-surface-2 text-muted-foreground',
  contacted: 'border-border bg-card text-foreground',
  interested: 'border-status-violet/30 bg-status-violet-bg text-status-violet',
  registered: 'border-status-green/30 bg-status-green-bg text-status-green',
  first_order: 'border-status-green/30 bg-status-green-bg text-status-green',
  job_confirmed: 'border-status-green bg-status-green text-primary-foreground',
  discarded: 'border-status-red/30 bg-status-red-bg text-status-red',
}

/**
 * Los que ya no necesitan seguimiento: fuera de la vista "Hoy". Un registrado
 * todavía se sigue (falta su primer pedido). Espejo del índice parcial
 * `idx_ops_pp_follow_up` de la 030: se tocan juntos.
 */
export const CLOSED_PROSPECT_STATUSES: ReadonlyArray<ProspectStatus> = ['job_confirmed', 'discarded']

/** "Se registró en la plataforma": registrado o más allá. */
export const REGISTERED_PROSPECT_STATUSES: ReadonlyArray<ProspectStatus> = [
  'registered',
  'first_order',
  'job_confirmed',
]

// ── Ficha (030) ────────────────────────────────────────────────────────────

export const PROSPECT_FRONTS = ['ruta-2', 'corredor-norte', 'por-pedido'] as const
export type ProspectFront = (typeof PROSPECT_FRONTS)[number]

export const PROSPECT_FRONT_LABELS: Record<ProspectFront, string> = {
  'ruta-2': 'Ruta 2',
  'corredor-norte': 'Corredor Norte',
  'por-pedido': 'Por pedido',
}

export const PREFERRED_CHANNELS = ['whatsapp', 'app_web'] as const
export type PreferredChannel = (typeof PREFERRED_CHANNELS)[number]

export const PREFERRED_CHANNEL_LABELS: Record<PreferredChannel, string> = {
  whatsapp: 'Por WhatsApp',
  app_web: 'Por la app o la web',
}

/**
 * Los 4 checks. Con los 4 el contacto queda "Verificado" — derivado al leer,
 * no una columna (ver la cabecera de la 030).
 */
export const VERIFY_CHECKS = [
  { key: 'verifyTestResponse', label: 'Responde a un pedido de prueba en menos de 4 h hábiles' },
  { key: 'verifyIdentity', label: 'Identidad y dirección confirmadas' },
  { key: 'verifyPayment', label: 'Acepta transferencia o Mercado Pago' },
  { key: 'verifyReputation', label: '4,3★ o más en reseñas, o una visita nuestra' },
] as const
export type VerifyKey = (typeof VERIFY_CHECKS)[number]['key']

// ── Charlas (030) ──────────────────────────────────────────────────────────

export const INTERACTION_CHANNELS = ['call', 'whatsapp', 'visit'] as const
export type InteractionChannel = (typeof INTERACTION_CHANNELS)[number]
export const INTERACTION_CHANNEL_LABELS: Record<InteractionChannel, string> = {
  call: 'Llamado',
  whatsapp: 'WhatsApp',
  visit: 'Visita',
}

export const OFFERED_MODELS = ['fee_per_job', 'free_plan', 'other'] as const
export type OfferedModel = (typeof OFFERED_MODELS)[number]
export const OFFERED_MODEL_LABELS: Record<OfferedModel, string> = {
  fee_per_job: 'Fee por trabajo confirmado',
  free_plan: 'Plan gratis',
  other: 'Otro',
}

export const REACTIONS = ['positive', 'neutral', 'negative'] as const
export type Reaction = (typeof REACTIONS)[number]
export const REACTION_LABELS: Record<Reaction, string> = {
  positive: 'Positiva',
  neutral: 'Neutral',
  negative: 'Negativa',
}
export const REACTION_CLASSES: Record<Reaction, string> = {
  positive: 'text-status-green',
  neutral: 'text-muted-foreground',
  negative: 'text-status-red',
}

export const OBJECTIONS = [
  'not_enough_work',
  'price',
  'no_apps',
  'distrust',
  'enough_clients',
  'not_now',
  'other',
] as const
export type Objection = (typeof OBJECTIONS)[number]
export const OBJECTION_LABELS: Record<Objection, string> = {
  not_enough_work: 'No le generamos suficiente trabajo',
  price: 'Precio',
  no_apps: 'No usa apps',
  distrust: 'Desconfianza',
  enough_clients: 'Ya tiene clientes de sobra',
  not_now: 'No es el momento',
  other: 'Otra',
}

/** Qué le contó: los 4 checks de cada charla. */
export const TOLD_TOPICS = [
  { key: 'toldHowOrders', label: 'Cómo llegan los pedidos' },
  { key: 'toldProfile', label: 'Su perfil como web propia' },
  { key: 'toldZoneDemand', label: 'Demanda en su zona' },
  { key: 'toldAsistir24', label: 'Alianza con Asistir 24' },
] as const
export type ToldKey = (typeof TOLD_TOPICS)[number]['key']

/** Atajos del próximo paso en el formulario del celular. */
export const NEXT_STEP_SUGGESTIONS = [
  'Volver a llamar',
  'Mandar info por WhatsApp',
  'Ir en persona',
  'Esperar que se registre',
  'Mandarle un pedido de prueba',
] as const

/** Una charla, como se lee. `occurredAt` en ISO; el día del seguimiento como texto. */
export interface ProspectInteraction {
  id: string
  occurredAt: string
  channel: InteractionChannel
  answered: boolean | null
  talkedToDecider: boolean | null
  toldHowOrders: boolean
  toldProfile: boolean
  toldZoneDemand: boolean
  toldAsistir24: boolean
  offeredModel: OfferedModel | null
  offeredAmount: string | null
  reaction: Reaction | null
  questionsAnswers: string | null
  objection: Objection | null
  objectionOther: string | null
  jobsPerMonthToPay: number | null
  pitchNotes: string | null
  statusAfter: ProspectStatus
  discardReason: string | null
  nextStep: string
  nextFollowUpOn: string | null
  actorName: string | null
}

// ── Plan ───────────────────────────────────────────────────────────────────

export const PROSPECT_PLANS = ['undecided', 'free', 'plus'] as const
export type ProspectPlan = (typeof PROSPECT_PLANS)[number]

export const PROSPECT_PLAN_LABELS: Record<ProspectPlan, string> = {
  undecided: 'Sin definir',
  free: 'Gratis',
  plus: 'Plus',
}

// ── Teléfono ───────────────────────────────────────────────────────────────

/**
 * ESPEJO de `ops.normalize_ar_phone` (migración 024): `549` + 10 dígitos, o
 * `null`. La verdad es la de la base —ahí vive el índice único de
 * duplicados—; esto existe para el botón de WhatsApp y la vista previa del
 * CSV. Si divergen, la vista previa dice "nuevo" y la base lo rechaza como
 * duplicado: falla fuerte, nunca guarda dos veces. Se tocan juntas.
 *
 * Nunca se completa una característica: un número de 8 dígitos o un "15"
 * suelto sin código de área dan `null`.
 */
export function normalizeArPhone(phone: string | null | undefined): string | null {
  const v = (phone ?? '').replace(/[^0-9]/g, '')
  if (/^549[0-9]{10}$/.test(v)) return v
  if (/^54[0-9]{10}$/.test(v)) return `549${v.slice(2)}`
  if (/^0?1115[0-9]{8}$/.test(v)) return `54911${v.slice(-8)}`
  if (/^0[0-9]{10}$/.test(v)) return `549${v.slice(1)}`
  if (/^(11[0-9]{8}|[23][0-9]{9})$/.test(v)) return `549${v}`
  return null
}

/** `https://wa.me/549…` — sólo con la forma canónica. */
export function prospectWhatsAppUrl(phoneDigits: string | null): string | null {
  return phoneDigits ? `https://wa.me/${phoneDigits}` : null
}

// ── Lo que viaja ───────────────────────────────────────────────────────────

export interface PartnerProspect {
  id: string
  name: string
  phone: string | null
  phoneDigits: string | null
  locality: string | null
  shortNote: string | null
  categorySlugs: Array<string>
  originSlug: string
  status: ProspectStatus
  ownerId: string | null
  talkedTo: string | null
  plan: ProspectPlan
  /** `YYYY-MM-DD`, armado en SQL: un `date` pasado por `Date` corre el día. */
  lastContactOn: string | null
  nextFollowUpOn: string | null
  /**
   * Días hasta el próximo seguimiento, contra HOY en Buenos Aires. Lo calcula
   * Postgres: la pantalla es SSR y restar contra el reloj del navegador daría
   * otro número (mismatch de hidratación), mismo patrón que `age_minutes` de
   * `/actividad`. Negativo = vencido.
   */
  followUpInDays: number | null
  notes: string | null
  partnerId: string | null
  partnerName: string | null
  partnerStatus: string | null
  createdAt: string
  updatedAt: string
  // ── 030 ──
  front: ProspectFront | null
  frontQuoteRequestId: string | null
  /** `AL-n` del pedido del frente; `null` sin pedido. */
  frontQuoteCode: string | null
  knewAutolibre: boolean | null
  clientAcquisition: string | null
  preferredChannel: PreferredChannel | null
  hasCapacity: boolean | null
  managementSystem: string | null
  network: string | null
  verifyTestResponse: boolean
  verifyIdentity: boolean
  verifyPayment: boolean
  verifyReputation: boolean
  /** Los 4 checks, derivado en el SELECT. */
  verified: boolean
  discardReason: string | null
  nextStep: string | null
  /** Fecha de alta en el marketplace (`YYYY-MM-DD`): la de la liquidación. */
  partnerRegisteredOn: string | null
  interactionCount: number
}

export interface ProspectOrigin {
  slug: string
  label: string
}

/** Un comercial: un admin del panel. */
export interface ProspectOwner {
  id: string
  name: string
  email: string
}

export interface ProspectCategoryOption {
  slug: string
  name: string
}

/**
 * Los contadores de arriba. Siguen a TODOS los filtros menos el de estado:
 * son justamente el desglose por estado, y con el filtro de estado puesto
 * dirían "3 interesados de 3".
 */
export interface ProspectSummary {
  total: number
  /** Todo lo que salió de "Por contactar". */
  contacted: number
  interested: number
  /** Registrado o más allá (primer pedido, trabajo confirmado). */
  registered: number
  discarded: number
  verified: number
  /** Seguimientos vencidos o de hoy, de contactos abiertos. */
  dueToday: number
}

export interface ProspectFacets {
  origins: Array<ProspectOrigin>
  owners: Array<ProspectOwner>
  categories: Array<ProspectCategoryOption>
  /** Las localidades cargadas, crudas (texto libre), para el filtro de zona. */
  localities: Array<string>
}

/** El detalle de un contacto: la ficha, su historial y lo necesario para editar. */
export type ProspectDetailResult =
  | { available: false; missing: ProspectsMissing }
  | {
      available: true
      prospect: PartnerProspect
      interactions: Array<ProspectInteraction>
      facets: ProspectFacets
    }

/** Qué migración falta: la 024 (no hay tabla) o la 030 (embudo viejo). */
export type ProspectsMissing = '024' | '030'

export type ProspectListResult =
  | { available: false; missing: ProspectsMissing }
  | {
      available: true
      rows: Array<PartnerProspect>
      /** Cuántos matchean el filtro; `rows` corta en `PROSPECT_LIST_LIMIT`. */
      matched: number
      summary: ProspectSummary
      facets: ProspectFacets
    }

export type ProspectTodayResult =
  | { available: false; missing: ProspectsMissing }
  | {
      available: true
      rows: Array<PartnerProspect>
      summary: ProspectSummary
      facets: ProspectFacets
      /** Agencias de API Chasis vencidas o de hoy; `null` si la base no tiene la 031. */
      agencies: Array<ChasisAgency> | null
    }

// ── Resumen y altas (etapa 2) ──────────────────────────────────────────────

/**
 * El resumen de la pestaña Resumen. Dos clases de número, y la pantalla lo
 * dice: los conteos por estado y los verificados son el estado ACTUAL de los
 * contactos que pasan el filtro (sin fecha); las charlas, las objeciones, los
 * trabajos/mes y las altas del período sí miran el rango de fechas.
 */
export interface ComercialSummary {
  total: number
  byStatus: Record<ProspectStatus, number>
  verified: number
  /** `YYYY-MM` del mes actual en Buenos Aires: el de "Altas del mes". */
  month: string
  altasMonth: number
  /** Altas con `partner_registered_on` dentro del rango; `null` sin rango. */
  altasPeriod: number | null
  interactions: number
  /** Por objeción: proveedores distintos que la plantearon (el número que manda) y charlas. */
  objections: Array<{ objection: Objection; prospects: number; interactions: number }>
  /** Los textos de "Otra", agrupados, de más a menos repetido (10 como mucho). */
  otherObjections: Array<{ text: string; count: number }>
  /**
   * Trabajos por mes que piden para pagar: el ÚLTIMO valor cargado de cada
   * contacto dentro del rango, promediado entre contactos — el que habló cinco
   * veces no pesa cinco veces. `n` = contactos con valor.
   */
  jobs: { avg: number | null; median: number | null; n: number }
}

export type ComercialSummaryResult =
  | { available: false; missing: ProspectsMissing }
  | {
      available: true
      summary: ComercialSummary
      /** Seguimientos vencidos o de hoy, con los mismos filtros (sin la fecha). */
      due: Array<PartnerProspect>
      facets: ProspectFacets
    }

/**
 * Un contacto sin vincular cuyo teléfono coincide con un proveedor del
 * marketplace o con una solicitud que todavía no es proveedor. Vincular es
 * siempre un click de una persona: nunca automático (una cadena comparte
 * teléfono entre sucursales).
 */
export interface RegistrationCandidate {
  prospect: Pick<PartnerProspect, 'id' | 'name' | 'phone' | 'locality' | 'status' | 'ownerId'>
  partners: Array<{ id: string; name: string; status: string; createdOn: string }>
  applications: Array<{ id: string; businessName: string; status: string; createdOn: string }>
}

export type MonthlyRegistrationsResult =
  | { available: false; missing: ProspectsMissing }
  | {
      available: true
      /** El mes que se muestra (`YYYY-MM`), el pedido o el actual de Buenos Aires. */
      month: string
      /** Las altas del mes, ordenadas por "Conseguido por" y fecha. */
      rows: Array<PartnerProspect>
      candidates: Array<RegistrationCandidate>
      facets: ProspectFacets
    }

export const PROSPECT_LIST_LIMIT = 300

/** Un proveedor del marketplace, para vincular. */
export interface PartnerMatch {
  id: string
  name: string
  whatsapp: string | null
  coverageZone: string | null
  status: string
}

/** Lo que ya existe con alguno de estos teléfonos (alta manual y CSV). */
export interface PhoneMatches {
  prospects: Array<{ id: string; name: string; phoneDigits: string }>
  partners: Array<{ id: string; name: string; phoneDigits: string }>
}

export interface ImportResult {
  created: number
  skipped: Array<{ index: number; existingId: string }>
}

// ── Search params ──────────────────────────────────────────────────────────

/**
 * Calificados `prospect*`: `status`, `origin` u `owner` pelados chocarían con
 * otras rutas en el merge de `FullSearchSchema` (`notifications.md`). `q` se
 * comparte.
 */
export const prospectSearchSchema = z.object({
  q: z.string().trim().max(200).optional().catch(undefined),
  prospectStatus: z.enum(PROSPECT_STATUSES).optional().catch(undefined),
  prospectOrigin: z.string().trim().max(60).optional().catch(undefined),
  prospectRubro: z.string().trim().max(80).optional().catch(undefined),
  /** Un uuid, o `none` = sin comercial asignado. */
  prospectOwner: z.union([z.uuid(), z.literal('none')]).optional().catch(undefined),
  /** Un frente, o `none` = sin frente. */
  prospectFront: z.union([z.enum(PROSPECT_FRONTS), z.literal('none')]).optional().catch(undefined),
  /** Localidades crudas (por igualdad: es lo que se cargó). Vacío = todas. */
  prospectZones: multiSelectParam(z.string().trim().max(200)),
  prospectVerified: z.coerce.boolean().catch(false).default(false),
})
export type ProspectSearch = z.infer<typeof prospectSearchSchema>

/**
 * El Resumen: los filtros de Contactos más un rango de fechas (días en hora de
 * Buenos Aires, inclusive). Calificados `prospect*` como el resto. El rango
 * acota las charlas y las altas, no los conteos por estado.
 */
export const prospectSummarySearchSchema = prospectSearchSchema.extend({
  prospectFrom: z.iso.date().optional().catch(undefined),
  prospectTo: z.iso.date().optional().catch(undefined),
})
export type ProspectSummarySearch = z.infer<typeof prospectSummarySearchSchema>

/** Altas: el mes (`YYYY-MM`). Sin él, el servidor usa el actual de Buenos Aires. */
export const prospectMonthSearchSchema = z.object({
  prospectMonth: z
    .string()
    .regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/)
    .optional()
    .catch(undefined),
})

/** `2026-11` + 1 → `2026-12`. Aritmética pura, sin `Date` local. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const total = y * 12 + (m - 1) + delta
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

const MONTH_NAMES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
] as const

/** `2026-11` → `noviembre de 2026`. Sin `Intl`: tiene que dar lo mismo en el servidor y el cliente. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${MONTH_NAMES[m - 1] ?? month} de ${y}`
}

// ── Escrituras ─────────────────────────────────────────────────────────────

const text = (max: number) => z.string().max(max)
const optionalDate = z.union([z.iso.date(), z.literal('')])

/**
 * Las claves editables, en camelCase. Todas opcionales: la edición es un
 * PARCHE (autoguardado campo por campo, ver la cabecera de la 024). Una clave
 * ausente no se toca; `''`/`null` borra.
 */
const prospectFieldsSchema = z.object({
  name: text(200),
  phone: text(60),
  locality: text(200),
  shortNote: text(280),
  categorySlugs: z.array(z.string().max(80)).max(20),
  originSlug: z.string().min(1).max(60),
  status: z.enum(PROSPECT_STATUSES),
  ownerId: z.uuid().nullable(),
  talkedTo: text(200),
  plan: z.enum(PROSPECT_PLANS),
  lastContactOn: optionalDate,
  nextFollowUpOn: optionalDate,
  notes: text(5000),
  partnerId: z.uuid().nullable(),
  front: z.enum(PROSPECT_FRONTS).nullable(),
  frontQuoteRequestId: z.uuid().nullable(),
  knewAutolibre: z.boolean().nullable(),
  clientAcquisition: text(500),
  preferredChannel: z.enum(PREFERRED_CHANNELS).nullable(),
  hasCapacity: z.boolean().nullable(),
  managementSystem: text(200),
  network: text(200),
  verifyTestResponse: z.boolean(),
  verifyIdentity: z.boolean(),
  verifyPayment: z.boolean(),
  verifyReputation: z.boolean(),
  discardReason: text(500),
  nextStep: text(300),
  partnerRegisteredOn: optionalDate,
})
export type ProspectFields = z.infer<typeof prospectFieldsSchema>
export type ProspectPatch = Partial<ProspectFields>

/**
 * camelCase → la clave del SP. Explícito y no con una regex: una clave mal
 * mapeada sería un campo que "se guarda" y no se guarda (el SP además rechaza
 * claves desconocidas con `UNKNOWN_FIELD`).
 */
export const PROSPECT_PATCH_KEYS: Record<keyof ProspectFields, string> = {
  name: 'name',
  phone: 'phone',
  locality: 'locality',
  shortNote: 'short_note',
  categorySlugs: 'category_slugs',
  originSlug: 'origin_slug',
  status: 'status',
  ownerId: 'owner_id',
  talkedTo: 'talked_to',
  plan: 'plan',
  lastContactOn: 'last_contact_on',
  nextFollowUpOn: 'next_follow_up_on',
  notes: 'notes',
  partnerId: 'partner_id',
  front: 'front',
  frontQuoteRequestId: 'front_quote_request_id',
  knewAutolibre: 'knew_autolibre',
  clientAcquisition: 'client_acquisition',
  preferredChannel: 'preferred_channel',
  hasCapacity: 'has_capacity',
  managementSystem: 'management_system',
  network: 'network',
  verifyTestResponse: 'verify_test_response',
  verifyIdentity: 'verify_identity',
  verifyPayment: 'verify_payment',
  verifyReputation: 'verify_reputation',
  discardReason: 'discard_reason',
  nextStep: 'next_step',
  partnerRegisteredOn: 'partner_registered_on',
}

/** Las claves que sólo existen desde la 030: sin ella no se mandan. */
export const PROSPECT_030_KEYS: ReadonlyArray<keyof ProspectFields> = [
  'front',
  'frontQuoteRequestId',
  'knewAutolibre',
  'clientAcquisition',
  'preferredChannel',
  'hasCapacity',
  'managementSystem',
  'network',
  'verifyTestResponse',
  'verifyIdentity',
  'verifyPayment',
  'verifyReputation',
  'discardReason',
  'nextStep',
  'partnerRegisteredOn',
]

export function toSpPatch(patch: ProspectPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(PROSPECT_PATCH_KEYS) as Array<keyof ProspectFields>) {
    if (patch[key] !== undefined) out[PROSPECT_PATCH_KEYS[key]] = patch[key]
  }
  return out
}

export const createProspectSchema = prospectFieldsSchema
  .partial()
  .extend({ name: z.string().trim().min(1, 'Falta el nombre').max(200), originSlug: z.string().min(1).max(60) })
export type CreateProspectInput = z.infer<typeof createProspectSchema>

export const updateProspectSchema = z.object({
  id: z.uuid(),
  patch: prospectFieldsSchema.partial().refine((p) => Object.keys(p).length > 0, 'Parche vacío'),
})
export type UpdateProspectInput = z.infer<typeof updateProspectSchema>

export const PROSPECT_IMPORT_MAX = 2000

export const importProspectsSchema = z.object({
  rows: z.array(createProspectSchema).min(1).max(PROSPECT_IMPORT_MAX),
})
export type ImportProspectsInput = z.infer<typeof importProspectsSchema>

export const addOriginSchema = z.object({
  label: z.string().trim().min(1).max(60),
})

export const prospectIdSchema = z.object({ id: z.uuid() })

/**
 * Una charla. Obligatorios: canal, estado y próximo paso (la fecha la pone la
 * base si no viene). El resto, opcional. Mismas reglas que el SP de la 030
 * —que es el que vale—, para que el formulario diga qué falta al lado del
 * campo.
 */
export const addInteractionSchema = z
  .object({
    prospectId: z.uuid(),
    /** ISO con zona. Ausente = ahora. */
    occurredAt: z.string().max(40).optional(),
    channel: z.enum(INTERACTION_CHANNELS, 'Elegí el canal'),
    answered: z.boolean().nullable().optional(),
    talkedToDecider: z.boolean().nullable().optional(),
    toldHowOrders: z.boolean().optional(),
    toldProfile: z.boolean().optional(),
    toldZoneDemand: z.boolean().optional(),
    toldAsistir24: z.boolean().optional(),
    offeredModel: z.enum(OFFERED_MODELS).nullable().optional(),
    offeredAmount: text(120).optional(),
    reaction: z.enum(REACTIONS).nullable().optional(),
    questionsAnswers: text(5000).optional(),
    objection: z.enum(OBJECTIONS).nullable().optional(),
    objectionOther: text(300).optional(),
    jobsPerMonthToPay: z.number().int().min(0).max(10000).nullable().optional(),
    pitchNotes: text(5000).optional(),
    statusAfter: z.enum(PROSPECT_STATUSES, 'Elegí el estado'),
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
export type AddInteractionInput = z.infer<typeof addInteractionSchema>

/** camelCase → la clave del SP de la charla. Explícito, como `PROSPECT_PATCH_KEYS`. */
const INTERACTION_KEYS: Record<Exclude<keyof AddInteractionInput, 'prospectId'>, string> = {
  occurredAt: 'occurred_at',
  channel: 'channel',
  answered: 'answered',
  talkedToDecider: 'talked_to_decider',
  toldHowOrders: 'told_how_orders',
  toldProfile: 'told_profile',
  toldZoneDemand: 'told_zone_demand',
  toldAsistir24: 'told_asistir24',
  offeredModel: 'offered_model',
  offeredAmount: 'offered_amount',
  reaction: 'reaction',
  questionsAnswers: 'questions_answers',
  objection: 'objection',
  objectionOther: 'objection_other',
  jobsPerMonthToPay: 'jobs_per_month_to_pay',
  pitchNotes: 'pitch_notes',
  statusAfter: 'status_after',
  discardReason: 'discard_reason',
  nextStep: 'next_step',
  nextFollowUpOn: 'next_follow_up_on',
}

/** Lo que viaja al SP: sin claves vacías (un `''` en una fecha sería un error). */
export function toSpInteraction(input: AddInteractionInput): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(INTERACTION_KEYS) as Array<keyof typeof INTERACTION_KEYS>) {
    const v = input[key]
    if (v !== undefined && v !== '') out[INTERACTION_KEYS[key]] = v
  }
  return out
}

/** El pedido del frente "Por pedido", por su código `AL-n` (o el número solo). */
export const quoteCodeLookupSchema = z.object({
  code: z.string().trim().min(1).max(20),
})

/** `AL-1234`, `al 1234`, `1234` → 1234. Otra cosa → `null`. */
export function parseQuoteCode(raw: string): number | null {
  const m = /^(?:al)?[\s-]*([0-9]{1,9})$/i.exec(raw.trim())
  return m ? Number(m[1]) : null
}

export const phoneLookupSchema = z.object({
  phones: z.array(z.string().regex(/^549[0-9]{10}$/)).max(PROSPECT_IMPORT_MAX),
})

export const searchPartnersSchema = z.object({
  q: z.string().trim().min(2).max(100),
})

/** "Feria de Autopartes" → `feria-de-autopartes`. El SP valida el formato. */
export function originSlug(label: string): string {
  return normalizeForMatch(label)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// ── Errores ────────────────────────────────────────────────────────────────

export const PROSPECTS_UNAVAILABLE = 'PROSPECTS_UNAVAILABLE'
/** La 024 está y la 030 no: se lee lo de siempre, no se escribe nada nuevo. */
export const PROSPECTS_030_UNAVAILABLE = 'PROSPECTS_030_UNAVAILABLE'

/** El texto legible de un error de escritura. Las sentinelas son de la 024. */
export function readableProspectError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  if (msg.includes(PROSPECTS_UNAVAILABLE))
    return 'Falta aplicar la migración 024 en esta base (pnpm db:migrate).'
  if (msg.includes('DUPLICATE_PHONE')) return 'Ya hay otro contacto con ese teléfono.'
  if (msg.includes('NAME_REQUIRED')) return 'El nombre no puede quedar vacío.'
  if (msg.includes('INVALID_ORIGIN')) return 'Ese origen no existe. Recargá la página.'
  if (msg.includes('INVALID_CATEGORY_SLUG')) return 'Uno de los rubros ya no existe en el catálogo.'
  if (msg.includes('PARTNER_NOT_FOUND')) return 'Ese proveedor ya no existe en el marketplace.'
  if (msg.includes('OWNER_NOT_FOUND')) return 'Ese comercial ya no existe.'
  if (msg.includes('PROSPECT_NOT_FOUND')) return 'El contacto ya no existe. Recargá la página.'
  if (msg.includes('INVALID_DATE')) return 'Fecha inválida.'
  if (msg.includes(PROSPECTS_030_UNAVAILABLE))
    return 'Falta aplicar la migración 030 en esta base: las charlas y los campos nuevos no se guardan todavía.'
  if (msg.includes('DISCARD_REASON_REQUIRED')) return 'Para descartarlo hace falta el motivo.'
  if (msg.includes('NEXT_STEP_REQUIRED')) return 'Falta el próximo paso.'
  if (msg.includes('OBJECTION_OTHER_REQUIRED')) return 'Con la objeción "Otra", escribí cuál.'
  if (msg.includes('INTERACTION_IN_FUTURE')) return 'La fecha de la charla no puede ser futura.'
  if (msg.includes('INVALID_JOBS_PER_MONTH')) return 'Los trabajos por mes tienen que ser un número entero.'
  if (msg.includes('QUOTE_REQUEST_NOT_FOUND')) return 'No encontré ese pedido. Revisá el número (AL-…).'
  if (msg.includes('INVALID_CHANNEL')) return 'Elegí el canal de la charla.'
  if (msg.includes('INVALID_PROSPECT_STATUS'))
    return 'Ese estado no existe en esta base. Recargá la página (puede faltar la migración 030).'
  const row = /IMPORT_ROW_INVALID: (\d+)/.exec(msg)
  if (row) return `La fila ${Number(row[1]) + 1} del CSV no es válida; no se importó nada.`
  if (msg.includes('IMPORT_TOO_LARGE')) return `Hasta ${PROSPECT_IMPORT_MAX} filas por importación.`
  if (msg.includes('FORBIDDEN') || msg.includes('UNAUTHENTICATED'))
    return 'Tu sesión no tiene permisos de admin. Volvé a entrar.'
  return 'No se pudo guardar. Probá de nuevo.'
}

// ── CSV ────────────────────────────────────────────────────────────────────

/**
 * CSV mínimo: comillas dobles, `""` adentro de comillas, separador `,` o `;`
 * (el que más aparezca en la primera línea: Excel en castellano exporta con
 * `;`). Sin dependencias: el archivo lo arma Toby desde una planilla, no es
 * un formato hostil.
 */
export function parseCsv(input: string): Array<Array<string>> {
  const textIn = input.replace(/^﻿/, '')
  const firstLine = textIn.split(/\r?\n/, 1)[0] ?? ''
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','

  const rows: Array<Array<string>> = []
  let row: Array<string> = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < textIn.length; i++) {
    const ch = textIn[i]
    if (quoted) {
      if (ch === '"' && textIn[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && textIn[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** Las columnas que se reconocen, por nombre de encabezado. */
export const CSV_COLUMNS = ['name', 'phone', 'locality', 'rubro', 'shortNote'] as const
export type CsvColumn = (typeof CSV_COLUMNS)[number]

export const CSV_COLUMN_LABELS: Record<CsvColumn, string> = {
  name: 'Nombre',
  phone: 'Teléfono',
  locality: 'Localidad',
  rubro: 'Rubro',
  shortNote: 'Nota',
}

const HEADER_ALIASES: Record<CsvColumn, ReadonlyArray<string>> = {
  // Ya normalizados con `normalizeForMatch` (minúsculas, sin acentos, `-`).
  name: ['nombre', 'name', 'proveedor', 'razon-social', 'negocio', 'taller', 'comercio', 'titulo', 'title'],
  phone: ['telefono', 'tel', 'phone', 'whatsapp', 'celular', 'cel', 'movil', 'numero'],
  locality: ['localidad', 'ciudad', 'zona', 'barrio', 'partido', 'direccion', 'ubicacion', 'address'],
  rubro: ['rubro', 'rubros', 'categoria', 'category', 'tipo'],
  shortNote: ['nota', 'notas', 'observaciones', 'comentario', 'detalle'],
}

/** Índice de cada columna conocida en el encabezado, o `null` si no está. */
export function detectCsvColumns(header: ReadonlyArray<string>): Record<CsvColumn, number | null> {
  const norm = header.map((h) => normalizeForMatch(h))
  const out = {} as Record<CsvColumn, number | null>
  for (const col of CSV_COLUMNS) {
    const aliases = HEADER_ALIASES[col]
    const exact = norm.findIndex((h) => aliases.includes(h))
    const partial = exact >= 0 ? exact : norm.findIndex((h) => aliases.some((a) => h.startsWith(a)))
    out[col] = partial >= 0 ? partial : null
  }
  return out
}

/**
 * Un rubro del CSV contra los del marketplace, por nombre o slug normalizado.
 * Sin match devuelve `null` y la vista previa lo dice: no se inventa uno.
 */
export function matchCategory(
  raw: string,
  categories: ReadonlyArray<ProspectCategoryOption>,
): string | null {
  const needle = normalizeForMatch(raw)
  if (needle === '') return null
  const hit =
    categories.find((c) => normalizeForMatch(c.name) === needle || c.slug === needle) ??
    categories.find((c) => normalizeForMatch(c.name).startsWith(needle))
  return hit?.slug ?? null
}
