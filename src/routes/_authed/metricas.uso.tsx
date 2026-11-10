import { Link, createFileRoute } from '@tanstack/react-router'
import { PosthogEmbed } from '~/components/PosthogEmbed'
import { getPosthogEmbedFn } from '~/fn/posthog-embeds'
import { POSTHOG_DASHBOARDS } from '~/lib/posthog-dashboards'

const dashboard = POSTHOG_DASHBOARDS.uso

/**
 * Métricas › Uso y retención: un tablero de PostHog embebido.
 *
 * «Activo» acá es por APERTURA de la app (PostHog). El gráfico «Usuarios
 * activos» de Resumen es por ACCIONES guardadas en Postgres
 * (`activeUsersSeries`). Son dos definiciones y no se mezclan: la pestaña lo
 * dice arriba del tablero. → `.claude/rules/metricas.md`
 */
export const Route = createFileRoute('/_authed/metricas/uso')({
  /**
   * SSR MODE: 'data-only'. El loader (la URL del tablero, detrás de
   * `adminMiddleware`) corre en el servidor; el iframe se arma recién en el
   * navegador. Un iframe en el HTML del servidor puede cargar antes de la
   * hidratación y su `onLoad` no llegaría nunca: el cartel de carga quedaría fijo.
   */
  ssr: 'data-only',
  head: () => ({ meta: [{ title: `${dashboard.label} · Métricas — AutoLibre` }] }),
  loader: ({ abortController }) =>
    getPosthogEmbedFn({ data: { key: 'uso' }, signal: abortController.signal }),
  component: UsoTab,
})

function UsoTab() {
  const config = Route.useLoaderData()
  return (
    <PosthogEmbed
      dashboard={dashboard}
      config={config}
      note={
        <p className="rounded-lg border border-border bg-surface-2 px-3 py-2">
          <strong className="font-semibold">Activo = abrió la app ese día.</strong>{' '}
          <span className="text-muted-foreground">
            No es el mismo número que «Usuarios activos» de{' '}
            <Link to="/metricas" className="underline underline-offset-2">
              Resumen
            </Link>
            , que cuenta a quien hizo algo que quedó guardado en la base (o cuyo teléfono renovó el
            token de notificaciones). Miden cosas distintas: no se suman ni se comparan.
          </span>
        </p>
      }
    />
  )
}
