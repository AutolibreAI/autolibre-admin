import { createFileRoute } from '@tanstack/react-router'
import { AGENCY_STATUSES, AGENCY_STATUS_LABELS, agencySearchSchema, type AgencySearch } from '~/lib/chasis-agencies'
import { listAgenciesFn } from '~/fn/chasis-agencies'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { MultiSelect } from '~/components/MultiSelect'
import { SearchInput } from '~/components/SearchInput'
import { AgencyCard, AgencyComposer, AgencySummaryBlock } from '~/components/ChasisAgencies'
import { ProspectsUnavailable } from '~/components/ProspectsUnavailable'
import { Button } from '~/components/ui/button'
import { formatInt } from '~/lib/format'

/**
 * API Chasis (`/comercial/api-chasis`) — las agencias a las que se les ofrece
 * la API de datos vehiculares (`ops.chasis_agency`, migración 031), con el
 * resumen arriba: por estado, clientes, referidos cargados, consultas/mes del
 * pipeline y objeciones. Reemplaza la planilla aparte de agencias.
 *
 * `comercial.api-chasis.index.tsx` y no `comercial.api-chasis.tsx`: la ficha
 * (`$agencyId`) quedaría anidada en un `<Outlet/>` que el listado no tiene
 * (`scan-sessions.md`).
 *
 * SSR completo: "vencido hace N días" lo calcula Postgres en hora de Buenos
 * Aires. Search params calificados `agency*`. → `.claude/rules/partner-prospects.md`
 */
export const Route = createFileRoute('/_authed/comercial/api-chasis/')({
  validateSearch: agencySearchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => listAgenciesFn({ data: deps }),
  head: () => ({ meta: [{ title: 'API Chasis · Seguimiento comercial — AutoLibre' }] }),
  component: AgenciesView,
})

function AgenciesView() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { user } = Route.useRouteContext()

  const setSearch = (next: Partial<AgencySearch>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  if (!data.available) return <ProspectsUnavailable missing={data.missing} />

  const filtered =
    Boolean(search.q) || Boolean(search.agencyStatus) || search.agencyZones.length > 0 || Boolean(search.agencyOwner)

  return (
    <>
      <PageHeader
        title="API Chasis"
        subtitle={`${formatInt(data.matched)} ${filtered ? 'agencias con este filtro' : 'agencias'}`}
        actions={
          <>
            <SsrTag>ssr: full</SsrTag>
            <AgencyComposer facets={data.facets} currentUserId={user.id} />
          </>
        }
      />

      <AgencySummaryBlock summary={data.summary} />

      <div className="mb-5 space-y-4">
        <div className="flex flex-wrap items-end gap-5">
          <SearchInput
            label="Buscar"
            placeholder="Agencia, contacto, teléfono o zona"
            value={search.q}
            onSearch={(q) => setSearch({ q })}
          />
          <div className="space-y-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Zona</span>
            <MultiSelect
              label="Zona"
              options={data.facets.localities.map((l) => ({ value: l, label: l }))}
              selected={search.agencyZones}
              onChange={(next) => setSearch({ agencyZones: next })}
              placeholder="Todas"
              className="w-52"
            />
          </div>
          {filtered ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() => setSearch({ q: undefined, agencyStatus: undefined, agencyZones: [], agencyOwner: undefined })}
            >
              Limpiar todo
            </Button>
          ) : null}
        </div>

        <FilterGroup
          label="Estado"
          onClear={search.agencyStatus ? () => setSearch({ agencyStatus: undefined }) : undefined}
        >
          {AGENCY_STATUSES.map((s) => (
            <Chip
              key={s}
              active={search.agencyStatus === s}
              onClick={() => setSearch({ agencyStatus: search.agencyStatus === s ? undefined : s })}
            >
              {AGENCY_STATUS_LABELS[s]}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup
          label="Conseguido por"
          onClear={search.agencyOwner ? () => setSearch({ agencyOwner: undefined }) : undefined}
        >
          {data.facets.owners.map((o) => (
            <Chip
              key={o.id}
              active={search.agencyOwner === o.id}
              onClick={() => setSearch({ agencyOwner: search.agencyOwner === o.id ? undefined : o.id })}
            >
              {o.id === user.id ? `${o.name} (vos)` : o.name}
            </Chip>
          ))}
          <Chip
            active={search.agencyOwner === 'none'}
            onClick={() => setSearch({ agencyOwner: search.agencyOwner === 'none' ? undefined : 'none' })}
          >
            Sin asignar
          </Chip>
        </FilterGroup>
      </div>

      {data.rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          {filtered ? 'Ninguna agencia con este filtro.' : 'Todavía no hay agencias. Cargá la primera.'}
        </p>
      ) : (
        <div className="space-y-3">
          {data.rows.map((a) => (
            <AgencyCard key={a.id} agency={a} facets={data.facets} />
          ))}
          {data.matched > data.rows.length ? (
            <p className="text-sm text-muted-foreground">
              Se muestran {formatInt(data.rows.length)} de {formatInt(data.matched)}. Filtrá para ver el resto.
            </p>
          ) : null}
        </div>
      )}
    </>
  )
}
