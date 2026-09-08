import { Link, createFileRoute } from '@tanstack/react-router'
import { Bot, Zap } from 'lucide-react'
import {
  SCAN_ANOMALY_FILTERS,
  SCAN_DTC_FILTERS,
  SCAN_STATE_FILTERS,
  SCAN_STATE_FILTER_LABELS,
  anomalyTypeLabel,
  scanDurationLabel,
  scanSessionSearchSchema,
  type ScanAnomaly,
  type ScanSessionRow,
  type ScanSessionSearch,
} from '~/lib/scan-sessions'
import { SESSION_BUCKET_LABELS, scannerTypeLabel } from '~/lib/scanners'
import { listScanSessionsFn } from '~/fn/scan-sessions'
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
import { formatDateTime, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { SessionBucket } from '~/lib/scanners'

/**
 * Sesiones de escáner — todos los escaneos, uno por fila.
 *
 * SSR heredado (`true`): pantalla de CONTENIDO (tabla de casos con usuario,
 * patente y códigos de falla) que puede ser el primer pintado de una sesión de
 * trabajo. Mismo criterio que `/leads/multas`.
 *
 * Qué reemplaza: el `select * from driving_sessions order by started_at desc`
 * más los `select count(*)` sueltos por `session_id` que hacen falta para saber
 * qué trajo cada escaneo. → `.claude/rules/scan-sessions.md`
 */
export const Route = createFileRoute('/_authed/escaneres/sesiones')({
  validateSearch: scanSessionSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ deps, abortController }) =>
    listScanSessionsFn({ data: deps, signal: abortController.signal }),
  head: () => ({ meta: [{ title: 'Escáneres · Sesiones — AutoLibre' }] }),
  component: ScanSessions,
})

