import { Link, createFileRoute } from '@tanstack/react-router'
import { User, X, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  DETECTION_FAMILY_FILTERS,
  DETECTION_KIND_FILTERS,
  DETECTION_KIND_FILTER_LABELS,
  DETECTION_SEVERITY_FILTERS,
  DTC_SYSTEM_LABELS,
  SEVERITY_LABELS,
  detectionSearchSchema,
  detectionSelectionOpen,
  dtcFamily,
  ratioPct,
  type DetectionKind,
  type DetectionRow,
  type DetectionSearch,
  type DetectionSessionRow,
  type DetectionSessionsView,
  type MissingDtc,
} from '~/lib/detections'
import { anomalyTypeLabel, scanDurationLabel } from '~/lib/scan-sessions'
import { getDetectionSessionsFn, listDetectionsFn } from '~/fn/detections'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { SortHeader } from '~/components/SortHeader'
import { SearchInput } from '~/components/SearchInput'
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
  /**
   * Dos consultas en paralelo: la tabla (siempre) y las sesiones de la
   * detección seleccionada (sólo si hay una). El detalle va en el loader y no
   * en un `useState` con fetch, mismo criterio que `sessionsPanelOpen` de
   * `/escaneres/compatibilidad`: la selección vive en la URL, así que
   * compartir `/escaneres/detecciones?detectionKey=P0171&detectionOf=dtc`
   * pegado en un ticket tiene que abrir el panel ya cargado.
   */
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal
    const [detections, sessions] = await Promise.all([
      listDetectionsFn({ data: deps, signal }),
      detectionSelectionOpen(deps)
        ? getDetectionSessionsFn({ data: { of: deps.detectionOf, key: deps.detectionKey }, signal })
        : Promise.resolve(null),
    ])
    return { detections, sessions }
  },
  head: () => ({ meta: [{ title: 'Escáneres · Detecciones — AutoLibre' }] }),
  component: Detections,
})

function Detections() {
  const { detections, sessions } = Route.useLoaderData()
  const { rows, missingDtcs, dtcSessions, dtcVehicles, anomalySessions, anomalyVehicles } = detections
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<DetectionSearch>) =>
    navigate({ search: { ...search, ...next }, replace: true })

  const selectDetection = (row: DetectionRow) =>
    setSearch({ detectionKey: row.key, detectionOf: row.kind })

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
        <SearchInput
          label="Buscar"
          placeholder="Código DTC o tipo de anomalía"
          value={search.q}
          onSearch={(q) => setSearch({ q })}
        />

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
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <DetectionTableRow
                  key={`${r.kind}-${r.key}`}
                  row={r}
                  isSelected={search.detectionOf === r.kind && search.detectionKey === r.key}
                  sessionsDenominator={r.kind === 'dtc' ? dtcSessions : anomalySessions}
                  vehiclesDenominator={r.kind === 'dtc' ? dtcVehicles : anomalyVehicles}
                  onSelect={() => selectDetection(r)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <SessionsPanel
        view={sessions}
        onClose={() => setSearch({ detectionKey: undefined, detectionOf: undefined })}
      />

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
  isSelected,
  sessionsDenominator,
  vehiclesDenominator,
  onSelect,
}: {
  row: DetectionRow
  isSelected: boolean
  sessionsDenominator: number
  vehiclesDenominator: number
  onSelect: () => void
}) {
  const sessionsPct = ratioPct(r.sessions, sessionsDenominator)
  const vehiclesPct = ratioPct(r.vehicles, vehiclesDenominator)
  const family = r.kind === 'dtc' ? dtcFamily(r.key) : null

  return (
    <TableRow className={cn(isSelected && 'bg-brand-soft/40')}>
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

      <TableCell className="whitespace-nowrap">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={isSelected}
          className={cn(
            'rounded-md border px-2 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            isSelected
              ? 'border-brand bg-brand-soft text-brand'
              : 'border-border text-muted-foreground hover:border-foreground/20 hover:text-foreground',
          )}
        >
          Ver sesiones
        </button>
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

// ── El panel de sesiones de una detección ──────────────────────────────────

/**
 * Las sesiones donde apareció la detección seleccionada, con las condiciones
 * en las que apareció — la evidencia que la fila agregada no puede mostrar.
 *
 * Vive DEBAJO de la tabla y no en un modal: mismo criterio que el
 * `SessionsPanel` de `/escaneres/compatibilidad` — es una pantalla de
 * comparación, y un modal taparía la tabla que le da contexto al detalle. La
 * selección vive en la URL (`detectionKey`/`detectionOf`), así que compartir
 * el link pegado en un ticket abre el panel ya cargado.
 */
function SessionsPanel({
  view,
  onClose,
}: {
  view: DetectionSessionsView | null
  onClose: () => void
}) {
  if (!view) return null

  return (
    <section className="mt-4 rounded-lg border border-border bg-card">
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">
            Sesiones{' '}
            <span className="text-muted-foreground">
              · {view.of === 'anomaly' ? anomalyTypeLabel(view.key) : view.key}
            </span>
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatInt(view.sessions.length)}{' '}
            {view.sessions.length === 1 ? 'sesión' : 'sesiones'}, de la más reciente a la más vieja.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex shrink-0 items-center gap-1 rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <X className="size-3.5" aria-hidden />
          cerrar
        </button>
      </header>

      {view.sessions.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          No hay sesiones para esta detección.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {view.sessions.map((s) => (
            <SessionRow key={s.sessionId} session={s} of={view.of} />
          ))}
        </ul>
      )}
    </section>
  )
}

