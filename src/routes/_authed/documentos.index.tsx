import { Link, createFileRoute } from '@tanstack/react-router'
import { AlertTriangle, ChevronDown, ChevronUp, ChevronsUpDown, FileWarning } from 'lucide-react'
import {
  DOC_TYPE_FILTERS,
  DOC_TYPE_LABELS,
  EXPIRY_FILTERS,
  EXPIRY_FILTER_LABELS,
  documentSearchSchema,
  expiryState,
  type DocSortKey,
  type DocumentListItem,
  type DocumentSearch,
} from '~/lib/documents'
import { listAppDocuments } from '~/fn/documents'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
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
import { formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

export const Route = createFileRoute('/_authed/documentos/')({
  /**
   * SSR completo (el default de `start.ts`): es una pantalla de ENTRADA. Se
   * llega buscando un documento de alguien por email o patente —igual que
   * `/usuarios` y `/chats`— así que suele ser el primer pintado de la sesión,
   * donde `data-only` deja mirando el shell vacío mientras baja el bundle.
   */
  validateSearch: documentSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ deps, abortController }) =>
    listAppDocuments({ data: deps, signal: abortController.signal }),
  head: () => ({ meta: [{ title: 'Documentos — AutoLibre' }] }),
  component: DocumentsList,
})

const TYPE_FILTER_LABELS: Record<(typeof DOC_TYPE_FILTERS)[number], string> = {
  all: 'Todos',
  seguro: 'Seguro',
  cedula: 'Cédula',
  registro: 'Registro',
  vtv: 'VTV',
}

/**
 * El listado de documentos extraídos por OCR.
 *
 * Reemplaza los `select * from insurances / registration_cards /
 * driver_licenses / vehicle_inspections where user_id = '…'` sueltos que hoy
 * hay que correr para auditar lo que el OCR sacó de un documento — más el cruce
 * contra `vehicles` que en la práctica nadie hace.
 *
 * El orden por defecto es por subida descendente: lo recién cargado es lo que
 * todavía nadie revisó.
 */
