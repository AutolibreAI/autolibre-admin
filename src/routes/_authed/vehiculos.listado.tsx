import { Link, createFileRoute } from '@tanstack/react-router'
import {
  VEHICLE_STATE_FILTERS,
  VEHICLE_STATE_FILTER_LABELS,
  VEHICLE_TYPES,
  VEHICLE_TYPE_LABELS,
  vehicleSearchSchema,
  vehicleTypeLabel,
  type VehicleListRow,
} from '~/lib/vehicles'
import { listVehiclesFn } from '~/fn/vehicles'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { SortHeader } from '~/components/SortHeader'
import {
  AmountOrNoneCell,
  CountOrNeverCell,
  ExpiryCell,
  FineDebtCell,
} from '~/components/VehicleCells'
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

/**
 * El padrón entero de autos, uno por fila, SIN deduplicar por patente.
 *
 * ── Qué reemplaza ───────────────────────────────────────────────────────────
 *
 * `/usuarios` ya arma casi todo esto (`UserVehicleSummary`) pero sólo dentro de
 * la ficha de un usuario. Acá es transversal, con dueño, ordenable y filtrable.
 * El mismo auto cargado por dos personas son dos filas — a propósito: es el
 * dato que la card de Inicio (115 activos / 106 únicos) resume.
 */
export const Route = createFileRoute('/_authed/vehiculos/listado')({
  /**
   * SSR completo (heredado). Pantalla de contenido —tabla de autos con patente
   * y dueño— que puede ser el primer pintado de una sesión de trabajo.
   */
  validateSearch: vehicleSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ deps, abortController }) =>
    listVehiclesFn({ data: deps, signal: abortController.signal }),
  head: () => ({ meta: [{ title: 'Vehículos · Listado — AutoLibre' }] }),
  component: VehiculosListado,
})

