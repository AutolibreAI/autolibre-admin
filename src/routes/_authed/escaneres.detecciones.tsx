import { createFileRoute } from '@tanstack/react-router'
import {
  DETECTION_FAMILY_FILTERS,
  DETECTION_KIND_FILTERS,
  DETECTION_KIND_FILTER_LABELS,
  DETECTION_SEVERITY_FILTERS,
  DTC_SYSTEM_LABELS,
  SEVERITY_LABELS,
  detectionSearchSchema,
  dtcFamily,
  ratioPct,
  type DetectionRow,
  type DetectionSearch,
  type MissingDtc,
} from '~/lib/detections'
import { listDetectionsFn } from '~/fn/detections'
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
import { formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * Detecciones de escáner — cada fila es un código DTC o un tipo de anomalía,
 * agregado sobre todos los escaneos que trajeron datos.
 *
 * SSR heredado (`true`): pantalla de CONTENIDO / consulta, igual que las otras
 * dos pestañas de `/escaneres`. Se abre para contestar "¿qué falla aparece más
 * seguido y en cuántos autos?", y una tabla que llega tarde detrás de un shell
 * vacío molesta justo cuando alguien la está mirando.
 *
 * → `.claude/rules/scan-detections.md`
 */
export const Route = createFileRoute('/_authed/escaneres/detecciones')({
  validateSearch: detectionSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ deps, abortController }) =>
    listDetectionsFn({ data: deps, signal: abortController.signal }),
  head: () => ({ meta: [{ title: 'Escáneres · Detecciones — AutoLibre' }] }),
  component: Detections,
})

