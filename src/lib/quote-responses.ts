import { z } from 'zod'

/**
 * Lo que cada taller contestó para un pedido — `ops.quote_request_response`
 * (migración 015).
 *
 * ── Por qué NO es `public.quote_request_proposals` ─────────────────────────
 *
 * El backend tiene una tabla parecida, y esta feature deliberadamente no la
 * usa. Los dos motivos están completos en la cabecera de la migración; el
 * resumen es que no puede representar la mitad de los casos reales:
 *
 *   1. `amount_min` es NOT NULL con `CHECK (amount_min > 0)` — estricto, así
 *      que ni siquiera admite 0. Un diagnóstico sin precio no entra, y en el
 *      mensaje real que motivó esto los TRES talleres contestaron sin precio.
 *   2. No tiene dónde guardar la dirección y el teléfono de un taller que no
 *      está en el directorio, que es justo lo que la persona necesita para
 *      coordinar sola.
 *
 * ── Vocabulario: `response` en el código, "presupuesto" en la UI ───────────
 *
 * Regla dura 7 no obliga a llamar igual a dos cosas distintas: obliga a lo
 * contrario. `proposal` es el sustantivo del backend para una oferta CON
 * precio (`quote_requests.proposals_count`); una fila de acá puede no tenerlo,
 * y es "lo que contestó el taller". La UI dice "Presupuestos" porque es la
 * palabra del equipo — misma divergencia deliberada que `tier` ↔ "Aliado" y
 * `service_categories` ↔ "Rubro". → `.claude/rules/leads.md`
 *
 * No confundir con `assistant_proposals`, que son las propuestas del chat de
 * IA (`metricas.md`, bloque 3). Otra tabla, otro contexto.
 */

// ── Moneda ──────────────────────────────────────────────────────────────────
//
// Catálogo NUESTRO, no el enum `quote_request_proposal_currency` de `public`:
// la tabla de `ops` no depende del deploy del backend. Los valores coinciden a
// propósito, para que el backfill del día que se unifiquen sea un cast directo
// (ver la cabecera de la migración).

export const QUOTE_CURRENCIES = ['ARS', 'USD'] as const
export type QuoteCurrency = (typeof QUOTE_CURRENCIES)[number]

export const QUOTE_CURRENCY_LABELS: Record<QuoteCurrency, string> = {
  ARS: 'Pesos',
  USD: 'Dólares',
}

export function quoteCurrencyLabel(raw: string): string {
  return QUOTE_CURRENCY_LABELS[raw as QuoteCurrency] ?? raw
}

/** `numeric(12,2)`: lo máximo que entra sin un `numeric field overflow`. */
export const MAX_QUOTE_AMOUNT = 9_999_999_999

// ── Tipo de salida ──────────────────────────────────────────────────────────

export interface QuoteResponse {
  id: string
  quoteRequestId: string
  /** Orden en el mensaje. Editorial: lo decide el operador, no el precio. */
  position: number

  /** El partner del directorio, si lo es. `null` = taller de afuera. */
  partnerId: string | null
  /** `partners.status` actual, para avisar si quedó pausado o archivado. */
  partnerStatus: string | null
  /** `partners.tier` actual. `null` para un taller de afuera. */
  partnerTier: string | null
  /** Los campos CRUDOS del taller de afuera, para sembrar el formulario. */
  providerName: string | null
  providerAddress: string | null
  providerPhone: string | null

  /**
   * Lo RESUELTO, que es lo que se muestra y lo que va al mensaje: del partner
   * si es del directorio (y entonces sigue al directorio cuando cambia), del
   * campo tipeado si es de afuera.
   */
  name: string
  address: string | null
  phone: string | null
  /** Sólo del directorio: un taller de afuera no tiene horarios cargados. */
  hours: string | null

  /**
   * Tres estados y los tres significan cosas distintas:
   * `null` = el taller no pasó precio · `0` = sin cargo · `> 0` = el precio.
   */
  amountMin: number | null
  amountMax: number | null
  currency: string

  /** Lo que le contamos a la persona sobre este taller. Es el párrafo. */
  detail: string
  /** `YYYY-MM-DD`, o `null` si no declaró vigencia. */
  validUntil: string | null
  /**
   * Vencida contra el reloj de POSTGRES, no del navegador: la ficha es SSR
   * completo y comparar contra `Date.now()` daría un booleano distinto del que
   * mandó el servidor — un mismatch de hidratación por fila. Mismo patrón que
   * `age_minutes` en `/actividad`. `null` cuando no hay `valid_until`.
   */
  expired: boolean | null
  /** Para el operador. NO sale en el mensaje. */
  internalNotes: string | null
  createdAt: string
}

