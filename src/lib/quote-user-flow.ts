import { z } from 'zod'

/**
 * Completar el flujo de la persona EN SU NOMBRE — el equipo la llama y carga
 * desde el panel los dos pasos que quedaron sin hacer en la app:
 *
 *  1. Elegir la propuesta → `PUT /admin/quote-requests/:id/selected-proposal`
 *  2. Declarar si fue al taller (`user_outcome`) →
 *     `POST /admin/quote-requests/:id/user-outcome`
 *
 * El tercer paso de la app (reseñar al taller) NUNCA se carga en nombre de la
 * persona: una reseña es una opinión, y una opinión que escribe el equipo no
 * es de nadie. No hay ni habrá acción para eso acá.
 *
 * Con cuenta o SIN cuenta (`user_id` NULL: web pública y WhatsApp), con las
 * mismas reglas — desde el 2026-11-25 el backend procesa los dos y el operador
 * no tiene que notar diferencia. Sin cuenta la única procedencia posible es el
 * equipo (`provenanceSource`): no hay app desde la que la persona lo declare.
 * Un taller que no estaba entre las propuestas no se modela: va en una nota
 * interna.
 *
 * Client-safe y SIN imports de `~/` a propósito: lo prueba `node --test`
 * directo (`tests/quote-user-flow.test.ts`), que no resuelve alias.
 */

// ── Las reglas de cuándo se ofrece cada acción ──────────────────────────────

/** Lo mínimo del pedido que deciden las dos reglas. */
export interface QuoteUserFlowFacts {
  userId: string | null
  status: string
  answeredAt: string | null
  closeReasonCode: string | null
}

/**
 * «Marcar como elegida por el usuario»: con el pedido sin cerrar, tenga o no
 * cuenta. Lo demás (propuesta activa y del pedido) lo decide el backend atómico
 * con la escritura; acá sólo se evita ofrecer lo que seguro rebota.
 */
export function canSelectProposalOnBehalf(f: QuoteUserFlowFacts): boolean {
  return f.status !== 'closed'
}

/**
 * «Declarar si fue»: tenga o no cuenta, con `answered_at` (hubo algo que responderle)
 * y sin cancelación de la persona. A diferencia de elegir, SÍ se permite con el
 * pedido cerrado por el operador: es el caso típico de un pedido viejo que se
 * cerró sin que la persona contara cómo le fue.
 */
export function canDeclareOutcomeOnBehalf(f: QuoteUserFlowFacts): boolean {
  return f.answeredAt !== null && f.closeReasonCode !== 'cancelled_by_user'
}

/**
 * Flujo incompleto: respondido y sin `user_outcome`, con cuenta o sin ella. Es a quién hay
 * que llamar. Se excluyen los cancelados por la persona: ahí no hay nada que
 * declarar (el backend lo rechaza con 400 `INVALID_STATE_TRANSITION`).
 */
export function hasIncompleteUserFlow(f: QuoteUserFlowFacts & { userOutcome: string | null }): boolean {
  return canDeclareOutcomeOnBehalf(f) && f.userOutcome === null
}

// ── Los payloads de los server functions ────────────────────────────────────

export const selectQuoteProposalOnBehalfSchema = z
  .object({
    quoteRequestId: z.uuid(),
    proposalId: z.uuid(),
  })
  .strict()
export type SelectQuoteProposalOnBehalfInput = z.infer<typeof selectQuoteProposalOnBehalfSchema>

/** Lo que el backend acepta en `outcome`, mismo enum que `quote_requests.user_outcome`. */
export const QUOTE_USER_OUTCOME_DECLARATIONS = ['hired', 'not_hired', 'pending'] as const
export type QuoteUserOutcomeDeclaration = (typeof QUOTE_USER_OUTCOME_DECLARATIONS)[number]

/**
 * Cómo se lo pregunta el operador a la persona por teléfono. NO son los
 * rótulos de `user_outcome` en el resto de la ficha («Contrató», «Sin elegir»):
 * esos describen el dato; éstos son la pregunta «¿fue al taller?».
 */
