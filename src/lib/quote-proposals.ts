import { z } from 'zod'
import { MAX_QUOTE_AMOUNT, QUOTE_CURRENCIES, type QuoteCurrency, type QuoteResponse } from '~/lib/quote-responses'

/**
 * «Propuestas en la app» — `public.quote_request_proposals` del BACKEND
 * (bounded context `quotes/`, migraciones 0120–0122 de `autolibre-backend-hex`).
 *
 * ── No es `ops.quote_request_response`, y conviven ──────────────────────────
 *
 * Los presupuestos de `ops` (015/022, `~/lib/quote-responses`) son lo que
 * contestó cada taller y alimentan la plantilla de WhatsApp. Las propuestas de
 * acá son lo que se le PUBLICA a la persona en la app: hasta 3 activas por
 * pedido, con push. Un presupuesto de `ops` puede sembrar una propuesta
 * (`responseToProposalDraft`), pero nunca se envía solo.
 *
 * ── Lee por SQL, escribe por HTTP ───────────────────────────────────────────
 *
 * Cuarta pantalla que escribe contra el backend hex (después de manuales,
 * notificaciones y conocimiento), con el mismo cliente (`~/server/backend`) y
 * la identidad del admin. El `grep` da positivo: `AdminQuoteRequestController`
 * con `AdminGuard` en cada handler. Una escritura SQL acá sería imposible de
 * hacer bien (push, idempotencia por `sendId`, lugares 1..3, el estado del
 * pedido): si aparece un `INSERT/UPDATE quote_request_proposals` en este repo,
 * está mal.
 *
 * No hay GET admin: la lectura es SQL directo (`quote-proposals.repo.ts`),
 * protegida por su propio guard de disponibilidad, porque en producción la
 * tabla vieja `quote_request_proposals` existe SIN las columnas nuevas.
 */

// ── Límites del backend ─────────────────────────────────────────────────────
//
// Espejan `quote-proposal.entity.ts`, `quote-proposal-provider.vo.ts` e
// `quote-proposal-items.vo.ts`. Duplicados a propósito, igual que los CHECK de
// los SP de `ops`: el de acá llega como issue al lado del campo, el del
// backend es el que no se puede saltear.

/** Lugares por pedido: una propuesta activa ocupa uno, retirarla lo libera. */
export const MAX_QUOTE_PROPOSAL_SLOTS = 3
export const MAX_PROPOSAL_PROVIDER_NAME = 120
export const MAX_PROPOSAL_PROVIDER_ADDRESS = 300
export const MAX_PROPOSAL_DESCRIPTION = 2000
export const MAX_PROPOSAL_INTERNAL_NOTES = 2000
export const MAX_PROPOSAL_RECOMMENDATION_REASON = 500
export const MAX_PROPOSAL_ITEMS = 50
/** Ojo: `ops` admite 200. Un ítem precargado más largo se recorta con aviso. */
export const MAX_PROPOSAL_ITEM_LABEL = 120

// ── Tipos de salida (lectura) ───────────────────────────────────────────────

export interface QuoteProposalItem {
  label: string
  amount: number
  optional: boolean
}

export interface QuoteProposal {
  id: string
  sendId: string
  /** El lugar 1..3. Lo asigna el backend: no se edita. */
  position: number
  partnerId: string | null
  /** Resuelto: el del partner si es del directorio, el tipeado si es de afuera. */
  providerName: string
  /** Crudos del taller de afuera (para sembrar la corrección). `null` para un partner. */
  providerAddress: string | null
  providerPhone: string | null
  /** Sólo para un partner: si su ficha tiene WhatsApp cargado. Un externo siempre lo trae. */
  partnerHasWhatsapp: boolean
  /** `null` en las dos = "a confirmar". `0` = sin cargo. Con ítems, la suma de los obligatorios. */
  amountMin: number | null
  amountMax: number | null
  currency: string
  /** `[]` = sin desglose. */
  items: Array<QuoteProposalItem>
  description: string
  internalNotes: string | null
  /** `YYYY-MM-DD`, armado por `to_char` (un `date` pasado por `Date` corre el día). */
  validUntil: string | null
  /** Contra el reloj de Postgres, no del navegador: la ficha es SSR. */
  expired: boolean | null
  isRecommended: boolean
  recommendationReason: string | null
  /** `null` = activa. */
  withdrawnAt: string | null
  createdAt: string
  updatedAt: string | null
}

export interface QuoteProposalSend {
  id: string
  closesSearch: boolean
  sentAt: string
  /** `null` si el admin que lo mandó ya no tiene fila en `users`. */
  sentByEmail: string | null
}

