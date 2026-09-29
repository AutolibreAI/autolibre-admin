import { Link, createFileRoute } from '@tanstack/react-router'
import {
  VEHICLE_DOCUMENT_FILTERS,
  VEHICLE_DOCUMENT_FILTER_LABELS,
  VEHICLE_PRESENCE_FILTERS,
  VEHICLE_PRESENCE_FILTER_LABELS,
  VEHICLE_SCAN_FILTERS,
  VEHICLE_SCAN_FILTER_LABELS,
  VEHICLE_STATE_FILTERS,
  VEHICLE_STATE_FILTER_LABELS,
  VEHICLE_TYPES,
  VEHICLE_TYPE_LABELS,
  vehicleSearchSchema,
  vehicleTypeLabel,
  type VehicleListRow,
  type VehicleSearch,
  type VehicleSortKey,
} from '~/lib/vehicles'
import { VEHICLE_REGIONS, VEHICLE_REGION_LABELS } from '~/lib/vehicle-location'
import { listVehicleFacetsFn, listVehicleProvinceOptionsFn, listVehiclesFn } from '~/fn/vehicles'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup, RangeFilter } from '~/components/Filters'
import { MultiSelect } from '~/components/MultiSelect'
import { SortHeader } from '~/components/SortHeader'
import {
  AmountOrNoneCell,
  CountOrNeverCell,
  ExpiryCell,
  FineDebtCell,
  LocationCell,
} from '~/components/VehicleCells'
import { SearchInput } from '~/components/SearchInput'
import {
  Table,
  TableBody,
  TableCell,
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
 *
 * ── Lo que vino de la rama `listado-vehiculos` (portado el 2026-09-28) ──────
 *
 * Todas las columnas ordenan, y casi todas filtran con el control que le toca
 * a su tipo de dato: texto libre (`q`), multiselect de valores que salen de la
 * base (marca, modelo), rango numérico o de fecha, o chips de estado. Con 26
 * columnas, los controles sueltos harían ilegible la pantalla antes de leer una
 * fila: los de uso diario quedan arriba y el resto en «Más filtros».
 *
 * La patente abre la ficha del auto (`/vehiculos/:vehicleId`).
 */
export const Route = createFileRoute('/_authed/vehiculos/listado')({
  /**
   * SSR completo (heredado). Pantalla de contenido —tabla de autos con patente
   * y dueño— que puede ser el primer pintado de una sesión de trabajo.
   */
  validateSearch: vehicleSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal
    // Las opciones de provincia, marca y modelo NO dependen del filtro (son las
    // que existen en la base), pero van en el mismo `Promise.all`: son
    // consultas chicas y así no hay un segundo round trip.
    const [rows, provinces, facets] = await Promise.all([
      listVehiclesFn({ data: deps, signal }),
      listVehicleProvinceOptionsFn({ signal }),
      listVehicleFacetsFn({ signal }),
    ])
    return { rows, provinces, facets }
  },
  head: () => ({ meta: [{ title: 'Vehículos · Listado — AutoLibre' }] }),
  component: VehiculosListado,
})

/** Los filtros que viven en «Más filtros» — para abrirlo solo si alguno está activo. */
function advancedFilterCount(s: VehicleSearch): number {
  return [
    s.vehicleBrands.length > 0,
    s.vehicleModels.length > 0,
    s.vehicleYearMin !== undefined || s.vehicleYearMax !== undefined,
    Boolean(s.vehicleCreatedFrom || s.vehicleCreatedTo),
    s.vehicleNeverActive || Boolean(s.vehicleActivityFrom || s.vehicleActivityTo),
    s.vehicleScans !== 'all',
    Boolean(s.vehicleLastScanFrom || s.vehicleLastScanTo),
    s.vehicleScanMinutesMin !== undefined || s.vehicleScanMinutesMax !== undefined,
    s.vehicleChatsMin !== undefined || s.vehicleChatsMax !== undefined,
    s.vehiclePastTasksMin !== undefined || s.vehiclePastTasksMax !== undefined,
    s.vehiclePendingTasksMin !== undefined || s.vehiclePendingTasksMax !== undefined,
    s.vehicleInsurance !== 'all',
    s.vehicleVtv !== 'all',
    s.vehicleRegistrationCard !== 'all',
    s.vehicleOdometerMin !== undefined || s.vehicleOdometerMax !== undefined,
    s.vehicleDtcClearKmMin !== undefined || s.vehicleDtcClearKmMax !== undefined,
  ].filter(Boolean).length
}

