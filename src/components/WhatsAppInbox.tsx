import { Link } from '@tanstack/react-router'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { listWhatsAppConversationsFn, whatsappConversationChangesFn } from '~/fn/whatsapp-inbox'
import { cn } from '~/lib/utils'
import {
  compareConversations,
  conversationTitle,
  effectiveReplyState,
  formatPhone,
  lastMessagePreview,
  parseWhatsAppInboxError,
  readableWhatsAppInboxError,
  REPLY_STATE_LABELS,
  type ConversationPage,
  type WhatsAppConversation,
} from '~/lib/whatsapp-inbox'
import { Button } from '~/components/ui/button'

/**
 * La lista de la bandeja de WhatsApp y el estado que comparte con el hilo.
 * → `.claude/plans/whatsapp-inbox.md`
 *
 * ── Un solo sondeo ──────────────────────────────────────────────────────────
 *
 * Se sondea SÓLO `conversations/changes` (acordado con el backend: ese feed
 * también se mueve cuando cambia el estado de un saliente viejo). Cada vez que
 * una conversación aparece en un lote, su contador de `changeSignal` sube, y el
 * hilo abierto —si es ésa— pide sus `messages/changes`. Una invocación por tick
 * en vez de dos (cada una es una función de Vercel).
 *
 * No es `router.invalidate()`: eso rehace el loader y tira el merge por id.
 */

/**
 * Conservador a propósito: el backend tiene un rate limit GLOBAL de 60 req/min
 * por IP y todos los admins salen por las IPs de Vercel. Un 429 cuenta como
 * falla y dispara el backoff. Nunca menos de 10 s.
 */
const POLL_THREAD_OPEN_MS = 10_000
const POLL_IDLE_MS = 15_000
const POLL_MAX_BACKOFF_MS = 60_000

// ── Sondeo ──────────────────────────────────────────────────────────────────

/**
 * Corre `run` cada `intervalMs`, uno por vez. Se pausa con la pestaña oculta
 * y hace un tick apenas vuelve. Ante error, backoff 2× hasta 60 s. Fase 2: el
 * «timbre» SSE va a llamar al mismo `run` (vía `poke`).
 */
export function usePolling(run: (signal: AbortSignal) => Promise<void>, intervalMs: number, enabled = true) {
  const runRef = useRef(run)
  runRef.current = run
  const pokeRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let timer: number | undefined
    let controller: AbortController | null = null
    let failures = 0

    const schedule = (ms: number) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void loop(), ms)
    }
    const loop = async () => {
      if (stopped || document.hidden || controller) return
      controller = new AbortController()
      try {
        await runRef.current(controller.signal)
        failures = 0
      } catch {
        failures++
      } finally {
        controller = null
      }
      if (!stopped) schedule(failures ? Math.min(intervalMs * 2 ** failures, POLL_MAX_BACKOFF_MS) : intervalMs)
    }
    const onVisibility = () => {
      if (!document.hidden) schedule(0)
    }

    pokeRef.current = () => schedule(0)
    document.addEventListener('visibilitychange', onVisibility)
    schedule(intervalMs)
    return () => {
      stopped = true
      window.clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisibility)
      pokeRef.current = () => {}
    }
  }, [intervalMs, enabled])

  return useCallback(() => pokeRef.current(), [])
}

/** `Date.now()` corregido contra el `serverNow` del backend, refrescado cada 30 s. */
export function useServerClock(offsetMs: number) {
  const [now, setNow] = useState(() => Date.now() + offsetMs)
  useEffect(() => {
    setNow(Date.now() + offsetMs)
    const t = window.setInterval(() => setNow(Date.now() + offsetMs), 30_000)
    return () => window.clearInterval(t)
  }, [offsetMs])
  return now
}

// ── Estado compartido ───────────────────────────────────────────────────────

interface InboxContextValue {
  get: (id: string) => WhatsAppConversation | undefined
  upsert: (c: WhatsAppConversation) => void
  /** Sube cada vez que el feed de cambios trae esa conversación. */
  changeSignal: Record<string, number>
  setServerNow: (iso: string) => void
  clockOffsetMs: number
}

