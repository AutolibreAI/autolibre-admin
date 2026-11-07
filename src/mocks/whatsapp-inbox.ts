/**
 * ⚠ MOCK — la bandeja de WhatsApp del backend (`/api/v1/admin/whatsapp/…`)
 * todavía no está desplegada. Es el ÚNICO lugar con datos de ejemplo de
 * `/whatsapp`; la UI pasa igual por los server functions reales
 * (`~/fn/whatsapp-inbox`), que eligen este módulo sólo en desarrollo
 * (`WHATSAPP_INBOX_MOCK`, ver ahí).
 *
 * Reemplaza a: los 7 endpoints del contrato congelado el 2026-11-06, con las
 * formas de `~/lib/whatsapp-inbox`. Cuando el backend esté desplegado, se
 * borra este archivo y el `if` del server function.
 *
 * Regla dura 8: todo es inventado y se nota — los talleres se llaman «… de
 * ejemplo», los números son `+54 9 11 0000-000x`. Nada sale de la base.
 *
 * Es STATEFUL, en memoria del proceso de `pnpm dev` (en `globalThis`, para
 * sobrevivir al HMR): mandar, marcar leído y los estados de entrega cambian de
 * verdad entre sondeos. Para probar los caminos raros, el texto manda:
 *   - `/503`     → 503 SERVICE_UNAVAILABLE (no se guarda: reintentar con el mismo id)
 *   - `/fail`    → 201 con outcome `failed`
 *   - `/unknown` → 201 con outcome `unknown`
 * Y cada ~60 s entra un mensaje nuevo en la primera conversación.
 */
import {
  whatsappInboxErrorMessage,
  type ConversationChanges,
  type ConversationPage,
  type MessageChanges,
  type PartnerConversations,
  type ReadResult,
  type SendResult,
  type ThreadPage,
  type WhatsAppConversation,
  type WhatsAppMessage,
} from '~/lib/whatsapp-inbox'

interface Actor {
  id: string
  name: string
}

interface ConvRecord {
  id: string
  phone: string
  partners: Array<{ id: string; name: string }>
  lastReadMessageId: string | null
  lastReadAt: string | null
  lastReadBy: { userId: string; name: string | null } | null
  optedOutAt: string | null
  version: number
  touchedAt: string
}

type MsgRecord = WhatsAppMessage & { version: number }

interface Store {
  version: number
  conversations: Map<string, ConvRecord>
  messages: Map<string, MsgRecord>
  nextInboundAt: number
}

const DAY = 86_400_000
const MIN = 60_000
const INBOUND_EVERY_MS = 60_000
const MOCK_ADMIN = { userId: '00000000-0000-4000-8000-000000000001', name: 'Admin de ejemplo' }

const iso = (ms: number) => new Date(ms).toISOString()

