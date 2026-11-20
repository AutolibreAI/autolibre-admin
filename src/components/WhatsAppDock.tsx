import { Link, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, BellOff, Maximize2, MessageCircle } from 'lucide-react'
import { getWhatsAppInboxSourceFn, getWhatsAppThreadFn, listWhatsAppConversationsFn } from '~/fn/whatsapp-inbox'
import {
  WHATSAPP_LINES,
  WHATSAPP_LINE_LABELS,
  compareUnreadFirst,
  conversationLine,
  defaultLine,
  readableWhatsAppInboxError,
  unreadByLine,
  type ConversationPage,
  type ThreadPage,
  type WhatsAppConversation,
  type WhatsAppLine,
} from '~/lib/whatsapp-inbox'
import { cn } from '~/lib/utils'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '~/components/ui/sheet'
import { ConversationList, WhatsAppInboxProvider } from '~/components/WhatsAppInbox'
import { WhatsAppThread } from '~/components/WhatsAppThread'
import { useWhatsAppBackgroundPoll, useWhatsAppSound, useWhatsAppUnread } from '~/components/WhatsAppNotifier'

/**
 * WhatsApp siempre a la vista (pedido del 2026-11-20): un botón flotante con el
 * total de conversaciones sin leer de las dos líneas, y un panel lateral con
 * dos pestañas —Proveedores y Usuarios— que abre el hilo ADENTRO, sin salir
 * de la pantalla. → `.claude/plans/whatsapp-inbox.md`, "Botón flotante"
 *
 * Reusa todo lo de `/whatsapp`: el mismo `WhatsAppInboxProvider` (sondeo y
 * merge por id), la misma `ConversationList` y el mismo `WhatsAppThread`
 * (leer, responder, marcar leído, ventana de 24 h). No hay una segunda copia
 * de esa lógica.
 *
 * Un solo sondeo a la vez, por el rate limit del backend: con el panel
 * abierto sondea su provider; cerrado y fuera de `/whatsapp`, el de fondo.
 *
 * ⚠ La línea de cada conversación es PROVISORIA (`conversationLine`): el
 * backend todavía no guarda por cuál número entró. Responder sale por el
 * número que el backend tenga configurado — hoy hay uno solo.
 */
export function WhatsAppDock() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [open, setOpen] = useState(false)
  const onWhatsAppRoute = pathname === '/whatsapp' || pathname.startsWith('/whatsapp/')

  useWhatsAppBackgroundPoll(!onWhatsAppRoute && !open)
  const unread = useWhatsAppUnread() ?? 0
  useUnreadTitle(unread)

  // En la ficha de una solicitud abajo a la derecha está la barra de «Guardar»
  // del editor: ahí el botón va arriba a la derecha (decidido el 2026-11-20).
  const top = /^\/solicitudes\/(?!otros$)[^/]+$/.test(pathname)

  const label = unread > 0 ? `WhatsApp: ${unread} ${unread === 1 ? 'conversación' : 'conversaciones'} sin leer` : 'WhatsApp'

  // En `/whatsapp` el botón tapaba el «Enviar» del hilo (abajo a la derecha) y
  // esa pantalla ya ES la versión completa del panel: ahí no se muestra.
  if (onWhatsAppRoute) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
        className={cn(
          'fixed right-5 z-40 flex size-14 items-center justify-center rounded-full bg-action text-white outline-none transition-transform hover:scale-105 focus-visible:ring-[3px] focus-visible:ring-ring/50',
          top ? 'top-20 md:top-5' : 'bottom-5',
        )}
      >
        <MessageCircle className="size-6" aria-hidden />
        {unread > 0 ? (
          <span
            aria-hidden
            className="absolute -right-1 -top-1 flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-white bg-status-red px-1.5 text-xs font-semibold tabular-nums text-white"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-[30rem] max-w-[100vw] bg-surface p-0">
          {open ? <DockBody onClose={() => setOpen(false)} /> : null}
        </SheetContent>
      </Sheet>
    </>
  )
}

/** El cuerpo del panel. Se monta al abrir: la primera página se pide recién ahí. */
function DockBody({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState<ConversationPage | null>(null)
  const [source, setSource] = useState<'mock' | 'backend' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      listWhatsAppConversationsFn({ data: {}, signal: controller.signal }),
      getWhatsAppInboxSourceFn({ signal: controller.signal }),
    ])
      .then(([p, s]) => {
        setPage(p)
        setSource(s)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setError(readableWhatsAppInboxError(cause instanceof Error ? cause.message : String(cause)))
      })
    return () => controller.abort()
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 pr-10">
        <SheetTitle className="font-heading text-base font-semibold">WhatsApp</SheetTitle>
        <SheetDescription className="sr-only">Conversaciones de WhatsApp de las líneas de proveedores y de usuarios.</SheetDescription>
        <div className="ml-auto flex items-center gap-1">
          <SoundToggle />
          <Link
            to="/whatsapp"
            onClick={onClose}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Maximize2 className="size-3.5" aria-hidden />
            Pantalla completa
          </Link>
        </div>
      </div>
      {source === 'mock' ? (
        <p className="border-b border-border bg-status-yellow-bg px-4 py-1.5 text-xs text-status-yellow">
          Datos de ejemplo (mock de desarrollo).
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="m-4 rounded-md border border-status-red/30 bg-status-red-bg p-3 text-sm text-status-red">
          {error}
        </p>
      ) : !page ? (
        <p className="p-4 text-sm text-muted-foreground">Cargando conversaciones…</p>
      ) : (
        <DockInbox initial={page} />
      )}
    </div>
  )
}

