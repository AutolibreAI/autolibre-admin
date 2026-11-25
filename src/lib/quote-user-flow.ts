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
 * Fuera de alcance: los pedidos SIN cuenta (`user_id` NULL). Ahí no hay app ni
 * "flujo de la persona" que completar: se cierran como siempre, con el
 * resultado del operador y una nota (`ops.close_quote_request`). Un taller que
 * no estaba entre las propuestas tampoco se modela: va en una nota interna.
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
 * «Marcar como elegida por el usuario»: sólo con cuenta y con el pedido sin
 * cerrar. Lo demás (propuesta activa y del pedido) lo decide el backend atómico
 * con la escritura; acá sólo se evita ofrecer lo que seguro rebota.
 */
export function canSelectProposalOnBehalf(f: QuoteUserFlowFacts): boolean {
  return f.userId !== null && f.status !== 'closed'
}

/**
 * «Declarar si fue»: con cuenta, con `answered_at` (hubo algo que responderle)
 * y sin cancelación de la persona. A diferencia de elegir, SÍ se permite con el
 * pedido cerrado por el operador: es el caso típico de un pedido viejo que se
 * cerró sin que la persona contara cómo le fue.
 */
export function canDeclareOutcomeOnBehalf(f: QuoteUserFlowFacts): boolean {
  return f.userId !== null && f.answeredAt !== null && f.closeReasonCode !== 'cancelled_by_user'
}

/**
 * Flujo incompleto: con cuenta, respondido y sin `user_outcome`. Es a quién hay
 * que llamar. Se excluyen los cancelados por la persona: ahí no hay nada que
 * declarar (el backend lo rechaza con 409).
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
 * `performedOn` obligatorio con `hired` y PROHIBIDO en los otros dos — el
 * backend contesta 400 si viene de más, así que acá no viaja ni vacío. Los
 * límites (no futuro, no antes del pedido) los vuelve a chequear el backend; el
 * date picker los impone con `min`/`max` (`performedOnBounds`).
 */
export const declareQuoteUserOutcomeOnBehalfSchema = z
  .object({
    quoteRequestId: z.uuid(),
    outcome: z.enum(QUOTE_USER_OUTCOME_DECLARATIONS),
    performedOn: z.string().regex(DAY, 'La fecha va como AAAA-MM-DD.').optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.outcome === 'hired' && v.performedOn === undefined)
      ctx.addIssue({ code: 'custom', path: ['performedOn'], message: 'Falta la fecha en que se hizo el trabajo.' })
    if (v.outcome !== 'hired' && v.performedOn !== undefined)
      ctx.addIssue({ code: 'custom', path: ['performedOn'], message: 'La fecha va sólo si fue al taller.' })
  })
export type DeclareQuoteUserOutcomeOnBehalfInput = z.infer<typeof declareQuoteUserOutcomeOnBehalfSchema>

/** El cuerpo HTTP, sin el id (va en la URL). `performedOn` sólo existe si viaja. */
export function declareOutcomeBody(
  input: DeclareQuoteUserOutcomeOnBehalfInput,
): { outcome: QuoteUserOutcomeDeclaration; performedOn?: string } {
  return input.outcome === 'hired' && input.performedOn
    ? { outcome: input.outcome, performedOn: input.performedOn }
    : { outcome: input.outcome }
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
    }

/** La fuente de un paso que TIENE dato. `null` en la columna = anterior a la migración = la app. */
export function provenanceSource(source: QuoteUserFlowSource | null): QuoteUserFlowSource {
  return source ?? 'user'
}

/** Cómo se dice el admin: nombre y email si están, lo que haya si no. */
export function actorLabel(by: QuoteUserFlowActor | null): string {
  if (!by) return 'un admin que ya no está'
  if (by.name && by.email) return `${by.name} (${by.email})`
  return by.name ?? by.email ?? by.id
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
 * - `reload`: el pedido cambió (cerrado, propuesta retirada, ya no admite la
 *   declaración); se relee la ficha.
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
  if (e.status === 404 && e.code === 'QUOTE_REQUEST_NOT_FOUND')
    return { text: 'Este pedido ya no existe en el backend. Recargá la pantalla.', action: 'reload' }
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
  if (e.status === 409)
    return {
      text: 'El pedido está cerrado (o se cerró mientras tanto): ya no se puede elegir una propuesta. Se recargó la ficha.',
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

  if (e.status === 409)
    return {
      text: 'Este pedido no admite declarar el resultado: todavía no tiene respuesta del equipo, o la persona lo canceló desde la app. No se guardó nada: se recargó la ficha.',
      action: 'reload',
    }
  if (e.status === 400)
    return {
      text: e.message
        ? `El backend rechazó la declaración: «${e.message}». Revisá la fecha (no puede ser futura ni anterior al pedido). No se guardó nada.`
        : 'El backend rechazó la declaración. Revisá la fecha (no puede ser futura ni anterior al pedido). No se guardó nada.',
      action: 'fix',
    }
  return fallback(e)
}
