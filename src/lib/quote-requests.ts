import { z } from 'zod'

/**
 * Pedidos de presupuesto — `/leads/pedidos` y `/leads/pedidos/:id`.
 *
 * ── Vocabulario ─────────────────────────────────────────────────────────────
 *
 * El aggregate del backend es `QuoteRequest` (`quote_requests`, bounded
 * context `quotes/`). NO es un `Lead` (regla dura 7): un `Lead` es el usuario
 * yendo hacia UN taller que ya eligió; un `QuoteRequest` es la persona diciendo
 * "necesito esto, ¿cuánto sale?" y el operador saliendo a buscar talleres.
 * Vive bajo `/leads` como línea de captación del panel, igual que `Insurance`
 * y `Fine`. Si aparece un `QuoteLead` o un `advanceQuoteLead`, está mal.
 *
 * Tampoco hay presupuestos por taller: el MVP del backend sacó las tablas
 * `quotes` / `quote_messages`. Lo que el operador consiguió vive en dos lugares
 * pobres a propósito: `proposals_count` (cuántas propuestas le devolvió) y el
 * texto libre de `internal_notes`. → `.claude/rules/leads.md`
 *
 * ── Qué consulta reemplaza ──────────────────────────────────────────────────
 *
 * `scripts/sql/listar-pedidos-de-presupuesto-abiertos.sql` del backend —borrado
 * el 2026-09-15—, que el operador corría en DBeaver (`… where status <> 'closed'
 * order by created_at`), más los cerrados, que ese script no mostraba y por eso
 * nadie miraba.
 *
 * ── Build-now, deploy-later ────────────────────────────────────────────────
 *
 * Al 2026-09-14 la tabla existe en DEV y NO en producción (la rama del backend
 * no está mergeada). La pantalla se escribió contra la tabla real y se protege
 * con `quoteRequestsAvailability()`: sin ese guard, abrir la pestaña en
 * producción sería un 500 de `relation "quote_requests" does not exist`.
 */

// ── Espejo de los enums del backend ─────────────────────────────────────────
//
// Mismos valores y mismo orden que los `pgEnum` de la migración (relevado
// contra DEV el 2026-09-14). Repetidos acá sólo para labels y para validar los
// search params — un valor que el backend agregue y este espejo no tenga se
// muestra CRUDO vía los `*Label()`, nunca se esconde.

export const QUOTE_REQUEST_STATUSES = ['received', 'contacted', 'answered', 'closed'] as const
export type QuoteRequestStatus = (typeof QUOTE_REQUEST_STATUSES)[number]

/** `closed` es terminal; los otros tres son "abiertos" — el corte del script de DBeaver. */
export const OPEN_QUOTE_REQUEST_STATUSES = ['received', 'contacted', 'answered'] as const

export const QUOTE_REQUEST_STATUS_LABELS: Record<QuoteRequestStatus, string> = {
  received: 'Recibido',
  contacted: 'Contactado',
  answered: 'Respondido',
  closed: 'Cerrado',
}

export const QUOTE_REQUEST_CHANNELS = ['app', 'web', 'whatsapp'] as const
export type QuoteRequestChannel = (typeof QUOTE_REQUEST_CHANNELS)[number]

export const QUOTE_REQUEST_CHANNEL_LABELS: Record<QuoteRequestChannel, string> = {
  app: 'App',
  web: 'Web',
  whatsapp: 'WhatsApp',
}

/**
 * El resultado según el OPERADOR (le preguntó a la persona). `null` = todavía
 * no se le preguntó, que NO es `no_response` ("se le preguntó y no contestó").
 */
export const QUOTE_REQUEST_OUTCOMES = ['hired', 'not_hired', 'no_response'] as const
export type QuoteRequestOutcome = (typeof QUOTE_REQUEST_OUTCOMES)[number]

export const QUOTE_REQUEST_OUTCOME_LABELS: Record<QuoteRequestOutcome, string> = {
  hired: 'Contrató',
  not_hired: 'No contrató',
  no_response: 'No respondió',
}

/** El resultado DECLARADO por el usuario desde la app. Eje aparte del de arriba. */
export const QUOTE_REQUEST_USER_OUTCOMES = ['hired', 'not_hired'] as const
export type QuoteRequestUserOutcome = (typeof QUOTE_REQUEST_USER_OUTCOMES)[number]