/**
 * `available: false` cuando esta base no tiene las migraciones 0120–0122 del
 * backend (hoy: producción). Mismo patrón que `quoteRequestsAvailability()`.
 */
export type QuoteProposalsResult =
  | { available: false }
  | {
      available: true
      /** Activas, ordenadas por `position`. */
      active: Array<QuoteProposal>
      /** Retiradas, para el historial plegado. */
      withdrawn: Array<QuoteProposal>
      sends: Array<QuoteProposalSend>
      /** `quote_requests.selected_proposal_id`: la que eligió la persona en la app. */
      selectedProposalId: string | null
      selectedAt: string | null
      /** `quote_requests.proposals_search_closed_at`: "no buscamos más". */
      searchClosedAt: string | null
      /** `3 − activas`, calculado en el SERVIDOR. */
      freeSlots: number
      /** Hubo al menos un envío por la app. Cambia lo que dicen Presupuestos y Plantillas. */
      hasAppSends: boolean
    }

// ── Sentinelas del panel ────────────────────────────────────────────────────

/** El handler no llamó al backend: esta base no tiene 0120–0122. */
export const QUOTE_PROPOSALS_UNAVAILABLE = 'QUOTE_PROPOSALS_UNAVAILABLE'
/**
 * El handler no llamó al backend: hay más propuestas que lugares libres. El
 * backend lo rechaza igual, pero con un 400 SIN code que no se puede distinguir
 * de otro error de validación.
 */
export const QUOTE_PROPOSALS_NO_FREE_SLOTS = 'QUOTE_PROPOSALS_NO_FREE_SLOTS'
/** Prefijo que arma `backendError(..., { proposal: true })`. */
export const QUOTE_PROPOSAL_ERROR = 'QUOTE_PROPOSAL_ERROR'

// ── Escritura: el contenido de una propuesta ────────────────────────────────

/** Hoy en UTC, `YYYY-MM-DD` — la misma fecha contra la que compara el backend. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

const proposalItemSchema = z.object({
  label: z.string().trim().min(1, 'Falta qué es el ítem.').max(MAX_PROPOSAL_ITEM_LABEL),
  amount: z.number().min(0).max(MAX_QUOTE_AMOUNT),
  optional: z.boolean(),
})

/**
 * Una propuesta tal como la escribe el admin: la misma forma en el envío y en
 * la corrección (PUT). Los opcionales AUSENTES no viajan (el backend valida con
 * `forbidNonWhitelisted` y la corrección es reemplazo completo: lo que no viene
 * queda vacío).
 */
export const quoteProposalContentSchema = z
  .object({
    partnerId: z.uuid().optional(),
    providerName: z.string().trim().max(MAX_PROPOSAL_PROVIDER_NAME).optional(),
    providerAddress: z.string().trim().max(MAX_PROPOSAL_PROVIDER_ADDRESS).optional(),
    /** Obligatorio para un taller de afuera: es su WhatsApp. El backend lo normaliza a 549. */
    providerPhone: z.string().trim().max(40).optional(),
    description: z.string().trim().min(1, 'Falta la descripción: es lo que lee la persona.').max(MAX_PROPOSAL_DESCRIPTION),
    /** Ausentes las dos = "a confirmar". */
    amountMin: z.number().min(0).max(MAX_QUOTE_AMOUNT).optional(),
    amountMax: z.number().min(0).max(MAX_QUOTE_AMOUNT).optional(),
    currency: z.enum(QUOTE_CURRENCIES),
    /** Con ítems, el precio lo deriva el backend y los montos NO pueden viajar. */
    items: z.array(proposalItemSchema).min(1).max(MAX_PROPOSAL_ITEMS).optional(),
    validUntil: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Usá el formato AAAA-MM-DD.')
      .optional(),
    internalNotes: z.string().trim().max(MAX_PROPOSAL_INTERNAL_NOTES).optional(),
    isRecommended: z.boolean(),
    recommendationReason: z.string().trim().max(MAX_PROPOSAL_RECOMMENDATION_REASON).optional(),
  })
  .refine((d) => (d.partnerId !== undefined) !== ((d.providerName ?? '') !== ''), {
    message: 'Elegí un partner del directorio o escribí el nombre del taller, no las dos cosas.',
    path: ['providerName'],
  })
  .refine(
    (d) => d.partnerId === undefined || ((d.providerAddress ?? '') === '' && (d.providerPhone ?? '') === ''),
    { message: 'La dirección y el WhatsApp de un partner salen de su ficha del directorio.', path: ['providerAddress'] },
  )
  .refine((d) => d.partnerId !== undefined || (d.providerPhone ?? '') !== '', {
    message: 'Un taller de afuera necesita su WhatsApp: es por donde la persona lo contacta.',
    path: ['providerPhone'],
  })
  .refine((d) => d.items === undefined || (d.amountMin === undefined && d.amountMax === undefined), {
    message: 'Con detalle por ítems, el precio es la suma de los ítems: no cargues «desde/hasta».',
    path: ['amountMin'],
  })
  .refine((d) => (d.amountMin === undefined) === (d.amountMax === undefined), {
    message: 'Las dos puntas del precio, o ninguna («a confirmar»).',
    path: ['amountMax'],
  })
  .refine((d) => d.amountMin === undefined || d.amountMax === undefined || d.amountMin <= d.amountMax, {
    message: 'El mínimo no puede ser mayor que el máximo.',
    path: ['amountMax'],
  })
  .refine((d) => d.validUntil === undefined || d.validUntil >= todayUtc(), {
    message: 'La vigencia no puede ser anterior a hoy.',
    path: ['validUntil'],
  })
  // Recomendada si y sólo si tiene motivo: es la regla de
  // `QuoteProposal.parseRecommendation`, en los dos sentidos.
  .refine((d) => !d.isRecommended || (d.recommendationReason ?? '') !== '', {
    message: 'Una propuesta recomendada necesita el motivo: es lo que lee la persona.',
    path: ['recommendationReason'],
  })
  .refine((d) => d.isRecommended || (d.recommendationReason ?? '') === '', {
    message: 'El motivo sólo va en la recomendada.',
    path: ['recommendationReason'],
  })