function seed(): Store {
  const now = Date.now()
  const store: Store = { version: 0, conversations: new Map(), messages: new Map(), nextInboundAt: now + 40_000 }
  const bump = () => ++store.version

  const conv = (c: Pick<ConvRecord, 'phone' | 'partners' | 'optedOutAt'>): ConvRecord => {
    const r: ConvRecord = {
      id: crypto.randomUUID(),
      ...c,
      lastReadMessageId: null,
      lastReadAt: null,
      lastReadBy: null,
      version: bump(),
      touchedAt: iso(now),
    }
    store.conversations.set(r.id, r)
    return r
  }
  const msg = (
    c: ConvRecord,
    agoMs: number,
    m: Partial<WhatsAppMessage> & Pick<WhatsAppMessage, 'direction' | 'kind'>,
  ): MsgRecord => {
    const r: MsgRecord = {
      id: crypto.randomUUID(),
      conversationId: c.id,
      clientMessageId: null,
      text: null,
      template: null,
      buttonTitle: null,
      status: m.direction === 'outbound' ? 'read' : null,
      error: null,
      sentBy: null,
      createdAt: iso(now - agoMs),
      statusUpdatedAt: m.direction === 'outbound' ? iso(now - agoMs + MIN) : null,
      ...m,
      version: bump(),
    }
    store.messages.set(r.id, r)
    return r
  }
  const markRead = (c: ConvRecord, m: MsgRecord) => {
    c.lastReadMessageId = m.id
    c.lastReadAt = m.createdAt
    c.lastReadBy = MOCK_ADMIN
  }
  const pid = () => crypto.randomUUID()

  // 1 · Partner, ventana abierta, no leída. Un despacho entero.
  const a = conv({ phone: '+5491100000001', partners: [{ id: pid(), name: 'Taller de ejemplo Norte' }], optedOutAt: null })
  msg(a, 3 * DAY, {
    direction: 'outbound',
    kind: 'template',
    template: { name: 'partner_dispatch_v1', label: 'Pedido de cotización', variables: { rubro: 'Frenos', zona: 'Vicente López' } },
  })
  msg(a, 3 * DAY - 20 * MIN, { direction: 'inbound', kind: 'button_reply', buttonTitle: 'Sí, me interesa' })
  const aDetails = msg(a, 3 * DAY - 19 * MIN, {
    direction: 'outbound',
    kind: 'template',
    template: { name: 'partner_dispatch_details_v1', label: 'Detalles del pedido', variables: { codigo: 'AL-1001' } },
  })
  markRead(a, aDetails)
  msg(a, 120 * MIN, { direction: 'inbound', kind: 'text', text: 'Buenas, ¿el auto lo traen ellos o lo buscamos?' })
  msg(a, 90 * MIN, { direction: 'inbound', kind: 'unsupported_media' })
  msg(a, 85 * MIN, { direction: 'inbound', kind: 'text', text: 'Les mandé una foto del presupuesto, ¿les llegó?' })

  // 2 · Número sin partner, ventana cerrada, leída. Un cuerpo purgado.
  const b = conv({ phone: '+5491100000002', partners: [], optedOutAt: null })
  msg(b, 5 * DAY, { direction: 'inbound', kind: 'unavailable' })
  msg(b, 2 * DAY, { direction: 'inbound', kind: 'text', text: 'Hola, ¿esto es AutoLibre? Quería consultar por un service.' })
  markRead(
    b,
    msg(b, 2 * DAY - 10 * MIN, {
      direction: 'outbound',
      kind: 'text',
      text: 'Hola! Sí, contame qué auto tenés y te paso opciones.',
      sentBy: MOCK_ADMIN,
    }),
  )

  // 3 · Partner que pidió la baja.
  const c = conv({
    phone: '+5491100000003',
    partners: [{ id: pid(), name: 'Taller de ejemplo Sur' }],
    optedOutAt: iso(now - 6 * 60 * MIN),
  })
  msg(c, 7 * 60 * MIN, {
    direction: 'outbound',
    kind: 'template',
    template: { name: 'partner_dispatch_v1', label: 'Pedido de cotización', variables: { rubro: 'Motor', zona: 'Lanús' } },
  })
  msg(c, 6 * 60 * MIN, { direction: 'inbound', kind: 'text', text: 'BAJA' })
  markRead(
    c,
    msg(c, 6 * 60 * MIN - MIN, {
      direction: 'outbound',
      kind: 'template',
      template: { name: 'unregistered', label: 'Plantilla sin registrar', variables: {} },
    }),
  )

  // 4 · Dos sucursales con el mismo número, ventana abierta, un saliente fallido y uno "unknown".
  const d = conv({
    phone: '+5491100000004',
    partners: [
      { id: pid(), name: 'Gomería de ejemplo (Centro)' },
      { id: pid(), name: 'Gomería de ejemplo (Oeste)' },
    ],
    optedOutAt: null,
  })
  msg(d, 4 * 60 * MIN, { direction: 'inbound', kind: 'text', text: '¿Tienen algún pedido de cubiertas para esta semana?' })
  msg(d, 3 * 60 * MIN, {
    direction: 'outbound',
    kind: 'text',
    text: 'Por ahora no, te avisamos apenas entre uno.',
    status: 'failed',
    error: { code: 'PROVIDER_REJECTED', message: 'WhatsApp rechazó el mensaje.' },
    sentBy: MOCK_ADMIN,
  })
  markRead(
    d,
    msg(d, 2 * 60 * MIN, {
      direction: 'outbound',
      kind: 'text',
      text: 'Por ahora no, te avisamos apenas entre uno.',
      status: 'unknown',
      sentBy: { userId: '00000000-0000-4000-8000-000000000002', name: null },
    }),
  )

  // 5 · Nunca escribió: sólo un template automático.
  const e = conv({ phone: '+5491100000005', partners: [{ id: pid(), name: 'Taller de ejemplo Oeste' }], optedOutAt: null })
  markRead(
    e,
    msg(e, 26 * 60 * MIN, {
      direction: 'outbound',
      kind: 'template',
      template: { name: 'partner_dispatch_v1', label: 'Pedido de cotización', variables: { rubro: 'Electricidad', zona: 'Morón' } },
      status: 'delivered',
    }),
  )

  return store
}