export const QUOTE_USER_OUTCOME_DECLARATION_LABELS: Record<QuoteUserOutcomeDeclaration, string> = {
  hired: 'Fue',
  not_hired: 'No fue',
  pending: 'Todavía no',
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Por qué NO fue al taller (backend, `quote_request_not_hired_reason`). El
 * orden es el del contrato y el del select. Mismo patrón que
 * `QUOTE_REQUEST_CANCELLATION_REASONS` (`~/lib/quote-requests`), pero vive acá
 * porque este archivo no puede importar de `~/` (lo prueba `node --test`).
 */
export const QUOTE_NOT_HIRED_REASONS = [
  'no_budget',
  'no_time',
  'did_it_themselves',
  'hired_outside_network',
  'no_longer_needed',
  'took_too_long',
  'other',
] as const
export type QuoteNotHiredReason = (typeof QUOTE_NOT_HIRED_REASONS)[number]

export const QUOTE_NOT_HIRED_REASON_LABELS: Record<QuoteNotHiredReason, string> = {
  no_budget: 'Falta de plata',
  no_time: 'Falta de tiempo',
  did_it_themselves: 'Lo hizo él',
  hired_outside_network: 'Lo hizo fuera de la red',
  no_longer_needed: 'Ya no lo necesita',
  took_too_long: 'Tardamos demasiado',
  other: 'Otro',
}

/** Un valor que el panel todavía no conoce se muestra crudo: nunca se pierde. */
export function quoteNotHiredReasonLabel(reason: string): string {
  return (QUOTE_NOT_HIRED_REASON_LABELS as Record<string, string>)[reason] ?? reason
}

/** Tope de la observación, en caracteres, ya recortada (el backend da 400 si lo pasa). */
export const QUOTE_NOT_HIRED_NOTE_MAX = 1000

/**
 * `performedOn` obligatorio con `hired` y PROHIBIDO en los otros dos — el
 * backend contesta 400 si viene de más, así que acá no viaja ni vacío. Los
 * límites (no futuro, no antes del pedido) los vuelve a chequear el backend; el
 * date picker los impone con `min`/`max` (`performedOnBounds`).
 *
 * `notHiredReason` / `notHiredNote`: sólo con `not_hired`, y los DOS opcionales
 * (incluso con «Otro» la observación no es obligatoria — decisión del usuario).
 * Con otro resultado, un valor no nulo es 400 del backend: acá se rechaza antes.
 * `null` explícito = «sin motivo» / «sin observación» (pisa lo que hubiera);
 * la clave ausente = el panel no los manda (la base no tiene la migración).
 */
export const declareQuoteUserOutcomeOnBehalfSchema = z
  .object({
    quoteRequestId: z.uuid(),
    outcome: z.enum(QUOTE_USER_OUTCOME_DECLARATIONS),
    performedOn: z.string().regex(DAY, 'La fecha va como AAAA-MM-DD.').optional(),
    notHiredReason: z.enum(QUOTE_NOT_HIRED_REASONS).nullable().optional(),
    notHiredNote: z
      .string()
      .refine((v) => v.trim().length <= QUOTE_NOT_HIRED_NOTE_MAX, {
        message: `La observación va hasta ${QUOTE_NOT_HIRED_NOTE_MAX} caracteres.`,
      })
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.outcome === 'hired' && v.performedOn === undefined)
      ctx.addIssue({ code: 'custom', path: ['performedOn'], message: 'Falta la fecha en que se hizo el trabajo.' })
    if (v.outcome !== 'hired' && v.performedOn !== undefined)
      ctx.addIssue({ code: 'custom', path: ['performedOn'], message: 'La fecha va sólo si fue al taller.' })
    if (v.outcome !== 'not_hired' && v.notHiredReason != null)
      ctx.addIssue({ code: 'custom', path: ['notHiredReason'], message: 'El motivo va sólo si no fue.' })
    if (v.outcome !== 'not_hired' && v.notHiredNote != null)
      ctx.addIssue({ code: 'custom', path: ['notHiredNote'], message: 'La observación va sólo si no fue.' })
  })
export type DeclareQuoteUserOutcomeOnBehalfInput = z.infer<typeof declareQuoteUserOutcomeOnBehalfSchema>

export type DeclareOutcomeBody = {
  outcome: QuoteUserOutcomeDeclaration
  performedOn?: string
  notHiredReason?: QuoteNotHiredReason | null
  notHiredNote?: string | null
}

