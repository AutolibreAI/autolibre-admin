import { Link, Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { SignOutButton } from '@clerk/tanstack-react-start'
import {
  Activity,
  Coins,
  Handshake,
  Inbox,
  LayoutDashboard,
  LogOut,
  Store,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Separator } from '~/components/ui/separator'

/**
 * Pathless layout route (`_authed`) — contributes no URL segment, only the
 * guard and the application shell. Everything under `src/routes/_authed/`
 * inherits both.
 *
 * Visual contract (token source: src/styles.css):
 *  - `canvas` background, `surface` sidebar, separated by a BORDER. No shadows
 *    — the design system defines elevation as zero everywhere.
 *  - Brand green appears only on the active nav item. Everything else is the
 *    grey / Action-Dark base.
 */
export const Route = createFileRoute('/_authed')({
  /**
   * TWO distinct rejections, and collapsing them into one would be a bug:
   *
   *  - No user at all → not signed in. Send them to Clerk, remembering where
   *    they were headed.
   *  - Signed in but not `admin` → a perfectly valid AutoLibre account that
   *    simply is not staff. Bouncing them to /login would loop forever, since
   *    they ARE signed in. They get told, and offered a way to switch accounts.
   *
   * Both run before any child loader, so a rejected request never reaches a
   * server function. On the server this is a redirect in the SSR response.
   */
  beforeLoad: ({ context, location }) => {
    if (!context.user) {
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
    if (context.user.role !== 'admin') {
      throw redirect({ to: '/sin-acceso' })
    }
    // Narrowing here means every child route sees `user` as a non-null admin.
    return { user: context.user }
  },
  component: AppShell,
})

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

/**
 * Single source of truth for the sidebar.
 *
 * Sections should mirror the backend's bounded contexts rather than invent an
 * admin-specific taxonomy, so that "partners" means the same thing in the
 * panel, the API and the database.
 */
const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { to: '/dashboard', label: 'Inicio', icon: LayoutDashboard },
  { to: '/solicitudes', label: 'Solicitudes', icon: Inbox },
  { to: '/partners', label: 'Partners', icon: Store },
  /**
   * `Leads` va después de `Partners` y no antes: es la dirección OPUESTA del
   * mismo contexto. `PartnerApplication` (Solicitudes) es el taller viniendo
   * hacia nosotros; `Lead` es el usuario yendo hacia el taller. Ponerlos
   * contiguos en el menú es lo que mantiene esa distinción a la vista.
   */
  { to: '/leads', label: 'Leads', icon: Handshake },
  /**
   * `Usuarios` cierra el bloque de dominio y va después de `Leads` a propósito:
   * es el OTRO extremo del mismo marketplace. Un lead sale de un usuario y
   * llega a un partner, así que las tres pantallas contiguas cubren el
   * recorrido entero — y desde la ficha del usuario se salta al partner que
   * administra, si administra alguno.
   */
  { to: '/usuarios', label: 'Usuarios', icon: Users },
  /**
   * Las dos últimas son las excepciones DECLARADAS a la regla de arriba: no
   * espejan un bounded context del backend porque el backend no tiene uno. Son
   * operación del panel.
   *
   * `Operación` lee tablas de `public` y no escribe ninguna: muestra colas
   * colgadas y motivos de falla, y manda a la pantalla donde se arregla. Su
   * única escritura es sobre `ops`, que este repo posee.
   *
   * `Costos de IA` vive entero en `ops` — el schema que este repo migra.
   */
  { to: '/operacion', label: 'Operación', icon: Activity },
  { to: '/ai-costos', label: 'Costos de IA', icon: Coins },
]

function AppShell() {
  const { user } = Route.useRouteContext()

  return (
    <div className="flex min-h-screen">
      <aside
        className="
          sticky top-0 flex h-screen w-56 shrink-0 flex-col
          border-r border-border bg-sidebar
          max-md:static max-md:h-auto max-md:w-full max-md:flex-row
          max-md:items-center max-md:justify-between max-md:border-r-0
          max-md:border-b max-md:px-4 max-md:py-3
        "
      >
        <div className="flex min-h-0 flex-1 flex-col px-3 py-5 max-md:flex-row max-md:items-center max-md:gap-4 max-md:p-0">
          <div className="px-2 max-md:px-0">
            <div className="font-heading text-base font-bold tracking-tight text-foreground">
              Auto<span className="text-brand">Libre</span>
            </div>
            <p className="text-xs text-muted-foreground max-md:hidden">Panel de administración</p>
          </div>

          <nav
            aria-label="Navegación principal"
            className="mt-6 flex flex-col gap-0.5 max-md:mt-0 max-md:flex-row max-md:flex-wrap"
          >
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                activeOptions={{ exact: to === '/dashboard' }}
                activeProps={{
                  className: 'bg-sidebar-accent text-sidebar-accent-foreground font-medium',
                  'aria-current': 'page',
                }}
                inactiveProps={{
                  className: 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                }}
                className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors"
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="px-3 pb-5 max-md:p-0">
          <Separator className="mb-3 max-md:hidden" />
          <div className="px-2 max-md:px-0 max-md:text-right">
            <div className="truncate text-sm font-medium text-foreground">{user.name}</div>
            <div className="mb-2 truncate text-xs text-muted-foreground max-md:mb-0">
              {user.email}
            </div>
            {/* Clerk owns the session, so it owns ending it. */}
            <SignOutButton redirectUrl="/">
              <Button
                variant="ghost"
                size="sm"
                className="h-auto gap-2 px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
              >
                <LogOut className="size-3.5" aria-hidden />
                Cerrar sesión
              </Button>
            </SignOutButton>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-7 pb-16 pt-6 max-md:px-4 max-md:pt-5">
        <Outlet />
      </main>
    </div>
  )
}