const g = globalThis as typeof globalThis & { __whatsappInboxMock?: Store }
function store(): Store {
  g.__whatsappInboxMock ??= seed()
  return g.__whatsappInboxMock
}

// ── Derivados ───────────────────────────────────────────────────────────────

const byOrder = (x: MsgRecord, y: MsgRecord) =>
  x.createdAt === y.createdAt ? (x.id < y.id ? -1 : 1) : x.createdAt < y.createdAt ? -1 : 1

function messagesOf(s: Store, conversationId: string): Array<MsgRecord> {
  return [...s.messages.values()].filter((m) => m.conversationId === conversationId).sort(byOrder)
}

function strip(m: MsgRecord): WhatsAppMessage {
  const { version: _v, ...rest } = m
  return rest
}

function previewOf(m: MsgRecord): { kind: string; text: string | null; truncated: boolean } {
  const raw = m.kind === 'template' ? (m.template?.label ?? null) : m.kind === 'button_reply' ? m.buttonTitle : m.text
  if (!raw || m.kind === 'unsupported_media' || m.kind === 'unavailable') return { kind: m.kind, text: null, truncated: false }
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  return { kind: m.kind, text: collapsed.slice(0, 80), truncated: collapsed.length > 80 }
}

function derive(s: Store, c: ConvRecord, now: number): WhatsAppConversation {
  const msgs = messagesOf(s, c.id)
  const last = msgs.at(-1) ?? null
  const inbound = msgs.filter((m) => m.direction === 'inbound')
  const lastInbound = inbound.at(-1) ?? null
  const windowExpires = lastInbound ? Date.parse(lastInbound.createdAt) + DAY : null

  const readIdx = c.lastReadMessageId ? msgs.findIndex((m) => m.id === c.lastReadMessageId) : -1
  const unreadInbound = msgs.slice(readIdx + 1).filter((m) => m.direction === 'inbound')

  // Opted out = pidió BAJA y no volvió a escribir desde entonces.
  const optedOut = c.optedOutAt !== null && !inbound.some((m) => m.createdAt > c.optedOutAt!)
  const replyState = optedOut
    ? 'opted_out'
    : !lastInbound
      ? 'no_inbound_yet'
      : windowExpires! > now
        ? 'open'
        : 'window_closed'

  const lastStatusAt = msgs.reduce((acc, m) => (m.statusUpdatedAt && m.statusUpdatedAt > acc ? m.statusUpdatedAt : acc), c.touchedAt)
  return {
    id: c.id,
    phone: c.phone,
    partners: c.partners,
    optedOutAt: c.optedOutAt,
    replyState,
    sessionWindowExpiresAt: windowExpires ? iso(windowExpires) : null,
    lastMessageAt: last?.createdAt ?? c.touchedAt,
    lastInboundAt: lastInbound?.createdAt ?? null,
    unread: unreadInbound.length > 0,
    unreadCount: Math.min(unreadInbound.length, 100),
    lastReadAt: c.lastReadAt,
    lastReadMessageId: c.lastReadMessageId,
    lastReadBy: c.lastReadBy,
    lastMessage: last ? { id: last.id, direction: last.direction, createdAt: last.createdAt, preview: previewOf(last) } : null,
    updatedAt: [last?.createdAt ?? '', lastStatusAt].sort().at(-1)!,
  }
}

function convVersion(s: Store, c: ConvRecord): number {
  return Math.max(c.version, ...messagesOf(s, c.id).map((m) => m.version))
}