const InboxContext = createContext<InboxContextValue | null>(null)

export function useInbox(): InboxContextValue {
  const v = useContext(InboxContext)
  if (!v) throw new Error('useInbox fuera de <WhatsAppInboxProvider>')
  return v
}

export function WhatsAppInboxProvider({
  initial,
  openConversationId,
  children,
}: {
  initial: ConversationPage
  openConversationId: string | undefined
  children: (state: {
    conversations: Array<WhatsAppConversation>
    unreadConversations: number
    error: string | null
    nextCursor: string | null
    loadMore: () => Promise<void>
    loadingMore: boolean
    nowMs: number
  }) => ReactNode
}) {
  const [byId, setById] = useState(() => new Map(initial.items.map((c) => [c.id, c])))
  const [unreadConversations, setUnread] = useState(initial.unreadConversations)
  const [nextCursor, setNextCursor] = useState(initial.nextCursor)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [changeSignal, setChangeSignal] = useState<Record<string, number>>({})
  const [clockOffsetMs, setClockOffset] = useState(0)
  const cursorRef = useRef(initial.changesAfter)
  const byIdRef = useRef(byId)
  byIdRef.current = byId

  const setServerNow = useCallback((iso: string) => {
    const offset = Date.parse(iso) - Date.now()
    // Sólo si se movió más de 5 s: si no, cada respuesta re-renderizaría todo.
    setClockOffset((prev) => (Math.abs(prev - offset) > 5_000 ? offset : prev))
  }, [])
  useEffect(() => setServerNow(initial.serverNow), [initial.serverNow, setServerNow])

  const upsertMany = useCallback((rows: Array<WhatsAppConversation>) => {
    if (rows.length === 0) return
    setById((prev) => {
      const next = new Map(prev)
      for (const r of rows) {
        const old = next.get(r.id)
        // Entrega al-menos-una-vez: nunca pisar con algo MÁS VIEJO.
        if (!old || old.updatedAt <= r.updatedAt) next.set(r.id, r)
      }
      return next
    })
  }, [])

  const upsert = useCallback((c: WhatsAppConversation) => upsertMany([c]), [upsertMany])

  const reloadFirstPage = useCallback(
    async (signal?: AbortSignal) => {
      const page = await listWhatsAppConversationsFn({ data: {}, signal })
      setById(new Map(page.items.map((c) => [c.id, c])))
      setNextCursor(page.nextCursor)
      setUnread(page.unreadConversations)
      cursorRef.current = page.changesAfter
      setServerNow(page.serverNow)
    },
    [setServerNow],
  )

  const pollChanges = useCallback(
    async (signal: AbortSignal) => {
      try {
        let more = true
        while (more) {
          const res = await whatsappConversationChangesFn({ data: { after: cursorRef.current }, signal })
          upsertMany(res.items)
          setUnread(res.unreadConversations)
          setServerNow(res.serverNow)
          if (res.items.length > 0) {
            setChangeSignal((prev) => {
              const next = { ...prev }
              for (const c of res.items) next[c.id] = (next[c.id] ?? 0) + 1
              return next
            })
          }
          cursorRef.current = res.nextAfter
          more = res.hasMore
        }
        setError(null)
      } catch (cause) {
        if (signal.aborted) return
        const raw = cause instanceof Error ? cause.message : String(cause)
        if (parseWhatsAppInboxError(raw)?.code === 'INVALID_CURSOR') {
          await reloadFirstPage(signal)
          return
        }
        setError(readableWhatsAppInboxError(raw))
        throw cause
      }
    },
    [upsertMany, setServerNow, reloadFirstPage],
  )

  usePolling(pollChanges, openConversationId ? POLL_THREAD_OPEN_MS : POLL_IDLE_MS)

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await listWhatsAppConversationsFn({ data: { cursor: nextCursor } })
      upsertMany(page.items)
      setNextCursor(page.nextCursor)
    } catch (cause) {
      setError(readableWhatsAppInboxError(cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setLoadingMore(false)
    }
  }, [nextCursor, loadingMore, upsertMany])

  const nowMs = useServerClock(clockOffsetMs)
  const conversations = useMemo(() => [...byId.values()].sort(compareConversations), [byId])

  const ctx = useMemo<InboxContextValue>(
    () => ({ get: (id) => byIdRef.current.get(id), upsert, changeSignal, setServerNow, clockOffsetMs }),
    // `byId` en las deps: `get` lee el ref, pero los consumidores tienen que re-renderizar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byId, upsert, changeSignal, setServerNow, clockOffsetMs],
  )

  return (
    <InboxContext.Provider value={ctx}>
      {children({ conversations, unreadConversations, error, nextCursor, loadMore, loadingMore, nowMs })}
    </InboxContext.Provider>
  )
}

