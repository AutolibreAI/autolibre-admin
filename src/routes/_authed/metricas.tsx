import { Link, Outlet, createFileRoute } from '@tanstack/react-router'
import { POSTHOG_DASHBOARDS } from '~/lib/posthog-dashboards'

/**
 * `/metricas` — en pestañas desde el 2026-11-10.
 *
 * **Resumen** es la pantalla de siempre (`metricas.index.tsx`): los números de
 * la base propia. Las otras cinco son tableros de PostHog embebidos
 * (`~/components/PosthogEmbed`), uno por ruta, así cada iframe se carga recién
 * al abrir su pestaña. → `.claude/rules/metricas.md`, "Tableros de PostHog".
 *
 * El índice NO redirige: es la pestaña Resumen, así el ítem del menú, el
 * redirect post-login y `/dashboard` siguen apuntando a `/metricas`. Mismo
 * patrón que `/conocimiento` y `/notificaciones`.
 *
 * Permisos: los hereda de `_authed` (sólo `admin`), como toda la sección. La URL
 * de cada tablero además pasa por `adminMiddleware` (`~/fn/posthog-embeds`).
 *
 * SSR heredado (`true`): este archivo es sólo la barra y un `<Outlet/>`; el
 * modo real lo fija cada pestaña.
 */
export const Route = createFileRoute('/_authed/metricas')({
  component: MetricasLayout,
})

const TABS: ReadonlyArray<{ to: string; label: string; exact?: boolean }> = [
  { to: '/metricas', label: 'Resumen', exact: true },
  { to: '/metricas/uso', label: POSTHOG_DASHBOARDS.uso.label },
  { to: '/metricas/activacion', label: POSTHOG_DASHBOARDS.activacion.label },
  { to: '/metricas/pedidos', label: POSTHOG_DASHBOARDS.pedidos.label },
  { to: '/metricas/diagnostico', label: POSTHOG_DASHBOARDS.diagnostico.label },
  { to: '/metricas/demanda', label: POSTHOG_DASHBOARDS.demanda.label },
]

function MetricasLayout() {
  return (
    <>
      <nav aria-label="Secciones de métricas" className="mb-6 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            activeOptions={{ exact: tab.exact ?? false, includeSearch: false }}
            activeProps={{ className: 'border-brand text-foreground', 'aria-current': 'page' }}
            inactiveProps={{ className: 'border-transparent text-muted-foreground hover:text-foreground' }}
            className="-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors"
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </>
  )
}
