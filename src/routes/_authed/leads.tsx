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
 * ── Al 2026-09-06 sólo dos pestañas tienen datos ────────────────────────────
 *
 * "Talleres" (los `leads` del marketplace) y "Seguros" (`insurances` por
 * vencer). Las otras tres son pestañas "todavía no" A PROPÓSITO: la decisión
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

const TABS: ReadonlyArray<Tab> = [
  { to: '/leads/talleres', label: 'Talleres' },
  { to: '/leads/seguros', label: 'Seguros' },
  { to: '/leads/contactos', label: 'Contactos', soon: true },
  { to: '/leads/financiacion', label: 'Financiación', soon: true },
  { to: '/leads/pedidos', label: 'Pedidos', soon: true },
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
