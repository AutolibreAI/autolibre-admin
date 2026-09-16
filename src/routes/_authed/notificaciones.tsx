import { Link, Outlet, createFileRoute } from '@tanstack/react-router'

/**
 * `/notificaciones` — la sección, en dos pestañas.
 *
 *  - **Historial** (`/notificaciones`, la de siempre) — una fila por
 *    notificación: de qué le avisamos a quién y si le llegó. Es donde cae
 *    `?userId=…` desde la ficha de un usuario, así que sigue siendo el índice y
 *    NO redirige a ningún lado. → `.claude/rules/notifications.md`
 *  - **Envíos** (`/notificaciones/envios`) — los envíos ad-hoc agrupados, con lo
 *    que pasó después de cada uno. → `~/lib/campaigns`
 *
 * ── Por qué el índice no redirige, a diferencia de `/leads` y `/vehiculos` ───
 *
 * Esos layouts mandan a su primera pestaña porque nadie linkeaba a la raíz. Acá
 * sí: `usuarios.$userId.tsx` y `/operacion` apuntan a `/notificaciones` con
 * search params, y un redirect los haría rebotar (un salto de más, y los search
 * params a merced de que el redirect los conserve). El índice ES el historial.
 *
 * SSR heredado (`true`): este layout es la barra de pestañas y un `<Outlet/>`.
 */
export const Route = createFileRoute('/_authed/notificaciones')({
  head: () => ({ meta: [{ title: 'Notificaciones — AutoLibre' }] }),
  component: NotificationsLayout,
})

const TABS = [
  /**
   * `exact` sólo en el índice: sin eso, «Historial» queda marcada como activa
   * también cuando se está mirando un envío — `/notificaciones/envios` empieza
   * con `/notificaciones`.
   */
  { to: '/notificaciones', label: 'Historial', exact: true },
  { to: '/notificaciones/envios', label: 'Envíos', exact: false },
] as const

function NotificationsLayout() {
  return (
    <>
      <nav
        aria-label="Secciones de notificaciones"
        className="mb-6 flex flex-wrap gap-1 border-b border-border"
      >
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            activeOptions={{ exact: tab.exact }}
            activeProps={{
              className: 'border-brand text-foreground',
              'aria-current': 'page',
            }}
            inactiveProps={{
              className: 'border-transparent text-muted-foreground hover:text-foreground',
            }}
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
