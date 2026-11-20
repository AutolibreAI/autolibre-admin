import { Outlet, createFileRoute, useParams } from '@tanstack/react-router'
import { useLayoutEffect, useRef, useState } from 'react'
import { getWhatsAppInboxSourceFn, listWhatsAppConversationsFn } from '~/fn/whatsapp-inbox'
import { formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import { z } from 'zod'
import {
  WHATSAPP_LINES,
  WHATSAPP_LINE_LABELS,
  compareUnreadFirst,
  conversationLine,
  defaultLine,
  readableWhatsAppInboxError,
  unreadByLine,
  whatsappLineParam,
} from '~/lib/whatsapp-inbox'
import { MockBanner } from '~/components/MockBanner'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { ConversationList, WhatsAppInboxProvider } from '~/components/WhatsAppInbox'
import { useWhatsAppSound } from '~/components/WhatsAppNotifier'
import { Bell, BellOff } from 'lucide-react'
import { Button } from '~/components/ui/button'

/**
 * `/whatsapp` — la bandeja de WhatsApp del equipo: una conversación por
 * número, con cualquier número (no sólo talleres). Lista a la izquierda, hilo
 * a la derecha (`$conversationId`, un UUID: el número NUNCA va a la URL).
 * → `.claude/plans/whatsapp-inbox.md`
 *
 * Qué reemplaza: nada que se corriera — hoy las respuestas de los talleres al
 * despacho (0142) no se ven en ningún lado y nadie puede contestarlas.
 *
 * `ssr: 'data-only'`: detrás de auth, y todo lo que se ve vive después en el
 * estado del cliente (sondeo + merge por id). Renderizar el markup en el
 * servidor no aporta nada y las horas relativas al reloj ("quedan 3 h") darían
 * un mismatch de hidratación.
 */
export const Route = createFileRoute('/_authed/whatsapp')({
  ssr: 'data-only',
  // La pestaña (Proveedores / Usuarios). Sin ella, la que tiene no leídas.
  validateSearch: z.object({ whatsappLine: whatsappLineParam }),
  loader: async ({ abortController }) => {
    const [page, source] = await Promise.all([
      listWhatsAppConversationsFn({ data: {}, signal: abortController.signal }),
      getWhatsAppInboxSourceFn(),
    ])
    return { page, source }
  },
  head: () => ({ meta: [{ title: 'WhatsApp — AutoLibre' }] }),
  errorComponent: ({ error }) => (
    <>
      <PageHeader title="WhatsApp" />
      <div className="rounded-lg border border-status-red/30 bg-status-red-bg p-4 text-sm text-status-red">
        {readableWhatsAppInboxError(error instanceof Error ? error.message : String(error))}
      </div>
    </>
  ),
  component: WhatsAppLayout,
})

/** Margen que queda debajo de la bandeja, en px (el `pb-16` del `<main>` no aplica: la página no scrollea). */
const BOTTOM_GAP_PX = 16

/**
 * Bloquea el scroll de la PÁGINA mientras `/whatsapp` está montada y estira la
 * bandeja hasta el borde de abajo de la ventana: así lo único que scrollea es
 * la lista y el hilo, como en cualquier cliente de chat.
 *
 * La altura se MIDE (`innerHeight - top`) en vez de un `calc(100dvh - Xrem)`
 * fijo: arriba hay header, aviso del mock y aviso de error, que aparecen y
 * desaparecen, y un número fijo deja o un hueco o un desborde.
 *
 * Se restaura el `overflow` anterior al desmontar: el shell es compartido, y
 * dejarlo en `hidden` rompería el scroll de todas las demás pantallas.
 */
function useFillViewport(deps: ReadonlyArray<unknown>) {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | null>(null)

  useLayoutEffect(() => {
    const html = document.documentElement
    const body = document.body
    const prev = { html: html.style.overflow, body: body.style.overflow }
    window.scrollTo(0, 0)
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    return () => {
      html.style.overflow = prev.html
      body.style.overflow = prev.body
    }
  }, [])

  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current
      if (!el) return
      const top = el.getBoundingClientRect().top
      setHeight(Math.max(window.innerHeight - top - BOTTOM_GAP_PX, 320))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { ref, height }
}

function WhatsAppLayout() {
  const { page, source } = Route.useLoaderData()
  const { conversationId } = useParams({ strict: false })
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <WhatsAppInboxProvider initial={page} openConversationId={conversationId}>
      {({ conversations, unreadConversations, error, nextCursor, loadMore, loadingMore, nowMs }) => {
        const counts = unreadByLine(conversations)
        const line = search.whatsappLine ?? defaultLine(counts)
        const visible = conversations.filter((c) => conversationLine(c) === line).sort(compareUnreadFirst)
        return (
        <InboxFrame source={source} error={error}>
          {(frame) => (
        <>
          <PageHeader
            title="WhatsApp"
            subtitle={
              unreadConversations > 0
                ? `${formatInt(unreadConversations)} conversaciones sin leer`
                : 'Todo leído'
            }
            actions={
              <div className="flex items-center gap-2">
                <SoundToggle />
                <SsrTag>ssr: data-only</SsrTag>
              </div>
            }
          />
          {source === 'mock' ? (
            <MockBanner
              title="La bandeja usa datos de ejemplo"
              items={[
                'El backend todavía no tiene /admin/whatsapp: conversaciones, mensajes y envíos salen de src/mocks/whatsapp-inbox.ts (sólo en desarrollo).',
                'Para probar errores, mandá un texto con /503, /fail o /unknown. Cada ~60 s entra un mensaje en la primera conversación.',
              ]}
            />
          ) : null}
          {error ? (
            <p className="mb-3 rounded-md border border-status-yellow/40 bg-status-yellow-bg px-3 py-2 text-sm text-status-yellow">
              No se pudo actualizar la lista: {error}
            </p>
          ) : null}
          <div role="tablist" aria-label="Línea" className="mb-3 flex gap-1 border-b border-border">
            {WHATSAPP_LINES.map((l) => (
              <button
                key={l}
                type="button"
                role="tab"
                aria-selected={line === l}
                onClick={() => navigate({ to: '/whatsapp', search: { whatsappLine: l } })}
                className={cn(
                  '-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium',
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
            <span className="ml-auto self-center text-xs text-muted-foreground">
              Provisorio: una conversación es de Proveedores si el número es de un taller.
            </span>
          </div>
          <div
            ref={frame.ref}
            style={frame.height === null ? undefined : { height: frame.height }}
            className="grid h-[calc(100dvh-12rem)] min-h-80 overflow-hidden rounded-lg border border-border bg-surface md:grid-cols-[22rem_1fr]"
          >
            <aside
              className={cn(
                'min-h-0 overflow-y-auto border-border md:border-r',
                conversationId ? 'hidden md:block' : 'block',
              )}
              aria-label="Conversaciones"
            >
              <ConversationList
                conversations={visible}
                emptyText={
                  line === 'usuarios'
                    ? 'Todavía no hay conversaciones de usuarios en esta línea.'
                    : 'Todavía no hay conversaciones de proveedores.'
                }
                activeId={conversationId}
                nowMs={nowMs}
                nextCursor={nextCursor}
                loadingMore={loadingMore}
                onLoadMore={() => void loadMore()}
              />
            </aside>
            <section className={cn('min-h-0', conversationId ? 'block' : 'hidden md:block')}>
              <Outlet />
            </section>
          </div>
        </>
          )}
        </InboxFrame>
        )
      }}
    </WhatsAppInboxProvider>
  )
}

/** Envoltorio para poder usar el hook adentro del render-prop del provider (que depende de `error`). */
function InboxFrame({
  source,
  error,
  children,
}: {
  source: string
  error: string | null
  children: (frame: ReturnType<typeof useFillViewport>) => React.ReactNode
}) {
  const frame = useFillViewport([source, error])
  return <>{children(frame)}</>
}

/** Prender/apagar el sonido de mensaje nuevo. Por navegador (localStorage), no por cuenta. */
function SoundToggle() {
  const [on, setOn] = useWhatsAppSound()
  const label = on ? 'Silenciar el aviso de mensaje nuevo' : 'Activar el sonido de mensaje nuevo'
  return (
    <Button variant="ghost" size="sm" onClick={() => setOn(!on)} title={label} aria-label={label} aria-pressed={on}>
      {on ? <Bell className="size-4" aria-hidden /> : <BellOff className="size-4" aria-hidden />}
      <span className="text-xs">{on ? 'Sonido' : 'Silenciado'}</span>
    </Button>
  )
}
