import { z } from 'zod'

/**
 * Bandeja de WhatsApp (`/whatsapp`) — client-safe: tipos, schemas de las
 * respuestas del backend, etiquetas, la ventana de 24 h y la traducción de
 * errores. → `.claude/plans/whatsapp-inbox.md`
 *
 * Contrato CONGELADO con el backend el 2026-11-06 (`/api/v1/admin/whatsapp`,
 * fase 1). Si cambia, se toca ACÁ, en `~/server/backend` y en el mock
 * (`~/mocks/whatsapp-inbox`), y en ningún otro lado.
 *
 * Los enums que el backend puede ampliar se aceptan como `string`: un valor
 * que el espejo no conoce se muestra CRUDO, nunca rompe la validación.
 *
 * ⚠ PII: `phone` es el número COMPLETO de una persona o un taller. Nunca a un
 * `console.*`, a una URL, a un search param ni a analytics. La URL del hilo
 * lleva el UUID de la conversación.
 */

export const WHATSAPP_TEXT_MAX_LENGTH = 4096

/** Sentinelas propias. Las arma `backendError(..., { whatsapp: true })` y el mock. */
export const WHATSAPP_INBOX_ERROR = 'WHATSAPP_INBOX_ERROR'
export const WHATSAPP_INBOX_BAD_RESPONSE = 'WHATSAPP_INBOX_BAD_RESPONSE'

// ── Respuestas (contrato congelado) ─────────────────────────────────────────

const partnerRefSchema = z.object({ id: z.string(), name: z.string() })
const sentBySchema = z.object({ userId: z.string(), name: z.string().nullable() })

export const whatsappMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  clientMessageId: z.string().nullable(),
  direction: z.enum(['inbound', 'outbound']),
  /** `text` | `template` | `button_reply` | `unsupported_media` | `unavailable` (cuerpo purgado). */
  kind: z.string(),
  text: z.string().nullable(),
  /** Una referencia desconocida llega como `name: 'unregistered'`. */
  template: z
    .object({
      name: z.string(),
      label: z.string(),
      variables: z.record(z.string(), z.string()),
    })
    .nullable(),
  buttonTitle: z.string().nullable(),
  /** `pending` | `sent` | `delivered` | `read` | `failed` | `undelivered` | `unknown`; `null` en un entrante. */
  status: z.string().nullable(),
  /** Texto fijo del backend, nunca el del proveedor. */
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** `null` = entrante o automático. `name: null` = usuario borrado. */
  sentBy: sentBySchema.nullable(),
  createdAt: z.string(),
  statusUpdatedAt: z.string().nullable(),
})
export type WhatsAppMessage = z.infer<typeof whatsappMessageSchema>

export const whatsappConversationSchema = z.object({
  id: z.string(),
  /** ⚠ PII — ver la cabecera. E.164 (`+549…`). */
  phone: z.string(),
  /** Vacío si el número no es de ningún partner; varios si es de sucursales. */
  partners: z.array(partnerRefSchema),
  optedOutAt: z.string().nullable(),
  /** `open` | `window_closed` | `opted_out` | `no_inbound_yet`. */
  replyState: z.string(),
  sessionWindowExpiresAt: z.string().nullable(),
  lastMessageAt: z.string(),
  lastInboundAt: z.string().nullable(),
  unread: z.boolean(),
  /** 0..100, topeado por el backend. */
  unreadCount: z.number().int(),
  lastReadAt: z.string().nullable(),
  lastReadMessageId: z.string().nullable(),
  lastReadBy: sentBySchema.nullable(),
  lastMessage: z
    .object({
      id: z.string(),
      direction: z.enum(['inbound', 'outbound']),
      createdAt: z.string(),
      /** ~80 caracteres, espacios colapsados. Template → su etiqueta; botón → su título. */
      preview: z.object({ kind: z.string(), text: z.string().nullable(), truncated: z.boolean() }),
    })
    .nullable(),
  updatedAt: z.string(),
})
export type WhatsAppConversation = z.infer<typeof whatsappConversationSchema>

