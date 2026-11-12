import { z } from 'zod'

/**
 * «Despacho por WhatsApp» — el pedido sale a hasta 3 talleres por un template
 * de WhatsApp que manda el BACKEND (`partner_outreach`, 0142). Client-safe:
 * tipos, schemas de las respuestas, etiquetas y la traducción de errores.
 * → `.claude/rules/partner-dispatch.md`
 *
 * Los enums que el backend puede ampliar (motivos, estados de entrega, fallas)
 * se aceptan como `string`: un valor que el espejo no conoce se muestra CRUDO,
 * nunca en blanco y nunca rompe la validación de la respuesta entera.
 */

export const MAX_DISPATCH_SLOTS = 3

/** Sentinelas propias. Las arma `backendError(..., { dispatch: true })` y los handlers. */
export const PARTNER_DISPATCH_ERROR = 'PARTNER_DISPATCH_ERROR'
export const PARTNER_DISPATCH_UNAVAILABLE = 'PARTNER_DISPATCH_UNAVAILABLE'
export const PARTNER_DISPATCH_BAD_RESPONSE = 'PARTNER_DISPATCH_BAD_RESPONSE'

// ── Respuestas ──────────────────────────────────────────────────────────────

const textPreviewSchema = z.object({ text: z.string() })

export const dispatchDraftSchema = z.object({
  readiness: z.object({
    status: z.string(),
    reasons: z.array(z.string()),
  }),
  freeSlots: z.number().int(),
  rubros: z.array(z.object({ slug: z.string(), name: z.string(), primary: z.boolean() })),
  locality: z.string().nullable(),
  candidates: z.array(
    z.object({
      partnerId: z.string(),
      name: z.string(),
      distanceBucket: z.string(),
      templateRubros: z.string(),
      coveredRubros: z.array(z.string()),
      uncoveredRubros: z.array(z.string()),
      coversAllRubros: z.boolean(),
      templatePreview: textPreviewSchema,
    }),
  ),
  excluded: z.array(
    z.object({
      partnerId: z.string(),
      name: z.string().nullable(),
      reason: z.string(),
    }),
  ),
  detailsPreview: textPreviewSchema,
  piiFindings: z.array(z.string()),
  piiWarning: z
    .object({
      detected: z.literal(true),
      kinds: z.array(z.string()),
      message: z.string(),
    })
    .nullable(),
})
export type DispatchDraft = z.infer<typeof dispatchDraftSchema>
export type DispatchCandidate = DispatchDraft['candidates'][number]

export const approvedDispatchSchema = z.object({
  dispatchId: z.string(),
  outreach: z.array(z.object({ id: z.string(), partnerId: z.string(), status: z.string() })),
})
export type ApprovedDispatch = z.infer<typeof approvedDispatchSchema>

const outreachMessageSchema = z.object({
  direction: z.string(),
  kind: z.string(),
  text: z.string().nullable(),
  at: z.string(),
})

export const outreachRowSchema = z.object({
  id: z.string(),
  partnerId: z.string(),
  partnerName: z.string().nullable(),
  status: z.string(),
  deliveryStatus: z.string().nullable(),
  failureReason: z.string().nullable(),
  approvedAt: z.string(),
  templateSentAt: z.string().nullable(),
  respondedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  messages: z.array(outreachMessageSchema),
  /**
   * El hilo de la bandeja de WhatsApp (`/whatsapp/:id`), agregado el
   * 2026-11-06. `.optional()` porque un backend todavía sin desplegar no lo
   * manda, y una fila sin él no tiene que tirar la tarjeta entera.
   */
  whatsappConversationId: z.string().nullable().optional(),
})
export const outreachListSchema = z.array(outreachRowSchema)
export type OutreachRow = z.infer<typeof outreachRowSchema>
export type OutreachMessage = OutreachRow['messages'][number]

/**
 * Lo que devuelve el server function de lectura: el borrador y el seguimiento
 * por separado. Uno puede fallar sin llevarse al otro, y la ficha nunca da 500
 * por esta tarjeta.
 */
