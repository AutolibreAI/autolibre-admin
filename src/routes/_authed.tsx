import { useState } from "react";
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
} from "@tanstack/react-router";
import { SignOutButton } from "@clerk/tanstack-react-start";
import {
  Activity,
  Car,
  Coins,
  FileText,
  Handshake,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  ScanLine,
  Store,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "~/components/ui/sheet";

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
 *
 * Responsive contract:
 *  - `md` and up: a fixed vertical sidebar, always visible.
 *  - below `md`: a compact sticky top bar with a hamburger that opens the same
 *    nav as a left drawer (`Sheet`). Twelve items do not fit a wrapping bar or
 *    a bottom tab row without either eating the viewport or splitting the menu
 *    in two.
 */
export const Route = createFileRoute("/_authed")({
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
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
    if (context.user.role !== "admin") {
      throw redirect({ to: "/sin-acceso" });
    }
    // Narrowing here means every child route sees `user` as a non-null admin.
    return { user: context.user };
  },
  component: AppShell,
});

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Single source of truth for the sidebar.
 *
 * Sections should mirror the backend's bounded contexts rather than invent an
 * admin-specific taxonomy, so that "partners" means the same thing in the
 * panel, the API and the database.
 */
const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { to: "/dashboard", label: "Inicio", icon: LayoutDashboard },
  { to: "/solicitudes", label: "Solicitudes", icon: Inbox },
  { to: "/partners", label: "Partners", icon: Store },
  /**
   * `Leads` va después de `Partners` y no antes: es la dirección OPUESTA del
   * mismo contexto. `PartnerApplication` (Solicitudes) es el taller viniendo
   * hacia nosotros; `Lead` es el usuario yendo hacia el taller. Ponerlos
   * contiguos en el menú es lo que mantiene esa distinción a la vista.
   */
  { to: "/leads", label: "Leads", icon: Handshake },
  /**
   * `Usuarios` cierra el bloque de dominio y va después de `Leads` a propósito:
   * es el OTRO extremo del mismo marketplace. Un lead sale de un usuario y
   * llega a un partner, así que las tres pantallas contiguas cubren el
   * recorrido entero — y desde la ficha del usuario se salta al partner que
   * administra, si administra alguno.
   */
  { to: "/usuarios", label: "Usuarios", icon: Users },
  /**
   * `Vehículos` cierra el bloque de dominio, y va último de ese bloque porque es
   * el único que NO es marketplace: es `vehicle-management`, el bounded context
   * de los vehículos. Las cuatro de arriba cubren el recorrido taller ↔ usuario;
   * ésta cubre el auto.
   *
   * Tiene tres pestañas (Catálogo · Listado · Métricas). El Catálogo —que era
   * `/catalogo`, ahora `/vehiculos/catalogo`— es la ÚNICA pantalla del panel
   * cuyas escrituras no son SQL: sube PDFs por HTTP contra el backend hex,
   * porque el archivo va a DigitalOcean Spaces y ninguna cantidad de SQL lo
   * pone ahí. → `.claude/rules/vehicle-manuals.md`
   */
  { to: "/vehiculos", label: "Vehículos", icon: Car },
  /**
   * `Escáneres` va pegada a `Vehículos` porque comparte su eje vertical: las
   * filas de esa matriz SON los modelos del catálogo. Las dos contestan sobre
   * el auto, no sobre el marketplace ni sobre la persona.
   *
   * Es la única pantalla del panel que no mira un estado que alguien mueve,
   * sino un hecho acumulado: qué hardware enganchó con qué auto. Por eso no
   * tiene ni una acción — no hay nada que corregir en una sesión que ya pasó.
   * → `.claude/rules/scanner-compatibility.md`
   */
  { to: "/escaneres", label: "Escáneres", icon: ScanLine },
  /**
   * `Documentos` cierra el bloque de `vehicle-management`: son los cuatro
   * aggregates de documento —Insurance, RegistrationCard, DriverLicense,
   * VehicleInspection— cuyos campos el backend llena por OCR. La pantalla es de
   * REVISIÓN, no un CRUD: el OCR falla y hay que poder verlo contra los datos
   * reales del vehículo. Editar desde el panel es un paso aparte (necesita un
   * SP de `ops` con auditoría), así que hoy es read-only.
   */
  { to: "/documentos", label: "Documentos", icon: FileText },
  /**
   * `Chats de IA` es el último bloque de dominio y no encaja en ninguno de
   * los dos de arriba: `conversations` cuelga de `assistant/`, un bounded
   * context propio, no de `vehicle-management`. Va acá y no junto a
   * `Usuarios` porque la pregunta no es "qué tiene este usuario" — eso ya
   * está en su ficha — es "qué chats hay", con el usuario como una columna
   * más.
   */
  { to: "/chats", label: "Chats de IA", icon: MessageSquare },
  /**
   * Las tres últimas son las excepciones DECLARADAS a la regla de arriba: no
   * espejan un bounded context del backend porque el backend no tiene uno. Son
   * operación / analítica del panel.
   *
   * `Gráficos` es la curva de crecimiento —usuarios y vehículos período a
   * período— agregada a mano sobre `users`/`vehicles` de `public`, mismo
   * criterio que `Operación`. Es lo que `Inicio` no muestra: la tendencia, no
   * el snapshot.
   *
   * `Operación` lee tablas de `public` y no escribe ninguna: muestra colas
   * colgadas y motivos de falla, y manda a la pantalla donde se arregla. Su
   * única escritura es sobre `ops`, que este repo posee.
   *
   * `Costos de IA` vive entero en `ops` — el schema que este repo migra.
   */
  { to: "/graficos", label: "Gráficos", icon: TrendingUp },
  { to: "/operacion", label: "Operación", icon: Activity },
  { to: "/ai-costos", label: "Costos de IA", icon: Coins },
];