export type QuoteProposalContent = z.infer<typeof quoteProposalContentSchema>

/**
 * Un envío: 1..3 propuestas. `sendId` es la clave de idempotencia y la genera
 * el CLIENTE una vez por envío (como `broadcastId`): reintentar con el mismo id
 * devuelve lo ya guardado y no vuelve a avisar a la persona.
 *
 * El tope real es `freeSlots`, no 3: lo re-chequea el handler contra la base
 * antes del fetch (`QUOTE_PROPOSALS_NO_FREE_SLOTS`).
 */
export const sendQuoteProposalsSchema = z
  .object({
    quoteRequestId: z.uuid(),
    sendId: z.uuid(),
    closesSearch: z.boolean(),
    proposals: z.array(quoteProposalContentSchema).min(1).max(MAX_QUOTE_PROPOSAL_SLOTS),
  })
  .refine((d) => d.proposals.filter((p) => p.isRecommended).length <= 1, {
    message: 'Como mucho UNA propuesta recomendada.',
    path: ['proposals'],
  })
export type SendQuoteProposalsInput = z.infer<typeof sendQuoteProposalsSchema>

/**
 * Corrección: PUT con reemplazo completo, SIN push. `quoteRequestId` viaja sólo
 * para que el handler re-chequee el guard; el backend lo deriva de la propuesta.
 */
export const correctQuoteProposalSchema = z.object({
  quoteRequestId: z.uuid(),
  proposalId: z.uuid(),
  content: quoteProposalContentSchema,
})
export type CorrectQuoteProposalInput = z.infer<typeof correctQuoteProposalSchema>

/** Retirar: borrado lógico, idempotente, libera el lugar. */
export const withdrawQuoteProposalSchema = z.object({
  quoteRequestId: z.uuid(),
  proposalId: z.uuid(),
})
export type WithdrawQuoteProposalInput = z.infer<typeof withdrawQuoteProposalSchema>

/**
 * "No buscamos más" — cierra la BÚSQUEDA, no el pedido. `closureId` es la clave
 * de idempotencia, generada por el cliente igual que `sendId`.
 */
export const closeQuoteProposalsSearchSchema = z.object({
  quoteRequestId: z.uuid(),
  closureId: z.uuid(),
})
export type CloseQuoteProposalsSearchInput = z.infer<typeof closeQuoteProposalsSearchSchema>

// ── Errores ─────────────────────────────────────────────────────────────────

export interface QuoteProposalError {
  status: number
  /** `''` cuando el backend no mandó code (un 400 del ValidationPipe, un 404 de ruta). */
  code: string
  /** 0-based, como lo manda el backend. Sólo en el ENVÍO (el PUT es una sola propuesta). */
  proposalIndex: number | null
  partnerId: string | null
  message: string
}

