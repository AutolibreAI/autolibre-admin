import { z } from 'zod'
import { toCsv } from '~/lib/csv'
import {
  QUOTE_CHANNEL_FILTERS,
  QUOTE_OUTCOME_FILTERS,
  QUOTE_REQUEST_USER_OUTCOMES,
  quoteChannelLabel,
  quoteCloseReasonLabel,
  quoteOutcomeLabel,
  quotePublicCode,
  quoteStatusLabel,
  quoteUserOutcomeLabel,
  type QuoteRequestsAvailability,
} from '~/lib/quote-requests'
import { userOutcomeReporterLabel, type UserOutcomeReporter } from '~/lib/quote-user-flow'

/**
 * «Resolución de pedidos» — `/leads/pedidos/resolucion`. Una fila por pedido
 * (todos los canales, con cuenta y sin ella) con cómo terminó: qué dijo la
 * persona, qué registró el equipo, a qué taller fue, cuándo y quién lo informó.
 *
 * Reemplaza la planilla que se armaba a mano cruzando `quote_requests`, las
 * propuestas y la nota de cierre — y que se perdía cada vez que se cerraba.
 *
 * Los DOS resultados van en columnas separadas, a propósito (decisión del
 * 2026-11-25): `user_outcome` (lo que dijo la persona, en la app o por teléfono
 * al equipo) y `outcome` (lo que registró el equipo al cerrar con
 * `ops.close_quote_request`). Si más adelante se unifican, se decide aparte.
 */

// ── Search params ───────────────────────────────────────────────────────────
//
// Prefijo `res`, nunca `sort`/`dir`/`quoteChannel` pelados: `/leads/pedidos`
// ya usa esos nombres con OTROS enums, y TanStack mergea los search params —
// dos enums disjuntos bajo la misma clave rompen el typecheck de la ruta ajena
// (`.claude/rules/notifications.md`).

/** `undeclared` = `user_outcome IS NULL`: la persona todavía no dijo nada. */
export const QUOTE_RESOLUTION_USER_OUTCOME_FILTERS = ['all', ...QUOTE_REQUEST_USER_OUTCOMES, 'undeclared'] as const
export type QuoteResolutionUserOutcomeFilter = (typeof QUOTE_RESOLUTION_USER_OUTCOME_FILTERS)[number]

/**
 * Taller elegido: `all`, `none` (sin propuesta elegida), `external` (la
 * elegida es de un taller de afuera del directorio) o el uuid de un partner.
 */
export const QUOTE_RESOLUTION_PARTNER_SPECIAL = ['all', 'none', 'external'] as const

/** Cada clave mapea a una expresión cerrada en `SORT_COLUMNS` de `quote-resolution.repo.ts`. */
export const QUOTE_RESOLUTION_SORT_KEYS = [
  'createdAt',
  'channel',
  'contact',
  'proposals',
  'userOutcome',
  'outcome',
  'partner',
  'performedOn',
  'status',
] as const
export type QuoteResolutionSortKey = (typeof QUOTE_RESOLUTION_SORT_KEYS)[number]

const DAY = /^\d{4}-\d{2}-\d{2}$/

export const quoteResolutionSearchSchema = z.object({
  resChannel: z.enum(QUOTE_CHANNEL_FILTERS).catch('all').default('all'),
  resUserOutcome: z.enum(QUOTE_RESOLUTION_USER_OUTCOME_FILTERS).catch('all').default('all'),
  /** `unasked` = el equipo todavía no registró resultado. */
  resOutcome: z.enum(QUOTE_OUTCOME_FILTERS).catch('all').default('all'),
  resPartner: z.union([z.enum(QUOTE_RESOLUTION_PARTNER_SPECIAL), z.uuid()]).catch('all').default('all'),
  /** Día del pedido, en hora de Buenos Aires, inclusive. Un valor mal formado se descarta. */
  resFrom: z.string().regex(DAY).optional().catch(undefined),
  resTo: z.string().regex(DAY).optional().catch(undefined),
  /** Mismo corte que el chip de `/leads/pedidos` (`hasIncompleteUserFlow`). */
  resIncompleteFlow: z.coerce.boolean().catch(false).default(false),
  /** Igual que `/leads/pedidos`: duplicados y pruebas del equipo, fuera por default. */
  resShowDuplicates: z.coerce.boolean().catch(false).default(false),
  resSort: z.enum(QUOTE_RESOLUTION_SORT_KEYS).catch('createdAt').default('createdAt'),
  resDir: z.enum(['asc', 'desc']).catch('desc').default('desc'),
})
export type QuoteResolutionSearch = z.infer<typeof quoteResolutionSearchSchema>

// ── Lo que devuelve la lectura ──────────────────────────────────────────────

