import { Link } from '@tanstack/react-router'
import { AlertTriangle, ArrowLeft, Check, CheckCheck, HelpCircle, Paperclip } from 'lucide-react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getWhatsAppThreadFn, markWhatsAppReadFn, sendWhatsAppMessageFn, whatsappMessageChangesFn } from '~/fn/whatsapp-inbox'
import { cn } from '~/lib/utils'
import {
  classifySendError,
  compareMessages,
  conversationTitle,
  effectiveReplyState,
  formatPhone,
  formatWindowLeft,
  MESSAGE_STATUS_LABELS,
  parseWhatsAppInboxError,
  readableWhatsAppInboxError,
  REPLY_STATE_LABELS,
  WHATSAPP_TEXT_MAX_LENGTH,
  type ThreadPage,
  type WhatsAppConversation,
  type WhatsAppMessage,
} from '~/lib/whatsapp-inbox'
import { useInbox, useServerClock } from '~/components/WhatsAppInbox'
import { Button } from '~/components/ui/button'
import { Textarea } from '~/components/ui/textarea'

/**
 * El hilo de una conversación de WhatsApp: burbujas, marca de leído y el
 * composer con envío optimista. → `.claude/plans/whatsapp-inbox.md`
 *
 * Se monta con `key={conversationId}`: cambiar de conversación arranca de cero.
 *
 * ── Envío ───────────────────────────────────────────────────────────────────
 *
 * `clientMessageId` se genera al apretar Enviar (nunca en el render: SSR) y es
 * la clave de idempotencia del backend. Ante red caída / timeout / 503 la
 * burbuja queda «sin confirmar» y «Reintentar» manda EL MISMO id con EL MISMO
 * texto: si el primero llegó, el backend contesta 200 (replay) y se reconcilia.
 * Un 422 deja la burbuja fallida con el motivo y traba el composer ya. Un
 * `unknown` NUNCA se reenvía solo.
 */

interface PendingMessage {
  clientMessageId: string
  text: string
  state: 'sending' | 'unconfirmed' | 'failed'
  error: string | null
}

const BA = 'America/Argentina/Buenos_Aires'
const timeFmt = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: BA })
const dayLabelFmt = new Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: BA })
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: BA })
const READ_DEBOUNCE_MS = 1_500
const AT_BOTTOM_PX = 48

function upsertMessages(prev: Map<string, WhatsAppMessage>, rows: Array<WhatsAppMessage>) {
  if (rows.length === 0) return prev
  const next = new Map(prev)
  // Al-menos-una-vez: el que llega reemplaza por id.
  for (const r of rows) next.set(r.id, r)
  return next
}

