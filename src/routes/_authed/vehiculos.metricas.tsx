import { Link, createFileRoute } from '@tanstack/react-router'
import {
  VEHICLE_TYPES,
  VEHICLE_TYPE_LABELS,
  fleetSearchSchema,
  vehicleTypeLabel,
  type FleetMetricRow,
  type FleetSummary,
} from '~/lib/vehicles'
import { fleetMetricsFn, fleetSummaryFn } from '~/fn/vehicles'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { SortHeader } from '~/components/SortHeader'
import { Input } from '~/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatArs, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * La flota agrupada por MODELO del catálogo.
 *
 * ── Qué reemplaza ───────────────────────────────────────────────────────────
 *
 * La consulta que nadie corre: "¿cuáles son los modelos más comunes en la
 * flota, y cómo se comporta cada uno?". Sirve para priorizar trabajo de
 * catálogo (a qué modelo cargarle el manual, con cuál probar un escáner) y para
 * ver dónde se concentran las multas o los kilómetros.
 *
 * ── El grano es el CATÁLOGO, no el spec ─────────────────────────────────────
 *
 * Misma decisión que `/escaneres`: bajar al spec parte el mismo auto en dos
 * filas cuando dos specs difieren sólo en un campo que el proveedor no
 * devolvió. Un número más desagregado y equivocado no se cacha.
 */
export const Route = createFileRoute('/_authed/vehiculos/metricas')({
  /**
   * SSR completo (heredado). Tabla de agregados; se abre para mirar la flota de
   * conjunto.
   */
  validateSearch: fleetSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal
    const [rows, summary] = await Promise.all([
      fleetMetricsFn({ data: deps, signal }),
      fleetSummaryFn({ signal }),
    ])
    return { rows, summary }
  },
  head: () => ({ meta: [{ title: 'Vehículos · Métricas — AutoLibre' }] }),
  component: VehiculosMetricas,
})

function VehiculosMetricas() {
  const { rows, summary } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <>
      <PageHeader
        title="Métricas"
        subtitle="La flota por modelo del catálogo."
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <SummaryTiles summary={summary} shown={rows.length} />

      <div className="mb-4 mt-5 flex flex-wrap items-end gap-5">
        <Input
          type="search"
          placeholder="Filtrar por marca, modelo o versión"
          defaultValue={search.q ?? ''}
          className="w-72"
          onChange={(e) => {
            const value = e.currentTarget.value.trim()
            navigate({
              search: { ...search, q: value === '' ? undefined : value },
              replace: true,
            })
          }}
        />

        <FilterGroup label="Tipo">
          <Chip
            active={!search.vehicleType}
            onClick={() => navigate({ search: { ...search, vehicleType: undefined }, replace: true })}
          >
            Todos
          </Chip>
          {VEHICLE_TYPES.map((t) => (
            <Chip
              key={t}
              active={search.vehicleType === t}
              onClick={() =>
                navigate({
                  search: { ...search, vehicleType: search.vehicleType === t ? undefined : t },
                  replace: true,
                })
              }
            >
              {VEHICLE_TYPE_LABELS[t]}
            </Chip>
          ))}
        </FilterGroup>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Ningún modelo con ese filtro.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table className="min-w-[1200px]">
            <TableHeader>
              <TableRow>
                <SortHeader label="Modelo" sortKey="model" active={search.sort === 'model'} dir={search.dir} to="/vehiculos/metricas" firstClick="asc" />
                <SortHeader label="Tipo" sortKey="type" active={search.sort === 'type'} dir={search.dir} to="/vehiculos/metricas" firstClick="asc" />
                <SortHeader label="Vehículos" sortKey="vehicles" active={search.sort === 'vehicles'} dir={search.dir} to="/vehiculos/metricas" align="right" firstClick="desc" />
                <SortHeader label="Usuarios" sortKey="users" active={search.sort === 'users'} dir={search.dir} to="/vehiculos/metricas" align="right" firstClick="desc" />
                <SortHeader label="Km prom." sortKey="avgKm" active={search.sort === 'avgKm'} dir={search.dir} to="/vehiculos/metricas" align="right" firstClick="desc" />
                <TableHead className="text-right">Con VTV</TableHead>
                <TableHead className="text-right">Con seguro</TableHead>
                <SortHeader label="Con multas" sortKey="withFines" active={search.sort === 'withFines'} dir={search.dir} to="/vehiculos/metricas" align="right" firstClick="desc" />
                <SortHeader label="Deuda multas" sortKey="fineDebt" active={search.sort === 'fineDebt'} dir={search.dir} to="/vehiculos/metricas" align="right" firstClick="desc" />
                <SortHeader label="Escaneados" sortKey="scanned" active={search.sort === 'scanned'} dir={search.dir} to="/vehiculos/metricas" align="right" firstClick="desc" />
                <TableHead className="text-right">Manuales</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <Row key={r.catalogId} r={r} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  )
}