function SessionRow({ session: s, of }: { session: DetectionSessionRow; of: DetectionKind }) {
  const duration = scanDurationLabel(s.durationSeconds)

  return (
    <li className="px-4 py-3.5">
      <div className="flex items-center gap-2 text-sm">
        <Link
          to="/escaneres/sesiones/$sessionId"
          params={{ sessionId: s.sessionId }}
          className="rounded font-medium tabular-nums outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {formatDateTime(s.startedAt)}
        </Link>
        {duration ? <span className="text-xs text-muted-foreground">· {duration}</span> : null}
      </div>

      <div className="mt-2 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Field icon={User} label="Usuario">
          <Link
            to="/usuarios/$userId"
            params={{ userId: s.userId }}
            className="rounded font-medium outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {s.userName ?? s.userEmail}
          </Link>
          {s.userName ? <div className="text-xs text-muted-foreground">{s.userEmail}</div> : null}
        </Field>

        <Field label="Vehículo">
          <span className="font-mono font-semibold tracking-wider">{s.plate}</span>
          <div className="text-xs text-muted-foreground">{s.catalogLabel ?? 'sin modelo de catálogo'}</div>
        </Field>

        <Field label="Escáner">
          <span>{s.firmware ?? 'no identificado'}</span>
          {s.obdProtocol ? <div className="text-xs text-muted-foreground">{s.obdProtocol}</div> : null}
        </Field>

        <Field label="Lecturas">
          <span className="tabular-nums">{formatInt(s.totalReadings)}</span>
        </Field>

        <Field label="Batería">
          <span>{s.batteryVoltage ?? '—'}</span>
        </Field>

        <Field label="Desde el borrado de fallas">
          <span className="tabular-nums">
            {s.distanceSinceDtcClearKm === null ? '—' : `${s.distanceSinceDtcClearKm} km`}
          </span>
        </Field>
      </div>

      {of === 'dtc' ? (
        <div className="mt-2.5 space-y-1.5">
          {s.coOccurringDtcCodes.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              <span className="text-xs text-muted-foreground">Junto con:</span>
              {s.coOccurringDtcCodes.map((c) => (
                <code
                  key={c}
                  className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs font-semibold"
                >
                  {c}
                </code>
              ))}
            </div>
          ) : null}
          {s.dtcRawResponse ? (
            <details className="text-xs">
              <summary className="cursor-pointer select-none text-muted-foreground outline-none">
                Respuesta cruda del escáner
              </summary>
              <pre className="mt-1 overflow-x-auto rounded bg-secondary p-2 font-mono">
                {s.dtcRawResponse}
              </pre>
            </details>
          ) : null}
        </div>
      ) : (
        <div className="mt-2.5 space-y-1.5">
          {s.anomalyOccurrences.length > 1 ? (
            <p className="text-xs text-muted-foreground">
              {formatInt(s.anomalyOccurrences.length)} disparos en esta sesión — dos PIDs distintos
              pueden disparar la misma anomalía.
            </p>
          ) : null}
          {s.anomalyOccurrences.map((o, i) => (
            <div key={i} className="rounded-md border border-border bg-secondary/50 px-2.5 py-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  className={cn(
                    'inline-flex items-center rounded border px-1 py-px text-[11px]',
                    SEVERITY_CHIP[o.severity] ?? 'border-border text-muted-foreground',
                  )}
                >
                  {SEVERITY_LABELS[o.severity] ?? o.severity}
                </span>
                {o.affectedPid ? (
                  <span className="font-mono text-xs text-muted-foreground">{o.affectedPid}</span>
                ) : null}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{o.justification}</p>
            </div>
          ))}
        </div>
      )}
    </li>
  )
}

function Field({
  icon: Icon,
  label,
  children,
}: {
  icon?: LucideIcon
  label: string
  children: ReactNode
}) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {Icon ? <Icon className="size-3" aria-hidden /> : null}
        {label}
      </div>
      <div>{children}</div>
    </div>
  )
}