function usePageVisible() {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  useEffect(() => {
    const on = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}

export function WhatsAppThread({ initial }: { initial: ThreadPage }) {
  const inbox = useInbox()
  const conversationId = initial.conversation.id
  const conversation = inbox.get(conversationId) ?? initial.conversation
  const nowMs = useServerClock(inbox.clockOffsetMs)

  const [messages, setMessages] = useState(() => upsertMessages(new Map(), initial.items))
  const [pending, setPending] = useState<Array<PendingMessage>>([])
  const [olderCursor, setOlderCursor] = useState(initial.nextCursor)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const changesCursor = useRef(initial.changesAfter)

  // La conversación del hilo entra al estado compartido: la lista y el hilo leen la misma.
  useEffect(() => {
    inbox.upsert(initial.conversation)
    inbox.setServerNow(initial.serverNow)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyMessages = useCallback((rows: Array<WhatsAppMessage>) => {
    setMessages((prev) => upsertMessages(prev, rows))
    const ids = new Set(rows.map((r) => r.clientMessageId).filter(Boolean))
    if (ids.size) setPending((prev) => prev.filter((p) => !ids.has(p.clientMessageId)))
  }, [])

  // ── Cambios del hilo: cuando el feed de la lista trae esta conversación ──
  const syncing = useRef(false)
  const dirty = useRef(false)
  const syncChanges = useCallback(async () => {
    if (syncing.current) {
      dirty.current = true
      return
    }
    syncing.current = true
    try {
      do {
        dirty.current = false
        let more = true
        while (more) {
          const res = await whatsappMessageChangesFn({ data: { conversationId, after: changesCursor.current } })
          // Este feed NO trae la conversación: la trae el de la lista, que es el que disparó esto.
          applyMessages(res.items)
          inbox.setServerNow(res.serverNow)
          changesCursor.current = res.nextAfter
          more = res.hasMore
        }
      } while (dirty.current)
      setSyncError(null)
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause)
      if (parseWhatsAppInboxError(raw)?.code === 'INVALID_CURSOR') {
        // Cursor vencido: se rehace la primera página y se sigue desde ahí.
        const page = await getWhatsAppThreadFn({ data: { conversationId } }).catch(() => null)
        if (page) {
          applyMessages(page.items)
          changesCursor.current = page.changesAfter
          inbox.upsert(page.conversation)
          return
        }
      }
      setSyncError(readableWhatsAppInboxError(raw))
    } finally {
      syncing.current = false
    }
  }, [conversationId, applyMessages, inbox])

  const signal = inbox.changeSignal[conversationId] ?? 0
  const firstSignal = useRef(signal)
  useEffect(() => {
    if (signal !== firstSignal.current) void syncChanges()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal])

  // ── Scroll ──
  const scroller = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const v = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX
    atBottomRef.current = v
    setAtBottom(v)
  }
  const restoreFrom = useRef<number | null>(null)

  const sorted = useMemo(() => [...messages.values()].sort(compareMessages), [messages])
  const itemCount = sorted.length + pending.length

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (restoreFrom.current !== null) {
      // Cargar anteriores: mantener lo que se estaba mirando.
      el.scrollTop += el.scrollHeight - restoreFrom.current
      restoreFrom.current = null
    } else if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [itemCount])

  const loadOlder = async () => {
    if (!olderCursor || loadingOlder) return
    setLoadingOlder(true)
    try {
      const page = await getWhatsAppThreadFn({ data: { conversationId, cursor: olderCursor } })
      restoreFrom.current = scroller.current?.scrollHeight ?? null
      applyMessages(page.items)
      setOlderCursor(page.nextCursor)
    } catch (cause) {
      setSyncError(readableWhatsAppInboxError(cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setLoadingOlder(false)
    }
  }

  // ── Marca de leído: el más nuevo RENDERIZADO, con la pestaña visible y abajo de todo ──
  const visible = usePageVisible()
  const newestId = sorted.at(-1)?.id
  const lastMarked = useRef<string | null>(null)
  useEffect(() => {
    if (!conversation.unread || !visible || !atBottom || !newestId || lastMarked.current === newestId) return
    const t = window.setTimeout(() => {
      lastMarked.current = newestId
      markWhatsAppReadFn({ data: { conversationId, readUpToMessageId: newestId } })
        .then((r) => inbox.upsert(r.conversation))
        .catch(() => {
          lastMarked.current = null // se reintenta en el próximo cambio
        })
    }, READ_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [conversation.unread, visible, atBottom, newestId, conversationId, inbox])

  // ── Envío ──
  const inFlight = useRef(false)
  const [sending, setSending] = useState(false)
  const send = useCallback(
    async (text: string, retryId?: string) => {
      if (inFlight.current) return false
      inFlight.current = true
      setSending(true)
      // En el handler, nunca en el render: `crypto.randomUUID()` no corre en SSR.
      const clientMessageId = retryId ?? crypto.randomUUID()
      setPending((prev) => [
        ...prev.filter((p) => p.clientMessageId !== clientMessageId),
        { clientMessageId, text, state: 'sending', error: null },
      ])
      atBottomRef.current = true
      try {
        // 201 nuevo o 200 replay: los dos traen el mensaje guardado, y se reconcilia igual.
        const { outcome: _outcome, failureReason: _reason, serverNow, replayed: _replayed, ...message } =
          await sendWhatsAppMessageFn({ data: { conversationId, clientMessageId, text } })
        applyMessages([message])
        inbox.setServerNow(serverNow)
      } catch (cause) {
        const { kind, text: reason, detail } = classifySendError(cause instanceof Error ? cause.message : String(cause))
        if (detail?.replyState) {
          // El 422 trae el estado nuevo: el composer se traba sin esperar al sondeo.
          inbox.upsert({
            ...conversation,
            replyState: detail.replyState,
            sessionWindowExpiresAt: detail.sessionWindowExpiresAt,
            updatedAt: new Date(nowMs).toISOString(),
          })
        }
        setPending((prev) =>
          prev.map((p) =>
            p.clientMessageId === clientMessageId ? { ...p, state: kind === 'retryable' ? 'unconfirmed' : 'failed', error: reason } : p,
          ),
        )
      } finally {
        inFlight.current = false
        setSending(false)
      }
      return true
    },
    [conversationId, applyMessages, inbox, conversation, nowMs],
  )
  const discard = (id: string) => setPending((prev) => prev.filter((p) => p.clientMessageId !== id))

  const replyState = effectiveReplyState(conversation, nowMs)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadHeader conversation={conversation} replyState={replyState} nowMs={nowMs} />

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto bg-canvas px-4 py-3">
        {olderCursor ? (
          <div className="mb-3 text-center">
            <Button variant="outline" size="sm" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? 'Cargando…' : 'Cargar mensajes anteriores'}
            </Button>
          </div>
        ) : (
          <p className="mb-3 text-center text-xs text-muted-foreground">Principio de la conversación</p>
        )}

        {sorted.map((m, i) => {
          const day = dayKeyFmt.format(new Date(m.createdAt))
          const prevDay = i > 0 ? dayKeyFmt.format(new Date(sorted[i - 1]!.createdAt)) : null
          return (
            <Fragment key={m.id}>
              {day !== prevDay ? <DaySeparator iso={m.createdAt} /> : null}
              <MessageBubble message={m} />
            </Fragment>
          )
        })}
        {pending.map((p) => (
          <PendingBubble
            key={p.clientMessageId}
            pending={p}
            busy={sending}
            onRetry={() => void send(p.text, p.clientMessageId)}
            onDiscard={() => discard(p.clientMessageId)}
          />
        ))}
      </div>

      {syncError ? (
        <p className="border-t border-border bg-status-yellow-bg px-4 py-1.5 text-xs text-status-yellow">{syncError}</p>
      ) : null}

      <Composer replyState={replyState} conversation={conversation} sending={sending} onSend={send} />
    </div>
  )
}

// ── Cabecera ────────────────────────────────────────────────────────────────

function ThreadHeader({ conversation, replyState, nowMs }: { conversation: WhatsAppConversation; replyState: string; nowMs: number }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
      <div className="flex min-w-0 items-start gap-2">
        <Link to="/whatsapp" className="mt-0.5 text-muted-foreground hover:text-foreground md:hidden" aria-label="Volver a la lista">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{conversationTitle(conversation)}</h2>
          <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
            <span className="tabular-nums">{formatPhone(conversation.phone)}</span>
            {conversation.partners.map((p) => (
              <Link key={p.id} to="/partners/$partnerId" params={{ partnerId: p.id }} className="text-brand hover:underline">
                Ficha de {p.name}
              </Link>
            ))}
          </div>
        </div>
      </div>
      <div className="text-right text-xs">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium',
            replyState === 'open'
              ? 'border-status-green/30 bg-status-green-bg text-status-green'
              : replyState === 'opted_out'
                ? 'border-status-red/30 bg-status-red-bg text-status-red'
                : 'border-border bg-surface-2 text-muted-foreground',
          )}
        >
          {REPLY_STATE_LABELS[replyState] ?? replyState}
          {replyState === 'open' && conversation.sessionWindowExpiresAt
            ? ` · quedan ${formatWindowLeft(conversation.sessionWindowExpiresAt, nowMs)}`
            : ''}
        </span>
        {conversation.lastReadBy && !conversation.unread ? (
          <div className="mt-1 text-muted-foreground">Leído por {conversation.lastReadBy.name ?? 'un admin borrado'}</div>
        ) : null}
      </div>
    </header>
  )
}

