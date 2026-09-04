import { Link, createFileRoute } from '@tanstack/react-router'
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react'
import {
  DOCUMENT_STATUS_LABELS,
  VEHICLE_ARCHIVED_FILTERS,
  VEHICLE_DOCUMENT_FILTERS,
  VEHICLE_FINES_FILTERS,
  VEHICLE_REGISTRATION_CARD_FILTERS,
  VEHICLE_SCAN_FILTERS,
  vehicleSearchSchema,
  type VehicleArchivedFilter,
  type VehicleDocumentFilter,
  type VehicleFinesFilter,
  type VehicleListItem,
  type VehicleRegistrationCardFilter,
  type VehicleScanFilter,
  type VehicleSearch,
  type VehicleSortKey,
} from '~/lib/vehicles'
import { getVehicleBrandOptions, getVehicleModelOptions, listAppVehicles } from '~/fn/vehicles'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup, RangeFilter, SelectFilter } from '~/components/Filters'
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

export const Route = createFileRoute('/_authed/vehiculos/')({
  /**
   * SSR completo, mismo criterio que `/usuarios`: se llega buscando una
   * patente pegada en un ticket de soporte, así que suele ser el primer
   * pintado de la sesión. Las opciones de Marca/Modelo viajan en el MISMO
   * loader que el listado — son necesarias para pintar los `<select>` de
   * filtro, y pedirlas aparte del lado del cliente sería un segundo
   * round-trip para algo que ya se sabe hace falta.
   */
  validateSearch: vehicleSearchSchema,
  loaderDeps: ({ search }) => search,

  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal
    const [vehicles, brands, models] = await Promise.all([
      listAppVehicles({ data: deps, signal }),
      getVehicleBrandOptions({ signal }),
      getVehicleModelOptions({ signal }),
    ])
    return { vehicles, brands, models }
  },

  head: () => ({ meta: [{ title: 'Vehículos — AutoLibre' }] }),
  component: VehiclesList,
})

const ARCHIVED_FILTER_LABELS: Record<VehicleArchivedFilter, string> = {
  active: 'Activos',
  archived: 'Archivados',
  all: 'Todos',
}

const SCAN_FILTER_LABELS: Record<VehicleScanFilter, string> = {
  all: 'Todos',
  ok: 'Con datos',
  failures: 'Fallidos',
  never: 'Nunca',
}

const DOCUMENT_FILTER_LABELS: Record<VehicleDocumentFilter, string> = {
  all: 'Todos',
  valid: 'Vigente',
  expired: 'Vencido',
  missing: 'No cargado',
}

const REGISTRATION_CARD_FILTER_LABELS: Record<VehicleRegistrationCardFilter, string> = {
  all: 'Todos',
  loaded: 'Cargada',
  missing: 'No cargada',
}

const FINES_FILTER_LABELS: Record<VehicleFinesFilter, string> = {
  all: 'Todos',
  pending: 'Con pendientes',
  none: 'Ninguna',
}

/** `''` en un input ↔ `undefined` en el search param — nunca `0`. */
const toIntParam = (raw: string): number | undefined => (raw.trim() === '' ? undefined : Number(raw))
const toDateParam = (raw: string): string | undefined => (raw.trim() === '' ? undefined : raw)
const fromParam = (n: number | undefined): string => (n === undefined ? '' : String(n))
const fromDateParam = (d: string | undefined): string => d ?? ''

/**
 * El listado de vehículos.
 *
 * No reemplaza una única consulta de DBeaver: reemplaza la docena de `select`
 * sueltos por `vehicle_id` que hoy hacen falta para saber si un auto está
 * sano — contra `driving_sessions`, `conversations`, `maintenance_occurrences`,
 * `notifications`, `fines`, `insurances`, `vehicle_inspections`,
 * `registration_cards` y `diagnostic_dtcs`. → `.claude/rules/vehicles.md`
 *
 * Las 23 columnas se pueden ordenar Y filtrar, sin excepción — es el pedido
 * explícito que reemplazó al recorte inicial. Los filtros "rápidos" (los que
 * un operador usa todos los días) quedan arriba, sueltos; el resto vive
 * colapsado en «Más filtros» para que la pantalla no se vuelva ilegible de
 * entrada — el `<details>` es nativo a propósito, no hay componente de
 * acordeón en este repo todavía y uno nuevo no hacía falta para esto.
 */
