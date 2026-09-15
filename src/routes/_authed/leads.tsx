import { Link, Outlet, createFileRoute } from '@tanstack/react-router'

/**
 * `/leads` — el hub de las líneas de captación, en pestañas.
 *
 * ── Ojo con el vocabulario ──────────────────────────────────────────────────
 *
 * "Sección de leads" acá es la vista de PRODUCTO: cada pestaña es una línea por
 * la que un usuario puede llegar a pedirnos algo. El `Lead` del backend —el
 * enum `lead_status`, el embudo usuario→taller— es UNA de ellas: la pestaña
 * "Talleres". Las otras cuatro NO son `Lead`s y su código no dice `Lead`.
 * → `.claude/rules/leads.md`
 *
 * ── Al 2026-09-14 cuatro pestañas leen tablas reales ───────────────────────
 *
 * "Talleres" (los `leads` del marketplace), "Seguros" (`insurances` por vencer),
 * "Multas" (`fines` por vehículo consultado) y "Pedidos" (`quote_requests` —
 * escrita contra la tabla real, que al 2026-09-14 existe en DEV y todavía no en
 * producción; la pestaña lo dice con un guard, no con datos de ejemplo). Las
 * otras dos son pestañas "todavía no" A PROPÓSITO: la decisión
 * fue mostrarlas, no esconderlas hasta que existan, para que quede a la vista
 * qué líneas hay como plan y qué falta para cada una. Ver `.claude/rules/leads.md`.
 *
 * SSR heredado (`true`): este layout es sólo la barra de pestañas y un
 * `<Outlet/>`; el modo real lo fija cada pestaña en su archivo.
 */
export const Route = createFileRoute('/_authed/leads')({
  head: () => ({ meta: [{ title: 'Leads — AutoLibre' }] }),
  component: LeadsLayout,
})

interface Tab {
  to: string
  label: string
  /** `true` = todavía sin datos: se marca en la barra con un chip "pronto". */
  soon?: boolean
}

// `Pedidos` va primero porque `leads.index.tsx` redirige ahí: es la pestaña
// default al entrar a `/leads`. `Talleres` va último a pedido — el embudo del
// marketplace (0 filas en producción al 2026-09-14) es hoy la línea con menos
// actividad de las seis.
const TABS: ReadonlyArray<Tab> = [
  { to: '/leads/pedidos', label: 'Pedidos' },
  { to: '/leads/seguros', label: 'Seguros' },
  { to: '/leads/multas', label: 'Multas' },
  { to: '/leads/contactos', label: 'Contactos', soon: true },
  { to: '/leads/financiacion', label: 'Financiación', soon: true },
  { to: '/leads/talleres', label: 'Talleres' },
]

function LeadsLayout() {
  return (
    <>
      <nav
        aria-label="Líneas de captación"
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
            {tab.soon ? (
              <span className="rounded-full border border-border px-1.5 py-px text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
                pronto
              </span>
            ) : null}
          </Link>
        ))}
      </nav>

      <Outlet />
    </>
  )
}