export const QUOTE_REQUEST_USER_OUTCOME_LABELS: Record<QuoteRequestUserOutcome, string> = {
  hired: 'Contrató',
  not_hired: 'No contrató',
}

export const QUOTE_REQUEST_CLOSE_REASONS = [
  'cancelled_by_user',
  'no_workshops_found',
  'no_user_response',
  'resolved',
  'duplicate',
] as const
export type QuoteRequestCloseReason = (typeof QUOTE_REQUEST_CLOSE_REASONS)[number]

export const QUOTE_REQUEST_CLOSE_REASON_LABELS: Record<QuoteRequestCloseReason, string> = {
  cancelled_by_user: 'Cancelado por el usuario',
  no_workshops_found: 'Sin talleres',
  no_user_response: 'El usuario no respondió',
  resolved: 'Resuelto',
  duplicate: 'Duplicado',
}

export const QUOTE_REQUEST_CANCELLATION_REASONS = [
  'already_solved',
  'no_longer_needed',
  'created_by_mistake',
  'took_too_long',
  'other',
] as const
export type QuoteRequestCancellationReason = (typeof QUOTE_REQUEST_CANCELLATION_REASONS)[number]

export const QUOTE_REQUEST_CANCELLATION_REASON_LABELS: Record<QuoteRequestCancellationReason, string> = {
  already_solved: 'Ya lo resolvió',
  no_longer_needed: 'Ya no lo necesita',
  created_by_mistake: 'Lo creó por error',
  took_too_long: 'Tardamos demasiado',
  other: 'Otro',
}

/** Tolerante: un valor que el espejo no conoce sale tal cual, no en blanco. */
const labelOf = (labels: Record<string, string>, value: string): string => labels[value] ?? value

export const quoteStatusLabel = (v: string) => labelOf(QUOTE_REQUEST_STATUS_LABELS, v)
export const quoteChannelLabel = (v: string) => labelOf(QUOTE_REQUEST_CHANNEL_LABELS, v)
export const quoteOutcomeLabel = (v: string) => labelOf(QUOTE_REQUEST_OUTCOME_LABELS, v)
export const quoteUserOutcomeLabel = (v: string) => labelOf(QUOTE_REQUEST_USER_OUTCOME_LABELS, v)
export const quoteCloseReasonLabel = (v: string) => labelOf(QUOTE_REQUEST_CLOSE_REASON_LABELS, v)
export const quoteCancellationReasonLabel = (v: string) =>
  labelOf(QUOTE_REQUEST_CANCELLATION_REASON_LABELS, v)

/**
 * `AL-1001`. `public_number` es SÓLO para mostrar (se lo dicta la persona al
 * operador por teléfono): la identidad es el uuid, y los links van por `id`.
 * Mismo formato que `formatQuoteRequestPublicCode` del backend.
 */
export const quotePublicCode = (publicNumber: number) => `AL-${publicNumber}`

/** Móvil argentino en la forma canónica que guarda el backend: `549` + 10 dígitos. */
const WHATSAPP_PHONE = /^549\d{10}$/

/**
 * El link para escribirle a la persona por WhatsApp, o `null`.
 *
 * `QuoteRequest.create()` del backend guarda `contact_phone` normalizado para
 * WhatsApp (`5491125120472`), que es exactamente lo que pide `wa.me`: dígitos,
 * con código de país. Pero una fila rehidratada puede traer un valor viejo tal
 * cual (`15 2512-0472`), y ahí NO se adivina la característica: inferirla mal le
 * escribe a otra persona. Sacar separadores no infiere nada; completar prefijos
 * sí. Sin la forma canónica, no hay link.
 *
 * El texto precargado nombra el `AL-n`, que es lo que la persona ve y le dicta
 * al operador: ubica la conversación desde el primer mensaje. Se puede editar
 * en WhatsApp antes de mandarlo.
 */