function SummaryTiles({ summary, shown }: { summary: FleetSummary; shown: number }) {
  const tiles = [
    { label: 'Autos en la flota', value: formatInt(summary.totalVehicles) },
    { label: 'Modelos distintos', value: formatInt(summary.totalModels) },
    { label: 'Usuarios con auto', value: formatInt(summary.usersWithVehicle) },
    { label: 'Modelos en esta vista', value: formatInt(shown) },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t.label}
          </div>
          <div className="mt-1 font-heading text-2xl font-bold tracking-tight tabular-nums">
            {t.value}
          </div>
        </div>
      ))}
    </div>
  )
}

function Row({ r }: { r: FleetMetricRow }) {
  return (
    <TableRow>
      <TableCell>
        <Link
          to="/vehiculos/catalogo/$catalogId"
          params={{ catalogId: r.catalogId }}
          className="font-medium text-foreground hover:text-brand hover:underline"
        >
          {r.brand} {r.model} {r.trim} <span className="tabular-nums">{r.year}</span>
        </Link>
        {r.archivedCount > 0 ? (
          <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {formatInt(r.archivedCount)} archivado{r.archivedCount === 1 ? '' : 's'}
          </span>
        ) : null}
      </TableCell>

      <TableCell className="text-muted-foreground">{vehicleTypeLabel(r.vehicleType)}</TableCell>

      <TableCell className="text-right font-heading text-sm font-bold tabular-nums">
        {formatInt(r.vehicleCount)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {formatInt(r.userCount)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {r.avgOdometerKm === null ? '—' : formatInt(r.avgOdometerKm)}
      </TableCell>

      <TableCell className="text-right tabular-nums text-muted-foreground">
        {r.withVtv === 0 ? <span className="text-muted-foreground/50">0</span> : formatInt(r.withVtv)}
        <span className="text-muted-foreground/40"> / {formatInt(r.vehicleCount)}</span>
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {r.withInsurance === 0 ? (
          <span className="text-muted-foreground/50">0</span>
        ) : (
          formatInt(r.withInsurance)
        )}
        <span className="text-muted-foreground/40"> / {formatInt(r.vehicleCount)}</span>
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {r.withFines === 0 ? (
          <span className="text-muted-foreground/50">0</span>
        ) : (
          <span className="font-medium text-status-yellow">{formatInt(r.withFines)}</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        {r.fineDebtTotal === 0 ? (
          <span className="text-muted-foreground/50">{formatArs(0)}</span>
        ) : (
          <span className="font-medium text-status-yellow">{formatArs(r.fineDebtTotal)}</span>
        )}
      </TableCell>

      <TableCell className="text-right tabular-nums text-muted-foreground">
        {formatInt(r.scannedOk)}
      </TableCell>

      {/*
        Con manual en verde, sin manual en ámbar: acá el cero SÍ es un pendiente
        —este modelo tiene autos y ningún manual— al revés que el listado del
        catálogo, donde el cero de "vehículos" era sólo contexto.
      */}
      <TableCell className="text-right tabular-nums">
        <span className={cn(r.manualCount > 0 ? 'text-status-green' : 'text-status-yellow')}>
          {formatInt(r.manualCount)}
        </span>
      </TableCell>
    </TableRow>
  )
}