export type DispatchFetchResult<T> = { ok: true; data: T } | { ok: false; error: string }

export type PartnerDispatchResult =
  | { available: false }
  | { available: true; draft: DispatchFetchResult<DispatchDraft>; outreach: DispatchFetchResult<Array<OutreachRow>> }

// ── Entradas de los server functions ────────────────────────────────────────

export const approvePartnerDispatchSchema = z.object({
  quoteRequestId: z.uuid(),
  dispatchId: z.uuid(),
  partnerIds: z
    .array(z.uuid())
    .min(1, 'Elegí al menos un taller.')
    .max(MAX_DISPATCH_SLOTS, `Como mucho ${MAX_DISPATCH_SLOTS} talleres.`)
    .refine((ids) => new Set(ids).size === ids.length, 'Hay un taller repetido.'),
})
export type ApprovePartnerDispatchInput = z.infer<typeof approvePartnerDispatchSchema>

// ── Etiquetas ───────────────────────────────────────────────────────────────

const label = (map: Record<string, string>, value: string): string => map[value] ?? value

export const READINESS_STATUS_LABELS: Record<string, string> = {
  ready: 'Listo para despachar',
  needs_info: 'Falta información',
  rejected: 'No se puede despachar',
}
export const readinessStatusLabel = (s: string) => label(READINESS_STATUS_LABELS, s)

export const READINESS_REASON_LABELS: Record<string, string> = {
  request_closed: 'El pedido está cerrado.',
  missing_vehicle_catalog: 'Falta el vehículo: no tiene modelo de catálogo ni vehículo escrito.',
  missing_location: 'El pedido no tiene ubicación.',
  not_classified: 'El pedido no tiene rubros clasificados.',
  empty_description: 'La descripción está vacía.',
  description_has_pii: 'La descripción tiene datos personales.',
  no_free_slots: 'No quedan lugares libres (como mucho 3 talleres por pedido).',
  no_candidates: 'No hay talleres candidatos a 5 km o menos que cubran el rubro principal.',
}
export const readinessReasonLabel = (r: string) => label(READINESS_REASON_LABELS, r)

/** Qué se puede arreglar desde esta misma ficha, para que el aviso diga cómo. */
export const READINESS_REASON_HINTS: Record<string, string> = {
  // Desde la 0160 del backend (migración 032 acá) el despacho acepta el vehículo
  // escrito como label: el bloqueo salta sólo si no hay catálogo NI descripción.
  missing_vehicle_catalog: 'Completá uno de los dos: cargá la patente y tocá «Identificar vehículo» (tarjeta Vehículo), o escribí el vehículo en «Editar datos».',
  missing_location: 'Cargá la ubicación con «Corregir ubicación» y, si no está ubicada, «Geocodificar» (tarjeta Pedido).',
  not_classified: 'Elegí los rubros en «Talleres candidatos» y guardá la clasificación.',
  empty_description: 'Completá la descripción en «Editar datos».',
}

export const DISTANCE_BUCKET_LABELS: Record<string, string> = {
  under_1_km: 'a menos de 1 km',
  '1_to_3_km': 'a 1–3 km',
  '3_to_5_km': 'a 3–5 km',
  '5_to_10_km': 'a 5–10 km',
  over_10_km: 'a más de 10 km',
}
export const distanceBucketLabel = (b: string) => label(DISTANCE_BUCKET_LABELS, b)

export const EXCLUSION_REASON_LABELS: Record<string, string> = {
  invalid_whatsapp: 'sin WhatsApp válido en su ficha',
  opted_out: 'pidió no recibir pedidos',
  already_contacted: 'ya fue contactado para este pedido',
}
export const exclusionReasonLabel = (r: string) => label(EXCLUSION_REASON_LABELS, r)

export const PII_KIND_LABELS: Record<string, string> = {
  phone: 'teléfono',
  email: 'email',
  plate: 'patente',
  dni: 'DNI',
}
export const piiKindLabel = (k: string) => label(PII_KIND_LABELS, k)