/** 1 · `GET /conversations` — `lastMessageAt` desc. */
export const conversationPageSchema = z.object({
  items: z.array(whatsappConversationSchema),
  nextCursor: z.string().nullable(),
  /** Desde dónde arrancar el sondeo de cambios. */
  changesAfter: z.string(),
  unreadConversations: z.number().int(),
  serverNow: z.string(),
})
export type ConversationPage = z.infer<typeof conversationPageSchema>

/** 2 · `GET /conversations/changes` — también se mueve cuando cambia el estado de un saliente viejo. */
export const conversationChangesSchema = z.object({
  items: z.array(whatsappConversationSchema),
  /** Siempre presente, aunque no haya filas. */
  nextAfter: z.string(),
  hasMore: z.boolean(),
  unreadConversations: z.number().int(),
  serverNow: z.string(),
})
export type ConversationChanges = z.infer<typeof conversationChangesSchema>

/** 3 · `GET /conversations/by-partner/:partnerId` — 0..n (sucursales que comparten número, o ninguna). */
export const partnerConversationsSchema = z.object({
  items: z.array(whatsappConversationSchema),
  serverNow: z.string(),
})
export type PartnerConversations = z.infer<typeof partnerConversationsSchema>

/** 4 · `GET /conversations/:id/messages` — los N más NUEVOS, ascendente; `nextCursor` camina hacia ATRÁS. */
export const threadPageSchema = z.object({
  conversation: whatsappConversationSchema,
  items: z.array(whatsappMessageSchema),
  nextCursor: z.string().nullable(),
  changesAfter: z.string(),
  serverNow: z.string(),
})
export type ThreadPage = z.infer<typeof threadPageSchema>

/** 5 · `GET /conversations/:id/messages/changes` — nuevos + salientes que cambiaron de estado. NO trae la conversación. */
export const messageChangesSchema = z.object({
  items: z.array(whatsappMessageSchema),
  nextAfter: z.string(),
  hasMore: z.boolean(),
  serverNow: z.string(),
})
export type MessageChanges = z.infer<typeof messageChangesSchema>

/** 6 · `PUT /conversations/:id/read` — sólo avanza: un id más viejo no hace nada. */
export const readResultSchema = z.object({ conversation: whatsappConversationSchema, serverNow: z.string() })
export type ReadResult = z.infer<typeof readResultSchema>

/** 7 · `POST /conversations/:id/messages` — el mensaje esparcido + el resultado. Un rechazo del proveedor es 201 `failed`. */
export const sendResultSchema = whatsappMessageSchema.extend({
  outcome: z.string(),
  failureReason: z.string().nullable(),
  serverNow: z.string(),
})
/** `replayed` = el backend contestó 200: ese `clientMessageId` ya se había mandado. */
export type SendResult = z.infer<typeof sendResultSchema> & { replayed: boolean }

// ── Entradas de los server functions ────────────────────────────────────────

export const listConversationsInputSchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})
export const conversationChangesInputSchema = z.object({ after: z.string().min(1).max(512) })
export const partnerConversationsInputSchema = z.object({ partnerId: z.uuid() })
export const threadInputSchema = z.object({
  conversationId: z.uuid(),
  cursor: z.string().max(512).optional(),
})
export const messageChangesInputSchema = z.object({
  conversationId: z.uuid(),
  after: z.string().min(1).max(512),
})
/** Del lado del panel se llama `text`; al backend viaja como `body`. */
export const sendMessageInputSchema = z.object({
  conversationId: z.uuid(),
  clientMessageId: z.uuid(),
  text: z
    .string()
    .refine((t) => t.trim().length > 0, 'El mensaje está vacío')
    .refine((t) => t.length <= WHATSAPP_TEXT_MAX_LENGTH, `Máximo ${WHATSAPP_TEXT_MAX_LENGTH} caracteres`),
})
export const markReadInputSchema = z.object({
  conversationId: z.uuid(),
  readUpToMessageId: z.uuid(),
})

// ── Errores ─────────────────────────────────────────────────────────────────