/**
 * `available: false` cuando `ops.quote_request_response` no existe en esta
 * base — o sea, cuando falta correr `pnpm db:migrate`. Mismo patrón que
 * `quoteRequestsAvailability()`, y acá la causa es nuestra y no del backend.
 */
export type QuoteResponsesResult =
  | { available: false }
  | { available: true; rows: Array<QuoteResponse> }

// ── Escrituras: los SP de `ops` de la migración 015 ─────────────────────────
//
// Ningún schema lleva actor: `p_actor_id` sale de la sesión en el handler
// (guardrail 4 de `ops-write-actions.md`).

/**
 * Los campos compartidos por el alta y la edición.
 *
 * Los `refine` espejan los CHECK de la tabla. Están duplicados en zod y en el
 * SP a propósito, igual que las coordenadas de la 007: el de zod llega como
 * issue con el path del campo y el formulario lo muestra al lado del input; el
 * del SP es el que NO se puede saltear.
 */
const responseFields = z
  .object({
    partnerId: z.uuid().optional(),
    providerName: z.string().trim().max(200).optional(),
    providerAddress: z.string().trim().max(300).optional(),
    providerPhone: z.string().trim().max(40).optional(),
    /** Ausente = el taller no pasó precio. `0` = sin cargo, que sí es un precio. */
    amountMin: z.number().min(0).max(MAX_QUOTE_AMOUNT).optional(),
    amountMax: z.number().min(0).max(MAX_QUOTE_AMOUNT).optional(),
    currency: z.enum(QUOTE_CURRENCIES),
    detail: z.string().trim().min(1).max(2000),
    validUntil: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Usá el formato AAAA-MM-DD.')
      .optional(),
    internalNotes: z.string().trim().max(2000).optional(),
    /** Nota de AUDITORÍA (`ops.action_log`), no la nota interna de la fila. */
    auditNote: z.string().trim().max(500).optional(),
  })
  .refine((d) => (d.partnerId !== undefined) !== ((d.providerName ?? '') !== ''), {
    message: 'Elegí un partner del directorio o escribí el nombre del taller, no las dos cosas.',
    path: ['providerName'],
  })
  .refine(
    (d) =>
      d.partnerId === undefined ||
      ((d.providerAddress ?? '') === '' && (d.providerPhone ?? '') === ''),
    {
      message: 'La dirección y el teléfono de un partner salen de su ficha del directorio.',
      path: ['providerAddress'],
    },
  )
  .refine((d) => (d.amountMin === undefined) === (d.amountMax === undefined), {
    message: 'Las dos puntas del precio, o ninguna.',
    path: ['amountMax'],
  })
  .refine((d) => d.amountMin === undefined || d.amountMax === undefined || d.amountMin <= d.amountMax, {
    message: 'El mínimo no puede ser mayor que el máximo.',
    path: ['amountMax'],
  })

export const addQuoteResponseSchema = z.object({ quoteRequestId: z.uuid() }).and(responseFields)
export type AddQuoteResponseInput = z.infer<typeof addQuoteResponseSchema>

export const updateQuoteResponseSchema = z.object({ id: z.uuid() }).and(responseFields)
export type UpdateQuoteResponseInput = z.infer<typeof updateQuoteResponseSchema>

export const deleteQuoteResponseSchema = z.object({
  id: z.uuid(),
  auditNote: z.string().trim().max(500).optional(),
})
export type DeleteQuoteResponseInput = z.infer<typeof deleteQuoteResponseSchema>

/**
 * La lista COMPLETA de ids en el orden deseado, no un "mové éste uno arriba".
 * Con un movimiento relativo, dos operadores reordenando a la vez dejan un
 * orden que ninguno pidió; con la lista entera, el resultado es el que se vio
 * en pantalla. El SP rechaza una lista incompleta, con duplicados o con ajenos.
 */
export const reorderQuoteResponsesSchema = z.object({
  quoteRequestId: z.uuid(),
  ids: z.array(z.uuid()).min(1).max(50),
})
export type ReorderQuoteResponsesInput = z.infer<typeof reorderQuoteResponsesSchema>

/** Sentinela del handler cuando la tabla de `ops` no existe en esta base. */
export const QUOTE_RESPONSES_UNAVAILABLE = 'QUOTE_RESPONSES_UNAVAILABLE'

/**
 * Traduce las sentinelas de los SP de la 015. Client-safe: corre en el
 * navegador sobre el `message` del error.
 *
 * El fallback NO muestra el texto crudo de Postgres. Cada SP es una sola
 * sentencia, así que si falló no se aplicó nada — eso sí se puede decir.
 */