/**
 * El cuerpo HTTP, sin el id (va en la URL). `performedOn` sólo con «Fue»;
 * motivo y observación sólo con «No fue» y sólo si el input trae la clave. La
 * observación viaja recortada, y vacía → `null` (el backend hace lo mismo).
 */
export function declareOutcomeBody(input: DeclareQuoteUserOutcomeOnBehalfInput): DeclareOutcomeBody {
  if (input.outcome === 'hired' && input.performedOn) return { outcome: input.outcome, performedOn: input.performedOn }
  const body: DeclareOutcomeBody = { outcome: input.outcome }
  if (input.outcome !== 'not_hired') return body
  if (input.notHiredReason !== undefined) body.notHiredReason = input.notHiredReason
  if (input.notHiredNote !== undefined) body.notHiredNote = input.notHiredNote?.trim() || null
  return body
}

// ── Las fechas del date picker ──────────────────────────────────────────────

const TZ = 'America/Argentina/Buenos_Aires'

/** El día calendario de un instante, en Buenos Aires (`YYYY-MM-DD`). */
export function buenosAiresDay(instant: Date): string {
  // `en-CA` formatea como `YYYY-MM-DD`.
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    instant,
  )
}

/**
 * `min` = el día en que entró el pedido, `max` = hoy; los dos en hora de
 * Buenos Aires, que es lo que el operador tiene en el calendario. Un trabajo no
 * puede ser anterior al pedido ni futuro.
 */
export function performedOnBounds(createdAtIso: string, now: Date = new Date()): { min: string; max: string } {
  return { min: buenosAiresDay(new Date(createdAtIso)), max: buenosAiresDay(now) }
}

// ── Procedencia ─────────────────────────────────────────────────────────────

export type QuoteUserFlowSource = 'user' | 'operator'

export interface QuoteUserFlowActor {
  id: string
  name: string | null
  email: string | null
}

export interface QuoteUserFlowStepProvenance {
  /**
   * `null` = no hay dato en ese paso todavía. Una fila con dato y SIN fuente es
   * anterior a la migración del backend: entonces la única forma de cargarlo
   * era la app, y se lee como `user` (`provenanceSource`).
   */
  source: QuoteUserFlowSource | null
  /** El admin que lo cargó, sólo si fue el equipo. */
  by: QuoteUserFlowActor | null
}

/**
 * Quién cargó cada paso. `available: false` = la base todavía no tiene las
 * columnas del backend: la ficha funciona igual, sólo que sin decir quién.
 */
export type QuoteUserFlowProvenance =
  | { available: false }
  | {
      available: true
      selection: QuoteUserFlowStepProvenance
      outcome: QuoteUserFlowStepProvenance & {
        /** Fecha real del trabajo (`YYYY-MM-DD`), sólo con `hired`. */
        performedOn: string | null
      }
      /** Motivo y observación de «No fue» (sólo con `user_outcome = 'not_hired'`). */
      notHired: QuoteNotHiredDetail
    }

/**
 * `available: false` = la base no tiene las columnas del motivo (migración del
 * backend aparte de la procedencia): no se muestra ni se ofrece cargarlo.
 * `reason` es texto crudo: un valor nuevo del enum se muestra tal cual.
 */
export type QuoteNotHiredDetail =
  | { available: false }
  | { available: true; reason: string | null; note: string | null }

/**
 * La fuente de un paso que TIENE dato. Con cuenta, `null` en la columna =
 * anterior a la migración = la app (era el único camino). SIN cuenta no hay app:
 * la fuente es siempre el equipo, diga lo que diga la columna — «Declarado por
 * la persona en la app» no puede aparecer en un pedido sin cuenta.
 */
export function provenanceSource(source: QuoteUserFlowSource | null, hasAccount: boolean): QuoteUserFlowSource {
  if (!hasAccount) return 'operator'
  return source ?? 'user'
}

/** Cómo se dice el admin: nombre y email si están, lo que haya si no. */
export function actorLabel(by: QuoteUserFlowActor | null): string {
  if (!by) return 'un admin que ya no está'
  if (by.name && by.email) return `${by.name} (${by.email})`
  return by.name ?? by.email ?? by.id
}

