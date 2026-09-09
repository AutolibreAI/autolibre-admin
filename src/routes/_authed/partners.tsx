import { Link, Outlet, createFileRoute } from '@tanstack/react-router'

/**
 * `/partners` — el directorio del marketplace, en pestañas.
 *
 * Antes era una sola pantalla (la consulta 7 del runbook: qué rubros tiene cada
 * partner). Ahora esa tabla es la pestaña **Listado**, y al lado va
 * **Cobertura**: el tablero que cruza los 16 rubros contra la zona de cada
 * partner para ver qué oferta está cubierta y cuál hay que salir a capturar.
 * Mismo patrón de layout que `/leads` y `/vehiculos`.
 *
 * La ficha de un partner (`/partners/$partnerId`, consultas 7 y 8: el editor de
 * rubros) cuelga de acá también, así que hereda la barra — igual que
 * `/vehiculos/catalogo/:id` hereda la de Vehículos.
 *
 * SSR heredado (`true`): este archivo es sólo la barra y un `<Outlet/>`; el
 * modo real lo fija cada pestaña.
 */
export const Route = createFileRoute('/_authed/partners')({
  head: () => ({ meta: [{ title: 'Partners — AutoLibre' }] }),
  component: PartnersLayout,
})

interface Tab {
  to: string
  label: string
}

const TABS: ReadonlyArray<Tab> = [
  { to: '/partners/listado', label: 'Listado' },
  { to: '/partners/cobertura', label: 'Cobertura' },
]

function PartnersLayout() {
  return (
    <>
      <nav
        aria-label="Secciones de partners"
        className="mb-6 flex flex-wrap gap-1 border-b border-border"
      >
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
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
