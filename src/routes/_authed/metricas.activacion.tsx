import { createFileRoute } from '@tanstack/react-router'
import { PosthogEmbed } from '~/components/PosthogEmbed'
import { getPosthogEmbedFn } from '~/fn/posthog-embeds'
import { POSTHOG_DASHBOARDS } from '~/lib/posthog-dashboards'

const dashboard = POSTHOG_DASHBOARDS.activacion

/** Métricas › Activación: un tablero de PostHog embebido. → `.claude/rules/metricas.md` */
export const Route = createFileRoute('/_authed/metricas/activacion')({
  /**
   * SSR MODE: 'data-only'. El loader (la URL del tablero, detrás de
   * `adminMiddleware`) corre en el servidor; el iframe se arma recién en el
   * navegador. Un iframe en el HTML del servidor puede cargar antes de la
   * hidratación y su `onLoad` no llegaría nunca: el cartel de carga quedaría fijo.
   */
  ssr: 'data-only',
  head: () => ({ meta: [{ title: `${dashboard.label} · Métricas — AutoLibre` }] }),
  loader: ({ abortController }) =>
    getPosthogEmbedFn({ data: { key: 'activacion' }, signal: abortController.signal }),
  component: ActivacionTab,
})

function ActivacionTab() {
  const config = Route.useLoaderData()
  return <PosthogEmbed dashboard={dashboard} config={config} />
}
