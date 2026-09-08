import { Link, Outlet, createFileRoute } from '@tanstack/react-router'

/**
 * `/escaneres` — la sección de escáneres OBD, en dos pestañas.
 *
 * Antes era una sola pantalla (la matriz de compatibilidad). Ahora:
 *
 *  - **Compatibilidad** — la matriz catálogo × variante de escáner: "¿con qué
 *    autos anda este escáner?". Movida tal cual a `/escaneres/compatibilidad`.
 *    → `.claude/rules/scanner-compatibility.md`
 *  - **Sesiones** — todos los escaneos, uno por fila: usuario, fecha, duración,
 *    DTCs, anomalías, distancia desde el borrado, y lo demás que el escaneo
 *    extrae. Ordenable y filtrable. → `.claude/rules/scan-sessions.md`
 *
 * Las dos son SOLO LECTURA: un escaneo es un hecho que pasó, no un estado que el
 * admin mueva. Mismo patrón de layout que `/vehiculos` y `/leads`.
 *
 * SSR heredado (`true`): este layout es sólo la barra de pestañas y un
 * `<Outlet/>`.
 */
export const Route = createFileRoute('/_authed/escaneres')({
  head: () => ({ meta: [{ title: 'Escáneres — AutoLibre' }] }),
  component: EscaneresLayout,
})

const TABS = [
  { to: '/escaneres/compatibilidad', label: 'Compatibilidad' },
  { to: '/escaneres/sesiones', label: 'Sesiones' },
] as const

function EscaneresLayout() {
  return (
    <>
      <nav
        aria-label="Secciones de escáneres"
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
