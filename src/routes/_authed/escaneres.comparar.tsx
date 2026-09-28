import { Link, createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import {
  COMPARE_DEFAULT_PIDS,
  COMPARE_GROUP_BY,
  COMPARE_GROUP_BY_LABELS,
  COMPARE_KM_BUCKETS,
  COMPARE_LEVELS,
  COMPARE_LEVEL_LABELS,
  COMPARE_MAINTENANCE_WINDOW_DAYS,
  scanCompareSearchSchema,
  type CompareGroupBy,
  type CompareSession,
  type ScanCompareSearch,
} from '~/lib/scan-compare'
import {
  comparePids,
  formatPidValue,
  groupStats,
  implausibleReason,
  isSuspectSession,
  pidLabel,
  pidShort,
  pidUnit,
  quantile,
  type GroupStats,
} from '~/lib/scan-pids'
import { MIN_VEHICLES_FOR_CONFIDENCE } from '~/lib/scanners'
import { scanDurationLabel } from '~/lib/scan-sessions'
import { compareScanSessionsFn, listComparableCatalogsFn } from '~/fn/scan-compare'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { MultiSelect } from '~/components/MultiSelect'
import { PidRangeChart, type PidRangeGroup } from '~/components/PidRangeChart'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatDate, formatDateTime, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * `/escaneres/comparar` — comparar escaneos de autos iguales o parecidos.
 *
 * Reemplaza la consulta que nadie arma: abrir el `metrics` de N escaneos del
 * mismo modelo y compararlos a ojo. Pregunta tipo: "¿cuál es el LTFT normal de
 * un Vento 2.5?". Todo el contrato y sus límites en `~/lib/scan-compare`.
 *
 * El loader depende SÓLO del modelo y del nivel: la selección de autos,
 * escaneos, PIDs y el agrupado se aplican en el cliente sobre la misma lista
 * (son decenas de filas), así tildar un auto no vuelve al servidor y los
 * números de arriba y la tabla de abajo salen siempre del mismo snapshot.
 *
 * `ssr: 'data-only'`: detrás de auth, y el grueso es markup de gráficos que no
 * gana nada renderizándose dos veces.
 */
export const Route = createFileRoute('/_authed/escaneres/comparar')({
  ssr: 'data-only',
  validateSearch: scanCompareSearchSchema,
  loaderDeps: ({ search }) => ({
    compareCatalogId: search.compareCatalogId,
    compareLevel: search.compareLevel,
  }),
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal
    const [catalogs, view] = await Promise.all([
      listComparableCatalogsFn({ signal }),
      deps.compareCatalogId
        ? compareScanSessionsFn({
            data: { catalogId: deps.compareCatalogId, level: deps.compareLevel },
            signal,
          })
        : Promise.resolve(null),
    ])
    return { catalogs, view }
  },
  head: () => ({ meta: [{ title: 'Escáneres · Comparar — AutoLibre' }] }),
  component: CompareScreen,
})

const TRANSMISSION_LABELS: Record<string, string> = { manual: 'Manual', automatic: 'Automática', cvt: 'CVT' }
const FUEL_LABELS: Record<string, string> = {
  gasoline: 'Nafta',
  diesel: 'Diésel',
  cng: 'GNC',
  electric: 'Eléctrico',
  hybrid: 'Híbrido',
}

interface Group {
  key: string
  label: string
  order: number
  sessions: Array<CompareSession>
}