/** Lo que «Limpiar todo» resetea. El orden (`sort`/`dir`) no es un filtro: queda. */
const CLEARED_FILTERS: Partial<VehicleSearch> = {
  q: undefined,
  state: 'all',
  vehicleType: undefined,
  fineDebt: false,
  vehicleRegions: [],
  vehicleProvinces: [],
  vehicleBrands: [],
  vehicleModels: [],
  vehicleYearMin: undefined,
  vehicleYearMax: undefined,
  vehicleCreatedFrom: undefined,
  vehicleCreatedTo: undefined,
  vehicleNeverActive: false,
  vehicleActivityFrom: undefined,
  vehicleActivityTo: undefined,
  vehicleScans: 'all',
  vehicleLastScanFrom: undefined,
  vehicleLastScanTo: undefined,
  vehicleScanMinutesMin: undefined,
  vehicleScanMinutesMax: undefined,
  vehicleChatsMin: undefined,
  vehicleChatsMax: undefined,
  vehiclePastTasksMin: undefined,
  vehiclePastTasksMax: undefined,
  vehiclePendingTasksMin: undefined,
  vehiclePendingTasksMax: undefined,
  vehicleWithAlerts: false,
  vehicleInsurance: 'all',
  vehicleVtv: 'all',
  vehicleRegistrationCard: 'all',
  vehicleOdometerMin: undefined,
  vehicleOdometerMax: undefined,
  vehicleDtcClearKmMin: undefined,
  vehicleDtcClearKmMax: undefined,
  vehicleWithActiveDtc: false,
  vehicleWithInactiveDtc: false,
}

/** `''`/basura → `undefined` (sin tope). El schema ya lo tolera; esto evita mandarlo. */
const toIntParam = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