function DockInbox({ initial }: { initial: ConversationPage }) {
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  return (
    <WhatsAppInboxProvider initial={initial} openConversationId={openId}>
      {({ conversations, error, nextCursor, loadMore, loadingMore, nowMs }) => (
        <DockTabs
          conversations={conversations}
          error={error}
          nextCursor={nextCursor}
          loadMore={loadMore}
          loadingMore={loadingMore}
          nowMs={nowMs}
          openId={openId}
          setOpenId={setOpenId}
        />
      )}
    </WhatsAppInboxProvider>
  )
}

function DockTabs({
  conversations,
  error,
  nextCursor,
  loadMore,
  loadingMore,
  nowMs,
  openId,
  setOpenId,
}: {
  conversations: Array<WhatsAppConversation>
  error: string | null
  nextCursor: string | null
  loadMore: () => Promise<void>
  loadingMore: boolean
  nowMs: number
  openId: string | undefined
  setOpenId: (id: string | undefined) => void
}) {
  const counts = unreadByLine(conversations)
  // Abre en la pestaña con no leídas (Proveedores si las dos). Se decide UNA
  // vez: que llegue un mensaje en la otra no te cambia de pestaña.
  const [line, setLine] = useState<WhatsAppLine>(() => defaultLine(counts))
  const visible = conversations.filter((c) => conversationLine(c) === line).sort(compareUnreadFirst)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Línea" className="flex border-b border-border">
        {WHATSAPP_LINES.map((l) => (
          <button
            key={l}
            type="button"
            role="tab"
            aria-selected={line === l}
            onClick={() => {
              setLine(l)
              setOpenId(undefined)
            }}
            className={cn(
              '-mb-px flex flex-1 items-center justify-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium',
              line === l ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {WHATSAPP_LINE_LABELS[l]}
            {counts[l] > 0 ? (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-status-red px-1.5 text-[11px] font-semibold text-white tabular-nums">
                {counts[l] > 99 ? '99+' : counts[l]}
                <span className="sr-only"> sin leer</span>
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {error ? (
        <p className="border-b border-border bg-status-yellow-bg px-4 py-1.5 text-xs text-status-yellow">
          No se pudo actualizar: {error}
        </p>
      ) : null}

      {openId ? (
        <DockThread key={openId} conversationId={openId} onBack={() => setOpenId(undefined)} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ConversationList
            conversations={visible}
            activeId={undefined}
            nowMs={nowMs}
            nextCursor={nextCursor}
            loadingMore={loadingMore}
            onLoadMore={() => void loadMore()}
            onSelect={setOpenId}
            emptyText={
              line === 'usuarios'
                ? 'Todavía no hay conversaciones de usuarios en esta línea.'
                : 'Todavía no hay conversaciones de proveedores.'
            }
          />
        </div>
      )}
    </div>
  )
}

/** El hilo adentro del panel: el MISMO componente de `/whatsapp/:id`. */
function DockThread({ conversationId, onBack }: { conversationId: string; onBack: () => void }) {
  const [page, setPage] = useState<ThreadPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    getWhatsAppThreadFn({ data: { conversationId }, signal: controller.signal })
      .then(setPage)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setError(readableWhatsAppInboxError(cause instanceof Error ? cause.message : String(cause)))
      })
    return () => controller.abort()
  }, [conversationId])

  if (error) {
    return (
      <div className="p-4 text-sm">
        <button type="button" onClick={onBack} className="mb-2 text-muted-foreground underline">
          Volver
        </button>
        <p className="text-status-red">{error}</p>
      </div>
    )
  }
  if (!page) return <p className="p-4 text-sm text-muted-foreground">Cargando conversación…</p>
  return (
    <div className="min-h-0 flex-1">
      <WhatsAppThread initial={page} onBack={onBack} />
    </div>
  )
}

function SoundToggle() {
  const [on, setOn] = useWhatsAppSound()
  const label = on ? 'Silenciar el aviso de mensaje nuevo' : 'Activar el sonido de mensaje nuevo'
  return (
    <button
      type="button"
      onClick={() => setOn(!on)}
      title={label}
      aria-label={label}
      aria-pressed={on}
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
    >
      {on ? <Bell className="size-3.5" aria-hidden /> : <BellOff className="size-3.5" aria-hidden />}
      {on ? 'Sonido' : 'Silenciado'}
    </button>
  )
}

/**
 * «(3) Solicitudes — AutoLibre»: el contador en el título de la pestaña.
 * El router reescribe `<title>` en cada navegación, así que se observa el
 * `<head>` y se vuelve a poner el prefijo cuando hace falta.
 */
const PREFIX_RE = /^\(\d+\+?\) /

function useUnreadTitle(unread: number) {
  const desired = useRef(unread)
  desired.current = unread

  const apply = useCallback(() => {
    const base = document.title.replace(PREFIX_RE, '')
    const next = desired.current > 0 ? `(${desired.current > 99 ? '99+' : desired.current}) ${base}` : base
    if (document.title !== next) document.title = next
  }, [])

  useEffect(() => {
    apply()
  }, [unread, apply])

  useEffect(() => {
    const observer = new MutationObserver(() => apply())
    observer.observe(document.head, { subtree: true, childList: true, characterData: true })
    return () => {
      observer.disconnect()
      document.title = document.title.replace(PREFIX_RE, '')
    }
  }, [apply])
}