/**
 * Lee la sentinela `QUOTE_PROPOSAL_ERROR:<status>:<code>:<idx>:<partnerId>:<msg>`
 * que arma `backendError(..., { proposal: true })`. El mensaje va último porque
 * puede traer `:`. `null` si el error no es de ese formato.
 */
export function parseQuoteProposalError(cause: unknown): QuoteProposalError | null {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const at = raw.indexOf(`${QUOTE_PROPOSAL_ERROR}:`)
  if (at === -1) return null
  const parts = raw.slice(at + QUOTE_PROPOSAL_ERROR.length + 1).split(':')
  if (parts.length < 5) return null
  const [status, code, idx, partnerId, ...rest] = parts
  const index = idx === undefined || idx === '' ? null : Number(idx)
  return {
    status: Number(status),
    code: code ?? '',
    proposalIndex: index !== null && Number.isInteger(index) && index >= 0 ? index : null,
    partnerId: partnerId === undefined || partnerId === '' ? null : partnerId,
    message: rest.join(':'),
  }
}

/** "la propuesta 2" — el backend cuenta desde 0, la persona desde 1. */
const nth = (index: number | null): string => (index === null ? 'una propuesta' : `la propuesta ${index + 1}`)

/**
 * Traduce cualquier error de las escrituras de propuestas a castellano. Client-safe.
 *
 * Cada code dice algo DISTINTO y se dice distinto: los tres "no existe"
 * (pedido, propuesta, partner) no se funden en uno. El índice de la propuesta
 * lo usa la UI para pintar el error en la fila que corresponde; acá además
 * se nombra.
 */
export function readableQuoteProposalError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)

  if (raw.includes(QUOTE_PROPOSALS_UNAVAILABLE))
    return 'Esta base no tiene las migraciones 0120–0122 del backend: todavía no se pueden mandar propuestas por la app. No se envió nada.'
  if (raw.includes(QUOTE_PROPOSALS_NO_FREE_SLOTS))
    return 'Hay más propuestas que lugares libres (como mucho 3 activas por pedido). Retirá alguna o mandá menos. No se envió nada.'
  if (raw.startsWith('BACKEND_UNREACHABLE:'))
    return `No pudimos hablar con el backend (${raw.slice('BACKEND_UNREACHABLE:'.length)}). Revisá AUTOLIBRE_BACKEND_URL o que el backend esté levantado. No se envió nada.`
  if (raw === 'BACKEND_UNAUTHENTICATED' || raw === 'UNAUTHENTICATED')
    return 'Tu sesión expiró. Cerrá sesión y volvé a entrar.'
  if (raw === 'BACKEND_FORBIDDEN') return 'Tu usuario no es admin para el backend.'
  if (raw === 'FORBIDDEN') return 'Tu rol no tiene permiso para esta acción.'
  if (/timeout|timed out|aborted/i.test(raw) && !raw.includes(QUOTE_PROPOSAL_ERROR))
    return 'El backend tardó demasiado en contestar. Puede que se haya guardado igual: recargá antes de reintentar (reintentar el mismo envío no lo duplica).'

  const e = parseQuoteProposalError(cause)
  if (e) {
    switch (e.code) {
      case 'INVALID_STATE_TRANSITION':
        return 'El pedido está cerrado (o la propuesta está retirada): no admite envíos ni cambios. Recargá la pantalla.'
      case 'QUOTE_PROPOSAL_INVALID_PROVIDER_PHONE':
        return `El WhatsApp del taller de ${nth(e.proposalIndex)} no es un celular argentino válido.`
      case 'QUOTE_PROPOSAL_PARTNER_WITHOUT_WHATSAPP':
        return `El partner de ${nth(e.proposalIndex)} no tiene un WhatsApp válido en su ficha: cargalo en el directorio o usá otro taller.`
      case 'QUOTE_PROPOSAL_PARTNER_NOT_FOUND':
        return `El partner de ${nth(e.proposalIndex)} ya no existe en el directorio. Recargá la pantalla.`
      case 'QUOTE_PROPOSAL_NOT_FOUND':
        return 'Esa propuesta ya no existe. Recargá la pantalla.'
      case 'NOT_FOUND':
        return 'Este pedido ya no existe. Recargá la pantalla.'
    }
    // Un 404 sin code de una ruta que no existe: Nest contesta "Cannot POST …".
    if (e.status === 404 && e.message.startsWith('Cannot '))
      return 'El backend al que apunta el panel no tiene todavía los endpoints de propuestas (0120–0122 sin desplegar). No se envió nada.'
    if (e.status === 404) return `No se encontró lo que se quería cambiar: «${e.message}». Recargá la pantalla.`
    if (e.status === 409)
      return `Conflicto con lo que ya está guardado (otra propuesta recomendada, un envío de otro pedido o un cambio simultáneo): «${e.message}». Recargá la pantalla.`
    if (e.status === 400)
      return `El backend rechazó el envío: «${e.message}».`
    return `El backend contestó ${e.status}: «${e.message}».`
  }

  if (raw.startsWith('BACKEND_ERROR:')) return `El backend contestó con un error: ${raw.slice('BACKEND_ERROR:'.length)}`
  return 'No pudimos completar la acción. Recargá la pantalla para ver qué quedó guardado.'
}