function DaySeparator({ iso }: { iso: string }) {
  return (
    <div className="my-3 flex justify-center">
      <span className="rounded-full border border-border bg-surface px-3 py-0.5 text-xs text-muted-foreground first-letter:uppercase">
        {dayLabelFmt.format(new Date(iso))}
      </span>
    </div>
  )
}

// ── Burbujas ────────────────────────────────────────────────────────────────

function authorLabel(m: WhatsAppMessage): string {
  if (!m.sentBy) return 'AutoLibre (automático)'
  return m.sentBy.name ?? 'Admin (usuario borrado)'
}

function MessageBody({ m }: { m: WhatsAppMessage }) {
  switch (m.kind) {
    case 'text':
      return <p className="whitespace-pre-wrap break-words">{m.text}</p>
    case 'template': {
      const vars = Object.entries(m.template?.variables ?? {})
      return (
        <div>
          <p className="font-medium">Plantilla: {m.template?.label ?? m.template?.name ?? 'sin nombre'}</p>
          {vars.length > 0 ? (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-xs text-muted-foreground">
              {vars.map(([k, v]) => (
                <Fragment key={k}>
                  <dt>{k}</dt>
                  <dd className="break-words text-foreground">{v}</dd>
                </Fragment>
              ))}
            </dl>
          ) : null}
        </div>
      )
    }
    case 'button_reply':
      return (
        <p>
          <span className="rounded-md border border-border bg-surface-2 px-2 py-0.5 text-sm">{m.buttonTitle ?? 'Botón'}</span>
        </p>
      )
    case 'unsupported_media':
      return (
        <p className="flex items-center gap-1.5 italic text-muted-foreground">
          <Paperclip className="size-3.5" aria-hidden /> Adjunto no soportado
        </p>
      )
    case 'unavailable':
      return <p className="italic text-muted-foreground">Mensaje no disponible</p>
    default:
      return (
        <p className="italic text-muted-foreground">
          Tipo de mensaje «{m.kind}» {m.text ? `— ${m.text}` : ''}
        </p>
      )
  }
}

