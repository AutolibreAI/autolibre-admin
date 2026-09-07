import { Link, createFileRoute } from '@tanstack/react-router'
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react'
import {
  FINE_STALE_AFTER_DAYS,
  fineJurisdictionLabel,
  fineSearchSchema,
  type FineDebtorRow,
  type FineSearch,
  type FineSortKey,
} from '~/lib/fines'
import { listFineDebtorsFn, listFineJurisdictionsFn } from '~/fn/fines'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { Input } from '~/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatArs, formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * Multas — la cola de vehículos con deuda, para un servicio de gestión/pago.
 *
 * ── Qué reemplaza ───────────────────────────────────────────────────────────
 *
 * La consulta que nadie corre porque cruza tres tablas: "de todos los autos con
 * multas consultadas, ¿quiénes deben más, desde cuándo, y de quién son?".
 * `/usuarios` ya muestra esto pero por vehículo dentro de la ficha de UN
 * usuario; acá es transversal y ordenable.
 *
 * ── Vocabulario ─────────────────────────────────────────────────────────────
 *
 * `Fine` es un aggregate de `vehicle-management`, NO un `Lead`. Vive bajo
 * `/leads` como línea de captación. → `.claude/rules/leads.md`
 */
export const Route = createFileRoute('/_authed/leads/multas')({
  /**
   * SSR completo (heredado). Pantalla de CONTENIDO —tabla de casos con patente,
   * usuario y montos— que puede ser el primer pintado de una sesión de trabajo.
   * Mismo criterio que `/leads/talleres` y `/leads/seguros`.
   */
  validateSearch: fineSearchSchema,
  loaderDeps: ({ search }) => search,

  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal
    const [rows, jurisdictions] = await Promise.all([
      listFineDebtorsFn({ data: deps, signal }),
      listFineJurisdictionsFn({ signal }),
    ])
    return { rows, jurisdictions }
  },

  head: () => ({ meta: [{ title: 'Leads · Multas — AutoLibre' }] }),
  component: Multas,
})

