import { createFileRoute, useRouter } from '@tanstack/react-router'
import {
  PROSPECT_STATUSES,
  PROSPECT_STATUS_LABELS,
  prospectSearchSchema,
  type ProspectSearch,
} from '~/lib/partner-prospects'
import { listProspectsFn } from '~/fn/partner-prospects'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { SearchInput } from '~/components/SearchInput'
import { ProspectCard, ProspectSummaryTiles } from '~/components/ProspectCards'
import { ProspectComposer } from '~/components/ProspectComposer'
import { ProspectImporter } from '~/components/ProspectImporter'
import { ProspectsUnavailable } from '~/components/ProspectsUnavailable'
import { Button } from '~/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { formatInt } from '~/lib/format'

const ALL = '__all__'

/**
 * Contactos (`/comercial/contactos`) — todos los proveedores que contacta el
 * equipo comercial, de cualquier origen.
 *
 * Reemplaza el tablero suelto de Ruta 2 (una planilla para un solo origen) y
 * el "¿cuántos llevamos?" que hoy se cuenta a mano.
 *
 * SSR completo: el listado corta en 300 y las fechas relativas vienen de
 * Postgres. Los filtros son search params calificados `prospect*`.
 */
export const Route = createFileRoute('/_authed/comercial/contactos')({
  validateSearch: prospectSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => listProspectsFn({ data: deps }),
  head: () => ({ meta: [{ title: 'Contactos · Seguimiento comercial — AutoLibre' }] }),
  component: ContactsView,
})

function ContactsView() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { user } = Route.useRouteContext()
  const router = useRouter()

  const setSearch = (next: Partial<ProspectSearch>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  if (!data.available) return <ProspectsUnavailable />

  const filtered =
    Boolean(search.q) ||
    Boolean(search.prospectStatus) ||
    Boolean(search.prospectOrigin) ||
    Boolean(search.prospectRubro) ||
    Boolean(search.prospectOwner)

  return (
    <>
      <PageHeader
        title="Contactos"
        subtitle={`${formatInt(data.matched)} ${filtered ? 'con este filtro' : 'proveedores contactados o por contactar'}`}
        actions={
          <>
            <SsrTag>ssr: full</SsrTag>
            <ProspectImporter facets={data.facets} currentUserId={user.id} />
            <ProspectComposer facets={data.facets} currentUserId={user.id} />
          </>
        }
      />

      <ProspectSummaryTiles summary={data.summary} />

      <div className="mb-5 space-y-4">
        <div className="flex flex-wrap items-end gap-5">
          <SearchInput
            label="Buscar"
            placeholder="Nombre, teléfono, localidad o con quién hablé"
            value={search.q}
            onSearch={(q) => setSearch({ q })}
          />

          <div className="space-y-1.5">
            <label htmlFor="pp-rubro" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Rubro
            </label>
            <Select
              value={search.prospectRubro ?? ALL}
              onValueChange={(v) => setSearch({ prospectRubro: v === ALL ? undefined : v })}
            >
              <SelectTrigger id="pp-rubro" className="h-8 w-56 shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos</SelectItem>
                {data.facets.categories.map((c) => (
                  <SelectItem key={c.slug} value={c.slug}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {filtered ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() =>
                setSearch({
                  q: undefined,
                  prospectStatus: undefined,
                  prospectOrigin: undefined,
                  prospectRubro: undefined,
                  prospectOwner: undefined,
                })
              }
            >
              Limpiar todo
            </Button>
          ) : null}
        </div>

        <FilterGroup
          label="Estado"
          onClear={search.prospectStatus ? () => setSearch({ prospectStatus: undefined }) : undefined}
        >
          {PROSPECT_STATUSES.map((s) => (
            <Chip
              key={s}
              active={search.prospectStatus === s}
              onClick={() => setSearch({ prospectStatus: search.prospectStatus === s ? undefined : s })}
            >
              {PROSPECT_STATUS_LABELS[s]}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup
          label="Origen"
          onClear={search.prospectOrigin ? () => setSearch({ prospectOrigin: undefined }) : undefined}
        >
          {data.facets.origins.map((o) => (
            <Chip
              key={o.slug}
              active={search.prospectOrigin === o.slug}
              onClick={() => setSearch({ prospectOrigin: search.prospectOrigin === o.slug ? undefined : o.slug })}
            >
              {o.label}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup
          label="Comercial"
          onClear={search.prospectOwner ? () => setSearch({ prospectOwner: undefined }) : undefined}
        >
          {data.facets.owners.map((o) => (
            <Chip
              key={o.id}
              active={search.prospectOwner === o.id}
              onClick={() => setSearch({ prospectOwner: search.prospectOwner === o.id ? undefined : o.id })}
            >
              {o.id === user.id ? `${o.name} (vos)` : o.name}
            </Chip>
          ))}
          <Chip
            active={search.prospectOwner === 'none'}
            onClick={() => setSearch({ prospectOwner: search.prospectOwner === 'none' ? undefined : 'none' })}
          >
            Sin asignar
          </Chip>
        </FilterGroup>
      </div>

      {data.rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          {filtered ? 'Ningún contacto con este filtro.' : 'Todavía no hay contactos. Cargá uno o importá un CSV.'}
        </p>
      ) : (
        <div className="space-y-3">
          {data.rows.map((p) => (
            <ProspectCard
              key={p.id}
              prospect={p}
              facets={data.facets}
              onListChanged={() => void router.invalidate()}
            />
          ))}
          {data.matched > data.rows.length ? (
            <p className="text-sm text-muted-foreground">
              Se muestran {formatInt(data.rows.length)} de {formatInt(data.matched)}. Filtrá por origen, estado o
              rubro para ver el resto.
            </p>
          ) : null}
        </div>
      )}
    </>
  )
}