function VehiculosListado() {
  const rows = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true })

  const filtered =
    Boolean(search.q) ||
    search.state !== 'all' ||
    Boolean(search.vehicleType) ||
    search.vtvExpired ||
    search.fineDebt

  return (
    <>
      <PageHeader
        title="Listado"
        subtitle={`${formatInt(rows.length)} ${filtered ? 'con este filtro' : 'autos cargados'} · sin deduplicar`}
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
            placeholder="Patente, alias, modelo o dueño"
            defaultValue={search.q ?? ''}
            className="w-64"
            onChange={(e) => {
              const value = e.currentTarget.value.trim()
              setSearch({ q: value === '' ? undefined : value })
            }}
          />
        </div>

        <FilterGroup label="Estado">
          {VEHICLE_STATE_FILTERS.map((s) => (
            <Chip key={s} active={search.state === s} onClick={() => setSearch({ state: s })}>
              {VEHICLE_STATE_FILTER_LABELS[s]}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="Tipo">
          <Chip active={!search.vehicleType} onClick={() => setSearch({ vehicleType: undefined })}>
            Todos
          </Chip>
          {VEHICLE_TYPES.map((t) => (
            <Chip
              key={t}
              active={search.vehicleType === t}
              onClick={() => setSearch({ vehicleType: search.vehicleType === t ? undefined : t })}
            >
              {VEHICLE_TYPE_LABELS[t]}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="Alertas">
          <Chip
            tone="warn"
            active={search.vtvExpired}
            onClick={() => setSearch({ vtvExpired: !search.vtvExpired })}
          >
            VTV vencida
          </Chip>
          <Chip
            tone="warn"
            active={search.fineDebt}
            onClick={() => setSearch({ fineDebt: !search.fineDebt })}
          >
            Con deuda de multas
          </Chip>
        </FilterGroup>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Ningún auto con estos filtros.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table className="min-w-[1580px]">
            <TableHeader>
              <TableRow>
                <SortHeader label="Vehículo" sortKey="plate" active={search.sort === 'plate'} dir={search.dir} to="/vehiculos/listado" />
                <SortHeader label="Dueño" sortKey="owner" active={search.sort === 'owner'} dir={search.dir} to="/vehiculos/listado" />
                <SortHeader label="Tipo" sortKey="type" active={search.sort === 'type'} dir={search.dir} to="/vehiculos/listado" firstClick="asc" />
                <SortHeader label="Km" sortKey="odometer" active={search.sort === 'odometer'} dir={search.dir} to="/vehiculos/listado" align="right" firstClick="desc" />
                <SortHeader label="VTV" sortKey="vtv" active={search.sort === 'vtv'} dir={search.dir} to="/vehiculos/listado" firstClick="asc" />
                <TableHead>Seguro</TableHead>
                <SortHeader label="Multas" sortKey="fineCount" active={search.sort === 'fineCount'} dir={search.dir} to="/vehiculos/listado" align="right" firstClick="desc" />
                <SortHeader label="Deuda multas" sortKey="fineDebt" active={search.sort === 'fineDebt'} dir={search.dir} to="/vehiculos/listado" align="right" firstClick="desc" />
                <TableHead className="text-right">Deuda patente</TableHead>
                <SortHeader label="Tareas ✓ / pend" sortKey="tasksPending" active={search.sort === 'tasksPending'} dir={search.dir} to="/vehiculos/listado" align="right" firstClick="desc" />
                <TableHead className="text-right">Escaneos</TableHead>
                <TableHead className="text-right">DTC · anom.</TableHead>
                <TableHead className="text-right">Chats diag.</TableHead>
                <SortHeader label="Alta" sortKey="createdAt" active={search.sort === 'createdAt'} dir={search.dir} to="/vehiculos/listado" firstClick="desc" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((v) => (
                <Row key={v.id} v={v} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {rows.length === 1000 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Cortado en 1000 filas. Afiná la búsqueda.
        </p>
      ) : null}
    </>
  )
}

function Row({ v }: { v: VehicleListRow }) {
  return (
    <TableRow className={cn(v.archived && 'opacity-60')}>
      <TableCell>
        <span className="font-mono font-semibold tracking-wider">{v.plate}</span>
        {v.archived ? (
          <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            archivado
          </span>
        ) : null}
        <div className="text-xs text-muted-foreground">
          {v.brand} {v.model} {v.trim} <span className="tabular-nums">{v.year}</span>
          {v.alias ? ` · ${v.alias}` : ''} · {v.color}
        </div>
      </TableCell>

      <TableCell>
        <Link
          to="/usuarios/$userId"
          params={{ userId: v.userId }}
          className="text-brand hover:underline"
        >
          {v.userName ?? v.userEmail}
        </Link>
        {v.userName ? (
          <div className="truncate text-xs text-muted-foreground">{v.userEmail}</div>
        ) : null}
      </TableCell>

      <TableCell className="text-muted-foreground">{vehicleTypeLabel(v.vehicleType)}</TableCell>

      <TableCell className="text-right tabular-nums">{formatInt(v.odometerKm)}</TableCell>

      <TableCell className="text-xs">
        <ExpiryCell iso={v.vtvExpiresAt} />
      </TableCell>
      <TableCell className="text-xs">
        <ExpiryCell iso={v.insuranceExpiresAt} />
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {v.fineConsultedAt === null ? (
          <span className="text-muted-foreground/50" title="Multas nunca consultadas">
            —
          </span>
        ) : v.fineCount === 0 ? (
          <span className="text-muted-foreground/50">0</span>
        ) : (
          formatInt(v.fineCount)
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        <FineDebtCell amount={v.fineDebtAmount} />
      </TableCell>

      <TableCell className="text-right tabular-nums text-xs">
        <AmountOrNoneCell amount={v.taxDebtAmount} title="Deuda de patente sin saldar" />
      </TableCell>

      <TableCell className="text-right tabular-nums">
        <span className="text-muted-foreground">{formatInt(v.tasksPast)}</span>
        <span className="text-muted-foreground/40"> / </span>
        <span className={cn(v.tasksPending > 0 && 'font-medium text-foreground')}>
          {formatInt(v.tasksPending)}
        </span>
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {v.scansTotal === 0 ? (
          <span className="text-muted-foreground/50" title="Nunca usó el escáner">
            —
          </span>
        ) : (
          <span className={cn(v.scansOk === 0 && 'text-status-yellow')}>
            {formatInt(v.scansOk)}
            <span className="text-muted-foreground"> / {formatInt(v.scansTotal)}</span>
          </span>
        )}
      </TableCell>

      <TableCell className="text-right tabular-nums">
        <CountOrNeverCell value={v.activeDtcCount} title="DTCs del último escaneo" />
        <span className="text-muted-foreground/40"> · </span>
        <CountOrNeverCell value={v.activeAnomalyCount} title="anomalías del último análisis" />
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {v.diagnosticChatCount === 0 ? (
          <span className="text-muted-foreground/50">0</span>
        ) : (
          formatInt(v.diagnosticChatCount)
        )}
      </TableCell>

      <TableCell className="tabular-nums text-muted-foreground">{formatDate(v.createdAt)}</TableCell>
    </TableRow>
  )
}