function VehiclesList() {
  const { vehicles, brands, models } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true })

  const quickFiltered =
    search.q ||
    search.archived !== 'active' ||
    search.scans !== 'all' ||
    search.onlyWithAlerts ||
    search.fines !== 'all' ||
    search.onlyNeverActive

  const moreFilters: Array<boolean> = [
    Boolean(search.brand),
    Boolean(search.model),
    search.yearMin !== undefined,
    search.yearMax !== undefined,
    Boolean(search.createdFrom),
    Boolean(search.createdTo),
    Boolean(search.activityFrom),
    Boolean(search.activityTo),
    Boolean(search.lastScanFrom),
    Boolean(search.lastScanTo),
    search.scanMinutesMin !== undefined,
    search.scanMinutesMax !== undefined,
    search.chatsMin !== undefined,
    search.chatsMax !== undefined,
    search.pastTasksMin !== undefined,
    search.pastTasksMax !== undefined,
    search.pendingTasksMin !== undefined,
    search.pendingTasksMax !== undefined,
    search.insurance !== 'all',
    search.vtv !== 'all',
    search.registrationCard !== 'all',
    search.odometerMin !== undefined,
    search.odometerMax !== undefined,
    search.dtcClearKmMin !== undefined,
    search.dtcClearKmMax !== undefined,
    search.onlyWithActiveDtc,
    search.onlyWithInactiveDtc,
  ]
  const moreFiltersCount = moreFilters.filter(Boolean).length

  const filtered = quickFiltered || moreFiltersCount > 0

  return (
    <>
      <PageHeader
        title="Vehículos"
        subtitle={`${formatInt(vehicles.length)} ${filtered ? 'con este filtro' : 'en total'}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <div className="mb-3 flex flex-wrap items-end gap-5">
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
            placeholder="Patente, marca, modelo, versión o dueño"
            defaultValue={search.q ?? ''}
            className="w-64"
            onChange={(e) => {
              const value = e.currentTarget.value.trim()
              setSearch({ q: value === '' ? undefined : value })
            }}
          />
        </div>

        <FilterGroup label="Estado">
          {VEHICLE_ARCHIVED_FILTERS.map((a) => (
            <Chip key={a} active={search.archived === a} onClick={() => setSearch({ archived: a })}>
              {ARCHIVED_FILTER_LABELS[a]}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="Escaneos">
          {VEHICLE_SCAN_FILTERS.map((s) => (
            <Chip
              key={s}
              tone={s === 'failures' ? 'warn' : 'brand'}
              active={search.scans === s}
              onClick={() => setSearch({ scans: s })}
            >
              {SCAN_FILTER_LABELS[s]}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="Alertas">
          <Chip
            tone="warn"
            active={search.onlyWithAlerts}
            onClick={() => setSearch({ onlyWithAlerts: !search.onlyWithAlerts })}
          >
            Con alertas activas
          </Chip>
        </FilterGroup>

        <FilterGroup label="Multas">
          {VEHICLE_FINES_FILTERS.map((f) => (
            <Chip
              key={f}
              tone={f === 'pending' ? 'warn' : 'brand'}
              active={search.fines === f}
              onClick={() => setSearch({ fines: f })}
            >
              {FINES_FILTER_LABELS[f]}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="Actividad">
          <Chip
            active={search.onlyNeverActive}
            onClick={() => setSearch({ onlyNeverActive: !search.onlyNeverActive })}
          >
            Nunca activos
          </Chip>
        </FilterGroup>
      </div>

      <details className="mb-4 rounded-lg border border-border bg-card">
        <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          Más filtros{moreFiltersCount > 0 ? ` (${moreFiltersCount})` : ''}
        </summary>

        <div className="flex flex-wrap items-end gap-5 border-t border-border p-4">
          <SelectFilter
            label="Marca"
            value={search.brand}
            onChange={(brand) => setSearch({ brand })}
            options={brands}
          />
          <SelectFilter
            label="Modelo"
            value={search.model}
            onChange={(model) => setSearch({ model })}
            options={models}
          />
          <RangeFilter
            label="Año"
            type="number"
            min={fromParam(search.yearMin)}
            max={fromParam(search.yearMax)}
            onChange={({ min, max }) =>
              setSearch({
                ...(min !== undefined && { yearMin: toIntParam(min) }),
                ...(max !== undefined && { yearMax: toIntParam(max) }),
              })
            }
          />
          <RangeFilter
            label="Alta"
            type="date"
            min={fromDateParam(search.createdFrom)}
            max={fromDateParam(search.createdTo)}
            onChange={({ min, max }) =>
              setSearch({
                ...(min !== undefined && { createdFrom: toDateParam(min) }),
                ...(max !== undefined && { createdTo: toDateParam(max) }),
              })
            }
          />
          <RangeFilter
            label="Última actividad"
            type="date"
            min={fromDateParam(search.activityFrom)}
            max={fromDateParam(search.activityTo)}
            onChange={({ min, max }) =>
              setSearch({
                ...(min !== undefined && { activityFrom: toDateParam(min) }),
                ...(max !== undefined && { activityTo: toDateParam(max) }),
              })
            }
          />
          <RangeFilter
            label="Último escaneo"
            type="date"
            min={fromDateParam(search.lastScanFrom)}
            max={fromDateParam(search.lastScanTo)}
            onChange={({ min, max }) =>
              setSearch({
                ...(min !== undefined && { lastScanFrom: toDateParam(min) }),
                ...(max !== undefined && { lastScanTo: toDateParam(max) }),
              })
            }
          />
          <RangeFilter
            label="Tiempo escaneado (min)"
            type="number"
            min={fromParam(search.scanMinutesMin)}
            max={fromParam(search.scanMinutesMax)}
            onChange={({ min, max }) =>
              setSearch({
                ...(min !== undefined && { scanMinutesMin: toIntParam(min) }),
                ...(max !== undefined && { scanMinutesMax: toIntParam(max) }),
              })
            }
          />
          <RangeFilter
            label="Chats IA diag."
            type="number"
            min={fromParam(search.chatsMin)}
            max={fromParam(search.chatsMax)}
            onChange={({ min, max }) =>
              setSearch({
                ...(min !== undefined && { chatsMin: toIntParam(min) }),
                ...(max !== undefined && { chatsMax: toIntParam(max) }),
              })
            }
          />
          <RangeFilter
            label="Tareas pasadas"
            type="number"
            min={fromParam(search.pastTasksMin)}
            max={fromParam(search.pastTasksMax)}
            onChange={({ min, max }) =>
              setSearch({
                ...(min !== undefined && { pastTasksMin: toIntParam(min) }),
                ...(max !== undefined && { pastTasksMax: toIntParam(max) }),
              })
            }
          />
          <RangeFilter
            label="Tareas futuras"
            type="number"
            min={fromParam(search.pendingTasksMin)}
            max={fromParam(search.pendingTasksMax)}
            onChange={({ min, max }) =>
              setSearch({
                ...(min !== undefined && { pendingTasksMin: toIntParam(min) }),
                ...(max !== undefined && { pendingTasksMax: toIntParam(max) }),
              })
            }
          />

          <FilterGroup label="Seguro">
            {VEHICLE_DOCUMENT_FILTERS.map((d) => (
              <Chip
                key={d}
                tone={d === 'expired' ? 'warn' : 'brand'}
                active={search.insurance === d}
                onClick={() => setSearch({ insurance: d })}
              >
                {DOCUMENT_FILTER_LABELS[d]}
              </Chip>
            ))}
          </FilterGroup>

          <FilterGroup label="VTV">
            {VEHICLE_DOCUMENT_FILTERS.map((d) => (
              <Chip
                key={d}
                tone={d === 'expired' ? 'warn' : 'brand'}
                active={search.vtv === d}
                onClick={() => setSearch({ vtv: d })}
              >
                {DOCUMENT_FILTER_LABELS[d]}
              </Chip>
            ))}
          </FilterGroup>

          <FilterGroup label="Cédula">
            {VEHICLE_REGISTRATION_CARD_FILTERS.map((r) => (
              <Chip
                key={r}
                active={search.registrationCard === r}
                onClick={() => setSearch({ registrationCard: r })}
              >
                {REGISTRATION_CARD_FILTER_LABELS[r]}
              </Chip>
            ))}
          </FilterGroup>

          <RangeFilter
            label="Kilometraje"
            type="number"
            min={fromParam(search.odometerMin)}
            max={fromParam(search.odometerMax)}
            onChange={({ min, max }) =>
              setSearch({
                ...(min !== undefined && { odometerMin: toIntParam(min) }),
                ...(max !== undefined && { odometerMax: toIntParam(max) }),
              })
            }
          />
          <RangeFilter
            label="Km s/ borrado"
            type="number"
            min={fromParam(search.dtcClearKmMin)}
            max={fromParam(search.dtcClearKmMax)}
            onChange={({ min, max }) =>
              setSearch({
                ...(min !== undefined && { dtcClearKmMin: toIntParam(min) }),
                ...(max !== undefined && { dtcClearKmMax: toIntParam(max) }),
              })
            }
          />

          <FilterGroup label="DTCs">
            <Chip
              tone="warn"
              active={search.onlyWithActiveDtc}
              onClick={() => setSearch({ onlyWithActiveDtc: !search.onlyWithActiveDtc })}
            >
              Con activos
            </Chip>
            <Chip
              active={search.onlyWithInactiveDtc}
              onClick={() => setSearch({ onlyWithInactiveDtc: !search.onlyWithInactiveDtc })}
            >
              Con inactivos
            </Chip>
          </FilterGroup>
        </div>
      </details>

      {vehicles.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-6 py-16 text-center">
          <p className="text-sm font-medium">Ningún vehículo con este filtro</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
            Probá con parte de la patente, la marca o el email del dueño.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHeader label="Patente" sortKey="plate" search={search} />
                <SortableHeader label="Marca" sortKey="brand" search={search} />
                <SortableHeader label="Modelo" sortKey="model" search={search} />
                <SortableHeader label="Año" sortKey="year" search={search} align="right" />
                <SortableHeader label="Versión" sortKey="trim" search={search} />
                <SortableHeader label="Dueño" sortKey="owner" search={search} />
                <SortableHeader label="Alta" sortKey="createdAt" search={search} />
                <SortableHeader label="Última actividad" sortKey="lastActivity" search={search} />
                <SortableHeader label="Escaneos" sortKey="scans" search={search} align="right" />
                <SortableHeader label="Último escaneo" sortKey="lastScanAt" search={search} />
                <SortableHeader label="Tiempo escaneado" sortKey="scanMinutes" search={search} align="right" />
                <SortableHeader label="Chats IA diag." sortKey="chats" search={search} align="right" />
                <SortableHeader label="Tareas pasadas" sortKey="pastTasks" search={search} align="right" />
                <SortableHeader label="Tareas futuras" sortKey="pendingTasks" search={search} align="right" />
                <SortableHeader label="Alertas" sortKey="alerts" search={search} align="right" />
                <SortableHeader label="Seguro" sortKey="insurance" search={search} />
                <SortableHeader label="VTV" sortKey="vtv" search={search} />
                <SortableHeader label="Cédula" sortKey="registrationCard" search={search} />
                <SortableHeader label="Multas" sortKey="fines" search={search} align="right" />
                <SortableHeader label="Kilometraje" sortKey="odometer" search={search} align="right" />
                <SortableHeader label="Km s/ borrado" sortKey="dtcClearKm" search={search} align="right" />
                <SortableHeader label="DTCs activos" sortKey="activeDtc" search={search} align="right" />
                <SortableHeader label="DTCs inactivos" sortKey="inactiveDtc" search={search} align="right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {vehicles.map((v) => (
                <Row key={v.id} vehicle={v} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {vehicles.length === 500 ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Cortado en 500 filas. Afiná la búsqueda — el listado no pagina a
          propósito: paginar sin buscar es hojear un padrón, y nadie encuentra
          nada así.
        </p>
      ) : null}
    </>
  )
}

function Row({ vehicle: v }: { vehicle: VehicleListItem }) {
  return (
    <TableRow className={cn(v.archived && 'opacity-60')}>
      <TableCell>
        <Link
          to="/vehiculos/$vehicleId"
          params={{ vehicleId: v.id }}
          className="rounded font-medium outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="font-mono tracking-wider">{v.plate}</span>
        </Link>
        {v.alias ? <div className="text-xs text-muted-foreground">«{v.alias}»</div> : null}
      </TableCell>

      <TableCell>{v.brand}</TableCell>
      <TableCell>{v.model}</TableCell>
      <TableCell className="text-right tabular-nums">{v.year}</TableCell>
      <TableCell className="text-muted-foreground">{v.trim}</TableCell>

      <TableCell>
        <Link
          to="/usuarios/$userId"
          params={{ userId: v.ownerId }}
          className="rounded outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {v.ownerName ?? v.ownerEmail}
        </Link>
        {v.ownerName ? <div className="text-xs text-muted-foreground">{v.ownerEmail}</div> : null}
      </TableCell>

      <TableCell className="tabular-nums text-muted-foreground">{formatDate(v.createdAt)}</TableCell>

      <TableCell className="tabular-nums text-muted-foreground">
        {v.lastActivityAt ? (
          formatDate(v.lastActivityAt)
        ) : (
          <span className="text-xs text-muted-foreground/70">sin actividad</span>
        )}
      </TableCell>

      {/* Mismo criterio que `/usuarios`: OK sobre total, ámbar cuando ninguno sirvió. */}
      <TableCell className="text-right tabular-nums">
        {v.scansTotal === 0 ? (
          <span className="text-muted-foreground/50" title="Nunca se escaneó">
            —
          </span>
        ) : (
          <span
            className={cn(v.scansOk === 0 && 'text-status-yellow')}
            title={
              v.scansOk === 0
                ? `${v.scansTotal} intento(s), ninguno trajo datos`
                : `${v.scansOk} de ${v.scansTotal} trajeron datos`
            }
          >
            {v.scansOk}
            <span className="text-muted-foreground"> / {v.scansTotal}</span>
          </span>
        )}
      </TableCell>

      <TableCell className="tabular-nums text-muted-foreground">
        {v.lastScanAt ? formatDate(v.lastScanAt) : <span className="text-muted-foreground/50">—</span>}
      </TableCell>

      <TableCell className="text-right tabular-nums text-muted-foreground">
        {v.scanMinutesTotal === 0 ? (
          <span className="text-muted-foreground/50">—</span>
        ) : (
          `${formatInt(v.scanMinutesTotal)} min`
        )}
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {v.diagnosticChatCount === 0 ? (
          <span className="text-muted-foreground/50">0</span>
        ) : (
          formatInt(v.diagnosticChatCount)
        )}
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {v.pastTasksCount === 0 ? (
          <span className="text-muted-foreground/50">0</span>
        ) : (
          formatInt(v.pastTasksCount)
        )}
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {v.pendingTasksCount === 0 ? (
          <span className="text-muted-foreground/50">0</span>
        ) : (
          formatInt(v.pendingTasksCount)
        )}
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {v.activeAlertsCount === 0 ? (
          <span className="text-muted-foreground/50">0</span>
        ) : (
          <span className="font-medium text-status-yellow">{formatInt(v.activeAlertsCount)}</span>
        )}
      </TableCell>

      <TableCell>
        <DocumentCell status={v.insuranceStatus} expiresAt={v.insuranceExpiresAt} />
      </TableCell>

      <TableCell>
        <DocumentCell status={v.vtvStatus} expiresAt={v.vtvExpiresAt} />
      </TableCell>

      <TableCell>
        {v.registrationCardLoadedAt ? (
          <span className="text-status-green" title={`Cargada ${formatDate(v.registrationCardLoadedAt)}`}>
            cargada
          </span>
        ) : (
          <span className="text-muted-foreground/50">no cargada</span>
        )}
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {v.finesCount === 0 ? (
          <span className="text-muted-foreground/50">0</span>
        ) : (
          <span
            className={cn(v.finesPendingCount > 0 && 'font-medium text-status-yellow')}
            title={`${v.finesPendingCount} pendiente(s) de ${v.finesCount} total`}
          >
            {v.finesPendingCount}
            <span className="text-muted-foreground"> / {v.finesCount}</span>
          </span>
        )}
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {v.odometerValue === 0 ? (
          <span className="text-status-yellow" title="Sin odómetro cargado">
            0
          </span>
        ) : (
          formatInt(v.odometerValue)
        )}
      </TableCell>

      <TableCell className="text-right tabular-nums text-muted-foreground">
        {v.distanceSinceDtcClearKm === null ? (
          <span className="text-muted-foreground/50">—</span>
        ) : (
          formatInt(v.distanceSinceDtcClearKm)
        )}
      </TableCell>

      <TableCell className="text-right tabular-nums">
        <DtcCountCell codes={v.activeDtcCodes} tone="warn" />
      </TableCell>

      <TableCell className="text-right tabular-nums">
        <DtcCountCell codes={v.inactiveDtcCodes} tone="neutral" />
      </TableCell>
    </TableRow>
  )
}

/**
 * Seguro y VTV comparten esta celda: las dos son "¿está vigente el
 * documento?". `null` (gris) es "no cargado", que es DISTINTO de `expired`
 * (ámbar) — un documento vencido al menos existió.
 */
function DocumentCell({ status, expiresAt }: { status: string | null; expiresAt: string | null }) {
  if (!status || !expiresAt) return <span className="text-muted-foreground/50">no cargado</span>

  const label = DOCUMENT_STATUS_LABELS[status] ?? status
  return (
    <span className={cn(status !== 'active' && 'text-status-yellow')} title={`Vence ${formatDate(expiresAt)}`}>
      {label}
    </span>
  )
}

/**
 * DTCs activos e inactivos comparten esta celda. `null` (gris, "—") es
 * "nunca se escaneó por DTC" — sólo puede pasar del lado "activos", porque
 * "inactivos" siempre es un array (posiblemente vacío). El tono `warn` es
 * sólo para activos: un DTC inactivo es información, no un problema vigente.
 */
function DtcCountCell({ codes, tone }: { codes: Array<string> | null; tone: 'warn' | 'neutral' }) {
  if (codes === null) {
    return (
      <span className="text-muted-foreground/50" title="Nunca se escaneó por DTC">
        —
      </span>
    )
  }
  if (codes.length === 0) return <span className="text-muted-foreground/50">0</span>
  return (
    <span
      className={cn(tone === 'warn' && 'font-medium text-status-yellow')}
      title={codes.join(', ')}
    >
      {formatInt(codes.length)}
    </span>
  )
}

function SortableHeader({
  label,
  sortKey,
  search,
  align,
}: {
  label: string
  sortKey: VehicleSortKey
  search: VehicleSearch
  align?: 'right'
}) {
  const active = search.sort === sortKey
  const nextDir = active && search.dir === 'asc' ? 'desc' : 'asc'

  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <Link
        to="/vehiculos"
        search={(prev) => ({ ...prev, sort: sortKey, dir: nextDir })}
        replace
        className={cn(
          'inline-flex items-center gap-1 whitespace-nowrap rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
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