export interface WhatsAppInboxErrorDetail {
  status: number
  code: string
  message: string
  /** Los campos del 422: el estado actualizado, para trabar el composer sin esperar al sondeo. */
  sessionWindowExpiresAt: string | null
  replyState: string | null
}

export function whatsappInboxErrorMessage(detail: WhatsAppInboxErrorDetail): string {
  return `${WHATSAPP_INBOX_ERROR}:${JSON.stringify(detail)}`
}

export function parseWhatsAppInboxError(raw: string): WhatsAppInboxErrorDetail | null {
  if (!raw.startsWith(`${WHATSAPP_INBOX_ERROR}:`)) return null
  try {
    const parsed = JSON.parse(raw.slice(WHATSAPP_INBOX_ERROR.length + 1)) as Partial<WhatsAppInboxErrorDetail>
    return {
      status: typeof parsed.status === 'number' ? parsed.status : 0,
      code: typeof parsed.code === 'string' ? parsed.code : '',
      message: typeof parsed.message === 'string' ? parsed.message : '',
      sessionWindowExpiresAt: typeof parsed.sessionWindowExpiresAt === 'string' ? parsed.sessionWindowExpiresAt : null,
      replyState: typeof parsed.replyState === 'string' ? parsed.replyState : null,
    }
  } catch {
    return null
  }
}

export type SendFailureKind =
  /** Reintentar con el MISMO `clientMessageId`: red, timeout, 429, 503. */
  | 'retryable'
  /** No se reintenta: la burbuja queda fallida con el motivo. */
  | 'final'

export function classifySendError(raw: string): { kind: SendFailureKind; text: string; detail: WhatsAppInboxErrorDetail | null } {
  const detail = parseWhatsAppInboxError(raw)
  if (!detail) {
    if (raw.startsWith('BACKEND_UNREACHABLE:')) return { kind: 'retryable', text: 'No se pudo contactar al backend.', detail }
    // Timeout, red caída, error del server function: no sabemos si llegó.
    return { kind: 'retryable', text: 'No se pudo confirmar el envío.', detail }
  }
  switch (detail.code) {
    case 'OUTSIDE_SESSION_WINDOW':
      return { kind: 'final', text: 'La ventana de 24 h se cerró antes de enviar.', detail }
    case 'RECIPIENT_OPTED_OUT':
      return { kind: 'final', text: 'Este contacto pidió no ser contactado.', detail }
    case 'CLIENT_MESSAGE_ID_CONFLICT':
      return { kind: 'final', text: 'Este envío ya se usó con otro texto. Escribilo de nuevo.', detail }
  }
  if (detail.status === 404) return { kind: 'final', text: 'La conversación ya no existe.', detail }
  if (detail.status === 429) return { kind: 'retryable', text: 'Demasiados pedidos al backend; esperá unos segundos.', detail }
  if (detail.status >= 500 || detail.status === 0) {
    return { kind: 'retryable', text: 'El proveedor de WhatsApp no responde.', detail }
  }
  return { kind: 'final', text: readableWhatsAppInboxError(raw), detail }
}

export function readableWhatsAppInboxError(raw: string): string {
  if (raw === WHATSAPP_INBOX_BAD_RESPONSE) return 'El backend respondió con una forma que el panel no conoce.'
  if (raw.startsWith('BACKEND_UNREACHABLE:')) {
    return 'No se pudo contactar al backend. En desarrollo, revisá AUTOLIBRE_BACKEND_URL.'
  }
  if (raw === 'UNAUTHENTICATED') return 'Tu sesión venció. Volvé a entrar.'
  if (raw === 'FORBIDDEN') return 'Tu usuario no es admin.'
  const detail = parseWhatsAppInboxError(raw)
  if (!detail) return raw
  if (detail.status === 401) return 'El backend no reconoció tu sesión. Cerrá sesión y volvé a entrar.'
  if (detail.status === 403) return 'Tu usuario no es admin en el backend.'
  if (detail.status === 404 && !detail.code) return 'El backend desplegado todavía no tiene la bandeja de WhatsApp.'
  if (detail.status === 404) return 'Esa conversación no existe.'
  if (detail.status === 429) return 'El backend está limitando pedidos; la bandeja se actualiza más despacio.'
  if (detail.code === 'INVALID_CURSOR') return 'La lista quedó desactualizada; se recarga sola.'
  return detail.message || `Error ${detail.status}`
}