export const OUTREACH_STATUS_LABELS: Record<string, string> = {
  approved: 'Aprobado, por enviar',
  template_sent: 'Mensaje enviado',
  interested: 'Le interesa',
  details_sent: 'Detalles enviados',
  declined: 'No le interesa',
  expired: 'Vencido sin respuesta',
  failed: 'Falló el envío',
  cancelled: 'Cancelado',
}
export const outreachStatusLabel = (s: string) => label(OUTREACH_STATUS_LABELS, s)

export type OutreachTone = 'success' | 'warn' | 'danger' | 'neutral'
export function outreachStatusTone(s: string): OutreachTone {
  switch (s) {
    case 'interested':
    case 'details_sent':
      return 'success'
    case 'approved':
    case 'template_sent':
    case 'expired':
      return 'warn'
    case 'failed':
    case 'declined':
      return 'danger'
    default:
      return 'neutral'
  }
}

export const DELIVERY_STATUS_LABELS: Record<string, string> = {
  sending: 'enviando',
  queued: 'en cola',
  sent: 'enviado',
  delivered: 'entregado',
  read: 'leído',
  failed: 'falló',
  undelivered: 'no entregado',
}
export const deliveryStatusLabel = (s: string) => label(DELIVERY_STATUS_LABELS, s)

export const FAILURE_REASON_LABELS: Record<string, string> = {
  provider_rejected: 'el proveedor de WhatsApp lo rechazó',
  send_outcome_unknown: 'no se sabe si salió (el envío no confirmó)',
  outside_session_window: 'fuera de la ventana de 24 h de WhatsApp',
  delivery_failed: 'no se pudo entregar',
}
export const failureReasonLabel = (r: string) => label(FAILURE_REASON_LABELS, r)

export const MESSAGE_KIND_LABELS: Record<string, string> = {
  template: 'primer contacto',
  session: 'detalles',
  button: 'botón',
  text: 'texto',
}
export const messageKindLabel = (k: string) => label(MESSAGE_KIND_LABELS, k)

export const MESSAGE_DIRECTION_LABELS: Record<string, string> = {
  outbound: 'AutoLibre',
  inbound: 'Taller',
}
export const messageDirectionLabel = (d: string) => label(MESSAGE_DIRECTION_LABELS, d)

// ── Errores ─────────────────────────────────────────────────────────────────

export interface PartnerDispatchError {
  status: number
  /** `''` cuando no hay code (un 400 del ValidationPipe, un 404 de ruta inexistente). */
  code: string
  reasons: Array<string>
  partnerIds: Array<string>
  freeSlots: number | null
  message: string
}

/**
 * Lee `PARTNER_DISPATCH_ERROR:<json>`. El JSON va entero después del prefijo,
 * así que el mensaje puede traer cualquier cosa. `null` si no es ese formato.
 */
export function parsePartnerDispatchError(cause: unknown): PartnerDispatchError | null {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const at = raw.indexOf(`${PARTNER_DISPATCH_ERROR}:`)
  if (at === -1) return null
  try {
    const v = JSON.parse(raw.slice(at + PARTNER_DISPATCH_ERROR.length + 1)) as Record<string, unknown>
    const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])
    return {
      status: typeof v.status === 'number' ? v.status : 0,
      code: typeof v.code === 'string' ? v.code : '',
      reasons: strings(v.reasons),
      partnerIds: strings(v.partnerIds),
      freeSlots: typeof v.freeSlots === 'number' ? v.freeSlots : null,
      message: typeof v.message === 'string' ? v.message : '',
    }
  } catch {
    return null
  }
}

export interface ReadableDispatchError {
  text: string
  /** El kill switch: se muestra NEUTRO, no en rojo. No es un error de nadie. */
  disabled: boolean
  /** El borrador quedó viejo: estos partners ya no son candidatos. */
  staleIds: Array<string>
}