function StatusIcon({ status }: { status: string | null }) {
  const label = status ? (MESSAGE_STATUS_LABELS[status] ?? status) : ''
  const cls = 'size-3.5'
  const icon =
    status === 'read' ? (
      <CheckCheck className={cn(cls, 'text-brand')} />
    ) : status === 'delivered' ? (
      <CheckCheck className={cls} />
    ) : status === 'sent' || status === 'pending' ? (
      // `pending` = el backend lo aceptó y lo está pasando a Meta. Se muestra
      // ya con un tilde (optimista); el `title` dice el estado real, y si
      // después falla, el sondeo lo cambia a ⚠.
      <Check className={cls} />
    ) : status === 'failed' || status === 'undelivered' ? (
      <AlertTriangle className={cn(cls, 'text-status-red')} />
    ) : status === 'unknown' ? (
      <HelpCircle className={cn(cls, 'text-status-yellow')} />
    ) : null
  return icon ? (
    <span className="inline-flex items-center" title={label} aria-label={label}>
      {icon}
    </span>
  ) : null
}

function MessageBubble({ message: m }: { message: WhatsAppMessage }) {
  const out = m.direction === 'outbound'
  const failed = m.status === 'failed' || m.status === 'undelivered'
  return (
    <div className={cn('mb-2 flex', out ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[75%] rounded-lg border px-3 py-2 text-sm',
          out ? 'border-brand-muted bg-brand-soft' : 'border-border bg-surface',
          failed && 'border-status-red/40',
        )}
      >
        {out ? <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">{authorLabel(m)}</div> : null}
        <MessageBody m={m} />
        <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted-foreground tabular-nums">
          {timeFmt.format(new Date(m.createdAt))}
          {out ? <StatusIcon status={m.status} /> : null}
        </div>
        {out && failed ? (
          <p className="mt-1 text-xs text-status-red">
            {MESSAGE_STATUS_LABELS[m.status!]}
            {m.error ? `: ${m.error.message}` : ''}
          </p>
        ) : null}
        {out && m.status === 'unknown' ? (
          <p className="mt-1 text-xs text-status-yellow">No sabemos si salió. No se reenvía solo: revisalo antes de mandar de nuevo.</p>
        ) : null}
      </div>
    </div>
  )
}

function PendingBubble({
  pending: p,
  busy,
  onRetry,
  onDiscard,
}: {
  pending: PendingMessage
  busy: boolean
  onRetry: () => void
  onDiscard: () => void
}) {
  return (
    <div className="mb-2 flex justify-end">
      <div
        className={cn(
          'max-w-[75%] rounded-lg border px-3 py-2 text-sm',
          p.state === 'failed' ? 'border-status-red/40 bg-status-red-bg' : 'border-brand-muted bg-brand-soft',
        )}
      >
        <p className="whitespace-pre-wrap break-words">{p.text}</p>
        <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
          {p.state === 'sending' ? (
            // Optimista: el tilde aparece al apretar Enviar. Si el envío falla,
            // la burbuja pasa a «no se pudo confirmar» / «falló» con su motivo.
            <span className="inline-flex items-center" title="Enviando…" aria-label="Enviando">
              <Check className="size-3.5" />
            </span>
          ) : null}
        </div>
        {p.state !== 'sending' ? (
          <div className="mt-1 space-y-1 text-xs">
            <p className={p.state === 'failed' ? 'text-status-red' : 'text-status-yellow'}>
              {p.error}
              {p.state === 'unconfirmed' ? ' Reintentar no lo duplica.' : ''}
            </p>
            <div className="flex justify-end gap-2">
              {p.state === 'unconfirmed' ? (
                <Button size="sm" variant="outline" onClick={onRetry} disabled={busy}>
                  Reintentar
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={onDiscard} disabled={busy}>
                Descartar
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ── Composer ────────────────────────────────────────────────────────────────

function disabledReason(replyState: string, conversation: WhatsAppConversation): string | null {
  switch (replyState) {
    case 'open':
      return null
    case 'window_closed':
      return 'La ventana de 24 h se cerró: solo se puede responder cuando el contacto vuelva a escribir.'
    case 'opted_out':
      return conversation.partners.length > 0
        ? 'Este taller pidió no ser contactado.'
        : 'Este contacto pidió no ser contactado.'
    case 'no_inbound_yet':
      return 'Este contacto todavía no escribió: sin una ventana abierta no se puede mandar texto libre.'
    default:
      return `No se puede responder (estado «${replyState}»).`
  }
}

function Composer({
  replyState,
  conversation,
  sending,
  onSend,
}: {
  replyState: string
  conversation: WhatsAppConversation
  sending: boolean
  onSend: (text: string) => Promise<boolean>
}) {
  const [text, setText] = useState('')
  const reason = disabledReason(replyState, conversation)
  const tooLong = text.length > WHATSAPP_TEXT_MAX_LENGTH
  const canSend = !reason && !sending && text.trim().length > 0 && !tooLong

  const submit = async () => {
    if (!canSend) return
    const value = text
    setText('')
    const accepted = await onSend(value)
    if (!accepted) setText(value)
  }

  if (reason) {
    return (
      <div
        className={cn(
          'border-t px-4 py-3 text-sm',
          replyState === 'opted_out'
            ? 'border-status-red/30 bg-status-red-bg text-status-red'
            : 'border-border bg-surface-2 text-muted-foreground',
        )}
      >
        {reason}
      </div>
    )
  }

  return (
    <form
      className="border-t border-border bg-surface px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label htmlFor="whatsapp-composer" className="sr-only">
        Mensaje
      </label>
      <Textarea
        id="whatsapp-composer"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
        rows={2}
        placeholder="Escribí un mensaje (Enter envía, Shift+Enter agrega un renglón)"
        className="resize-none"
      />
      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className={cn(tooLong && 'text-status-red')}>
          {text.length > WHATSAPP_TEXT_MAX_LENGTH - 500 ? `${text.length} / ${WHATSAPP_TEXT_MAX_LENGTH}` : ''}
        </span>
        <Button type="submit" size="sm" disabled={!canSend}>
          {sending ? 'Enviando…' : 'Enviar'}
        </Button>
      </div>
    </form>
  )
}