function VehiculosListado() {
  const { rows, provinces, facets } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<VehicleSearch>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  const advanced = advancedFilterCount(search)
  const filtered =
    advanced > 0 ||
    Boolean(search.q) ||
    search.state !== 'all' ||
    Boolean(search.vehicleType) ||
    search.fineDebt ||
    search.vehicleWithAlerts ||
    search.vehicleWithActiveDtc ||
    search.vehicleWithInactiveDtc ||
    search.vehicleRegions.length > 0 ||
    search.vehicleProvinces.length > 0

  const toggle = <T,>(list: ReadonlyArray<T>, value: T): Array<T> =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value]

  /** Un header ordenable. `firstClick` sigue al tipo: texto asc, números/fechas desc. */
  const header = (
    label: string,
    sortKey: VehicleSortKey,
    opts: { align?: 'right'; firstClick?: 'asc' | 'desc' } = {},
  ) => (
    <SortHeader
      label={label}
      sortKey={sortKey}
      active={search.sort === sortKey}
      dir={search.dir}
      to="/vehiculos/listado"
      align={opts.align}
      firstClick={opts.firstClick ?? (opts.align === 'right' ? 'desc' : 'asc')}
    />
  )

  return (
    <>
      <PageHeader
        title="Listado"
        subtitle={`${formatInt(rows.length)} ${filtered ? 'con este filtro' : 'autos cargados'} · sin deduplicar`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <div className="mb-3 flex flex-wrap items-end gap-5">
        <SearchInput
          label="Buscar"
          placeholder="Patente, alias, modelo o dueño"
          value={search.q}
          onSearch={(q) => setSearch({ q })}
        />

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

        {/*
          Presencia/ausencia de un problema. `warn`: acotan a filas que piden
          atención, no a "seleccionado y todo bien".
        */}
        <FilterGroup label="Alertas">
          <Chip
            tone="warn"
            active={search.vehicleVtv === 'expired'}
            onClick={() => setSearch({ vehicleVtv: search.vehicleVtv === 'expired' ? 'all' : 'expired' })}
          >
            VTV vencida
          </Chip>
          <Chip tone="warn" active={search.fineDebt} onClick={() => setSearch({ fineDebt: !search.fineDebt })}>
            Con deuda de multas
          </Chip>
          <Chip
            tone="warn"
            active={search.vehicleWithActiveDtc}
            onClick={() => setSearch({ vehicleWithActiveDtc: !search.vehicleWithActiveDtc })}
          >
            DTC activos
          </Chip>
          <Chip
            tone="warn"
            active={search.vehicleWithInactiveDtc}
            onClick={() => setSearch({ vehicleWithInactiveDtc: !search.vehicleWithInactiveDtc })}
          >
            DTC inactivos
          </Chip>
          <Chip
            tone="warn"
            active={search.vehicleWithAlerts}
            onClick={() => setSearch({ vehicleWithAlerts: !search.vehicleWithAlerts })}
          >
            Avisos sin leer
          </Chip>
        </FilterGroup>

        {/*
          Radicación. Multiselect como `/partners/listado`: vacío = sin filtro,
          O dentro del grupo, Y entre grupos. "Sin clasificar" va en ámbar: hay
          dato y el clasificador no lo supo ubicar (falta un alias).
        */}
        <FilterGroup
          label="Radicación"
          onClear={search.vehicleRegions.length ? () => setSearch({ vehicleRegions: [] }) : undefined}
        >
          {VEHICLE_REGIONS.map((r) => (
            <Chip
              key={r}
              tone={r === 'sin_clasificar' ? 'warn' : 'brand'}
              active={search.vehicleRegions.includes(r)}
              onClick={() => setSearch({ vehicleRegions: toggle(search.vehicleRegions, r) })}
            >
              {VEHICLE_REGION_LABELS[r]}
            </Chip>
          ))}
        </FilterGroup>

        {provinces.length > 1 ? (
          <FilterGroup
            label="Provincia"
            onClear={search.vehicleProvinces.length ? () => setSearch({ vehicleProvinces: [] }) : undefined}
          >
            {provinces.map((p) => (
              <Chip
                key={p.value}
                active={search.vehicleProvinces.includes(p.value)}
                onClick={() => setSearch({ vehicleProvinces: toggle(search.vehicleProvinces, p.value) })}
              >
                {p.label}
                <span className="tabular-nums text-muted-foreground">{formatInt(p.vehicles)}</span>
              </Chip>
            ))}
          </FilterGroup>
        ) : null}

        {filtered ? (
          <button
            type="button"
            onClick={() => setSearch(CLEARED_FILTERS)}
            className="h-8 rounded-md px-2 text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Limpiar todo
          </button>
        ) : null}
      </div>

      {/*
        `<details>` nativo: no hay acordeón en este repo y uno nuevo no hacía
        falta sólo para esto. Se abre solo si ya hay un filtro de adentro
        activo — si no, un link pegado con `?vehicleYearMin=2015` filtraría sin
        mostrar por qué.
      */}
      <details
        open={advanced > 0 || undefined}
        className="group mb-4 rounded-lg border border-border bg-card"
      >
        <summary className="cursor-pointer select-none rounded-lg px-4 py-2.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
          Más filtros
          {advanced > 0 ? (
            <span className="ml-2 rounded-full bg-brand-soft px-2 py-0.5 text-xs tabular-nums text-brand">
              {formatInt(advanced)} activo{advanced === 1 ? '' : 's'}
            </span>
          ) : null}
        </summary>

        <div className="flex flex-wrap items-end gap-x-6 gap-y-4 border-t border-border px-4 py-4">
          <div className="space-y-1.5">
            <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">Marca</span>
            <MultiSelect
              label="Marca"
              options={facets.brands.map((b) => ({ value: b, label: b }))}
              selected={search.vehicleBrands}
              onChange={(vehicleBrands) => setSearch({ vehicleBrands })}
              placeholder="Todas"
              className="w-48"
            />
          </div>
          <div className="space-y-1.5">
            <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">Modelo</span>
            <MultiSelect
              label="Modelo"
              options={facets.models.map((m) => ({ value: m, label: m }))}
              selected={search.vehicleModels}
              onChange={(vehicleModels) => setSearch({ vehicleModels })}
              placeholder="Todos"
              className="w-48"
            />
          </div>
          <RangeFilter
            label="Año"
            type="number"
            min={search.vehicleYearMin}
            max={search.vehicleYearMax}
            onCommit={({ min, max }) => setSearch({ vehicleYearMin: toIntParam(min), vehicleYearMax: toIntParam(max) })}
          />
          <RangeFilter
            label="Kilometraje"
            unit="km"
            type="number"
            min={search.vehicleOdometerMin}
            max={search.vehicleOdometerMax}
            onCommit={({ min, max }) =>
              setSearch({ vehicleOdometerMin: toIntParam(min), vehicleOdometerMax: toIntParam(max) })
            }
          />
          <RangeFilter
            label="Km desde borrado de fallas"
            unit="km"
            type="number"
            min={search.vehicleDtcClearKmMin}
            max={search.vehicleDtcClearKmMax}
            onCommit={({ min, max }) =>
              setSearch({ vehicleDtcClearKmMin: toIntParam(min), vehicleDtcClearKmMax: toIntParam(max) })
            }
          />
          <RangeFilter
            label="Alta"
            type="date"
            min={search.vehicleCreatedFrom}
            max={search.vehicleCreatedTo}
            onCommit={({ min, max }) => setSearch({ vehicleCreatedFrom: min, vehicleCreatedTo: max })}
          />

          <FilterGroup label="Seguro">
            {VEHICLE_DOCUMENT_FILTERS.map((f) => (
              <Chip key={f} active={search.vehicleInsurance === f} onClick={() => setSearch({ vehicleInsurance: f })}>
                {VEHICLE_DOCUMENT_FILTER_LABELS[f]}
              </Chip>
            ))}
          </FilterGroup>
          <FilterGroup label="VTV">
            {VEHICLE_DOCUMENT_FILTERS.map((f) => (
              <Chip key={f} active={search.vehicleVtv === f} onClick={() => setSearch({ vehicleVtv: f })}>
                {VEHICLE_DOCUMENT_FILTER_LABELS[f]}
              </Chip>
            ))}
          </FilterGroup>
          <FilterGroup label="Cédula">
            {VEHICLE_PRESENCE_FILTERS.map((f) => (
              <Chip
                key={f}
                active={search.vehicleRegistrationCard === f}
                onClick={() => setSearch({ vehicleRegistrationCard: f })}
              >
                {VEHICLE_PRESENCE_FILTER_LABELS[f]}
              </Chip>
            ))}
          </FilterGroup>

          <FilterGroup label="Escaneos">
            {VEHICLE_SCAN_FILTERS.map((f) => (
              <Chip key={f} active={search.vehicleScans === f} onClick={() => setSearch({ vehicleScans: f })}>
                {VEHICLE_SCAN_FILTER_LABELS[f]}
              </Chip>
            ))}
          </FilterGroup>
          <RangeFilter
            label="Último escaneo"
            type="date"
            min={search.vehicleLastScanFrom}
            max={search.vehicleLastScanTo}
            onCommit={({ min, max }) => setSearch({ vehicleLastScanFrom: min, vehicleLastScanTo: max })}
          />
          <RangeFilter
            label="Tiempo escaneado"
            unit="min"
            type="number"
            min={search.vehicleScanMinutesMin}
            max={search.vehicleScanMinutesMax}
            onCommit={({ min, max }) =>
              setSearch({ vehicleScanMinutesMin: toIntParam(min), vehicleScanMinutesMax: toIntParam(max) })
            }
          />
          <RangeFilter
            label="Chats de diagnóstico"
            type="number"
            min={search.vehicleChatsMin}
            max={search.vehicleChatsMax}
            onCommit={({ min, max }) => setSearch({ vehicleChatsMin: toIntParam(min), vehicleChatsMax: toIntParam(max) })}
          />
          <RangeFilter
            label="Tareas hechas"
            type="number"
            min={search.vehiclePastTasksMin}
            max={search.vehiclePastTasksMax}
            onCommit={({ min, max }) =>
              setSearch({ vehiclePastTasksMin: toIntParam(min), vehiclePastTasksMax: toIntParam(max) })
            }
          />
          <RangeFilter
            label="Tareas pendientes"
            type="number"
            min={search.vehiclePendingTasksMin}
            max={search.vehiclePendingTasksMax}
            onCommit={({ min, max }) =>
              setSearch({ vehiclePendingTasksMin: toIntParam(min), vehiclePendingTasksMax: toIntParam(max) })
            }
          />

          <FilterGroup label="Actividad">
            <Chip
              tone="warn"
              active={search.vehicleNeverActive}
              onClick={() => setSearch({ vehicleNeverActive: !search.vehicleNeverActive })}
            >
              Nunca pasó nada
            </Chip>
          </FilterGroup>
          <RangeFilter
            label="Última actividad"
            type="date"
            min={search.vehicleActivityFrom}
            max={search.vehicleActivityTo}
            onCommit={({ min, max }) => setSearch({ vehicleActivityFrom: min, vehicleActivityTo: max })}
          />
        </div>
      </details>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Ningún auto con estos filtros.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table className="min-w-[2900px]">
            <TableHeader>
              <TableRow>
                {header('Vehículo', 'plate')}
                {header('Modelo', 'model')}
                {header('Año', 'year', { align: 'right' })}
                {header('Dueño', 'owner')}
                {header('Radicación', 'location')}
                {header('Tipo', 'type')}
                {header('Km', 'odometer', { align: 'right' })}
                {header('Km s/ borrado', 'dtcClearKm', { align: 'right' })}
                {header('VTV', 'vtv')}
                {header('Seguro', 'insurance')}
                {header('Cédula', 'registrationCard', { firstClick: 'desc' })}
                {header('Multas', 'fineCount', { align: 'right' })}
                {header('Deuda multas', 'fineDebt', { align: 'right' })}
                {header('Deuda patente', 'taxDebt', { align: 'right' })}
                {header('Tareas hechas', 'tasksPast', { align: 'right' })}
                {header('Tareas pend.', 'tasksPending', { align: 'right' })}
                {header('Escaneos', 'scans', { align: 'right' })}
                {header('Último escaneo', 'lastScanAt', { firstClick: 'desc' })}
                {header('Min escaneados', 'scanMinutes', { align: 'right' })}
                {header('DTC activos', 'activeDtc', { align: 'right' })}
                {header('DTC inactivos', 'inactiveDtc', { align: 'right' })}
                {header('Anomalías', 'anomalies', { align: 'right' })}
                {header('Chats diag.', 'chats', { align: 'right' })}
                {header('Avisos sin leer', 'alerts', { align: 'right' })}
                {header('Última actividad', 'lastActivity', { firstClick: 'desc' })}
                {header('Alta', 'createdAt', { firstClick: 'desc' })}
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
        <p className="mt-3 text-xs text-muted-foreground">Cortado en 1000 filas. Afiná la búsqueda.</p>
      ) : null}
    </>
  )
}