// ── Presentación ────────────────────────────────────────────────────────────

/** Título de una fila: los partners, o el número si no es de ninguno. */
export function conversationTitle(c: Pick<WhatsAppConversation, 'partners' | 'phone'>): string {
  if (c.partners.length === 0) return formatPhone(c.phone)
  return c.partners.map((p) => p.name).join(' · ')
}

/** `+5491125120472` → `+54 9 11 2512-0472`. Sólo para mostrar; nunca va a una URL. */
export function formatPhone(e164: string): string {
  const m = /^\+549(\d{2})(\d{4})(\d{4})$/.exec(e164)
  return m ? `+54 9 ${m[1]} ${m[2]}-${m[3]}` : e164
}

export function lastMessagePreview(last: WhatsAppConversation['lastMessage']): string {
  if (!last) return 'Sin mensajes'
  const { kind, text, truncated } = last.preview
  const t = text ? `${text}${truncated ? '…' : ''}` : null
  switch (kind) {
    case 'template':
      return t ? `Plantilla: ${t}` : 'Plantilla enviada'
    case 'unsupported_media':
      return 'Adjunto no soportado'
    case 'unavailable':
      return 'Mensaje no disponible'
    case 'button_reply':
      return t ? `Respondió «${t}»` : 'Respondió con un botón'
    default:
      return t ?? ''
  }
}

export const MESSAGE_STATUS_LABELS: Record<string, string> = {
  pending: 'Enviando',
  sent: 'Enviado',
  delivered: 'Entregado',
  read: 'Leído',
  failed: 'Falló',
  undelivered: 'No entregado',
  unknown: 'No sabemos si salió',
}

export const REPLY_STATE_LABELS: Record<string, string> = {
  open: 'Ventana abierta',
  window_closed: 'Ventana cerrada',
  opted_out: 'Pidió no ser contactado',
  no_inbound_yet: 'Nunca escribió',
}

/**
 * Lo que el composer puede hacer AHORA. El backend manda `replyState`, pero la
 * ventana vence con el reloj: si dice `open` y `sessionWindowExpiresAt` ya pasó
 * (con el desfase contra `serverNow`), se trata como cerrada sin esperar al
 * próximo sondeo. Nunca al revés: el cliente no ABRE una ventana.
 */
export function effectiveReplyState(
  c: Pick<WhatsAppConversation, 'replyState' | 'sessionWindowExpiresAt'>,
  nowMs: number,
): string {
  if (c.replyState !== 'open') return c.replyState
  if (!c.sessionWindowExpiresAt) return 'window_closed'
  return Date.parse(c.sessionWindowExpiresAt) > nowMs ? 'open' : 'window_closed'
}

/** "3 h 12 min", "45 min", "menos de 1 min". */
export function formatWindowLeft(expiresAt: string, nowMs: number): string {
  const ms = Date.parse(expiresAt) - nowMs
  if (ms <= 60_000) return 'menos de 1 min'
  const totalMin = Math.floor(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const min = totalMin % 60
  return h > 0 ? `${h} h ${min} min` : `${min} min`
}

/** Orden estable de mensajes: `createdAt` y, a igualdad, `id`. */
export function compareMessages(a: Pick<WhatsAppMessage, 'createdAt' | 'id'>, b: Pick<WhatsAppMessage, 'createdAt' | 'id'>) {
  return a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.createdAt < b.createdAt ? -1 : 1
}

/** Orden de la lista: `lastMessageAt` desc, como el backend. */
export function compareConversations(a: WhatsAppConversation, b: WhatsAppConversation) {
  return a.lastMessageAt === b.lastMessageAt ? (a.id < b.id ? -1 : 1) : a.lastMessageAt < b.lastMessageAt ? 1 : -1
}