/** En qué bloque cae un escaneo según la característica elegida. `order` fija el orden de los bloques. */
function groupOf(s: CompareSession, by: CompareGroupBy): { key: string; label: string; order: number } {
  switch (by) {
    case 'vehicle':
      return {
        key: s.vehicleId,
        label: `${s.plate} · ${s.year ?? 's/año'} · ${s.userLabel}`,
        order: s.year ?? 0,
      }
    case 'dtc':
      return s.dtcCodes.length > 0
        ? { key: 'with', label: 'Con DTCs', order: 1 }
        : { key: 'without', label: 'Sin DTCs', order: 0 }
    case 'maintenance':
      if (s.lastMaintenanceDaysBefore === null)
        return { key: 'none', label: 'Sin mantenimiento cargado antes', order: 2 }
      return s.lastMaintenanceDaysBefore <= COMPARE_MAINTENANCE_WINDOW_DAYS
        ? { key: 'recent', label: `Con mantenimiento en los ${COMPARE_MAINTENANCE_WINDOW_DAYS} días previos`, order: 0 }
        : { key: 'old', label: `Último mantenimiento hace más de ${COMPARE_MAINTENANCE_WINDOW_DAYS} días`, order: 1 }
    case 'year':
      return { key: String(s.year ?? 'none'), label: s.year ? String(s.year) : 'Sin año', order: s.year ?? 9999 }
    case 'km': {
      if (s.odometerKm === null) return { key: 'none', label: 'Km no cargado', order: 99 }
      const i = COMPARE_KM_BUCKETS.findIndex((b) => (s.odometerKm as number) <= b.upTo)
      const bucket = COMPARE_KM_BUCKETS[i]
      return { key: `km${i}`, label: bucket?.label ?? '—', order: i }
    }
    case 'transmission':
      return s.transmission
        ? { key: s.transmission, label: TRANSMISSION_LABELS[s.transmission] ?? s.transmission, order: 0 }
        : { key: 'none', label: 'Caja sin dato', order: 1 }
    case 'fuel':
      return s.fuelType
        ? { key: s.fuelType, label: FUEL_LABELS[s.fuelType] ?? s.fuelType, order: 0 }
        : { key: 'none', label: 'Combustible sin dato', order: 1 }
    case 'none':
      return { key: 'all', label: 'Todos', order: 0 }
  }
}