/**
 * De dónde sale «Rubro / servicio», con la misma precedencia que la ficha: lo
 * que cargó el operador gana sobre la IA. Entre lo del operador, los servicios
 * (más específicos, 0155 del backend) antes que los rubros de `ops` (016).
 */
export type QuoteResolutionServicesSource = 'operator_services' | 'operator_rubros' | 'ai'

export interface QuoteResolutionRow {
  id: string
  publicNumber: number
  createdAt: string
  channel: string
  enteredManually: boolean
  hasAccount: boolean
  /** El nombre/teléfono de la cuenta si tiene; si no (o si la cuenta no lo tiene), el del pedido. */
  contactName: string | null
  contactPhone: string | null
  services: Array<string>
  servicesSource: QuoteResolutionServicesSource | null
  /** `null` = la base no tiene las propuestas (0120–0122): no se sabe, que no es cero. */
  activeProposals: number | null
  userOutcome: string | null
  outcome: string | null
  /** La propuesta elegida: el partner del directorio o el taller de afuera. */
  selectedProviderName: string | null
  selectedPartnerId: string | null
  /** `YYYY-MM-DD`, sólo con «Fue» declarado por el equipo. */
  performedOn: string | null
  reporter: UserOutcomeReporter
  status: string
  closeReasonCode: string | null
  closedAt: string | null
  outcomeNote: string | null
}

export interface QuoteResolutionPartnerOption {
  id: string
  name: string
}

/** Tope del listado en pantalla (mismo criterio que `/leads/pedidos`: no pagina). */
export const QUOTE_RESOLUTION_LIST_LIMIT = 500
/** Tope del CSV: lo filtrado entero, con un techo que una función de Vercel aguanta. */
export const QUOTE_RESOLUTION_EXPORT_LIMIT = 5000

export type QuoteResolutionResult =
  | { availability: Extract<QuoteRequestsAvailability, { available: false }> }
  | {
      availability: Extract<QuoteRequestsAvailability, { available: true }>
      rows: Array<QuoteResolutionRow>
      /** Hay más filas que `QUOTE_RESOLUTION_LIST_LIMIT` con este filtro. */
      truncated: boolean
      partnerOptions: Array<QuoteResolutionPartnerOption>
      /** Sin 0120–0122 no hay propuestas: ni cantidad ni taller elegido. */
      proposalsAvailable: boolean
      /** Sin la 0169 del backend no hay fecha del trabajo ni quién informó. */
      userFlowAvailable: boolean
    }

export const QUOTE_RESOLUTION_SERVICES_SOURCE_LABELS: Record<QuoteResolutionServicesSource, string> = {
  operator_services: 'operador',
  operator_rubros: 'operador (rubro)',
  ai: 'IA',
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/**
 * Lo filtrado, con las MISMAS columnas y rótulos que la tabla (los valores
 * crudos de enum no viajan: un `not_hired` en una planilla se lee como un
 * error). Fechas: el pedido y el cierre en Buenos Aires (`AAAA-MM-DD HH:MM`),
 * el trabajo como día calendario.
 */
export function quoteResolutionCsv(rows: ReadonlyArray<QuoteResolutionRow>, publicUrlBase: string): string {
  const header = [
    'Pedido',
    'Fecha del pedido',
    'Canal',
    'Cuenta',
    'Contacto',
    'Teléfono',
    'Rubro / servicio',
    'Fuente del rubro',
    'Propuestas activas',
    'Resultado según el cliente',
    'Resultado según el equipo',
    'Taller elegido',
    'Fecha del trabajo',
    'Quién informó',
    'Estado',
    'Motivo de cierre',
    'Cerrado',
    'Nota',
    'Ficha',
  ]
  const body = rows.map((r) => [
    quotePublicCode(r.publicNumber),
    buenosAiresDateTime(r.createdAt),
    quoteChannelLabel(r.channel),
    r.hasAccount ? 'Sí' : 'No',
    r.contactName,
    r.contactPhone,
    r.services.join(', '),
    r.servicesSource ? QUOTE_RESOLUTION_SERVICES_SOURCE_LABELS[r.servicesSource] : null,
    r.activeProposals,
    r.userOutcome ? quoteUserOutcomeLabel(r.userOutcome) : 'No declaró',
    r.outcome ? quoteOutcomeLabel(r.outcome) : 'Sin registrar',
    r.selectedProviderName,
    r.performedOn,
    userOutcomeReporterLabel(r.reporter),
    quoteStatusLabel(r.status),
    r.closeReasonCode ? quoteCloseReasonLabel(r.closeReasonCode) : null,
    r.closedAt ? buenosAiresDateTime(r.closedAt) : null,
    r.outcomeNote,
    `${publicUrlBase}/leads/pedidos/${r.id}`,
  ])
  return toCsv(header, body)
}

/** `2026-11-25T15:04:00Z` → `2026-11-25 12:04` en Buenos Aires. */
export function buenosAiresDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}