function Detections() {
  const { rows, missingDtcs, dtcSessions, dtcVehicles, anomalySessions, anomalyVehicles } =
    Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<DetectionSearch>) =>
    navigate({ search: { ...search, ...next }, replace: true })

  const filtered =
    Boolean(search.q) ||
    search.detectionKind !== 'all' ||
    search.detectionSeverity !== 'all' ||
    search.detectionFamily !== 'all'

  const dtcCount = rows.filter((r) => r.kind === 'dtc').length
  const anomalyCount = rows.filter((r) => r.kind === 'anomaly').length

  return (
    <>
      <PageHeader
        title="Detecciones de escáner"
        subtitle={`${formatInt(rows.length)} ${filtered ? 'con este filtro' : 'detecciones'} · ${formatInt(dtcCount)} códigos DTC (sobre ${formatInt(dtcSessions)} escaneos) · ${formatInt(anomalyCount)} anomalías (sobre ${formatInt(anomalySessions)} con telemetría)`}
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
            placeholder="Código DTC o tipo de anomalía"
            defaultValue={search.q ?? ''}
            className="w-64"
            onChange={(e) => {
              const value = e.currentTarget.value.trim()
              setSearch({ q: value === '' ? undefined : value })
            }}
          />
        </div>

        <FilterGroup label="Tipo">
          {DETECTION_KIND_FILTERS.map((k) => (
            <Chip
              key={k}
              active={search.detectionKind === k}
              onClick={() => setSearch({ detectionKind: k })}
            >
              {DETECTION_KIND_FILTER_LABELS[k]}
            </Chip>
          ))}
        </FilterGroup>

        {/*
          Severidad sólo aplica a anomalías (un DTC no la lleva en estas
          tablas): elegir una severidad implícitamente esconde los códigos, y
          está bien. `red` en `warn` porque acota a lo más grave.
        */}
        <FilterGroup label="Severidad">
          {DETECTION_SEVERITY_FILTERS.map((s) => (
            <Chip
              key={s}
              tone={s === 'red' ? 'warn' : 'brand'}
              active={search.detectionSeverity === s}
              onClick={() => setSearch({ detectionSeverity: s })}
            >
              {s === 'all' ? 'Todas' : SEVERITY_LABELS[s]}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="Familia DTC">
          {DETECTION_FAMILY_FILTERS.map((f) => (
            <Chip
              key={f}
              active={search.detectionFamily === f}
              onClick={() => setSearch({ detectionFamily: f })}
            >
              {f === 'all' ? 'Todas' : DTC_SYSTEM_LABELS[f]}
            </Chip>
          ))}
        </FilterGroup>
      </div>

      {missingDtcs.length > 0 ? (
        <MissingDtcBlock
          missing={missingDtcs}
          onPick={(code) => setSearch({ q: code, detectionKind: 'dtc' })}
        />
      ) : null}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          {filtered
            ? 'Ninguna detección con estos filtros.'
            : 'Todavía no hay ninguna detección registrada. Cuando un escaneo traiga códigos DTC o el análisis de telemetría encuentre una anomalía, aparece acá.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <SortHeader label="Tipo" sortKey="kind" active={search.sort === 'kind'} dir={search.dir} to="/escaneres/detecciones" firstClick="asc" />
                <SortHeader label="Código / anomalía" sortKey="label" active={search.sort === 'label'} dir={search.dir} to="/escaneres/detecciones" firstClick="asc" />
                <SortHeader label="Severidad / familia" sortKey="severity" active={search.sort === 'severity'} dir={search.dir} to="/escaneres/detecciones" firstClick="desc" />
                <SortHeader label="Sesiones" sortKey="sessions" active={search.sort === 'sessions'} dir={search.dir} to="/escaneres/detecciones" align="right" firstClick="desc" />
                <SortHeader label="Vehículos" sortKey="vehicles" active={search.sort === 'vehicles'} dir={search.dir} to="/escaneres/detecciones" align="right" firstClick="desc" />
                <SortHeader label="Modelos" sortKey="models" active={search.sort === 'models'} dir={search.dir} to="/escaneres/detecciones" align="right" firstClick="desc" />
                <SortHeader label="Primera" sortKey="first" active={search.sort === 'first'} dir={search.dir} to="/escaneres/detecciones" firstClick="desc" />
                <SortHeader label="Última" sortKey="last" active={search.sort === 'last'} dir={search.dir} to="/escaneres/detecciones" firstClick="desc" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <DetectionTableRow
                  key={`${r.kind}-${r.key}`}
                  row={r}
                  sessionsDenominator={r.kind === 'dtc' ? dtcSessions : anomalySessions}
                  vehiclesDenominator={r.kind === 'dtc' ? dtcVehicles : anomalyVehicles}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Los DTC se cuentan sobre los <strong>{formatInt(dtcSessions)}</strong> escaneos
        que terminaron (un código se lee aunque el escáner no traiga telemetría en
        vivo); las anomalías, sobre los <strong>{formatInt(anomalySessions)}</strong>{' '}
        que sí trajeron datos. «Sesiones» cuenta 1 por escaneo aunque una anomalía se
        haya disparado varias veces en él; «disparos» es el crudo. La severidad la
        trae el análisis de telemetría; los códigos DTC no la llevan. El título de
        cada código sale del catálogo local{' '}
        <code className="font-mono">src/server/dtc-codes.json</code>; los que no
        están cargados salen listados arriba para agregarlos.
      </p>
    </>
  )
}

const KIND_TONE: Record<DetectionRow['kind'], string> = {
  dtc: 'border-status-violet/25 bg-status-violet-bg text-status-violet',
  anomaly: 'border-border bg-secondary text-muted-foreground',
}

const SEVERITY_CHIP: Record<string, string> = {
  red: 'border-status-red/30 bg-status-red-bg text-status-red',
  violet: 'border-status-violet/30 bg-status-violet-bg text-status-violet',
  yellow: 'border-status-yellow/30 bg-status-yellow-bg text-status-yellow',
}

function DetectionTableRow({
  row: r,
  sessionsDenominator,
  vehiclesDenominator,
}: {
  row: DetectionRow
  sessionsDenominator: number
  vehiclesDenominator: number
}) {
  const sessionsPct = ratioPct(r.sessions, sessionsDenominator)
  const vehiclesPct = ratioPct(r.vehicles, vehiclesDenominator)
  const family = r.kind === 'dtc' ? dtcFamily(r.key) : null

  return (
    <TableRow>
      <TableCell>
        <span
          className={cn(
            'inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium',
            KIND_TONE[r.kind],
          )}
        >
          {r.kind === 'dtc' ? 'DTC' : 'Anomalía'}
        </span>
      </TableCell>

      <TableCell className="max-w-72">
        {r.kind === 'dtc' ? (
          <div className="space-y-0.5">
            <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs font-semibold">
              {r.key}
            </code>
            {r.dtcTitle ? (
              <div className="text-xs">{r.dtcTitle}</div>
            ) : (
              <div className="text-xs text-status-yellow">sin título cargado</div>
            )}
          </div>
        ) : (
          <>
            <span className="font-medium">{r.label}</span>
            <div className="font-mono text-[11px] text-muted-foreground">{r.key}</div>
          </>
        )}
      </TableCell>

      <TableCell>
        {r.kind === 'anomaly' ? (
          <div className="flex flex-wrap gap-1">
            {r.severities.length === 0 ? (
              <span className="text-muted-foreground/50">—</span>
            ) : (
              r.severities.map((s) => (
                <span
                  key={s}
                  className={cn(
                    'inline-flex items-center rounded border px-1 py-px text-[11px]',
                    SEVERITY_CHIP[s] ?? 'border-border text-muted-foreground',
                  )}
                >
                  {SEVERITY_LABELS[s] ?? s}
                </span>
              ))
            )}
          </div>
        ) : family ? (
          <div className="text-xs">
            <div>{r.dtcSystem ?? family.systemLabel}</div>
            <div className="text-muted-foreground">
              {family.generic === null
                ? 'formato no estándar'
                : family.generic
                  ? 'genérico'
                  : 'de fabricante'}
            </div>
          </div>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </TableCell>

      <TableCell className="whitespace-nowrap text-right tabular-nums">
        {formatInt(r.sessions)}
        {sessionsPct !== null ? (
          <span className="ml-1 text-xs text-muted-foreground">{sessionsPct}%</span>
        ) : null}
        {r.occurrences > r.sessions ? (
          <div className="text-xs text-muted-foreground">{formatInt(r.occurrences)} disparos</div>
        ) : null}
      </TableCell>

      <TableCell className="whitespace-nowrap text-right tabular-nums">
        {formatInt(r.vehicles)}
        {vehiclesPct !== null ? (
          <span className="ml-1 text-xs text-muted-foreground">{vehiclesPct}%</span>
        ) : null}
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {r.models === 0 ? (
          <span className="text-muted-foreground/50">—</span>
        ) : (
          formatInt(r.models)
        )}
      </TableCell>

      <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
        {formatDate(r.firstSeen)}
      </TableCell>

      <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
        {formatDate(r.lastSeen)}
      </TableCell>
    </TableRow>
  )
}

/**
 * DTCs detectados en un escaneo con datos que NO están en
 * `src/server/dtc-codes.json`. Bloque aparte —no un filtro— porque es trabajo
 * pendiente que hay que ver aunque la tabla esté filtrada por otra cosa. Se
 * calcula sin los filtros de la tabla. `tone="warn"` (ámbar): falta un dato, no
 * está roto nada. Cada código es un botón que filtra la tabla por él.
 */
function MissingDtcBlock({
  missing,
  onPick,
}: {
  missing: Array<MissingDtc>
  onPick: (code: string) => void
}) {
  return (
    <div className="mb-4 rounded-lg border border-status-yellow/40 bg-status-yellow-bg p-4">
      <h2 className="text-sm font-semibold text-status-yellow">
        {formatInt(missing.length)} código{missing.length === 1 ? '' : 's'} DTC sin
        título cargado
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Los detectamos en un escaneo pero no están en{' '}
        <code className="font-mono">src/server/dtc-codes.json</code>. Agregalos ahí
        para que aparezca su título.
      </p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {missing.map((m) => (
          <li key={m.code}>
            <button
              type="button"
              onClick={() => onPick(m.code)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs outline-none hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              title={`Ver en la tabla · última vez ${formatDate(m.lastSeen)}`}
            >
              <code className="font-mono font-semibold">{m.code}</code>
              <span className="tabular-nums text-muted-foreground">
                {formatInt(m.sessions)} ses. · {formatInt(m.vehicles)} veh.
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