export function quoteWhatsAppUrl(
  phone: string,
  publicNumber: number,
  contactName: string | null,
): string | null {
  const digits = phone.replace(/\D/g, '')
  if (!WHATSAPP_PHONE.test(digits)) return null

  const greeting = contactName ? `Hola ${contactName}` : 'Hola'
  const text = `${greeting}, te escribimos de AutoLibre por tu pedido de presupuesto ${quotePublicCode(publicNumber)}.`
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
}

// ── Señal derivada del reloj ────────────────────────────────────────────────

/**
 * Un pedido abierto sin `contacted_at` pasadas estas horas es "sin contactar".
 *
 * Es una deducción NUESTRA del reloj, no un estado del dominio — misma forma que
 * `stuck` en `/operacion` y `atrasada` en `/notificaciones`, y por eso se pinta
 * ámbar y no rojo. 24 h porque el pedido lo trabaja una persona llamando por
 * teléfono en horario hábil: menos que un día es "todavía no llegó", más es
 * "se quedó sin ver".
 */
export const QUOTE_UNCONTACTED_AFTER_HOURS = 24

// ── Disponibilidad ─────────────────────────────────────────────────────────

/**
 * La tabla puede no existir (producción al 2026-09-14) o existir sin la
 * migración 0093 del backend (`public_number`, `close_reason_code`,
 * `proposals_count`, `user_outcome`…). Las dos rompen el SELECT, así que se
 * distinguen para poder decir cuál de las dos pasa.
 */
export type QuoteRequestsAvailability =
  | { available: true }
  | { available: false; reason: 'no_table' }
  | { available: false; reason: 'missing_0093'; missingColumns: Array<string> }

// ── Search params ───────────────────────────────────────────────────────────
//
// Calificados por dominio (`quoteStatus`, `quoteChannel`, …), nunca `status` /
// `channel` / `state` / `kind` pelados: `status` lo usan `/solicitudes` y
// `/leads/talleres`, `channel` lo usa `/notificaciones`, `state` y `kind` otras
// dos. TanStack mergea los search params de todas las rutas y dos enums
// disjuntos bajo la misma clave rompen el typecheck de la ruta AJENA.
// → `.claude/rules/notifications.md`

/**
 * `open` es el default porque es exactamente el corte del script de DBeaver
 * que esta pantalla reemplaza (`status <> 'closed'`). `cancelled_by_user` va en
 * el mismo grupo porque es un subconjunto de `closed` que interesa mirar solo.
 */
export const QUOTE_STATUS_FILTERS = ['open', 'all', ...QUOTE_REQUEST_STATUSES, 'cancelled_by_user'] as const
export type QuoteStatusFilter = (typeof QUOTE_STATUS_FILTERS)[number]

export const QUOTE_CHANNEL_FILTERS = ['all', ...QUOTE_REQUEST_CHANNELS] as const
export type QuoteChannelFilter = (typeof QUOTE_CHANNEL_FILTERS)[number]

/** `unasked` = `outcome IS NULL`: al operador le falta preguntar. */
export const QUOTE_OUTCOME_FILTERS = ['all', ...QUOTE_REQUEST_OUTCOMES, 'unasked'] as const
export type QuoteOutcomeFilter = (typeof QUOTE_OUTCOME_FILTERS)[number]

/** Cada clave mapea a una expresión cerrada en `SORT_COLUMNS` de `quote-requests.repo.ts`. */
export const QUOTE_SORT_KEYS = [
  'createdAt',
  'code',
  'status',
  'channel',
  'contact',
  'account',
  'plate',
  'declaredAmount',
  'proposals',
  'toContact',
  'toAnswer',
  'notes',
] as const
export type QuoteSortKey = (typeof QUOTE_SORT_KEYS)[number]

export const quoteRequestSearchSchema = z.object({
  /** Código `AL-n`, patente, teléfono, email, nombre, descripción o email de la cuenta. */
  q: z.string().trim().max(120).optional(),
  quoteStatus: z.enum(QUOTE_STATUS_FILTERS).catch('open').default('open'),
  quoteChannel: z.enum(QUOTE_CHANNEL_FILTERS).catch('all').default('all'),
  quoteOutcome: z.enum(QUOTE_OUTCOME_FILTERS).catch('all').default('all'),
  /** Sólo abiertos, sin `contacted_at`, con más de `QUOTE_UNCONTACTED_AFTER_HOURS`. */
  quoteUncontacted: z.coerce.boolean().catch(false).default(false),
  /**
   * `createdAt asc` por default: el más viejo primero, igual que el `order by
   * created_at` del script — es una cola de trabajo, lo que más esperó va arriba.
   */
  sort: z.enum(QUOTE_SORT_KEYS).catch('createdAt').default('createdAt'),
  dir: z.enum(['asc', 'desc']).catch('asc').default('asc'),
})
export type QuoteRequestSearch = z.infer<typeof quoteRequestSearchSchema>

