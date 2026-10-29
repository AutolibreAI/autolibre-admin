import { Link, Outlet, createFileRoute } from '@tanstack/react-router'

/**
 * `/comercial` — el seguimiento comercial: los proveedores que el equipo sale
 * a buscar para el marketplace (`ops.partner_prospect`, migración 024).
 * → `.claude/rules/partner-prospects.md`
 *
 * Dos pestañas. **Hoy va primero** y es adonde redirige la raíz: es lo
 * primero que tiene que ver quien entra a trabajar (los seguimientos vencidos
 * y los del día). Contactos es el padrón entero con sus filtros.
 *
 * SSR heredado (`true`): este layout es sólo la barra de pestañas.
 */
export const Route = createFileRoute('/_authed/comercial')({
  head: () => ({ meta: [{ title: 'Seguimiento comercial — AutoLibre' }] }),
  component: ComercialLayout,
})

const TABS: ReadonlyArray<{ to: string; label: string }> = [
  { to: '/comercial/hoy', label: 'Hoy' },
  { to: '/comercial/contactos', label: 'Contactos' },
]

function ComercialLayout() {
  return (
    <>
      <nav aria-label="Seguimiento comercial" className="mb-6 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
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
