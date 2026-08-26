import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react'
import { SORT_FIELDS, listSearchSchema, type SortField } from '~/lib/search'
import { RECORD_STATUSES } from '~/lib/types'
import { listRecords } from '~/fn/records'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { StatusBadge } from '~/components/StatusBadge'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatDate } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { RecordItem, RecordStatus } from '~/lib/types'

export const Route = createFileRoute('/_authed/records/')({
  /**
   * VALIDATED SEARCH PARAMS.
   *
   * The single point where `?page=2&sort=name&...` stops being a string blob
   * and becomes typed state. `Route.useSearch()`, `loaderDeps`, the loader and
   * every `<Link search={...}>` in the app are checked against this schema.
   */
  validateSearch: listSearchSchema,

  /**
   * The loader's cache key. Only these values cause a refetch, and Router
   * dedupes identical keys — re-selecting the current sort is free, changing
   * the page is a fresh load.
   */
  loaderDeps: ({ search }) => search,

  loader: ({ deps, abortController }) =>
    listRecords({ data: deps, signal: abortController.signal }),

  head: () => ({ meta: [{ title: 'Registros — AutoLibre' }] }),
  component: RecordsList,
})

const STATUS_LABELS: Record<RecordStatus, string> = {
  active: 'Activo',
  pending: 'Pendiente',
  archived: 'Archivado',
}

const SORT_LABELS: Record<SortField, string> = {
  name: 'Nombre',
  updatedAt: 'Actualizado',
}

function RecordsList() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const page = Route.useLoaderData()

  /** Any filter change resets to page 1 — otherwise you land on an empty page. */
  const setFilter = (patch: Partial<typeof search>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, page: 1 }), replace: true })

  const hasFilters = Boolean(search.q || search.status)

  return (
    <>
      <PageHeader
        title="Registros"
        subtitle={`${page.total} en total · página ${page.page} de ${page.pageCount}`}
        actions={<SsrTag>ssr: full · search-driven loader</SsrTag>}
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
            placeholder="Nombre o categoría"
            defaultValue={search.q ?? ''}
            className="w-56"
            onChange={(e) => {
              const value = e.currentTarget.value.trim()
              setFilter({ q: value === '' ? undefined : value })
            }}
          />
        </div>

        <div className="space-y-1.5">
          <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Estado
          </span>
          <div className="flex gap-1.5">
            <FilterChip active={!search.status} onClick={() => setFilter({ status: undefined })}>
              Todos
            </FilterChip>
            {RECORD_STATUSES.map((s) => (
              <FilterChip
                key={s}
                active={search.status === s}
                onClick={() => setFilter({ status: s })}
              >
                {STATUS_LABELS[s]}
              </FilterChip>
            ))}
          </div>
        </div>

        {hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              navigate({
                search: (prev) => ({ ...prev, q: undefined, status: undefined, page: 1 }),
                replace: true,
              })
            }
          >
            Limpiar filtros
          </Button>
        ) : null}
      </div>

      {page.items.length === 0 ? (
        <div className="rounded-lg border border-border bg-card py-16 text-center text-sm text-muted-foreground">
          Ningún registro coincide con esos filtros.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <SortHeader field="name" />
                <TableHead>Categoría</TableHead>
                <TableHead>Estado</TableHead>
                <SortHeader field="updatedAt" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((item) => (
                <Row key={item.id} item={item} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Pagination page={page.page} pageCount={page.pageCount} total={page.total} />
    </>
  )
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'h-8 rounded-md border px-3 text-sm transition-colors',
        active
          ? 'border-brand bg-brand-soft text-brand'
          : 'border-border bg-card text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function SortHeader({ field }: { field: SortField }) {
  const search = Route.useSearch()
  const active = search.sort === field
  const nextDir = active && search.dir === 'desc' ? 'asc' : 'desc'
  const Arrow = search.dir === 'asc' ? ArrowUp : ArrowDown

  return (
    <TableHead
      aria-sort={active ? (search.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {/*
        A link, not a button: the sort IS the URL, so it has to be navigable,
        middle-clickable and shareable. Spreading the current search keeps every
        other param intact, so "sorting reset my filters" cannot happen.
      */}
      <Link
        to="/records"
        /**
         * Se construye desde `search` (el `useSearch()` de ESTA ruta, tipado con
         * su propio esquema) y no desde el `prev` del updater funcional.
         *
         * Motivo concreto: `/solicitudes` también tiene un param `status`, con
         * otros valores. El `prev` del updater está tipado como la unión de los
         * search de todas las rutas, así que un `...prev` a ciegas arrastra un
         * `status` que este esquema no acepta y deja de compilar. El updater
         * funcional sirve mientras los params son locales a la ruta; con nombres
         * compartidos entre rutas, no.
         */
        search={{ ...search, sort: field, dir: nextDir, page: 1 }}
        replace
        className={cn(
          'inline-flex items-center gap-1 hover:text-foreground',
          active && 'text-brand',
        )}
        aria-label={`Ordenar por ${SORT_LABELS[field]}, ${
          nextDir === 'asc' ? 'ascendente' : 'descendente'
        }`}
      >
        {SORT_LABELS[field]}
        {active ? <Arrow className="size-3" aria-hidden /> : null}
      </Link>
    </TableHead>
  )
}

function Row({ item }: { item: RecordItem }) {
  return (
    <TableRow>
      <TableCell>
        <Link
          to="/records/$recordId"
          params={{ recordId: item.id }}
          className="font-medium hover:text-brand hover:underline"
        >
          {item.name}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground">{item.category}</TableCell>
      <TableCell>
        <StatusBadge status={item.status} />
      </TableCell>
      <TableCell className="text-muted-foreground">{formatDate(item.updatedAt)}</TableCell>
    </TableRow>
  )
}

function Pagination({
  page,
  pageCount,
  total,
}: {
  page: number
  pageCount: number
  total: number
}) {
  // Misma razón que en SortHeader: el search se arma desde el esquema de esta
  // ruta, no desde el `prev` del updater.
  const search = Route.useSearch()
  const atStart = page <= 1
  const atEnd = page >= pageCount

  return (
    <nav className="mt-4 flex items-center gap-2 text-sm text-muted-foreground" aria-label="Paginación">
      <Button asChild variant="outline" size="sm" disabled={atStart}>
        <Link
          to="/records"
          search={{ ...search, page: Math.max(1, page - 1) }}
          disabled={atStart}
          aria-disabled={atStart}
          className={cn(atStart && 'pointer-events-none opacity-40')}
        >
          <ChevronLeft className="size-4" aria-hidden />
          Anterior
        </Link>
      </Button>

      <Button asChild variant="outline" size="sm" disabled={atEnd}>
        <Link
          to="/records"
          search={{ ...search, page: Math.min(pageCount, page + 1) }}
          disabled={atEnd}
          aria-disabled={atEnd}
          className={cn(atEnd && 'pointer-events-none opacity-40')}
        >
          Siguiente
          <ChevronRight className="size-4" aria-hidden />
        </Link>
      </Button>

      <span className="ml-auto">{total} resultados</span>
    </nav>
  )
}