export const quoteRequestIdSchema = z.object({ quoteRequestId: z.uuid() })

// ── Escrituras: las transiciones del operador (SPs de `ops`, migración 011) ──
//
// Ningún schema lleva un actor: `p_actor_id` sale de la sesión en el handler
// (guardrail 4 de `ops-write-actions.md`). Un actor por payload sería una firma
// falsificable en `ops.action_log`.

/**
 * Nota de AUDITORÍA: va a `ops.action_log.note` (`p_note`). NO es la nota
 * interna del pedido — esa es `addQuoteRequestInternalNoteSchema` y alimenta el
 * hilo de la ficha. Confundirlas deja el hilo sin la llamada y el log con texto
 * que no es auditoría.
 */
const auditNote = z.string().trim().max(500).optional()

export const markQuoteRequestContactedSchema = z.object({
  quoteRequestId: z.uuid(),
  auditNote,
})
export type MarkQuoteRequestContactedInput = z.infer<typeof markQuoteRequestContactedSchema>

export const markQuoteRequestAnsweredSchema = z.object({
  quoteRequestId: z.uuid(),
  /** Cero es válido: "llamamos y no conseguimos nada". El techo es holgura, no regla. */
  proposalsCount: z.number().int().min(0).max(1000),
  auditNote,
})
export type MarkQuoteRequestAnsweredInput = z.infer<typeof markQuoteRequestAnsweredSchema>

/**
 * Los códigos que el OPERADOR puede elegir: todos menos `cancelled_by_user`, que
 * lo pone sólo la app junto con el motivo de la persona (el SP lo rechaza con
 * `CLOSE_REASON_RESERVED_FOR_APP`). Derivado del espejo, no una segunda lista:
 * un código nuevo del backend aparece acá solo.
 */
export const operatorCloseReasonSchema = z.enum(QUOTE_REQUEST_CLOSE_REASONS).exclude(['cancelled_by_user'])
export const OPERATOR_CLOSE_REASONS = operatorCloseReasonSchema.options
export type OperatorCloseReason = z.infer<typeof operatorCloseReasonSchema>

export const closeQuoteRequestSchema = z.object({
  quoteRequestId: z.uuid(),
  closeReasonCode: operatorCloseReasonSchema,
  /** Nota interna del cierre (`closed_reason`). La persona nunca la ve. */
  closedReason: z.string().trim().max(1000).optional(),
  /** Ausente = "no se sabe / no se preguntó", que NO es `no_response`. */
  outcome: z.enum(QUOTE_REQUEST_OUTCOMES).optional(),
  outcomeNote: z.string().trim().max(1000).optional(),
  auditNote,
})
export type CloseQuoteRequestInput = z.infer<typeof closeQuoteRequestSchema>

export const addQuoteRequestInternalNoteSchema = z.object({
  quoteRequestId: z.uuid(),
  /**
   * UNA línea. `internal_notes` es un log de una nota por renglón
   * (`YYYY-MM-DD HH24:MI — texto`), y el SP agrega el texto tal cual: un salto
   * adentro de la nota partiría la entrada en dos y la segunda mitad se leería
   * como una línea "sin fecha — escrita a mano" en `parseInternalNotes`. Se
   * colapsa acá, antes de viajar.
   */
  text: z
    .string()
    .overwrite((s) => s.replace(/\s+/g, ' ').trim())
    .min(1, 'La nota no puede estar vacía.')
    .max(2000),
})
export type AddQuoteRequestInternalNoteInput = z.infer<typeof addQuoteRequestInternalNoteSchema>

/** Lo que devuelven las cuatro escrituras. El estado nuevo lo relee la ficha. */
export interface QuoteRequestWriteResult {
  id: string
  status: string
}

