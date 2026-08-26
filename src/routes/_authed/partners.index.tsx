import { Link, createFileRoute } from '@tanstack/react-router'
import { EyeOff } from 'lucide-react'
import { partnerSearchSchema } from '~/lib/catalog'
import { listMarketplacePartners } from '~/fn/partners'
import { PageHeader, SsrTag } from '~/components/PageHeader'
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
import { cn } from '~/lib/utils'
import type { PartnerListItem } from '~/lib/catalog'

export const Route = createFileRoute('/_authed/partners/')({
  validateSearch: partnerSearchSchema,
  loaderDeps: ({ search }) => search,

  loader: ({ deps, abortController }) =>
    listMarketplacePartners({ data: deps, signal: abortController.signal }),

  head: () => ({ meta: [{ title: 'Partners — AutoLibre' }] }),
  component: PartnersList,
})

/**
 * Consulta 7 del runbook: qué rubros tiene cada partner.
 *
 * El orden por defecto es POR CANTIDAD ASCENDENTE, no alfabético: los que
 * tienen cero van primero porque son los rotos. Un listado alfabético los
 * escondería en el medio, que es justo lo que hace que este modo de falla pase
 * desapercibido.
 */
function PartnersList() {
  const partners = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const invisibleCount = partners.filter((p) => p.invisible).length

  return (
    <>
      <PageHeader
        title="Partners"
        subtitle={`${partners.length} publicados`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
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
              navigate({
                search: { ...search, q: value === '' ? undefined : value },
                replace: true,
              })
            }}
          />
        </div>

        <button
          type="button"
          aria-pressed={search.onlyInvisible}
          onClick={() =>
            navigate({
              search: { ...search, onlyInvisible: !search.onlyInvisible },
              replace: true,
            })
          }
          className={cn(
            'flex h-8 items-center gap-2 rounded-md border px-3 text-sm transition-colors',
            search.onlyInvisible
              ? 'border-status-red bg-status-red-bg text-status-red'
              : 'border-border bg-card text-muted-foreground hover:text-foreground',
          )}
        >
          <EyeOff className="size-3.5" aria-hidden />
          Solo invisibles
          {invisibleCount > 0 && !search.onlyInvisible ? ` (${invisibleCount})` : ''}
        </button>
      </div>

      {partners.length === 0 ? (
        <div className="rounded-lg border border-border bg-card py-16 text-center text-sm text-muted-foreground">
          {search.onlyInvisible
            ? 'Ningún partner quedó sin rubros. Eso es lo esperable.'
            : 'No hay partners con ese filtro.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Partner</TableHead>
                <TableHead>Zona de cobertura</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Rubros</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {partners.map((p) => (
                <Row key={p.id} partner={p} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  )
}

function Row({ partner }: { partner: PartnerListItem }) {
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
      <TableCell className="text-right">
        {partner.invisible ? (
          <span className="inline-flex items-center gap-1.5 text-status-red">
            <EyeOff className="size-3.5" aria-hidden />
            invisible
          </span>
        ) : (
          partner.serviceCount
        )}
      </TableCell>
    </TableRow>
  )
}
