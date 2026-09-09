import { Link, createFileRoute } from '@tanstack/react-router'
import { EyeOff, X } from 'lucide-react'
import {
  PARTNER_STATUS_FILTERS,
  PARTNER_STATUS_FILTER_LABELS,
  partnerSearchSchema,
} from '~/lib/catalog'
import { getServiceCatalog, listMarketplacePartners } from '~/fn/partners'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { SortHeader } from '~/components/SortHeader'
import { Badge } from '~/components/ui/badge'
import { Input } from '~/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { PartnerListItem } from '~/lib/catalog'

const TO = '/partners/listado'

/**
 * Consulta 7 del runbook, ampliada: el directorio con qué RUBROS (las 16
 * `service_categories`) y cuántos SERVICIOS (`services`) cubre cada partner,
 * ordenable y filtrable por esas columnas.
 *
 * El default `sort=services asc` mantiene la regla de `partner-approval.md`: los
 * de cero rubros van primero porque son los rotos. Un listado que arranca
 * alfabético los esconde en el medio.
 */
export const Route = createFileRoute('/_authed/partners/listado')({
  validateSearch: partnerSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal
    const [partners, catalog] = await Promise.all([
      listMarketplacePartners({ data: deps, signal }),
      getServiceCatalog({ signal }),
    ])
    return { partners, catalog }
  },
  head: () => ({ meta: [{ title: 'Partners · Listado — AutoLibre' }] }),
  component: PartnersListado,
})

function PartnersListado() {
  const { partners, catalog } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  // `resetScroll: false`: tocar un chip de rubro adentro de una fila no debe
  // saltar al tope de la tabla.
  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  const invisibleCount = partners.filter((p) => p.invisible).length

  const activeService =
    search.service != null
      ? catalog
          .flatMap((f) => f.services)
          .find((s) => s.slug === search.service)
      : undefined

  const filtered =
    Boolean(search.q) ||
    search.onlyInvisible ||
    search.partnerStatus !== 'all' ||
    search.category != null ||
    search.service != null

  return (
    <>
      <PageHeader
        title="Listado"
        subtitle={`${formatInt(partners.length)} ${filtered ? 'con este filtro' : 'partners'}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <div className="mb-4 flex flex-wrap items-end gap-5">
        <div className="space-y-1.5">
          <label
            htmlFor="q"
            className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            Buscar
          </label>
          <Input
            id="q"
            type="search"
            placeholder="Nombre del taller"
            defaultValue={search.q ?? ''}
            className="w-56"
            onChange={(e) => {
              const value = e.currentTarget.value.trim()
              setSearch({ q: value === '' ? undefined : value })
            }}
          />
        </div>

        <FilterGroup label="Estado">
          {PARTNER_STATUS_FILTERS.map((s) => (
            <Chip
              key={s}
              active={search.partnerStatus === s}
              onClick={() => setSearch({ partnerStatus: s })}
            >
              {PARTNER_STATUS_FILTER_LABELS[s]}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="Rubro">
          <Chip active={search.category == null} onClick={() => setSearch({ category: undefined })}>
            Todos
          </Chip>
          {catalog.map((fam) => (
            <Chip
              key={fam.slug}
              active={search.category === fam.slug}
              onClick={() =>
                setSearch({
                  category: search.category === fam.slug ? undefined : fam.slug,
                })
              }
            >
              {fam.name}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="Sin rubros">
          <Chip
            tone="warn"
            active={search.onlyInvisible}
            onClick={() => setSearch({ onlyInvisible: !search.onlyInvisible })}
          >
            <EyeOff className="size-3.5" aria-hidden />
            Solo invisibles
            {invisibleCount > 0 && !search.onlyInvisible ? ` (${invisibleCount})` : ''}
          </Chip>
        </FilterGroup>
      </div>

      {search.service != null ? (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setSearch({ service: undefined })}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-brand bg-brand-soft px-2.5 text-xs text-brand"
          >
            Servicio: {activeService?.name ?? search.service}
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : null}

      {partners.length === 0 ? (
        <div className="rounded-lg border border-border bg-card py-16 text-center text-sm text-muted-foreground">
          {search.onlyInvisible
            ? 'Ningún partner quedó sin rubros. Eso es lo esperable.'
            : 'No hay partners con ese filtro.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table className="min-w-[1000px]">
            <TableHeader>
              <TableRow>
                <SortHeader
                  label="Partner"
                  sortKey="name"
                  active={search.sort === 'name'}
                  dir={search.dir}
                  to={TO}
                />
                <SortHeader
                  label="Zona de cobertura"
                  sortKey="zone"
                  active={search.sort === 'zone'}
                  dir={search.dir}
                  to={TO}
                />
                <SortHeader
                  label="Estado"
                  sortKey="status"
                  active={search.sort === 'status'}
                  dir={search.dir}
                  to={TO}
                />
                <TableHead>Rubros</TableHead>
                <SortHeader
                  label="Nº rubros"
                  sortKey="categories"
                  active={search.sort === 'categories'}
                  dir={search.dir}
                  to={TO}
                  align="right"
                  firstClick="desc"
                />
                <SortHeader
                  label="Servicios"
                  sortKey="services"
                  active={search.sort === 'services'}
                  dir={search.dir}
                  to={TO}
                  align="right"
                  firstClick="desc"
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {partners.map((p) => (
                <Row
                  key={p.id}
                  partner={p}
                  activeCategory={search.category}
                  onToggleCategory={(slug) =>
                    setSearch({ category: search.category === slug ? undefined : slug })
                  }
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  )
}

function Row({
  partner,
  activeCategory,
  onToggleCategory,
}: {
  partner: PartnerListItem
  activeCategory?: string
  onToggleCategory: (slug: string) => void
}) {
  return (
    <TableRow className={cn(partner.invisible && 'bg-status-red-bg/40')}>
      <TableCell>
        <Link
          to="/partners/$partnerId"
          params={{ partnerId: partner.id }}
          className="font-medium hover:text-brand hover:underline"
        >
          {partner.name}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground">{partner.coverageZone}</TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className={
            partner.status === 'active'
              ? 'bg-status-green-bg text-status-green border-status-green/20'
              : 'bg-secondary text-muted-foreground border-border'
          }
        >
          {partner.status}
        </Badge>
      </TableCell>
      <TableCell>
        {partner.invisible ? (
          <span className="inline-flex items-center gap-1.5 text-status-red">
            <EyeOff className="size-3.5" aria-hidden />
            invisible
          </span>
        ) : (
          <div className="flex max-w-[28rem] flex-wrap gap-1">
            {partner.categories.map((c) => (
              <button
                key={c.slug}
                type="button"
                onClick={() => onToggleCategory(c.slug)}
                className={cn(
                  'rounded border px-1.5 py-px text-xs transition-colors',
                  c.slug === activeCategory
                    ? 'border-brand bg-brand-soft text-brand'
                    : 'border-border text-muted-foreground hover:border-foreground/20 hover:text-foreground',
                )}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <span className={cn(partner.categoryCount === 0 && 'text-status-red')}>
          {partner.categoryCount}
        </span>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <span className={cn(partner.serviceCount === 0 && 'text-status-red')}>
          {partner.serviceCount}
        </span>
      </TableCell>
    </TableRow>
  )
}