/** Traduce cualquier error de la lectura o de la aprobación. Client-safe. */
export function readablePartnerDispatchError(cause: unknown): ReadableDispatchError {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const plain = (text: string): ReadableDispatchError => ({ text, disabled: false, staleIds: [] })

  if (raw.includes(PARTNER_DISPATCH_UNAVAILABLE))
    return plain('Esta base no tiene la migración 0142 del backend (partner_outreach): falta desplegar el despacho. No se envió nada.')
  if (raw.includes(PARTNER_DISPATCH_BAD_RESPONSE))
    return plain('El backend contestó con una forma que el panel no reconoce. Puede ser una versión distinta del despacho: recargá, y si sigue, avisá.')
  if (raw.startsWith('BACKEND_UNREACHABLE:'))
    return plain(
      `No pudimos hablar con el backend (${raw.slice('BACKEND_UNREACHABLE:'.length)}). Revisá AUTOLIBRE_BACKEND_URL o que el backend esté levantado. No se envió nada.`,
    )
  if (raw === 'UNAUTHENTICATED') return plain('Tu sesión expiró. Cerrá sesión y volvé a entrar.')
  if (raw === 'FORBIDDEN') return plain('Tu rol no tiene permiso para esta acción.')

  const e = parsePartnerDispatchError(cause)
  if (!e) {
    if (/timeout|timed out|aborted/i.test(raw))
      return plain('El backend tardó demasiado en contestar. Puede que se haya aprobado igual: tocá «Actualizar» antes de reintentar (reintentar el mismo despacho no lo duplica).')
    return plain('No pudimos completar la acción. Tocá «Actualizar» para ver qué quedó.')
  }

  switch (e.code) {
    case 'FEATURE_DISABLED':
      return {
        text: 'El despacho automático está desactivado en el backend (PARTNER_DISPATCH_ENABLED). No se envió nada; mientras tanto, derivá a mano desde «Talleres candidatos».',
        disabled: true,
        staleIds: [],
      }
    case 'INVALID_STATE_TRANSITION':
      return plain('El pedido está cerrado: no se puede despachar. Tocá «Actualizar».')
    case 'DISPATCH_NOT_READY':
      return plain(
        `Al pedido le falta algo para despachar${e.reasons.length > 0 ? `: ${e.reasons.map(readinessReasonLabel).join(' ')}` : '.'} No se envió nada.`,
      )
    case 'PARTNER_NOT_ELIGIBLE':
      return {
        text: 'Algunos talleres elegidos ya no son candidatos (el borrador quedó viejo: alguien los contactó, cambió su WhatsApp o se movió el pedido). Tocá «Actualizar» y volvé a elegir. No se envió nada.',
        disabled: false,
        staleIds: e.partnerIds,
      }
    case 'NO_FREE_SLOTS':
      return plain(
        `No quedan lugares suficientes${e.freeSlots !== null ? ` (quedan ${e.freeSlots})` : ''}: otra aprobación los tomó mientras tanto. Tocá «Actualizar». No se envió nada.`,
      )
    case 'DISPATCH_ID_CONFLICT':
      return plain('Ese despacho ya se usó con otros talleres. Cambiá la selección o volvé a aprobar: el panel arma un despacho nuevo.')
    case 'NOT_FOUND':
      return plain('Este pedido ya no existe. Recargá la pantalla.')
    case 'FORBIDDEN':
      return plain('Tu usuario no es admin para el backend.')
  }

  if (e.status === 404 && e.message.startsWith('Cannot '))
    return plain('El backend desplegado todavía no tiene el despacho (migración 0142). No se envió nada.')
  if (e.status === 401) return plain('Tu sesión expiró para el backend. Cerrá sesión y volvé a entrar.')
  if (e.status === 403) return plain('Tu usuario no es admin para el backend.')
  if (e.status === 404) return plain(`No se encontró: «${e.message}». Recargá la pantalla.`)
  if (e.status === 400) return plain(`El backend rechazó el pedido: «${e.message}».`)
  return plain(`El backend contestó ${e.status}: «${e.message}».`)
}
