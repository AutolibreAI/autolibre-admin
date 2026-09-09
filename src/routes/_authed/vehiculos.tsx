import { Link, Outlet, createFileRoute } from '@tanstack/react-router'

/**
 * `/vehiculos` — el bloque de `vehicle-management`, en tres pestañas.
 *
 * Antes se llamaba `/catalogo` y era una sola pantalla. Ahora la sección se
 * llama Vehículos y el catálogo es una de sus tres pestañas:
 *
 *  - **Catálogo** — los modelos (`vehicle_catalogs`) y sus manuales. Lo que
 *    estaba en `/catalogo`, movido tal cual a `/vehiculos/catalogo`. Sigue
 *    siendo la ÚNICA pantalla del panel cuyas escrituras no son SQL (sube PDFs
 *    por HTTP al backend hex). → `.claude/rules/vehicle-manuals.md`
 *  - **Listado** — cada `vehicles` cargado en el sistema, uno por fila, sin
 *    deduplicar. Con lo que cuelga de cada auto: VTV, seguro, multas, deuda,
 *    tareas, escaneos.
 *  - **Flota** — los `vehicles` agrupados por modelo del catálogo: cuántos autos
 *    de cada uno, y las métricas que eso habilita. La ruta sigue siendo
 *    `/vehiculos/metricas`; sólo la etiqueta es "Flota", para no chocar con el
 *    ítem de nav de primer nivel "Métricas".
 *
 * `/escaneres` NO es una pestaña de acá aunque comparta el eje (los modelos del
 * catálogo): es un hecho acumulado (qué hardware enganchó con qué auto), no un
 * estado, y merece su propio ítem de nav.
 *
 * SSR heredado (`true`): este layout es sólo la barra de pestañas y un
 * `<Outlet/>`.
 */
export const Route = createFileRoute('/_authed/vehiculos')({
  head: () => ({ meta: [{ title: 'Vehículos — AutoLibre' }] }),
  component: VehiculosLayout,
})

interface Tab {
  to: string
  label: string
}

const TABS: ReadonlyArray<Tab> = [
  { to: '/vehiculos/catalogo', label: 'Catálogo' },
  { to: '/vehiculos/listado', label: 'Listado' },
  { to: '/vehiculos/metricas', label: 'Flota' },
]

function VehiculosLayout() {
  return (
    <>
      <nav
        aria-label="Secciones de vehículos"
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