/**
 * Quién informó el resultado de la persona (`user_outcome`), para un listado
 * («Resolución de pedidos»). Misma regla que la ficha (`provenanceSource`):
 *
 * - sin resultado → `none`;
 * - SIN cuenta → siempre el equipo: no hay app desde la que la persona lo
 *   declare, aunque la base no tenga todavía las columnas de procedencia;
 * - con cuenta y sin las columnas → `unknown` (falta la migración del backend);
 * - con cuenta → la columna, y `null` = anterior a la migración = la app.
 */
export type UserOutcomeReporter =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'user' }
  | { kind: 'operator'; by: QuoteUserFlowActor | null }

export function userOutcomeReporter(f: {
  hasValue: boolean
  hasAccount: boolean
  provenanceAvailable: boolean
  source: QuoteUserFlowSource | null
  by: QuoteUserFlowActor | null
}): UserOutcomeReporter {
  if (!f.hasValue) return { kind: 'none' }
  if (!f.hasAccount) return { kind: 'operator', by: f.provenanceAvailable ? f.by : null }
  if (!f.provenanceAvailable) return { kind: 'unknown' }
  return provenanceSource(f.source, true) === 'operator' ? { kind: 'operator', by: f.by } : { kind: 'user' }
}

/** El texto de la columna «Quién informó» (y del CSV). */
export function userOutcomeReporterLabel(r: UserOutcomeReporter): string {
  switch (r.kind) {
    case 'none':
      return '—'
    case 'unknown':
      return 'No se sabe (falta la migración del backend)'
    case 'user':
      return 'La persona (app)'
    case 'operator':
      return r.by ? `Equipo: ${actorLabel(r.by)}` : 'Equipo'
  }
}

// ── Errores ─────────────────────────────────────────────────────────────────

/** Sentinela de `backendError(..., { quoteUserFlow: true })`. */
export const QUOTE_USER_FLOW_ERROR = 'QUOTE_USER_FLOW_ERROR'

export interface QuoteUserFlowErrorInfo {
  /** 0 = timeout (salió y no volvió: puede haberse guardado). */
  status: number
  code: string
  message: string
  /** 404 «Cannot PUT|POST …»: el backend desplegado no tiene el endpoint. */
  cannotRoute: boolean
}

export function quoteUserFlowErrorMessage(info: QuoteUserFlowErrorInfo): string {
  return `${QUOTE_USER_FLOW_ERROR}:${JSON.stringify(info)}`
}

/** Lee `QUOTE_USER_FLOW_ERROR:<json>`. `null` si no es ese formato. */
export function parseQuoteUserFlowError(cause: unknown): QuoteUserFlowErrorInfo | null {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const at = raw.indexOf(`${QUOTE_USER_FLOW_ERROR}:`)
  if (at === -1) return null
  try {
    const v = JSON.parse(raw.slice(at + QUOTE_USER_FLOW_ERROR.length + 1)) as Record<string, unknown>
    return {
      status: typeof v.status === 'number' ? v.status : 0,
      code: typeof v.code === 'string' ? v.code : '',
      message: typeof v.message === 'string' ? v.message : '',
      cannotRoute: v.cannotRoute === true,
    }
  } catch {
    return null
  }
}

/**
 * Qué hace la UI con el error:
 * - `retry`: reintentar manda EXACTAMENTE lo mismo (timeout, 5xx). Las dos
 *   escrituras dejan un valor fijo, así que repetirlas no duplica nada.
 * - `reload`: el pedido cambió (400 `INVALID_STATE_TRANSITION`: cerrado o ya
 *   no admite la declaración; 404: propuesta retirada o pedido inexistente;
 *   409 `CONFLICT`: carrera con otra escritura); se relee la ficha.
 * - `fix`: hay que corregir algo o no hay nada que reintentar.
 */
export type QuoteUserFlowErrorAction = 'retry' | 'reload' | 'fix'

export interface ReadableQuoteUserFlowError {
  text: string
  action: QuoteUserFlowErrorAction
}