/** Lo que pasa "solo" entre sondeos: entregas, lecturas y algún entrante. */
function tick(s: Store) {
  const now = Date.now()
  for (const m of s.messages.values()) {
    if (m.direction !== 'outbound' || !m.statusUpdatedAt) continue
    const age = now - Date.parse(m.statusUpdatedAt)
    const next = m.status === 'sent' && age > 4_000 ? 'delivered' : m.status === 'delivered' && age > 10_000 ? 'read' : null
    if (next) {
      m.status = next
      m.statusUpdatedAt = iso(now)
      m.version = ++s.version
    }
  }
  if (now >= s.nextInboundAt) {
    s.nextInboundAt = now + INBOUND_EVERY_MS
    const first = [...s.conversations.values()][0]
    if (first) {
      const r: MsgRecord = {
        id: crypto.randomUUID(),
        conversationId: first.id,
        clientMessageId: null,
        direction: 'inbound',
        kind: 'text',
        text: `Mensaje de ejemplo entrante (${new Date(now).toISOString().slice(11, 16)} UTC)`,
        template: null,
        buttonTitle: null,
        status: null,
        error: null,
        sentBy: null,
        createdAt: iso(now),
        statusUpdatedAt: null,
        version: ++s.version,
      }
      s.messages.set(r.id, r)
    }
  }
}

function fail(
  status: number,
  code: string,
  message: string,
  extra: { sessionWindowExpiresAt?: string | null; replyState?: string | null } = {},
): never {
  throw new Error(
    whatsappInboxErrorMessage({
      status,
      code,
      message,
      sessionWindowExpiresAt: extra.sessionWindowExpiresAt ?? null,
      replyState: extra.replyState ?? null,
    }),
  )
}

function parseCursor(raw: string): number {
  if (!/^\d+$/.test(raw)) fail(400, 'INVALID_CURSOR', 'Invalid cursor')
  return Number(raw)
}

function getConv(s: Store, id: string): ConvRecord {
  const c = s.conversations.get(id)
  if (!c) fail(404, 'NOT_FOUND', 'Conversation not found')
  return c
}

const delay = () => new Promise((r) => setTimeout(r, 150 + Math.random() * 250))

function sortedConversations(s: Store, now: number) {
  return [...s.conversations.values()]
    .map((c) => derive(s, c, now))
    .sort((x, y) => (x.lastMessageAt === y.lastMessageAt ? (x.id < y.id ? -1 : 1) : x.lastMessageAt < y.lastMessageAt ? 1 : -1))
}

// ── Los "endpoints" ─────────────────────────────────────────────────────────

/** 1 */
export async function mockListConversations(input: { cursor?: string; limit?: number }): Promise<ConversationPage> {
  await delay()
  const s = store()
  tick(s)
  const now = Date.now()
  const all = sortedConversations(s, now)
  const offset = input.cursor ? parseCursor(input.cursor) : 0
  const limit = input.limit ?? 50
  return {
    items: all.slice(offset, offset + limit),
    nextCursor: offset + limit < all.length ? String(offset + limit) : null,
    changesAfter: String(s.version),
    unreadConversations: all.filter((c) => c.unread).length,
    serverNow: iso(now),
  }
}

/** 2 */
export async function mockConversationChanges(input: { after: string }): Promise<ConversationChanges> {
  await delay()
  const s = store()
  const after = parseCursor(input.after)
  tick(s)
  const now = Date.now()
  const all = [...s.conversations.values()]
  return {
    items: all.filter((c) => convVersion(s, c) > after).map((c) => derive(s, c, now)),
    nextAfter: String(s.version),
    hasMore: false,
    unreadConversations: all.map((c) => derive(s, c, now)).filter((c) => c.unread).length,
    serverNow: iso(now),
  }
}

/** 3 */
export async function mockConversationsByPartner(input: { partnerId: string }): Promise<PartnerConversations> {
  await delay()
  const s = store()
  const now = Date.now()
  return {
    items: [...s.conversations.values()].filter((c) => c.partners.some((p) => p.id === input.partnerId)).map((c) => derive(s, c, now)),
    serverNow: iso(now),
  }
}

const THREAD_PAGE = 50