function Multas() {
  const { rows, jurisdictions } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<FineSearch>) =>
    navigate({ search: { ...search, ...next }, replace: true })

  const withDebt = rows.filter((r) => r.debtAmount > 0).length
  const totalDebt = rows.reduce((sum, r) => sum + r.debtAmount, 0)
  const filtered =
    Boolean(search.q) ||
    Boolean(search.jurisdiction) ||
    search.debt !== 'all' ||
    search.freshness !== 'all'

  return (
    <>
      <PageHeader
        title="Multas"
        subtitle={`${formatInt(rows.length)} ${filtered ? 'con este filtro' : 'vehículos consultados'} · ${formatInt(withDebt)} con deuda`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <div className="mb-5 rounded-lg border border-border bg-card p-4">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Total adeudado {filtered ? '(con este filtro)' : ''}
        </div>
        <div className="mt-1 font-heading text-2xl font-bold tracking-tight tabular-nums">
          {formatArs(totalDebt)}
        </div>
      </div>

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
            placeholder="Patente, email o nombre"
            defaultValue={search.q ?? ''}
            className="w-60"
            onChange={(e) => {
              const value = e.currentTarget.value.trim()
              setSearch({ q: value === '' ? undefined : value })
            }}
          />
        </div>

        <FilterGroup label="Deuda">
          <Chip active={search.debt === 'all'} onClick={() => setSearch({ debt: 'all' })}>
            Todas
          </Chip>
          <Chip active={search.debt === 'with'} onClick={() => setSearch({ debt: 'with' })}>
            Con deuda
          </Chip>
          <Chip active={search.debt === 'without'} onClick={() => setSearch({ debt: 'without' })}>
            Sin deuda
          </Chip>
        </FilterGroup>

        {/*
          `warn` porque acota a filas donde el dato puede estar informando de
          menos: una consulta vieja no vio las multas nuevas. No es un error, es
          una advertencia — mismo tono que "sólo fallidos" en /usuarios.
        */}
        <FilterGroup label="Consulta">
          <Chip active={search.freshness === 'all'} onClick={() => setSearch({ freshness: 'all' })}>
            Todas
          </Chip>
          <Chip active={search.freshness === 'fresh'} onClick={() => setSearch({ freshness: 'fresh' })}>
            Al día (≤{FINE_STALE_AFTER_DAYS} d)
          </Chip>
          <Chip
            tone="warn"
            active={search.freshness === 'stale'}
            onClick={() => setSearch({ freshness: 'stale' })}
          >
            Desactualizada
          </Chip>
        </FilterGroup>

        {jurisdictions.length > 0 ? (
          <FilterGroup label="Jurisdicción">
            <Chip
              active={!search.jurisdiction}
              onClick={() => setSearch({ jurisdiction: undefined })}
            >
              Todas
            </Chip>
            {jurisdictions.map((j) => (
              <Chip
                key={j}
                active={search.jurisdiction === j}
                onClick={() =>
                  setSearch({
                    jurisdiction:
                      search.jurisdiction === j
                        ? undefined
                        : (j as FineSearch['jurisdiction']),
                  })
                }
              >
                {fineJurisdictionLabel(j)}
              </Chip>
            ))}
          </FilterGroup>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          {filtered
            ? 'Ningún vehículo con estos filtros.'
            : 'Ningún vehículo con multas consultadas todavía. Cuando la app consulte las multas de un auto, aparece acá.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <SortHeader label="Vehículo" sortKey="plate" search={search} />
                <SortHeader label="Usuario" sortKey="user" search={search} />
                <SortHeader label="Multas" sortKey="fineCount" search={search} align="right" />
                <SortHeader label="Adeudado" sortKey="debt" search={search} align="right" />
                <SortHeader label="Jurisdicciones" sortKey="jurisdictions" search={search} />
                <SortHeader label="Infracción más vieja" sortKey="oldestInfraction" search={search} />
                <SortHeader label="Última consulta" sortKey="consultedAt" search={search} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <FineRow key={r.vehicleId} row={r} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  )
}

/**
 * Los headers de orden son links, no botones: el orden ES la URL — navegable,
 * clickeable con el botón del medio, compartible. Misma regla que
 * `/usuarios`. Clickear el mismo header invierte la dirección; clickear otro
 * arranca en `desc` (para montos y fechas es lo que se quiere ver primero).
 */
function SortHeader({
  label,
  sortKey,
  search,
  align,
}: {
  label: string
  sortKey: FineSortKey
  search: FineSearch
  align?: 'right'
}) {
  const active = search.sort === sortKey
  const nextDir = active && search.dir === 'desc' ? 'asc' : 'desc'

  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <Link
        to="/leads/multas"
        search={(prev) => ({ ...prev, sort: sortKey, dir: nextDir })}
        replace
        className={cn(
          'inline-flex items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          align === 'right' && 'flex-row-reverse',
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

function FineRow({ row }: { row: FineDebtorRow }) {
  const stale = row.daysSinceConsult > FINE_STALE_AFTER_DAYS
  const noDebt = row.debtAmount === 0

  return (
    <TableRow className={cn(row.archived && 'opacity-60')}>
      <TableCell>
        <span className="font-mono font-semibold tracking-wider">{row.plate}</span>
        {row.archived ? (
          <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            archivado
          </span>
        ) : null}
        <div className="text-xs text-muted-foreground">
          {row.brand} {row.model} <span className="tabular-nums">{row.year}</span>
        </div>
      </TableCell>

      <TableCell>
        <Link
          to="/usuarios/$userId"
          params={{ userId: row.userId }}
          className="text-brand hover:underline"
        >
          {row.userName ?? row.userEmail}
        </Link>
        {row.userName ? (
          <div className="truncate text-xs text-muted-foreground">{row.userEmail}</div>
        ) : null}
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {row.fineCount === 0 ? (
          <span className="text-muted-foreground/50">0</span>
        ) : (
          formatInt(row.fineCount)
        )}
      </TableCell>

      {/*
        El monto es la cabeza de la fila. Ámbar si hay deuda —plata que el
        usuario debe—; el `$0` va en texto plano: "consultado, sin deuda" es un
        dato, no un logro.
      */}
      <TableCell className="text-right tabular-nums">
        {noDebt ? (
          <span className="text-muted-foreground" title="Consultado — sin multas pendientes">
            {formatArs(0)}
          </span>
        ) : (
          <span className="font-medium text-status-yellow">{formatArs(row.debtAmount)}</span>
        )}
      </TableCell>

      <TableCell>
        {row.jurisdictions.length === 0 ? (
          <span className="text-muted-foreground/50">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {row.jurisdictions.map((j) => (
              <span
                key={j}
                className="rounded border border-border px-1.5 py-px text-[11px] text-muted-foreground"
              >
                {fineJurisdictionLabel(j)}
              </span>
            ))}
          </div>
        )}
      </TableCell>

      <TableCell className="tabular-nums text-muted-foreground">
        {row.oldestInfraction ? formatDate(row.oldestInfraction) : '—'}
      </TableCell>

      {/*
        "hace N días" es una lectura NUESTRA del reloj, no un dato del dominio —
        por eso se dice en voz alta y se marca ámbar pasado el umbral: una
        consulta vieja pudo no ver multas nuevas. Mismo criterio que `stuck` en
        /operacion.
      */}
      <TableCell className="tabular-nums">
        <div>{formatDate(row.consultedAt)}</div>
        <div className={cn('text-xs', stale ? 'font-medium text-status-yellow' : 'text-muted-foreground')}>
          hace {formatInt(row.daysSinceConsult)} d{stale ? ' · desactualizada' : ''}
        </div>
      </TableCell>
    </TableRow>
  )
}