/** Lo común a las dos acciones. `null` = no es un error de este flujo (la UI cae al genérico de pedidos). */
function commonError(raw: string, e: QuoteUserFlowErrorInfo | null, endpoint: string): ReadableQuoteUserFlowError | null {
  const unreachable = /BACKEND_UNREACHABLE:(\S+)/.exec(raw)
  if (unreachable)
    return {
      text: `No se pudo llegar al backend (${unreachable[1]}). Revisá AUTOLIBRE_BACKEND_URL. No se guardó nada.`,
      action: 'fix',
    }
  if (!e) return null
  if (e.status === 0)
    return {
      text: 'El backend no contestó a tiempo. Puede que haya quedado guardado: reintentá, se manda exactamente lo mismo y no duplica nada.',
      action: 'retry',
    }
  if (e.status === 401)
    return { text: 'Tu sesión venció para el backend. Cerrá sesión y volvé a entrar. No se guardó nada.', action: 'fix' }
  if (e.status === 403) return { text: 'Tu usuario no es admin para el backend. No se guardó nada.', action: 'fix' }
  if (e.status === 404 && e.cannotRoute)
    return {
      text: `El backend desplegado todavía no tiene esta acción (${endpoint}). Hay que desplegarlo. No se guardó nada.`,
      action: 'fix',
    }
  // 404 `NOT_FOUND`: el pedido no existe (desde 2026-11-25 un pedido sin cuenta ya no da 404).
  if (e.status === 404 && e.code === 'NOT_FOUND')
    return {
      text: 'El backend no encuentra este pedido (no existe o se borró). No se guardó nada: se recargó la ficha.',
      action: 'reload',
    }
  // 409 `CONFLICT`: sólo la carrera de dos escrituras simultáneas sobre el pedido.
  if (e.status === 409)
    return {
      text: 'Otro cambio se aplicó al pedido al mismo tiempo. No se guardó nada: se recargó la ficha, revisala y volvé a intentar.',
      action: 'reload',
    }
  if (e.status >= 500)
    return {
      text: 'El backend falló. Puede que haya quedado guardado: reintentá, se manda exactamente lo mismo y no duplica nada.',
      action: 'retry',
    }
  return null
}

function fallback(e: QuoteUserFlowErrorInfo): ReadableQuoteUserFlowError {
  return { text: `El backend contestó ${e.status}${e.message ? `: «${e.message}»` : ''}. No se guardó nada.`, action: 'fix' }
}

/** «Marcar como elegida por el usuario». `null` = no es de este flujo. */
export function readableSelectProposalError(cause: unknown): ReadableQuoteUserFlowError | null {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const e = parseQuoteUserFlowError(raw)
  const common = commonError(raw, e, 'PUT /admin/quote-requests/:id/selected-proposal')
  if (common || !e) return common

  if (e.status === 404 && e.code === 'QUOTE_PROPOSAL_NOT_FOUND')
    return {
      text: 'Esa propuesta ya no está activa en el pedido (la retiraron mientras tanto). No se guardó nada: se recargó la ficha.',
      action: 'reload',
    }
  if (e.status === 400 && e.code === 'INVALID_STATE_TRANSITION')
    return {
      text: 'El pedido está cerrado (o se cerró mientras tanto): ya no se puede elegir una propuesta. No se guardó nada: se recargó la ficha.',
      action: 'reload',
    }
  if (e.status === 400)
    return {
      text: e.message
        ? `El backend rechazó la elección: «${e.message}». No se guardó nada.`
        : 'El backend rechazó la elección. No se guardó nada.',
      action: 'fix',
    }
  return fallback(e)
}

/** «Declarar si fue». `null` = no es de este flujo. */
export function readableDeclareOutcomeError(cause: unknown): ReadableQuoteUserFlowError | null {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const e = parseQuoteUserFlowError(raw)
  const common = commonError(raw, e, 'POST /admin/quote-requests/:id/user-outcome')
  if (common || !e) return common

  if (e.status === 400 && e.code === 'INVALID_STATE_TRANSITION')
    return {
      text: 'Este pedido no admite declarar el resultado: todavía no tiene respuesta del equipo, o la persona lo canceló desde la app. No se guardó nada: se recargó la ficha.',
      action: 'reload',
    }
  if (e.status === 400)
    return {
      text: e.message
        ? `El backend rechazó la declaración: «${e.message}». Revisá la fecha (no puede ser futura ni anterior al pedido) y la observación (hasta 1000 caracteres). No se guardó nada.`
        : 'El backend rechazó la declaración. Revisá la fecha (no puede ser futura ni anterior al pedido) y la observación (hasta 1000 caracteres). No se guardó nada.',
      action: 'fix',
    }
  return fallback(e)
}