function ScanSessions() {
  const rows = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<ScanSessionSearch>) =>
    navigate({ search: { ...search, ...next }, replace: true })

  const filtered =
    Boolean(search.q) ||
    search.scanState !== 'all' ||
    search.dtc !== 'all' ||
    search.anomaly !== 'all'

  const withData = rows.filter((r) => r.bucket === 'ok').length
  const withDtc = rows.filter((r) => r.dtcCount > 0).length
  const withAnomaly = rows.filter((r) => r.anomalyCount > 0).length

  return (
    <>
      <PageHeader
        title="Sesiones de escáner"
        subtitle={`${formatInt(rows.length)} ${filtered ? 'con este filtro' : 'escaneos'} · ${formatInt(withData)} trajeron datos · ${formatInt(withDtc)} con DTC · ${formatInt(withAnomaly)} con anomalías`}
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
            placeholder="Usuario, patente, modelo, VIN, DTC o firmware"
            defaultValue={search.q ?? ''}
            className="w-72"
            onChange={(e) => {
              const value = e.currentTarget.value.trim()
              setSearch({ q: value === '' ? undefined : value })
            }}
          />
        </div>

        <FilterGroup label="Estado">
          {SCAN_STATE_FILTERS.map((s) => (
            <Chip
              key={s}
              active={search.scanState === s}
              onClick={() => setSearch({ scanState: s })}
            >
              {SCAN_STATE_FILTER_LABELS[s]}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="DTCs">
          {SCAN_DTC_FILTERS.map((d) => (
            <Chip key={d} active={search.dtc === d} onClick={() => setSearch({ dtc: d })}>
              {d === 'all' ? 'Todos' : d === 'with' ? 'Con DTC' : 'Sin DTC'}
            </Chip>
          ))}
        </FilterGroup>

        {/*
          `red` en `warn` porque acota a las sesiones con la anomalía más grave;
          `with`/`without` son neutros. Mismo criterio que "sólo fallidos" en
          otras pantallas.
        */}
        <FilterGroup label="Anomalías">
          {SCAN_ANOMALY_FILTERS.map((a) => (
            <Chip
              key={a}
              tone={a === 'red' ? 'warn' : 'brand'}
              active={search.anomaly === a}
              onClick={() => setSearch({ anomaly: a })}
            >
              {a === 'all'
                ? 'Todas'
                : a === 'with'
                  ? 'Con anomalías'
                  : a === 'red'
                    ? 'Con anomalía roja'
                    : 'Sin anomalías'}
            </Chip>
          ))}
        </FilterGroup>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          {filtered
            ? 'Ningún escaneo con estos filtros.'
            : 'Todavía no hay ningún escaneo registrado. Cuando la app suba una sesión de manejo, aparece acá.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <SortHeader label="Estado" sortKey="status" active={search.sort === 'status'} dir={search.dir} to="/escaneres/sesiones" firstClick="asc" />
                <SortHeader label="Usuario" sortKey="user" active={search.sort === 'user'} dir={search.dir} to="/escaneres/sesiones" firstClick="asc" />
                <SortHeader label="Vehículo" sortKey="vehicle" active={search.sort === 'vehicle'} dir={search.dir} to="/escaneres/sesiones" firstClick="asc" />
                <SortHeader label="Fecha" sortKey="date" active={search.sort === 'date'} dir={search.dir} to="/escaneres/sesiones" firstClick="desc" />
                <SortHeader label="Duración" sortKey="duration" active={search.sort === 'duration'} dir={search.dir} to="/escaneres/sesiones" align="right" firstClick="desc" />
                <SortHeader label="Lecturas" sortKey="readings" active={search.sort === 'readings'} dir={search.dir} to="/escaneres/sesiones" align="right" firstClick="desc" />
                <SortHeader label="DTCs" sortKey="dtcs" active={search.sort === 'dtcs'} dir={search.dir} to="/escaneres/sesiones" firstClick="desc" />
                <SortHeader label="Anomalías" sortKey="anomalies" active={search.sort === 'anomalies'} dir={search.dir} to="/escaneres/sesiones" firstClick="desc" />
                <SortHeader label="Dist. desde borrado" sortKey="distance" active={search.sort === 'distance'} dir={search.dir} to="/escaneres/sesiones" align="right" firstClick="desc" />
                <SortHeader label="Batería" sortKey="battery" active={search.sort === 'battery'} dir={search.dir} to="/escaneres/sesiones" align="right" firstClick="asc" />
                <SortHeader label="Escáner" sortKey="firmware" active={search.sort === 'firmware'} dir={search.dir} to="/escaneres/sesiones" firstClick="asc" />
                <TableHead>Manejo (máx.)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <ScanRow key={r.id} row={r} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        «Enganchó sin nada» lo deducimos de cero lecturas y cero duración — mismo
        corte que la matriz de Compatibilidad, no un estado que el backend
        escriba. «DTCs» y «Anomalías» muestran cuántas y cuáles; las anomalías van
        con color por severidad (rojo / violeta / amarillo). «Dist. desde
        borrado» es la que reportó el escáner; vacía cuando el auto no la informa.
      </p>
    </>
  )
}

const BUCKET_TONE: Record<SessionBucket, string> = {
  ok: 'border-status-green/25 bg-status-green-bg text-status-green',
  noData: 'border-status-yellow/25 bg-status-yellow-bg text-status-yellow',
  failed: 'border-status-red/25 bg-status-red-bg text-status-red',
  pending: 'border-border bg-secondary text-muted-foreground',
}

const SEVERITY_CHIP: Record<string, string> = {
  red: 'border-status-red/30 bg-status-red-bg text-status-red',
  violet: 'border-status-violet/30 bg-status-violet-bg text-status-violet',
  yellow: 'border-status-yellow/30 bg-status-yellow-bg text-status-yellow',
}

const SEVERITY_DOT: Record<string, string> = {
  red: 'bg-status-red',
  violet: 'bg-status-violet',
  yellow: 'bg-status-yellow',
}

function ScanRow({ row: r }: { row: ScanSessionRow }) {
  const duration = scanDurationLabel(r.durationSeconds)
  const driving = [
    r.speedMax !== null ? `${formatInt(r.speedMax)} km/h` : null,
    r.rpmMax !== null ? `${formatInt(r.rpmMax)} rpm` : null,
    r.engineTempMax !== null ? `${formatInt(r.engineTempMax)} °C` : null,
  ].filter(Boolean)

  return (
    <TableRow>
      <TableCell>
        <span
          className={cn(
            'inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium',
            BUCKET_TONE[r.bucket],
          )}
        >
          {SESSION_BUCKET_LABELS[r.bucket]}
        </span>
      </TableCell>

      <TableCell className="max-w-52">
        <Link
          to="/usuarios/$userId"
          params={{ userId: r.userId }}
          className="font-medium text-brand hover:underline"
        >
          {r.userName ?? r.userEmail}
        </Link>
        {r.userName ? (
          <div className="truncate text-xs text-muted-foreground">{r.userEmail}</div>
        ) : null}
      </TableCell>

      <TableCell>
        <span className="font-mono font-semibold tracking-wider">{r.plate}</span>
        {r.alias ? (
          <span className="ml-1 text-xs text-muted-foreground">· {r.alias}</span>
        ) : null}
        <div className="text-xs text-muted-foreground">
          {r.catalogLabel ?? 'sin modelo de catálogo'}
        </div>
      </TableCell>

      <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
        {formatDateTime(r.startedAt)}
      </TableCell>

      <TableCell className="whitespace-nowrap text-right tabular-nums">
        {duration ?? <span className="text-muted-foreground/50">—</span>}
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {formatInt(r.totalReadings)}
        <div className="text-xs text-muted-foreground">
          {formatInt(r.chunksUploaded)}/{formatInt(r.totalChunks)} chunks
        </div>
      </TableCell>

      <TableCell className="min-w-32">
        {r.dtcCount === 0 ? (
          <span className="text-muted-foreground/50">—</span>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-xs font-medium tabular-nums text-muted-foreground">
              {formatInt(r.dtcCount)}
            </span>
            {r.dtcCodes.map((code) => (
              <code
                key={code}
                className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px]"
              >
                {code}
              </code>
            ))}
          </div>
        )}
      </TableCell>

      <TableCell className="min-w-48">
        <AnomalyCell
          count={r.anomalyCount}
          bySeverity={r.anomaliesBySeverity}
          anomalies={r.anomalies}
        />
      </TableCell>

      <TableCell className="whitespace-nowrap text-right tabular-nums">
        {r.distanceSinceDtcClearKm === null ? (
          <span className="text-muted-foreground/50" title="El auto no reporta este dato">
            —
          </span>
        ) : (
          `${formatInt(r.distanceSinceDtcClearKm)} km`
        )}
      </TableCell>

      <TableCell className="whitespace-nowrap text-right tabular-nums">
        {r.batteryVoltage ?? <span className="text-muted-foreground/50">—</span>}
      </TableCell>

      <TableCell className="min-w-40">
        <div>
          {scannerTypeLabel(r.scannerType)}{' '}
          <span className={r.firmware ? '' : 'text-muted-foreground'}>
            {r.firmware ?? '(no identificado)'}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {r.obdProtocol ? `OBD ${r.obdProtocol}` : 'OBD n/d'}
          {r.detectedVin ? (
            <>
              {' · VIN '}
              <span className="font-mono">{r.detectedVin}</span>
            </>
          ) : (
            ' · sin VIN'
          )}
        </div>
      </TableCell>

      <TableCell className="min-w-40 text-xs text-muted-foreground">
        {driving.length > 0 ? (
          <span className="tabular-nums">{driving.join(' · ')}</span>
        ) : (
          <span className="text-muted-foreground/50">sin telemetría</span>
        )}
        {(r.producedAiDiagnostic || r.producedTelemetryAnalysis) && (
          <div className="mt-1 flex flex-wrap gap-x-2">
            {r.producedAiDiagnostic ? (
              <span className="inline-flex items-center gap-1">
                <Bot className="size-3" aria-hidden /> diagnóstico IA
              </span>
            ) : null}
            {r.producedTelemetryAnalysis ? (
              <span className="inline-flex items-center gap-1">
                <Zap className="size-3" aria-hidden /> análisis
              </span>
            ) : null}
          </div>
        )}
      </TableCell>
    </TableRow>
  )
}

/**
 * Anomalías: cuántas y cuáles. Los puntos de color resumen la severidad de un
 * vistazo; los chips nombran cada una. Si son muchas, se muestran las primeras y
 * un "+N" — la fila no puede crecer sin límite.
 */
function AnomalyCell({
  count,
  bySeverity,
  anomalies,
}: {
  count: number
  bySeverity: { red: number; violet: number; yellow: number }
  anomalies: Array<ScanAnomaly>
}) {
  if (count === 0) return <span className="text-muted-foreground/50">—</span>

  const shown = anomalies.slice(0, 4)
  const rest = anomalies.length - shown.length

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium tabular-nums text-muted-foreground">
          {formatInt(count)}
        </span>
        {(['red', 'violet', 'yellow'] as const).map((sev) =>
          bySeverity[sev] > 0 ? (
            <span key={sev} className="inline-flex items-center gap-0.5">
              <span className={cn('inline-block size-1.5 rounded-full', SEVERITY_DOT[sev])} aria-hidden />
              <span className="text-[10px] tabular-nums text-muted-foreground">{bySeverity[sev]}</span>
            </span>
          ) : null,
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {shown.map((a, i) => (
          <span
            key={`${a.type}-${a.pid ?? i}`}
            className={cn(
              'inline-flex items-center rounded border px-1 py-px text-[11px]',
              SEVERITY_CHIP[a.severity] ?? 'border-border text-muted-foreground',
            )}
            title={a.pid ? `${anomalyTypeLabel(a.type)} · ${a.pid}` : anomalyTypeLabel(a.type)}
          >
            {anomalyTypeLabel(a.type)}
          </span>
        ))}
        {rest > 0 ? (
          <span className="inline-flex items-center text-[11px] text-muted-foreground">
            +{rest}
          </span>
        ) : null}
      </div>
    </div>
  )
}