// ── La lista ────────────────────────────────────────────────────────────────

const timeFmt = new Intl.DateTimeFormat('es-AR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Argentina/Buenos_Aires',
})
const dayFmt = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: 'short',
  timeZone: 'America/Argentina/Buenos_Aires',
})
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })

/** Hoy → "14:32"; otro día → "03 nov". En hora de Buenos Aires. */
export function formatListTime(iso: string, nowMs: number): string {
  const d = new Date(iso)
  return dayKeyFmt.format(d) === dayKeyFmt.format(new Date(nowMs)) ? timeFmt.format(d) : dayFmt.format(d)
}

const REPLY_DOT: Record<string, string> = {
  open: 'bg-status-green',
  window_closed: 'bg-muted-foreground/40',
  no_inbound_yet: 'bg-muted-foreground/40',
  opted_out: 'bg-status-red',
}

export function ConversationList({
  conversations,
  activeId,
  nowMs,
  nextCursor,
  loadingMore,
  onLoadMore,
}: {
  conversations: Array<WhatsAppConversation>
  activeId: string | undefined
  nowMs: number
  nextCursor: string | null
  loadingMore: boolean
  onLoadMore: () => void
}) {
  if (conversations.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay conversaciones de WhatsApp.</p>
  }
  return (
    <div>
      <ul className="divide-y divide-border">
        {conversations.map((c) => {
          const state = effectiveReplyState(c, nowMs)
          return (
            <li key={c.id}>
              <Link
                to="/whatsapp/$conversationId"
                params={{ conversationId: c.id }}
                className={cn(
                  'flex gap-3 px-4 py-3 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring',
                  c.id === activeId && 'bg-muted',
                )}
              >
                <span
                  className={cn('mt-1.5 size-2 shrink-0 rounded-full', REPLY_DOT[state] ?? 'bg-muted-foreground/40')}
                  title={REPLY_STATE_LABELS[state] ?? state}
                  aria-label={REPLY_STATE_LABELS[state] ?? state}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={cn('truncate text-sm', c.unread ? 'font-semibold' : 'font-medium')}>
                      {conversationTitle(c)}
                    </span>
                    {c.lastMessage ? (
                      <span
                        className={cn('shrink-0 text-xs tabular-nums', c.unread ? 'text-foreground' : 'text-muted-foreground')}
                      >
                        {formatListTime(c.lastMessage.createdAt, nowMs)}
                      </span>
                    ) : null}
                  </div>
                  {c.partners.length > 0 ? (
                    <div className="truncate text-xs text-muted-foreground tabular-nums">{formatPhone(c.phone)}</div>
                  ) : null}
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        'truncate text-sm',
                        c.unread ? 'text-foreground' : 'text-muted-foreground',
                        c.lastMessage && c.lastMessage.preview.kind !== 'text' && 'italic',
                      )}
                    >
                      {c.lastMessage?.direction === 'outbound' ? 'Vos: ' : ''}
                      {lastMessagePreview(c.lastMessage)}
                    </span>
                    {c.unread ? (
                      <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-action px-1.5 text-[11px] font-semibold text-white tabular-nums">
                        {c.unreadCount >= 100 ? '99+' : c.unreadCount}
                        <span className="sr-only">sin leer</span>
                      </span>
                    ) : null}
                  </div>
                </div>
              </Link>
            </li>
          )
        })}
      </ul>
      {nextCursor ? (
        <div className="p-3 text-center">
          <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Cargando…' : 'Cargar más'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