function buildGroups(sessions: Array<CompareSession>, by: CompareGroupBy): Array<Group> {
  const map = new Map<string, Group>()
  for (const s of sessions) {
    const g = groupOf(s, by)
    const found = map.get(g.key)
    if (found) found.sessions.push(s)
    else map.set(g.key, { ...g, sessions: [s] })
  }
  return [...map.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
}

/**
 * La mediana de las medias por escaneo, y la misma cuenta con UN valor por
 * auto (la mediana de sus escaneos). Excluye los PIDs dudosos.
 */
function statsFor(sessions: Array<CompareSession>, pid: string): { bySession: GroupStats; byVehicle: GroupStats } {
  const credible = sessions.filter((s) => {
    const m = s.metrics[pid]
    return m && implausibleReason(pid, m) === null
  })
  const avgs = credible.map((s) => (s.metrics[pid] as { avg: number }).avg)
  const perVehicle = new Map<string, Array<number>>()
  for (const s of credible) {
    perVehicle.set(s.vehicleId, [...(perVehicle.get(s.vehicleId) ?? []), (s.metrics[pid] as { avg: number }).avg])
  }
  const vehicleValues = [...perVehicle.values()].map((v) => quantile(v, 0.5) as number)
  return { bySession: groupStats(avgs), byVehicle: groupStats(vehicleValues) }
}

function CompareScreen() {
  const { catalogs, view } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<ScanCompareSearch>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  const all = view?.sessions ?? []

  // ── La selección, en el cliente ─────────────────────────────────────────
  const vehicleSet = new Set(search.compareVehicles)
  const sessionSet = new Set(search.compareSessions)
  const inVehicles = all.filter((s) => vehicleSet.size === 0 || vehicleSet.has(s.vehicleId))
  const selected = inVehicles.filter((s) => sessionSet.size === 0 || sessionSet.has(s.id))
  const suspectIds = new Set(selected.filter((s) => isSuspectSession(s.metrics)).map((s) => s.id))
  const used = search.compareIncludeSuspect ? selected : selected.filter((s) => !suspectIds.has(s.id))

  const availablePids = useMemo(
    () => [...new Set(all.flatMap((s) => Object.keys(s.metrics)))].sort(comparePids),
    [all],
  )
  const pids = (
    search.comparePids.length > 0
      ? search.comparePids
      : COMPARE_DEFAULT_PIDS.filter((p) => availablePids.includes(p))
  ).filter((p) => availablePids.includes(p))

  const groups = buildGroups(used, search.compareGroupBy)
  const usedVehicles = new Set(used.map((s) => s.vehicleId)).size

  const vehicleOptions = [...new Map(all.map((s) => [s.vehicleId, s])).values()].map((s) => ({
    value: s.vehicleId,
    label: `${s.plate} · ${s.catalogLabel} · ${s.userLabel}`,
  }))
  const sessionOptions = inVehicles.map((s) => ({
    value: s.id,
    label: `${s.plate} · ${formatDateTime(s.startedAt)}${s.dtcCodes.length > 0 ? ` · ${s.dtcCodes.length} DTC` : ''}`,
  }))

  return (
    <>
      <PageHeader
        title="Comparar escaneos"
        subtitle="Cómo se comportan autos iguales o parecidos: el valor normal de cada PID y qué cambia con DTCs, km o mantenimiento."
        actions={<SsrTag>ssr: data-only</SsrTag>}
      />

      <div className="mb-4 flex flex-wrap items-end gap-5">
        <div className="space-y-1.5">
          <label
            htmlFor="compare-catalog"
            className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            Modelo de referencia
          </label>
          <select
            id="compare-catalog"
            value={search.compareCatalogId ?? ''}
            onChange={(e) =>
              setSearch({
                compareCatalogId: e.target.value || undefined,
                compareVehicles: [],
                compareSessions: [],
              })
            }
            className="h-8 max-w-[28rem] rounded-md border border-border bg-card px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Elegí un modelo…</option>
            {catalogs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} — {formatInt(c.sessions)} {c.sessions === 1 ? 'escaneo' : 'escaneos'},{' '}
                {formatInt(c.vehicles)} {c.vehicles === 1 ? 'auto' : 'autos'}
              </option>
            ))}
          </select>
        </div>

        <FilterGroup label="Similares">
          {COMPARE_LEVELS.map((l) => (
            <Chip
              key={l}
              active={search.compareLevel === l}
              onClick={() => setSearch({ compareLevel: l, compareVehicles: [], compareSessions: [] })}
            >
              {COMPARE_LEVEL_LABELS[l]}
            </Chip>
          ))}
        </FilterGroup>
      </div>

      {!search.compareCatalogId ? (
        <CatalogPicker catalogs={catalogs} onPick={(id) => setSearch({ compareCatalogId: id })} />
      ) : !view || all.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Este modelo no tiene ningún escaneo con análisis de telemetría.
        </p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-5">
            <FilterGroup
              label="Autos"
              onClear={search.compareVehicles.length > 0 ? () => setSearch({ compareVehicles: [], compareSessions: [] }) : undefined}
            >
              <MultiSelect
                label="Autos"
                options={vehicleOptions}
                selected={search.compareVehicles}
                onChange={(v) => setSearch({ compareVehicles: v, compareSessions: [] })}
                placeholder={`Todos (${formatInt(vehicleOptions.length)})`}
                searchPlaceholder="Patente, modelo, dueño…"
                className="w-72"
              />
            </FilterGroup>

            <FilterGroup
              label="Escaneos"
              onClear={search.compareSessions.length > 0 ? () => setSearch({ compareSessions: [] }) : undefined}
            >
              <MultiSelect
                label="Escaneos"
                options={sessionOptions}
                selected={search.compareSessions}
                onChange={(v) => setSearch({ compareSessions: v })}
                placeholder={`Todos (${formatInt(sessionOptions.length)})`}
                searchPlaceholder="Patente o fecha…"
                className="w-72"
              />
            </FilterGroup>

            <FilterGroup
              label="PIDs"
              onClear={search.comparePids.length > 0 ? () => setSearch({ comparePids: [] }) : undefined}
            >
              <MultiSelect
                label="PIDs"
                options={availablePids.map((p) => ({ value: p, label: pidLabel(p) }))}
                selected={search.comparePids}
                onChange={(v) => setSearch({ comparePids: v })}
                placeholder="Los principales"
                className="w-64"
              />
            </FilterGroup>
          </div>

          <div className="mb-4 flex flex-wrap items-end gap-5">
            <FilterGroup label="Agrupar por">
              {COMPARE_GROUP_BY.map((g) => (
                <Chip key={g} active={search.compareGroupBy === g} onClick={() => setSearch({ compareGroupBy: g })}>
                  {COMPARE_GROUP_BY_LABELS[g]}
                </Chip>
              ))}
            </FilterGroup>

            {suspectIds.size > 0 ? (
              <FilterGroup label="Lecturas dudosas">
                <Chip
                  tone="warn"
                  active={search.compareIncludeSuspect}
                  onClick={() => setSearch({ compareIncludeSuspect: !search.compareIncludeSuspect })}
                >
                  Incluir {formatInt(suspectIds.size)} {suspectIds.size === 1 ? 'escaneo' : 'escaneos'}
                </Chip>
              </FilterGroup>
            ) : null}
          </div>

          <Summary
            catalogs={view.catalogs}
            sessions={used.length}
            vehicles={usedVehicles}
            excludedSuspect={search.compareIncludeSuspect ? 0 : suspectIds.size}
            groupBy={search.compareGroupBy}
          />

          {used.length === 0 ? (
            <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
              No queda ningún escaneo con esta selección.
            </p>
          ) : (
            <>
              <div className="mb-6 grid gap-4 xl:grid-cols-2">
                {pids.map((pid) => (
                  <PidCard key={pid} pid={pid} groups={groups} used={used} groupBy={search.compareGroupBy} />
                ))}
              </div>

              <SessionsTable sessions={used} pids={pids} suspectIds={suspectIds} />
            </>
          )}
        </>
      )}
    </>
  )
}