function DocumentsList() {
  const docs = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<DocumentSearch>) =>
    navigate({ search: { ...search, ...next }, replace: true })

  const filtered =
    Boolean(search.q) ||
    search.kind !== 'all' ||
    search.expiry !== 'all' ||
    search.onlyMismatches ||
    search.onlyMissingFields

  const mismatchCount = docs.filter((d) => d.fieldMismatch).length
  const missingCount = docs.filter((d) => d.missingFields).length

  return (
    <>
      <PageHeader
        title="Documentos"
        subtitle={`${formatInt(docs.length)} ${filtered ? 'con este filtro' : 'con OCR'}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      {/*
        Aviso arriba, sólo cuando hay algo que revisar y el filtro no está
        puesto — mismo criterio que el banner de admins native en `/usuarios`.
      */}
      {!filtered && (mismatchCount > 0 || missingCount > 0) ? (
        <div className="mb-4 flex items-start gap-3 rounded-md border border-status-yellow/30 bg-status-yellow-bg p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-yellow" aria-hidden />
          <div className="min-w-0 text-sm">
            <p className="font-medium">
              {mismatchCount > 0
                ? `${formatInt(mismatchCount)} con un campo que no coincide con el vehículo`
                : null}
              {mismatchCount > 0 && missingCount > 0 ? ' · ' : null}
              {missingCount > 0 ? `${formatInt(missingCount)} con campos sin extraer` : null}
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              El OCR no siempre acierta. Abrí la ficha para ver el detalle; la
              corrección todavía se hace por SQL (editar desde el panel es un
              paso aparte).
            </p>
          </div>
        </div>
      ) : null}

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
            placeholder="Email, nombre, patente o nº"
            defaultValue={search.q ?? ''}
            className="w-64"
            onChange={(e) => {
              const value = e.currentTarget.value.trim()
              setSearch({ q: value === '' ? undefined : value })
            }}
          />
        </div>

        <FilterGroup label="Tipo">
          {DOC_TYPE_FILTERS.map((t) => (
            <Chip key={t} active={search.kind === t} onClick={() => setSearch({ kind: t })}>
              {TYPE_FILTER_LABELS[t]}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="Vencimiento">
          {EXPIRY_FILTERS.map((e) => (
            <Chip
              key={e}
              tone={e === 'vencido' || e === 'por_vencer' ? 'warn' : 'brand'}
              active={search.expiry === e}
              onClick={() => setSearch({ expiry: e })}
            >
              {EXPIRY_FILTER_LABELS[e]}
            </Chip>
          ))}
        </FilterGroup>

        {/*
          Tono `warn`: acotan a filas problemáticas. Son dos cosas distintas y
          no se suman en un solo filtro: un mismatch es un dato que contradice
          al vehículo; un faltante es un campo que el OCR dejó vacío.
        */}
        <FilterGroup label="Revisión">
          <Chip
            tone="warn"
            active={search.onlyMismatches}
            onClick={() => setSearch({ onlyMismatches: !search.onlyMismatches })}
          >
            <AlertTriangle className="size-3.5" aria-hidden />
            No coincide
          </Chip>
          <Chip
            tone="warn"
            active={search.onlyMissingFields}
            onClick={() => setSearch({ onlyMissingFields: !search.onlyMissingFields })}
          >
            <FileWarning className="size-3.5" aria-hidden />
            Campos vacíos
          </Chip>
        </FilterGroup>
      </div>

      {docs.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-6 py-16 text-center">
          <p className="text-sm font-medium">Ningún documento con este filtro</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
            Sólo se listan los documentos que pasaron por OCR (los que tienen un
            archivo subido). La VTV consultada por patente no entra.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHeader label="Usuario" sortKey="user" search={search} />
                <SortableHeader label="Tipo" sortKey="type" search={search} />
                <SortableHeader label="Vehículo" sortKey="vehicle" search={search} />
                <TableHead>Dato principal</TableHead>
                <TableHead>Nº</TableHead>
                <SortableHeader label="Vencimiento" sortKey="expiration" search={search} />
                <SortableHeader label="Subido" sortKey="uploaded" search={search} />
                <TableHead>Archivo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.map((d) => (
                <DocRow key={`${d.docType}-${d.id}`} doc={d} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {docs.length === 500 ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Cortado en 500 filas. Afiná la búsqueda — el listado no pagina a
          propósito.
        </p>
      ) : null}
    </>
  )
}

function DocRow({ doc: d }: { doc: DocumentListItem }) {
  const flagged = d.fieldMismatch || d.missingFields

  return (
    <TableRow className={cn(flagged && 'bg-status-yellow-bg/40')}>
      <TableCell>
        <Link
          to="/documentos/$docType/$docId"
          params={{ docType: d.docType, docId: d.id }}
          className="rounded text-sm font-medium outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {d.userName ?? d.userEmail}
        </Link>
        {d.userName ? <div className="text-xs text-muted-foreground">{d.userEmail}</div> : null}
      </TableCell>

      <TableCell>
        <Badge variant="outline" className="border-border bg-secondary text-muted-foreground">
          {DOC_TYPE_LABELS[d.docType]}
        </Badge>
      </TableCell>

      <TableCell className="text-sm">
        {d.vehiclePlate ? (
          <span className="font-mono font-medium tracking-wide">{d.vehiclePlate}</span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </TableCell>

      <TableCell className="max-w-[220px] truncate text-sm" title={d.primaryLabel ?? undefined}>
        {d.primaryLabel ?? <span className="text-status-yellow">sin extraer</span>}
      </TableCell>

      <TableCell className="font-mono text-xs">
        {d.documentNumber ?? <span className="font-sans text-status-yellow">sin extraer</span>}
      </TableCell>

      <TableCell className="tabular-nums">
        <ExpiryCell days={d.daysUntilExpiration} iso={d.expirationDate} />
      </TableCell>

      <TableCell className="text-sm tabular-nums text-muted-foreground">
        {d.uploadedAt ? formatDate(d.uploadedAt) : '—'}
      </TableCell>

      <TableCell className="text-xs">
        {d.hasFile ? (
          <span className="text-muted-foreground">{mimeShort(d.fileMimeType)}</span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </TableCell>
    </TableRow>
  )
}

function mimeShort(mime: string | null): string {
  if (!mime) return 'archivo'
  if (mime === 'application/pdf') return 'PDF'
  if (mime.startsWith('image/')) return mime.slice(6).toUpperCase()
  return mime
}

/**
 * "Cuántos días faltan" — `days` viene PRECALCULADO por Postgres
 * (`expiration_date - current_date` en `documents.repo.ts`). La pantalla es SSR
 * completo, así que restar contra `new Date()` acá arriesgaría un mismatch de
 * hidratación si servidor y cliente caen a los dos lados de una medianoche UTC.
 * Mismo patrón que `LicenseCell` en `usuarios.index.tsx`.
 */
function ExpiryCell({ days, iso }: { days: number | null; iso: string | null }) {
  if (days === null || !iso) {
    return <span className="text-xs text-muted-foreground/70">sin fecha</span>
  }

  const state = expiryState(days)
  const title = formatDate(iso)

  if (state === 'vencido') {
    return (
      <span className="text-sm text-status-yellow" title={title}>
        venció hace {formatInt(Math.abs(days))} día{Math.abs(days) === 1 ? '' : 's'}
      </span>
    )
  }
  if (state === 'por_vencer') {
    return (
      <span className="text-sm text-status-yellow" title={title}>
        vence en {formatInt(days)} día{days === 1 ? '' : 's'}
      </span>
    )
  }
  return (
    <span className="text-sm text-muted-foreground" title={title}>
      vence {formatDate(iso)}
    </span>
  )
}

/**
 * Header de orden = link, no botón: el orden ES la URL, navegable y compartible.
 * Mismo patrón que `/usuarios` y `/chats`. Clickear el activo invierte la
 * dirección; clickear otro arranca en `asc`.
 */
function SortableHeader({
  label,
  sortKey,
  search,
}: {
  label: string
  sortKey: DocSortKey
  search: DocumentSearch
}) {
  const active = search.sort === sortKey
  const nextDir = active && search.dir === 'asc' ? 'desc' : 'asc'

  return (
    <TableHead>
      <Link
        to="/documentos"
        search={(prev) => ({ ...prev, sort: sortKey, dir: nextDir })}
        replace
        className={cn(
          'inline-flex items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          active && 'text-foreground',
        )}
      >
        {label}
        {active ? (
          search.dir === 'asc' ? (
            <ChevronUp className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" aria-hidden />
          )
        ) : (
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground/40" aria-hidden />
        )}
      </Link>
    </TableHead>
  )
}