/** Un cero que no pide atención: gris, para que lo que sí la pide resalte. */
function Count({ value, warn = false }: { value: number; warn?: boolean }) {
  if (value === 0) return <span className="text-muted-foreground/50">0</span>
  return <span className={cn(warn && 'text-status-yellow')}>{formatInt(value)}</span>
}

/**
 * DTCs. `null` (nunca se escaneó) ≠ `[]` (escaneado y limpio) ≠ con códigos.
 * Los códigos van en el `title`: la columna dice cuántos, la ficha dice cuáles.
 */
function DtcCodesCell({ codes, warn }: { codes: Array<string> | null; warn: boolean }) {
  if (codes === null) {
    return (
      <span className="text-muted-foreground/50" title="Nunca se escaneó por DTC">
        —
      </span>
    )
  }
  if (codes.length === 0) return <span className="text-muted-foreground/50">0</span>
  return (
    <span className={cn(warn && 'text-status-yellow')} title={codes.join(', ')}>
      {formatInt(codes.length)}
    </span>
  )
}

function DateOrNever({ iso, never }: { iso: string | null; never: string }) {
  if (!iso) return <span className="text-muted-foreground/50">{never}</span>
  return <span className="tabular-nums">{formatDate(iso)}</span>
}

function Row({ v }: { v: VehicleListRow }) {
  return (
    <TableRow className={cn(v.archived && 'opacity-60')}>
      <TableCell>
        <Link
          to="/vehiculos/$vehicleId"
          params={{ vehicleId: v.id }}
          className="rounded font-mono font-semibold tracking-wider text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {v.plate}
        </Link>
        {v.archived ? (
          <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">archivado</span>
        ) : null}
        <div className="text-xs text-muted-foreground">
          {v.alias ? `${v.alias} · ` : ''}
          {v.color}
        </div>
      </TableCell>

      <TableCell>
        {v.brand} {v.model}
        <div className="text-xs text-muted-foreground">{v.trim}</div>
      </TableCell>

      <TableCell className="text-right tabular-nums">{v.year}</TableCell>

      <TableCell>
        <Link to="/usuarios/$userId" params={{ userId: v.userId }} className="text-brand hover:underline">
          {v.userName ?? v.userEmail}
        </Link>
        {v.userName ? <div className="truncate text-xs text-muted-foreground">{v.userEmail}</div> : null}
      </TableCell>

      <TableCell className="text-xs whitespace-nowrap">
        <LocationCell location={v.location} />
      </TableCell>

      <TableCell className="text-muted-foreground">{vehicleTypeLabel(v.vehicleType)}</TableCell>

      <TableCell className="text-right tabular-nums">
        {v.odometerKm === 0 ? (
          <span className="text-muted-foreground/50" title="Kilometraje no cargado">
            —
          </span>
        ) : (
          formatInt(v.odometerKm)
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {v.distanceSinceDtcClearKm === null ? (
          <span className="text-muted-foreground/50" title="Sin dato">
            —
          </span>
        ) : (
          formatInt(v.distanceSinceDtcClearKm)
        )}
      </TableCell>

      <TableCell className="text-xs">
        <ExpiryCell iso={v.vtvExpiresAt} />
      </TableCell>
      <TableCell className="text-xs">
        <ExpiryCell iso={v.insuranceExpiresAt} />
      </TableCell>
      <TableCell className="text-xs">
        <DateOrNever iso={v.registrationCardLoadedAt} never="no cargada" />
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {v.fineConsultedAt === null ? (
          <span className="text-muted-foreground/50" title="Multas nunca consultadas">
            —
          </span>
        ) : (
          <Count value={v.fineCount} />
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        <FineDebtCell amount={v.fineDebtAmount} />
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        <AmountOrNoneCell amount={v.taxDebtAmount} title="Deuda de patente sin saldar" />
      </TableCell>

      <TableCell className="text-right tabular-nums">
        <Count value={v.tasksPast} />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <span className={cn(v.tasksPending > 0 && 'font-medium text-foreground')}>
          <Count value={v.tasksPending} />
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
      <TableCell className="text-xs">
        <DateOrNever iso={v.lastScanAt} never="nunca" />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <Count value={v.scanMinutesTotal} />
      </TableCell>

      <TableCell className="text-right tabular-nums">
        <DtcCodesCell codes={v.activeDtcCodes} warn />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <DtcCodesCell codes={v.inactiveDtcCodes} warn={false} />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <CountOrNeverCell value={v.activeAnomalyCount} title="anomalías del último análisis" />
      </TableCell>

      <TableCell className="text-right tabular-nums">
        <Count value={v.diagnosticChatCount} />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <Count value={v.unreadAlertCount} warn />
      </TableCell>

      <TableCell className="text-xs">
        <DateOrNever iso={v.lastActivityAt} never="nunca" />
      </TableCell>
      <TableCell className="tabular-nums text-muted-foreground">{formatDate(v.createdAt)}</TableCell>
    </TableRow>
  )
}