export function readableQuoteResponseError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)

  if (raw.includes(QUOTE_RESPONSES_UNAVAILABLE))
    return 'Falta aplicar la migración 015 en esta base (pnpm db:migrate). No se aplicó nada.'
  if (raw.includes('QUOTE_RESPONSE_NOT_FOUND'))
    return 'Ese presupuesto ya no existe — puede que lo haya borrado otra persona. Recargá la pantalla.'
  if (raw.includes('QUOTE_REQUEST_NOT_FOUND')) return 'Este pedido ya no existe. Recargá la pantalla.'
  if (raw.includes('PROVIDER_REQUIRED'))
    return 'Falta el taller: elegí uno del directorio o escribí el nombre.'
  if (raw.includes('PROVIDER_AMBIGUOUS'))
    return 'Es un partner del directorio O un taller de afuera, no las dos cosas.'
  if (raw.includes('PROVIDER_CONTACT_NOT_EDITABLE'))
    return 'La dirección y el teléfono de un partner salen de su ficha del directorio: corregilos ahí.'
  if (raw.includes('PARTNER_NOT_FOUND')) return 'Ese partner ya no existe. Recargá la pantalla.'
  if (raw.includes('DETAIL_REQUIRED')) return 'Falta qué contestó el taller: es el párrafo que lee la persona.'
  if (raw.includes('AMOUNT_INCOMPLETE'))
    return 'Cargá las dos puntas del precio, o ninguna. Para un precio cerrado, poné el mismo número en las dos.'
  if (raw.includes('AMOUNT_TOO_LARGE'))
    return 'El precio no entra en la columna: el máximo es 9.999.999.999,99.'
  if (raw.includes('INVALID_AMOUNT_RANGE')) return 'El mínimo no puede ser mayor que el máximo.'
  if (raw.includes('INVALID_AMOUNT')) return 'El precio no puede ser negativo. Cero es válido: significa sin cargo.'
  if (raw.includes('INVALID_CURRENCY')) return 'Esa moneda no existe en el catálogo. Recargá la pantalla.'
  if (raw.includes('VALID_UNTIL_IN_PAST'))
    return 'La vigencia no puede ser anterior a la fecha en que se cargó el presupuesto.'
  if (raw.includes('INVALID_VALID_UNTIL')) return 'La vigencia tiene que ser una fecha AAAA-MM-DD.'
  if (raw.includes('REORDER_MISMATCH') || raw.includes('REORDER_DUPLICATE_IDS') || raw.includes('REORDER_EMPTY'))
    return 'El orden cambió por debajo mientras lo movías. Recargá la pantalla y probá de nuevo.'
  if (raw.includes('ACTOR_NOT_FOUND') || raw.includes('ACTOR_REQUIRED'))
    return 'Tu sesión no corresponde a un usuario de AutoLibre. Volvé a iniciar sesión.'
  if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'
  if (raw === 'UNAUTHENTICATED') return 'Tu sesión expiró. Volvé a iniciar sesión.'
  return 'No pudimos guardar. No se aplicó nada — cada acción es una sola operación en la base.'
}

// ── Formato ─────────────────────────────────────────────────────────────────

/**
 * Los formateadores viven acá y no en `~/lib/format` porque el dólar es dato
 * de ESTE contexto: el resto del panel muestra pesos (`formatArs`), y el único
 * otro dólar del repo es `formatUsd` de `~/lib/ai-usage`, que existe porque al
 * proveedor de IA se le paga en dólares.
 *
 * Locale pineado y sin decimales, igual que `formatArs`: el markup del
 * servidor tiene que coincidir byte a byte con el primer render del cliente.
 */
const AMOUNT_FORMATTERS: Record<string, Intl.NumberFormat> = {
  ARS: new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }),
  USD: new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }),
}

const PLAIN = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 })

/** Una moneda que el catálogo no conoce sale con el código adelante, nunca vacía. */
function formatAmount(amount: number, currency: string): string {
  const f = AMOUNT_FORMATTERS[currency]
  return f ? f.format(amount) : `${currency} ${PLAIN.format(amount)}`
}

/**
 * El precio como lo lee una persona, o `null` cuando el taller no pasó ninguno.
 *
 * Los tres estados de la columna se vuelven tres salidas distintas, y la
 * diferencia importa: `null` desaparece del mensaje (un renglón vacío se lee
 * como un error), `0` dice "Sin cargo" (que es una respuesta, y buena), y un
 * rango con las dos puntas iguales se muestra como un solo número.
 */
export function formatQuoteAmount(
  r: Pick<QuoteResponse, 'amountMin' | 'amountMax' | 'currency'>,
): string | null {
  if (r.amountMin === null || r.amountMax === null) return null
  if (r.amountMin === 0 && r.amountMax === 0) return 'Sin cargo'
  const min = formatAmount(r.amountMin, r.currency)
  if (r.amountMin === r.amountMax) return min
  return `${min} a ${formatAmount(r.amountMax, r.currency)}`
}