function CatalogPicker({
  catalogs,
  onPick,
}: {
  catalogs: Array<{ id: string; label: string; sessions: number; vehicles: number }>
  onPick: (id: string) => void
}) {
  const sorted = [...catalogs].sort((a, b) => b.sessions - a.sessions || a.label.localeCompare(b.label))
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="mb-3 text-sm text-muted-foreground">
        Elegí un modelo para empezar. Estos son los que tienen escaneos con análisis, los más escaneados arriba.
      </p>
      <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onPick(c.id)}
              className="flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate">{c.label}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatInt(c.sessions)} esc. · {formatInt(c.vehicles)} {c.vehicles === 1 ? 'auto' : 'autos'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Summary({
  catalogs,
  sessions,
  vehicles,
  excludedSuspect,
  groupBy,
}: {
  catalogs: Array<{ id: string; label: string }>
  sessions: number
  vehicles: number
  excludedSuspect: number
  groupBy: CompareGroupBy
}) {
  return (
    <div className="mb-4 space-y-1 text-sm text-muted-foreground">
      <p>
        <span className="font-medium text-foreground">
          {formatInt(sessions)} {sessions === 1 ? 'escaneo' : 'escaneos'} de {formatInt(vehicles)}{' '}
          {vehicles === 1 ? 'auto' : 'autos'}
        </span>{' '}
        · {catalogs.length === 1 ? 'modelo' : 'modelos'}: {catalogs.map((c) => c.label).join(' · ')}
        {excludedSuspect > 0 ? (
          <span className="text-status-yellow">
            {' '}
            · {formatInt(excludedSuspect)} {excludedSuspect === 1 ? 'excluido' : 'excluidos'} por lectura dudosa
          </span>
        ) : null}
      </p>
      <p className="text-xs leading-relaxed">
        Cada fila es un escaneo: la línea va del mínimo al máximo, la banda es el promedio ± un desvío y el punto
        el promedio. La franja verde de fondo es el rango intercuartil de los promedios del bloque y la línea
        verde su mediana — el valor "normal". Es el resumen que guarda la base; las curvas completas no están
        disponibles en el panel.
        {groupBy === 'km' ? ' El km es el actual del auto, no el del día del escaneo.' : ''}
        {groupBy === 'maintenance'
          ? ` La ventana de ${COMPARE_MAINTENANCE_WINDOW_DAYS} días es un corte nuestro, y es correlación: no dice que el mantenimiento cambió el PID.`
          : ''}
      </p>
    </div>
  )
}

function PidCard({
  pid,
  groups,
  used,
  groupBy,
}: {
  pid: string
  groups: Array<Group>
  used: Array<CompareSession>
  groupBy: CompareGroupBy
}) {
  const overall = statsFor(used, pid)
  const unit = pidUnit(pid)
  const lowEvidence = overall.byVehicle.n < MIN_VEHICLES_FOR_CONFIDENCE
  const showGroupStats = groups.length > 1 || groupBy === 'vehicle'

  const chartGroups: Array<PidRangeGroup> = groups
    .map((g) => {
      const rows = g.sessions
        .filter((s) => s.metrics[pid])
        .map((s) => {
          const m = s.metrics[pid] as NonNullable<(typeof s.metrics)[string]>
          return {
            key: s.id,
            label: (
              <Link
                to="/escaneres/sesiones/$sessionId"
                params={{ sessionId: s.id }}
                className="rounded outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {groupBy === 'vehicle' ? formatDate(s.startedAt) : `${s.plate} · ${formatDate(s.startedAt)}`}
              </Link>
            ),
            sublabel:
              s.dtcCodes.length > 0 ? `${s.dtcCodes.length} DTC · ${formatInt(m.sampleCount)} muestras` : `${formatInt(m.sampleCount)} muestras`,
            metric: m,
            suspect: implausibleReason(pid, m),
          }
        })
      return {
        key: g.key,
        title: g.label,
        rows,
        stats: showGroupStats ? statsFor(g.sessions, pid) : null,
      }
    })
    .filter((g) => g.rows.length > 0)

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3">
        <h2 className="text-sm font-semibold">{pidLabel(pid)}</h2>
        {overall.bySession.median !== null ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Valor típico:{' '}
            <span className={cn('font-heading text-base font-semibold', lowEvidence ? 'text-muted-foreground' : 'text-foreground')}>
              {formatPidValue(overall.byVehicle.median as number)} {unit}
            </span>{' '}
            por auto · {formatPidValue(overall.bySession.median)} {unit} por escaneo (IQR{' '}
            {formatPidValue(overall.bySession.q1 as number)}–{formatPidValue(overall.bySession.q3 as number)}) ·{' '}
            {formatInt(overall.bySession.n)} {overall.bySession.n === 1 ? 'escaneo' : 'escaneos'} de{' '}
            {formatInt(overall.byVehicle.n)} {overall.byVehicle.n === 1 ? 'auto' : 'autos'}
            {lowEvidence ? (
              <span className="block text-muted-foreground">
                Poca evidencia: hacen falta {MIN_VEHICLES_FOR_CONFIDENCE} autos distintos para leerlo como "normal" del
                modelo.
              </span>
            ) : null}
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-muted-foreground">Ningún escaneo creíble midió este PID.</p>
        )}
      </div>
      {chartGroups.length > 0 ? (
        <PidRangeChart pid={pid} groups={chartGroups} labelWidth="8.5rem" />
      ) : (
        <p className="text-sm text-muted-foreground">Ningún escaneo de la selección midió este PID.</p>
      )}
    </div>
  )
}