/** 4 */
export async function mockThread(input: { conversationId: string; cursor?: string }): Promise<ThreadPage> {
  await delay()
  const s = store()
  tick(s)
  const c = getConv(s, input.conversationId)
  const msgs = messagesOf(s, c.id)
  const end = input.cursor ? parseCursor(input.cursor) : msgs.length
  const start = Math.max(0, end - THREAD_PAGE)
  const now = Date.now()
  return {
    conversation: derive(s, c, now),
    items: msgs.slice(start, end).map(strip),
    nextCursor: start > 0 ? String(start) : null,
    changesAfter: String(s.version),
    serverNow: iso(now),
  }
}

/** 5 */
export async function mockMessageChanges(input: { conversationId: string; after: string }): Promise<MessageChanges> {
  await delay()
  const s = store()
  const after = parseCursor(input.after)
  tick(s)
  const c = getConv(s, input.conversationId)
  return {
    items: messagesOf(s, c.id)
      .filter((m) => m.version > after)
      .map(strip),
    nextAfter: String(s.version),
    hasMore: false,
    serverNow: iso(Date.now()),
  }
}

/** 6 */
export async function mockMarkRead(input: { conversationId: string; readUpToMessageId: string }, actor: Actor): Promise<ReadResult> {
  await delay()
  const s = store()
  const c = getConv(s, input.conversationId)
  const msgs = messagesOf(s, c.id)
  const target = msgs.findIndex((m) => m.id === input.readUpToMessageId)
  if (target < 0) fail(404, 'NOT_FOUND', 'Message not found in this conversation')
  const current = c.lastReadMessageId ? msgs.findIndex((m) => m.id === c.lastReadMessageId) : -1
  // Sólo avanza: un id más viejo no hace nada.
  if (target > current) {
    c.lastReadMessageId = msgs[target]!.id
    c.lastReadAt = iso(Date.now())
    c.lastReadBy = { userId: actor.id, name: actor.name }
    c.touchedAt = c.lastReadAt
    c.version = ++s.version
  }
  const now = Date.now()
  return { conversation: derive(s, c, now), serverNow: iso(now) }
}

/** 7 */
export async function mockSendMessage(
  input: { conversationId: string; clientMessageId: string; text: string },
  actor: Actor,
): Promise<SendResult> {
  await delay()
  const s = store()
  tick(s)
  const c = getConv(s, input.conversationId)
  const now = Date.now()

  const existing = [...s.messages.values()].find((m) => m.clientMessageId === input.clientMessageId)
  if (existing) {
    if (existing.text !== input.text) fail(400, 'CLIENT_MESSAGE_ID_CONFLICT', 'clientMessageId reused with a different body')
    return {
      ...strip(existing),
      outcome: existing.status === 'failed' ? 'failed' : existing.status === 'unknown' ? 'unknown' : 'sent',
      failureReason: existing.error?.message ?? null,
      serverNow: iso(now),
      replayed: true,
    }
  }

  const before = derive(s, c, now)
  if (before.replyState === 'opted_out') {
    fail(422, 'RECIPIENT_OPTED_OUT', 'Recipient opted out', {
      replyState: 'opted_out',
      sessionWindowExpiresAt: before.sessionWindowExpiresAt,
    })
  }
  if (before.replyState !== 'open') {
    fail(422, 'OUTSIDE_SESSION_WINDOW', 'Outside the 24h session window', {
      replyState: before.replyState,
      sessionWindowExpiresAt: before.sessionWindowExpiresAt,
    })
  }
  if (input.text.includes('/503')) fail(503, 'SERVICE_UNAVAILABLE', 'WhatsApp provider unavailable')

  const outcome = input.text.includes('/fail') ? 'failed' : input.text.includes('/unknown') ? 'unknown' : 'sent'
  const r: MsgRecord = {
    id: crypto.randomUUID(),
    conversationId: c.id,
    clientMessageId: input.clientMessageId,
    direction: 'outbound',
    kind: 'text',
    text: input.text,
    template: null,
    buttonTitle: null,
    status: outcome,
    error: outcome === 'failed' ? { code: 'PROVIDER_REJECTED', message: 'WhatsApp rechazó el mensaje.' } : null,
    sentBy: { userId: actor.id, name: actor.name },
    createdAt: iso(now),
    statusUpdatedAt: iso(now),
    version: ++s.version,
  }
  s.messages.set(r.id, r)
  return { ...strip(r), outcome, failureReason: r.error?.message ?? null, serverNow: iso(now), replayed: false }
}