/** Sentinela del handler cuando `quote_requests` no existe o le faltan columnas. */
export const QUOTE_REQUESTS_UNAVAILABLE = 'QUOTE_REQUESTS_UNAVAILABLE'

/**
 * Traduce las sentinelas de los SP de la 011 (y la del guard) a algo legible.
 * Client-safe a propósito: corre en el navegador, sobre el `message` del error.
 *
 * El fallback NO muestra el texto crudo de Postgres. Cada SP es una sola
 * sentencia, así que si falló no se aplicó nada — eso sí se puede decir.
 */
export function readableQuoteRequestError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)

  if (raw.includes(QUOTE_REQUESTS_UNAVAILABLE))
    return 'Los pedidos de presupuesto no están desplegados en esta base (falta la tabla o columnas de la migración 0093 del backend). No se aplicó nada.'
  if (raw.includes('QUOTE_REQUEST_NOT_FOUND')) return 'Este pedido ya no existe. Recargá la pantalla.'
  if (raw.includes('INVALID_QUOTE_REQUEST_TRANSITION')) {
    // El SP dice el estado REAL del pedido bloqueado: "… un pedido en closed".
    const state = /un pedido en (\w+)/.exec(raw)?.[1]
    return `El pedido cambió de estado mientras lo mirabas${state ? ` (hoy está «${quoteStatusLabel(state)}»)` : ''} — por ejemplo, la persona lo canceló desde la app. No se aplicó nada: recargá la pantalla.`
  }
  if (raw.includes('PROPOSALS_COUNT_REQUIRED'))
    return 'Falta la cantidad de propuestas que se le pasaron. Cero es válido.'
  if (raw.includes('INVALID_PROPOSALS_COUNT')) return 'La cantidad de propuestas no puede ser negativa.'
  if (raw.includes('CLOSE_REASON_CODE_REQUIRED')) return 'Elegí un motivo de cierre.'
  if (raw.includes('INVALID_CLOSE_REASON_CODE'))
    return 'Ese motivo de cierre no existe en la base. Recargá la pantalla.'
  if (raw.includes('CLOSE_REASON_RESERVED_FOR_APP'))
    return '«Cancelado por el usuario» lo pone sólo la app, junto con el motivo de la persona. Elegí otro motivo.'
  if (raw.includes('INVALID_OUTCOME')) return 'Ese resultado no existe en la base. Recargá la pantalla.'
  if (raw.includes('INTERNAL_NOTE_REQUIRED')) return 'La nota no puede estar vacía.'
  if (raw.includes('ACTOR_NOT_FOUND') || raw.includes('ACTOR_REQUIRED'))
    return 'Tu sesión no corresponde a un usuario de AutoLibre. Volvé a iniciar sesión.'
  if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'
  if (raw === 'UNAUTHENTICATED') return 'Tu sesión expiró. Volvé a iniciar sesión.'
  return 'No pudimos guardar. No se aplicó nada — cada acción es una sola operación en la base.'
}

// ── Tipos de salida ─────────────────────────────────────────────────────────

export interface QuoteRequestListItem {
  id: string
  publicNumber: number
  createdAt: string
  /** Horas enteras desde `createdAt`, contra el reloj de Postgres. */
  ageHours: number
  status: string
  channel: string
  contactName: string | null
  contactPhone: string
  contactEmail: string | null
  /** `null` para web/whatsapp, y también para un POST público con `channel = app`. */
  userId: string | null
  userEmail: string | null
  userName: string | null
  /** La patente TAL CUAL la tipeó la persona. */
  plate: string
  /** El vehículo que vinculó el operador. Puede estar archivado o ser de otro usuario. */
  vehicleId: string | null
  vehiclePlate: string | null
  vehicleArchived: boolean | null
  /** `MARCA MODELO VERSIÓN AÑO` del catálogo; `null` sin vehículo o sin catálogo. */
  catalogLabel: string | null
  /** Vehículo vinculado cuyo dueño NO es la cuenta del pedido (sólo con los dos presentes). */
  vehicleOwnerMismatch: boolean
  /** La patente tipeada no coincide con la del vehículo vinculado (normalizadas). */
  plateMismatch: boolean
  description: string
  /** Lo que la persona dice que le cotizaron en otro lado. Sin columna de moneda: se asume ARS. */
  declaredAmount: number | null
  proposalsCount: number | null
  contactedAt: string | null
  answeredAt: string | null
  closedAt: string | null
  /** Minutos de `created_at` a `contacted_at`. `null` si no se contactó. */
  minutesToContact: number | null
  /** Minutos de `created_at` a `answered_at`. `null` si no se respondió. */
  minutesToAnswer: number | null
  closeReasonCode: string | null
  cancellationReason: string | null
  outcome: string | null
  userOutcome: string | null
  /** Líneas no vacías de `internal_notes`. */
  noteCount: number
  /** Abierto + sin `contacted_at` + más viejo que `QUOTE_UNCONTACTED_AFTER_HOURS`. Derivado. */
  uncontacted: boolean
}