function SessionsTable({
  sessions,
  pids,
  suspectIds,
}: {
  sessions: Array<CompareSession>
  pids: Array<string>
  suspectIds: Set<string>
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Auto</TableHead>
            <TableHead>Escaneo</TableHead>
            <TableHead>DTCs</TableHead>
            <TableHead className="text-right">Desde borrado</TableHead>
            <TableHead className="text-right">Km auto</TableHead>
            <TableHead>Últ. mantenimiento</TableHead>
            {pids.map((p) => (
              <TableHead key={p} className="text-right" title={pidLabel(p)}>
                {pidShort(p)} ({pidUnit(p)})
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="max-w-56">
                <span className="font-mono font-semibold tracking-wider">{s.plate}</span>
                <div className="truncate text-xs text-muted-foreground">{s.catalogLabel}</div>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Link
                  to="/escaneres/sesiones/$sessionId"
                  params={{ sessionId: s.id }}
                  className="rounded tabular-nums outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {formatDateTime(s.startedAt)}
                </Link>
                <div className="text-xs text-muted-foreground">
                  {scanDurationLabel(s.durationSeconds) ?? '—'} · {formatInt(s.totalReadings)} lecturas
                  {suspectIds.has(s.id) ? <span className="text-status-yellow"> · dudosa</span> : null}
                </div>
              </TableCell>
              <TableCell className="text-xs">
                {s.dtcCodes.length > 0 ? (
                  <span className="font-mono">{s.dtcCodes.join(', ')}</span>
                ) : (
                  <span className="text-muted-foreground">ninguno</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {s.distanceSinceDtcClearKm === null ? (
                  <span className="text-muted-foreground/50">—</span>
                ) : (
                  `${formatInt(s.distanceSinceDtcClearKm)} km`
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {s.odometerKm === null ? <span className="text-muted-foreground/50">—</span> : formatInt(s.odometerKm)}
              </TableCell>
              <TableCell className="max-w-48 text-xs">
                {s.lastMaintenanceName ? (
                  <>
                    <div className="truncate">{s.lastMaintenanceName}</div>
                    <div className="text-muted-foreground">
                      {s.lastMaintenanceDaysBefore === 0
                        ? 'el mismo día'
                        : `${formatInt(s.lastMaintenanceDaysBefore ?? 0)} días antes`}
                    </div>
                  </>
                ) : (
                  <span className="text-muted-foreground">ninguno cargado</span>
                )}
              </TableCell>
              {pids.map((p) => {
                const m = s.metrics[p]
                if (!m)
                  return (
                    <TableCell key={p} className="text-right text-muted-foreground/50">
                      —
                    </TableCell>
                  )
                const bad = implausibleReason(p, m)
                return (
                  <TableCell
                    key={p}
                    className={cn('whitespace-nowrap text-right tabular-nums', bad && 'text-status-yellow')}
                    title={bad ?? undefined}
                  >
                    {formatPidValue(m.avg)}
                    <div className="text-[11px] text-muted-foreground">
                      {formatPidValue(m.min)}–{formatPidValue(m.max)}
                    </div>
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