function Wordmark() {
  return (
    <div>
      <div className="font-heading text-base font-bold tracking-tight text-foreground">
        Auto<span className="text-brand">Libre</span>
      </div>
      <p className="text-xs text-muted-foreground">Panel de administración</p>
    </div>
  );
}

/**
 * La lista de navegación, una sola definición para la sidebar y el drawer.
 *
 * `onNavigate` lo pasa sólo el drawer: elegir un destino tiene que cerrarlo.
 * En la sidebar de escritorio no hay nada que cerrar, así que no se pasa.
 */
function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav
      aria-label="Navegación principal"
      className="flex flex-col gap-0.5"
    >
      {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          onClick={onNavigate}
          activeOptions={{ exact: to === "/dashboard" }}
          activeProps={{
            className:
              "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
            "aria-current": "page",
          }}
          inactiveProps={{
            className:
              "text-muted-foreground hover:bg-secondary hover:text-foreground",
          }}
          className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors"
        >
          <Icon className="size-4 shrink-0" aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );
}

function UserFooter({ name, email }: { name: string; email: string }) {
  return (
    <div className="px-2">
      <div className="truncate text-sm font-medium text-foreground">{name}</div>
      <div className="mb-2 truncate text-xs text-muted-foreground">{email}</div>
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
  );
}

function AppShell() {
  const { user } = Route.useRouteContext();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* ── Sidebar (md+) ──────────────────────────────────────────────── */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
        <div className="flex min-h-0 flex-1 flex-col px-3 py-5">
          <div className="px-2">
            <Wordmark />
          </div>
          <div className="mt-6">
            <NavLinks />
          </div>
        </div>
        <div className="px-3 pb-5">
          <Separator className="mb-3" />
          <UserFooter name={user.name} email={user.email} />
        </div>
      </aside>

      {/* ── Top bar + drawer (< md) ────────────────────────────────────── */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-border bg-sidebar px-4 py-3 md:hidden">
        <Wordmark />
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="border border-border text-muted-foreground hover:text-foreground"
              aria-label="Abrir navegación"
            >
              <Menu className="size-5" aria-hidden />
            </Button>
          </SheetTrigger>
          <SheetContent className="p-0">
            <div className="flex h-full flex-col">
              <div className="border-b border-border px-4 py-4">
                <SheetTitle>
                  Auto<span className="text-brand">Libre</span>
                </SheetTitle>
                <SheetDescription>Panel de administración</SheetDescription>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
                <NavLinks onNavigate={() => setMenuOpen(false)} />
              </div>
              <div className="border-t border-border px-3 py-4">
                <UserFooter name={user.name} email={user.email} />
              </div>
            </div>
          </SheetContent>
        </Sheet>
      </header>

      <main className="min-w-0 flex-1 px-4 pb-16 pt-5 md:px-7 md:pt-6">
        <Outlet />
      </main>
    </div>
  );
}