/**
 * Panorama SIN los filtros del listado — mismo criterio que las tarjetas de
 * `/leads/seguros`: los cuatro estados siempre, incluso en cero.
 */
export interface QuoteRequestStatusSummary {
  total: number
  byStatus: Record<QuoteRequestStatus, number>
  /** Subconjunto de `closed` con `close_reason_code = 'cancelled_by_user'`. */
  cancelledByUser: number
  uncontacted: number
}

export interface QuoteRequestDetail extends QuoteRequestListItem {
  updatedAt: string
  vehicleOwnerId: string | null
  vehicleOwnerEmail: string | null
  userOutcomeAt: string | null
  cancellationComment: string | null
  outcomeNote: string | null
  /** Nota interna del operador al cerrar. No la ve la persona. */
  closedReason: string | null
  internalNotes: string | null
  /** `raw_submission` ya serializado con indentación — viaja como string, no como `unknown`. */
  rawSubmissionJson: string
  /**
   * `location_address`, texto ya armado por el backend (device vs typed —
   * ver `.claude/rules/leads.md`). `null` cuando el pedido no trae ubicación
   * (WhatsApp, o un `typed` sin dirección). Es lo que rellena `{{zona}}` en
   * `~/lib/quote-templates`.
   */
  locationAddress: string | null
}

export type QuoteRequestsListResult =
  | { availability: Exclude<QuoteRequestsAvailability, { available: true }> }
  | {
      availability: { available: true }
      rows: Array<QuoteRequestListItem>
      summary: QuoteRequestStatusSummary
    }

export type QuoteRequestDetailResult =
  | { availability: Exclude<QuoteRequestsAvailability, { available: true }> }
  | { availability: { available: true }; detail: QuoteRequestDetail }

// ── Notas internas ──────────────────────────────────────────────────────────

export interface QuoteInternalNote {
  /** `YYYY-MM-DD HH:MI` tal cual, en hora de Buenos Aires. `null` si la línea no trae prefijo. */
  stamp: string | null
  text: string
}

/**
 * `internal_notes` es un log append-only: el script
 * `agregar-nota-interna-a-pedido-de-presupuesto.sql` agrega una línea
 * `YYYY-MM-DD HH24:MI — <nota>` con la hora en `America/Argentina/Buenos_Aires`.
 *
 * El sello NO se convierte a otra zona: no trae offset, y reinterpretarlo como
 * UTC (la zona de `~/lib/format`) lo correría tres horas. Se muestra crudo y la
 * UI dice que es hora de Buenos Aires. Una línea escrita a mano sin prefijo se
 * muestra entera, sin sello — no se descarta.
 */
export function parseInternalNotes(raw: string | null): Array<QuoteInternalNote> {
  if (!raw) return []
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line): QuoteInternalNote => {
      const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+[—–-]\s+(.*)$/.exec(line)
      const stamp = m?.[1]
      const text = m?.[2]
      return stamp !== undefined && text !== undefined ? { stamp, text } : { stamp: null, text: line }
    })
}

// ── Formato de duraciones ───────────────────────────────────────────────────

/** `45 min` · `3 h 20 min` · `2 d 4 h`. Minutos enteros, `null` → `—`. */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return '—'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
  }
  const days = Math.floor(hours / 24)
  const restH = hours % 24
  return restH === 0 ? `${days} d` : `${days} d ${restH} h`
}
