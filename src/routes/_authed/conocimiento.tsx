import { Link, Outlet, createFileRoute } from '@tanstack/react-router'

/**
 * `/conocimiento` — los documentos públicos del RAG, en pestañas.
 *
 * **Documentos** es la pantalla de siempre (`conocimiento.index.tsx`): la
 * cadena de versiones y la subida por HTTP. Desde el 2026-10-29, **Cambios
 * normativos**: la cola de fichas para revisar antes de tocar un .md
 * (`conocimiento.cambios.tsx`, contra mock).
 *
 * El índice NO redirige: es la pestaña Documentos, así el ítem del nav sigue
 * apuntando a `/conocimiento`. Mismo patrón que `/notificaciones`.
 *
 * SSR heredado (`true`): este archivo es sólo la barra y un `<Outlet/>`; el
 * modo real lo fija cada pestaña.
 */
export const Route = createFileRoute('/_authed/conocimiento')({
  component: KnowledgeLayout,
})

const TABS: ReadonlyArray<{ to: string; label: string; exact?: boolean }> = [
  { to: '/conocimiento', label: 'Documentos', exact: true },
  { to: '/conocimiento/cambios', label: 'Cambios normativos' },
]

function KnowledgeLayout() {
  return (
    <>
      <nav aria-label="Secciones de conocimiento" className="mb-6 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            activeOptions={{ exact: tab.exact ?? false }}
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
