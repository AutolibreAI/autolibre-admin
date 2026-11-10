import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ExternalLink, Loader2, TriangleAlert } from 'lucide-react'
import type { PosthogDashboard, PosthogEmbedConfig } from '~/lib/posthog-dashboards'

/** Pasado este tiempo sin `load`, se avisa (sin sacar el iframe: puede terminar de cargar). */
const SLOW_AFTER_MS = 20_000

/**
 * Un tablero de PostHog embebido, a ancho completo.
 *
 * ── Sin doble scroll ─────────────────────────────────────────────────────────
 *
 * El iframe es de otro dominio: no se puede medir su contenido para darle el
 * alto exacto. Lo que sí se puede es que la PÁGINA no scrollee: el iframe toma
 * todo el alto que queda de la ventana debajo de su borde superior (descontando
 * lo que haya debajo, como el padding del `<main>`), así el único scroll es el
 * del tablero. `minHeight` es el piso para ventanas muy bajas, donde sí aparece
 * el scroll de la página, porque un tablero de 200px no se puede leer.
 *
 * ── Carga ────────────────────────────────────────────────────────────────────
 *
 * Se monta sólo en el navegador (las rutas que lo usan son `ssr: 'data-only'`):
 * un iframe en el HTML del servidor puede terminar de cargar antes de que React
 * hidrate, y el `onLoad` no llegaría nunca — el cartel de carga quedaría fijo.
 */
export function PosthogEmbed({
  dashboard,
  config,
  // 360 y no más: en una laptop (≈850 px de alto) lo de arriba del tablero ocupa
  // ≈370 px, y con un piso de 480 la página scrolleaba además del tablero.
  minHeight = 360,
  note,
}: {
  dashboard: PosthogDashboard
  config: PosthogEmbedConfig
  /** Alto mínimo del iframe, en px. */
  minHeight?: number
  /** Una aclaración propia de este tablero, debajo de la línea fija. */
  note?: ReactNode
}) {
  return (
    <section aria-labelledby={`posthog-${dashboard.key}-title`}>
      <header className="mb-3">
        <h1 id={`posthog-${dashboard.key}-title`} className="text-xl font-bold tracking-tight">
          {dashboard.label}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">{dashboard.description}</p>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>Datos de uso de la app, medidos con PostHog. No incluye cuentas internas.</span>
          <a
            href={dashboard.dashboardUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Abrir en PostHog
            <ExternalLink className="size-3" aria-hidden />
          </a>
        </p>
        {note ? <div className="mt-2 text-sm">{note}</div> : null}
      </header>

      {config.status === 'ok' ? (
        <EmbedFrame title={dashboard.label} src={config.url} minHeight={minHeight} />
      ) : (
        <MissingConfig dashboard={dashboard} status={config.status} />
      )}
    </section>
  )
}

function MissingConfig({
  dashboard,
  status,
}: {
  dashboard: PosthogDashboard
  status: 'missing' | 'invalid'
}) {
  return (
    <div className="flex gap-3 rounded-lg border border-status-yellow/40 bg-status-yellow-bg px-4 py-3 text-sm text-status-yellow">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-1">
        <p className="font-medium">Falta configurar este tablero</p>
        <p>
          {status === 'missing' ? (
            <>
              La variable <code>{dashboard.envVar}</code> no está cargada en el entorno del servidor.
            </>
          ) : (
            <>
              La variable <code>{dashboard.envVar}</code> está cargada, pero no es un link de PostHog para
              embeber (<code>https://us.posthog.com/embedded/…</code>).
            </>
          )}{' '}
          El resto de Métricas funciona igual.
        </p>
      </div>
    </div>
  )
}

function EmbedFrame({ title, src, minHeight }: { title: string; src: string; minHeight: number }) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(minHeight)
  const [loaded, setLoaded] = useState(false)
  const [slow, setSlow] = useState(false)

  // Alto = lo que queda de la ventana debajo del iframe, menos lo que la página
  // tenga debajo de él. Se recalcula al cambiar el tamaño de la ventana.
  const fit = useCallback(() => {
    const el = wrapperRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const top = rect.top + window.scrollY
    // Lo que hay debajo = el padding inferior del <main> + lo que cuelgue después
    // del tablero. NO `scrollHeight`: con una página más corta que la ventana es
    // el alto de la ventana, y el espacio vacío se contaría como contenido.
    const main = el.closest('main')
    const padding = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0
    const lastBottom = main?.lastElementChild?.getBoundingClientRect().bottom ?? rect.bottom
    const below = padding + Math.max(0, lastBottom - rect.bottom)
    const next = Math.floor(window.innerHeight - top - below)
    setHeight(Math.max(minHeight, next))
  }, [minHeight])

  useLayoutEffect(() => {
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [fit])

  // Cambiar de tablero (otra URL) vuelve a mostrar la carga.
  useEffect(() => {
    setLoaded(false)
    setSlow(false)
    const t = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS)
    return () => window.clearTimeout(t)
  }, [src])

  return (
    <div
      ref={wrapperRef}
      className="relative overflow-hidden rounded-lg border border-border bg-card"
      style={{ height }}
    >
      {!loaded ? (
        <div
          role="status"
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-card px-4 text-center text-sm text-muted-foreground"
        >
          <Loader2 className="size-5 animate-spin" aria-hidden />
          <span>Cargando el tablero…</span>
          {slow ? (
            <span className="max-w-sm text-xs text-status-yellow">
              Está tardando más de lo normal. Si no aparece, probá «Abrir en PostHog».
            </span>
          ) : null}
        </div>
      ) : null}
      <iframe
        key={src}
        title={`Tablero de PostHog: ${title}`}
        src={src}
        onLoad={() => setLoaded(true)}
        referrerPolicy="no-referrer"
        allow="fullscreen"
        className="block size-full border-0"
      />
    </div>
  )
}