// ── Precarga desde un presupuesto de `ops` ──────────────────────────────────

/** Una propuesta sembrada desde un presupuesto: valores tipados, no strings de formulario. */
export interface QuoteProposalDraft {
  partnerId: string | null
  providerName: string
  providerAddress: string
  providerPhone: string
  description: string
  amountMin: number | null
  amountMax: number | null
  currency: QuoteCurrency
  items: Array<QuoteProposalItem>
  validUntil: string | null
}

const clip = (value: string, max: number): { value: string; clipped: boolean } =>
  value.length > max ? { value: value.slice(0, max), clipped: true } : { value, clipped: false }

/**
 * Siembra una propuesta desde lo que contestó un taller en `ops`. NUNCA envía:
 * el operador la revisa en el formulario.
 *
 * `ops` admite textos más largos que el backend (nombre e ítem hasta 200, acá
 * 120): se recortan y se AVISA, nunca en silencio. Un taller de afuera sin
 * teléfono se siembra igual — el envío lo va a pedir —, y también se avisa.
 * Un presupuesto vencido lo apaga la UI antes de llegar acá.
 */
export function responseToProposalDraft(r: QuoteResponse): {
  draft: QuoteProposalDraft
  warnings: Array<string>
} {
  const warnings: Array<string> = []
  const isPartner = r.partnerId !== null

  const name = clip(isPartner ? '' : (r.providerName ?? r.name).trim(), MAX_PROPOSAL_PROVIDER_NAME)
  if (name.clipped) warnings.push(`El nombre del taller se recortó a ${MAX_PROPOSAL_PROVIDER_NAME} caracteres.`)
  const address = clip(isPartner ? '' : (r.providerAddress ?? '').trim(), MAX_PROPOSAL_PROVIDER_ADDRESS)
  if (address.clipped) warnings.push(`La dirección se recortó a ${MAX_PROPOSAL_PROVIDER_ADDRESS} caracteres.`)
  const phone = isPartner ? '' : (r.providerPhone ?? '').trim()
  if (!isPartner && phone === '')
    warnings.push('Es un taller de afuera sin teléfono: cargá su WhatsApp antes de enviar.')
  const description = clip(r.detail.trim(), MAX_PROPOSAL_DESCRIPTION)
  if (description.clipped) warnings.push(`La descripción se recortó a ${MAX_PROPOSAL_DESCRIPTION} caracteres.`)

  let clippedItems = 0
  const items = r.items.slice(0, MAX_PROPOSAL_ITEMS).map((it) => {
    const label = clip(it.label.trim(), MAX_PROPOSAL_ITEM_LABEL)
    if (label.clipped) clippedItems++
    return { label: label.value, amount: it.amount, optional: it.optional }
  })
  if (clippedItems > 0)
    warnings.push(
      `${clippedItems === 1 ? 'Un ítem tenía' : `${clippedItems} ítems tenían`} más de ${MAX_PROPOSAL_ITEM_LABEL} caracteres y se ${clippedItems === 1 ? 'recortó' : 'recortaron'}.`,
    )

  const currency: QuoteCurrency = (QUOTE_CURRENCIES as ReadonlyArray<string>).includes(r.currency)
    ? (r.currency as QuoteCurrency)
    : 'ARS'

  return {
    draft: {
      partnerId: r.partnerId,
      providerName: name.value,
      providerAddress: address.value,
      providerPhone: phone,
      description: description.value,
      // Con desglose, el precio lo deriva el backend de los ítems: los montos no viajan.
      amountMin: items.length > 0 ? null : r.amountMin,
      amountMax: items.length > 0 ? null : r.amountMax,
      currency,
      items,
      validUntil: r.validUntil,
    },
    warnings,
  }
}
