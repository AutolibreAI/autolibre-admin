import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { ArrowLeft, Bot, Car, Cpu, GitCompare, Wrench, Zap } from 'lucide-react'
import {
  anomalyTypeLabel,
  scanDurationLabel,
  type ScanAnomalyDetail,
  type ScanNotEvaluable,
  type ScanSessionDetail,
  type ScanTelemetryAnalysis,
} from '~/lib/scan-sessions'
import {
  comparePids,
  implausiblePids,
  implausibleReason,
  isSuspectSession,
  pidLabel,
} from '~/lib/scan-pids'
import { SESSION_BUCKET_LABELS, scannerTypeLabel } from '~/lib/scanners'
import { getScanSessionDetailFn } from '~/fn/scan-sessions'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { CopyableId } from '~/components/CopyableId'
import { PidRangeChart } from '~/components/PidRangeChart'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Separator } from '~/components/ui/separator'
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
import type { SessionBucket } from '~/lib/scanners'
import type { ReactNode } from 'react'

/**
 * Detalle de UNA sesión de escáner — todo lo que el panel sabe de ese escaneo.
 *
 * Qué reemplaza: hoy no hay pantalla, sólo la reconstrucción manual con un
 * `select` por tabla. Acá se abre TODO lo que la base tiene: resumen, DTCs con
 * título, lo que midió cada PID (como rango), anomalías con su explicación,
 * los otros escaneos del mismo auto, el último mantenimiento previo, los
 * diagnósticos de IA y los chunks.
 *
 * Lo que NO hay, y la pantalla lo dice: la curva de cada PID en el tiempo. Las
 * lecturas crudas viven en DigitalOcean Spaces y el panel no las lee (decidido
 * el 2026-09-25). Cada PID se muestra con el resumen que sí está en la base:
 * mínimo, máximo, promedio y desvío.
 *
 * SSR completo por el mismo motivo que `/chats/:conversationId` y
 * `/usuarios/:userId`: se llega tanto desde el listado como por link pegado (un
 * uuid en un ticket de soporte), y ahí es el primer pintado de la sesión.
 *
 * Read-only entero — `driving_sessions` y todo lo que cuelga de `session_id` lo
 * escribe el backend. → `.claude/rules/scan-sessions.md`
 */
export const Route = createFileRoute('/_authed/escaneres/sesiones/$sessionId')({
  loader: async ({ params, abortController }) => {
    const detail = await getScanSessionDetailFn({
      data: params,
      signal: abortController.signal,
    }).catch((cause: unknown) => {
      if (cause instanceof Error && cause.message.startsWith('NOT_FOUND:')) return null
      throw cause
    })

    if (!detail) throw notFound()
    return detail
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `${loaderData.catalogLabel ?? loaderData.plate} — Sesión de escáner — AutoLibre`
          : 'Sesión de escáner',
      },
    ],
  }),
  component: ScanSessionDetailScreen,
})

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

const SEVERITY_LABEL: Record<string, string> = {
  red: 'Roja',
  violet: 'Violeta',
  yellow: 'Amarilla',
}

const FUEL_LABELS: Record<string, string> = {
  gasoline: 'nafta',
  diesel: 'diésel',
  cng: 'GNC',
  electric: 'eléctrico',
  hybrid: 'híbrido',
}

const TRANSMISSION_LABELS: Record<string, string> = {
  manual: 'manual',
  automatic: 'automática',
  cvt: 'CVT',
}

/** Números de `evidence` son floats del análisis; enteros se muestran sin decimales. */
const fmtNum = (n: number): string =>
  Number.isInteger(n) ? formatInt(n) : n.toLocaleString('es-AR', { maximumFractionDigits: 2 })

const fmtEvidenceValue = (v: unknown): string => {
  if (typeof v === 'number') return fmtNum(v)
  if (Array.isArray(v)) return v.map(fmtEvidenceValue).join(', ')
  if (v === null || v === undefined) return '—'
  return String(v)
}

const LINK =
  'rounded outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'

function ScanSessionDetailScreen() {
  const s = Route.useLoaderData()
  const duration = scanDurationLabel(s.durationSeconds)
  const specBits = [
    s.fuelType ? (FUEL_LABELS[s.fuelType] ?? s.fuelType) : null,
    s.transmission ? `caja ${TRANSMISSION_LABELS[s.transmission] ?? s.transmission}` : null,
  ].filter(Boolean)

  return (
    <>
      <Link
        to="/escaneres/sesiones"
        className="mb-3 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Sesiones de escáner
      </Link>

      <PageHeader
        title={s.catalogLabel ?? s.plate}
        subtitle={`${s.plate}${s.alias ? ` · ${s.alias}` : ''} · ${formatDateTime(s.startedAt)}${duration ? ` · ${duration}` : ''}`}
        actions={
          <>
            {s.catalogId ? (
              <Link
                to="/escaneres/comparar"
                search={{ compareCatalogId: s.catalogId, compareVehicles: [s.vehicleId] }}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
              >
                <GitCompare className="size-3.5" aria-hidden />
                Comparar con autos iguales
              </Link>
            ) : null}
            <SsrTag>ssr: full</SsrTag>
          </>
        }
      />

      {/* ── Resumen ─────────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardContent className="pt-6">
          <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Estado">
              <span
                className={cn(
                  'inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium',
                  BUCKET_TONE[s.bucket],
                )}
              >
                {SESSION_BUCKET_LABELS[s.bucket]}
              </span>
              <div className="mt-1 text-xs text-muted-foreground">{s.status} (según el backend)</div>
            </Field>

            <Field label="Duración">
              <span className="text-sm tabular-nums">
                {duration ?? <span className="text-muted-foreground/50">no cerró</span>}
              </span>
              <div className="text-xs text-muted-foreground">
                {formatDateTime(s.startedAt)}
                {s.endedAt ? ` → ${formatDateTime(s.endedAt)}` : ' → en curso'}
              </div>
            </Field>

            <Field label="Lecturas">
              <span className="text-sm tabular-nums">{formatInt(s.totalReadings)}</span>
              <div className="text-xs text-muted-foreground tabular-nums">
                {s.telemetry
                  ? `${formatInt(Object.keys(s.telemetry.metrics).length)} PIDs medidos`
                  : 'sin análisis de telemetría'}
              </div>
            </Field>

            <Field label="Códigos DTC">
              <span
                className={cn('text-sm tabular-nums', s.dtcCount > 0 && 'font-medium text-status-yellow')}
              >
                {s.dtcCount > 0 ? formatInt(s.dtcCount) : 'ninguno'}
              </span>
              <div className="text-xs text-muted-foreground">
                {s.dtcCodes.length > 0 ? s.dtcCodes.join(', ') : 'el escaneo no vio códigos'}
              </div>
            </Field>

            <Field label="Distancia desde borrado de DTCs">
              <span className="text-sm tabular-nums">
                {s.distanceSinceDtcClearKm === null ? (
                  <span className="text-muted-foreground">no informada</span>
                ) : (
                  `${formatInt(s.distanceSinceDtcClearKm)} km`
                )}
              </span>
              <div className="text-xs text-muted-foreground">
                {s.distanceSinceDtcClearKm === null
                  ? 'la ECU no la reportó'
                  : s.distanceSinceDtcClearKm === 0
                    ? 'borrados hace muy poco (o recién conectada la batería)'
                    : 'lo que el auto anduvo desde el último borrado'}
              </div>
            </Field>

            <Field label="Km del auto">
              <span className="text-sm tabular-nums">
                {s.vehicleOdometerKm ? (
                  `${formatInt(s.vehicleOdometerKm)} km`
                ) : (
                  <span className="text-muted-foreground">no cargado</span>
                )}
              </span>
              <div className="text-xs text-muted-foreground">el actual del auto, no el del día del escaneo</div>
            </Field>

            <Field label="Batería">
              <span className="text-sm tabular-nums">
                {s.batteryVoltage ?? <span className="text-muted-foreground/50">—</span>}
              </span>
              <div className="text-xs text-muted-foreground">al conectar el escáner</div>
            </Field>

            <Field label="Escáner">
              <div className="flex items-center gap-1.5 text-sm">
                <Cpu className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                {scannerTypeLabel(s.scannerType)}{' '}
                <span className={s.firmware ? '' : 'text-muted-foreground'}>
                  {s.firmware ?? '(no identificado)'}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {s.obdProtocol ? `OBD ${s.obdProtocol}` : 'OBD n/d'}
                {s.detectedVin ? (
                  <>
                    {' · VIN '}
                    <span className="font-mono">{s.detectedVin}</span>
                  </>
                ) : (
                  ' · sin VIN'
                )}
              </div>
            </Field>

            <Field label="Vehículo">
              <div className="flex items-center gap-1.5 text-sm">
                <Car className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="font-mono font-semibold tracking-wider">{s.plate}</span>
                {s.alias ? <span className="text-muted-foreground">· {s.alias}</span> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {s.catalogLabel ?? 'sin modelo de catálogo'}
                {specBits.length > 0 ? ` · ${specBits.join(' · ')}` : ''}
              </div>
            </Field>

            <Field label="Usuario">
              <Link
                to="/usuarios/$userId"
                params={{ userId: s.userId }}
                className={cn('text-sm font-medium', LINK)}
              >
                {s.userName ?? s.userEmail}
              </Link>
              {s.userName ? <div className="text-xs text-muted-foreground">{s.userEmail}</div> : null}
            </Field>
          </div>
        </CardContent>
      </Card>

      {/* ── DTCs ────────────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">
            Códigos DTC {s.dtcCount > 0 ? `(${formatInt(s.dtcCount)})` : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {s.dtcCodeInfo.length === 0 ? (
            <p className="text-sm text-muted-foreground">Esta sesión no vio ningún código DTC.</p>
          ) : (
            <DtcTable s={s} />
          )}
        </CardContent>
      </Card>

      {/* ── PIDs ────────────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Zap className="size-4" aria-hidden />
            Lo que midió cada PID
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!s.telemetry ? (
            <p className="text-sm text-muted-foreground">
              Esta sesión no produjo análisis de telemetría
              {s.bucket === 'noData' || s.bucket === 'failed'
                ? ' — coherente con que no trajo datos.'
                : '.'}
            </p>
          ) : (
            <PidSection telemetry={s.telemetry} />
          )}
        </CardContent>
      </Card>

      {/* ── Anomalías ───────────────────────────────────────────────────── */}
      {s.telemetry ? (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Anomalías</CardTitle>
          </CardHeader>
          <CardContent>
            <AnomalySection telemetry={s.telemetry} />
          </CardContent>
        </Card>
      ) : null}

      {/* ── El auto ─────────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Wrench className="size-4" aria-hidden />
            Historia del auto
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Escaneos de este auto ({formatInt(s.vehicleSessions.length)})
            </h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {s.vehicleSessions.map((v) => {
                const current = v.id === s.id
                return (
                  <li key={v.id} className={cn('flex items-center gap-3 px-3 py-2 text-sm', current && 'bg-secondary/60')}>
                    {current ? (
                      <span className="font-medium tabular-nums">{formatDateTime(v.startedAt)}</span>
                    ) : (
                      <Link
                        to="/escaneres/sesiones/$sessionId"
                        params={{ sessionId: v.id }}
                        className={cn('tabular-nums', LINK)}
                      >
                        {formatDateTime(v.startedAt)}
                      </Link>
                    )}
                    <span
                      className={cn(
                        'rounded border px-1.5 py-0.5 text-[11px]',
                        BUCKET_TONE[v.bucket],
                      )}
                    >
                      {SESSION_BUCKET_LABELS[v.bucket]}
                    </span>
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                      {formatInt(v.totalReadings)} lecturas · {v.dtcCount > 0 ? `${formatInt(v.dtcCount)} DTC` : 'sin DTC'}
                      {current ? ' · este' : ''}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Último mantenimiento antes del escaneo
            </h3>
            {s.lastMaintenance ? (
              <div className="rounded-lg border border-border p-3 text-sm">
                <div className="font-medium">
                  {s.lastMaintenance.name ?? s.lastMaintenance.serviceSlug ?? 'sin nombre'}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                  {formatDate(s.lastMaintenance.performedAt)}
                  {s.lastMaintenance.odometerAtService
                    ? ` · a los ${formatInt(s.lastMaintenance.odometerAtService)} km`
                    : ''}
                  {s.lastMaintenance.workshop ? ` · ${s.lastMaintenance.workshop}` : ''}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {formatInt(s.maintenanceBeforeCount)}{' '}
                  {s.maintenanceBeforeCount === 1 ? 'mantenimiento hecho' : 'mantenimientos hechos'} hasta ese día ·{' '}
                  <Link to="/usuarios/$userId" params={{ userId: s.userId }} className={LINK}>
                    ver todos en la ficha del usuario
                  </Link>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No hay ningún mantenimiento hecho cargado para este auto antes de este escaneo.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── IA ──────────────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="size-4" aria-hidden />
            Diagnósticos de IA{' '}
            {s.aiDiagnostics.length > 0 ? `(${formatInt(s.aiDiagnostics.length)})` : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {s.aiDiagnostics.length === 0 ? (
            <p className="text-sm text-muted-foreground">Esta sesión no produjo ningún diagnóstico de IA.</p>
          ) : (
            <ul className="space-y-4">
              {s.aiDiagnostics.map((d, i) => (
                <li key={d.id}>
                  {i > 0 ? <Separator className="mb-4" /> : null}
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <code className="font-mono">{d.model ?? 'modelo desconocido'}</code>
                    <span
                      className={cn(
                        'rounded border px-1.5 py-0.5',
                        d.status === 'ready'
                          ? 'border-status-green/25 bg-status-green-bg text-status-green'
                          : d.status === 'failed'
                            ? 'border-status-red/25 bg-status-red-bg text-status-red'
                            : 'border-border bg-secondary',
                      )}
                    >
                      {d.status}
                    </span>
                    {d.promptTokens !== null || d.completionTokens !== null ? (
                      <span className="tabular-nums" title="prompt / completion tokens">
                        {formatInt(d.promptTokens ?? 0)} / {formatInt(d.completionTokens ?? 0)} tokens
                      </span>
                    ) : null}
                    {d.embeddingTokens !== null ? (
                      <span className="tabular-nums" title={d.embeddingModel ?? undefined}>
                        {formatInt(d.embeddingTokens)} tokens de embedding
                      </span>
                    ) : null}
                    <span>{formatDateTime(d.createdAt)}</span>
                  </div>

                  {d.ragDocsUsed.length > 0 ? (
                    <div className="mb-2 flex flex-wrap gap-1">
                      {d.ragDocsUsed.map((doc) => (
                        <code key={doc} className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px]">
                          {doc}
                        </code>
                      ))}
                    </div>
                  ) : null}

                  {d.text ? (
                    <p className="whitespace-pre-wrap rounded-lg border border-border bg-secondary/40 p-3 text-sm leading-relaxed">
                      {d.text}
                    </p>
                  ) : d.failureReason ? (
                    <p className="rounded-lg border border-status-red/25 bg-status-red-bg p-3 text-sm text-status-red">
                      {d.failureReason}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">Sin texto (todavía en curso).</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── Técnico, plegado ────────────────────────────────────────────── */}
      <details className="group rounded-xl border border-border bg-card">
        <summary className="cursor-pointer list-none px-6 py-4 text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Datos técnicos
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            identificadores y chunks subidos ({formatInt(s.chunksUploaded)}/{formatInt(s.totalChunks)})
          </span>
        </summary>
        <div className="space-y-4 px-6 pb-6">
          <div className="grid gap-4 text-xs text-muted-foreground sm:grid-cols-3">
            <div>
              <div className="mb-1 font-medium uppercase tracking-wider">Id</div>
              <CopyableId value={s.id} className="text-xs" />
            </div>
            <div>
              <div className="mb-1 font-medium uppercase tracking-wider">Id externo</div>
              <span className="font-mono">{s.externalSessionId}</span>
            </div>
            <div>
              <div className="mb-1 font-medium uppercase tracking-wider">Fila creada</div>
              {formatDateTime(s.createdAt)} · {formatInt(s.chunkSize)} lecturas/chunk
            </div>
          </div>

          {s.chunks.length === 0 ? (
            <p className="text-sm text-muted-foreground">Todavía no se subió ningún chunk.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead className="text-right">Lecturas</TableHead>
                    <TableHead>Clave del objeto</TableHead>
                    <TableHead>SHA-256</TableHead>
                    <TableHead>Subido</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.chunks.map((c) => (
                    <TableRow key={c.chunkIndex}>
                      <TableCell className="tabular-nums">{c.chunkIndex}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatInt(c.readingCount)}</TableCell>
                      <TableCell className="max-w-72 break-all font-mono text-[11px] text-muted-foreground">
                        {c.objectKey}
                      </TableCell>
                      <TableCell className="max-w-40 truncate font-mono text-[11px] text-muted-foreground">
                        {c.contentSha256}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDateTime(c.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </details>
    </>
  )
}

/**
 * Todos los códigos del snapshot, con título. `diagnostic_dtcs` sólo tiene los
 * que alguien buscó, así que su respuesta cruda se suma cuando existe, pero la
 * lista la manda el snapshot.
 */
function DtcTable({ s }: { s: ScanSessionDetail }) {
  const detailByCode = new Map(s.dtcDetails.map((d) => [d.code, d]))
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Código</TableHead>
            <TableHead>Qué significa</TableHead>
            <TableHead>Sistema</TableHead>
            <TableHead>Respuesta cruda</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {s.dtcCodeInfo.map((d) => {
            const detail = detailByCode.get(d.code)
            const title = d.title ?? detail?.standardDescription ?? null
            return (
              <TableRow key={d.code}>
                <TableCell className="font-mono font-semibold">{d.code}</TableCell>
                <TableCell>
                  {title ?? <span className="text-status-yellow">sin título cargado</span>}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {d.system ?? <span className="text-muted-foreground/50">—</span>}
                </TableCell>
                <TableCell className="max-w-64 truncate text-xs text-muted-foreground">
                  {detail?.rawResponse ?? <span className="text-muted-foreground/50">—</span>}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * Un gráfico por PID — cada uno con SU eje, porque cada PID tiene su unidad.
 * Separado del componente de la ruta para recibir `telemetry` ya no-nullable
 * (el narrowing de una propiedad no sobrevive un `.map()`, `scan-sessions.md`).
 */
function PidSection({ telemetry }: { telemetry: ScanTelemetryAnalysis }) {
  const pids = Object.keys(telemetry.metrics).sort(comparePids)
  const suspectSession = isSuspectSession(telemetry.metrics)
  const badPids = implausiblePids(telemetry.metrics)
  const notEvaluableByPid = new Map<string, Array<ScanNotEvaluable>>()
  const notEvaluableOther: Array<ScanNotEvaluable> = []
  for (const n of telemetry.notEvaluable) {
    if (n.affectedPid && pids.includes(n.affectedPid)) {
      notEvaluableByPid.set(n.affectedPid, [...(notEvaluableByPid.get(n.affectedPid) ?? []), n])
    } else {
      notEvaluableOther.push(n)
    }
  }

  if (pids.length === 0) {
    return <p className="text-sm text-muted-foreground">El análisis no trae ninguna métrica de PID.</p>
  }

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Por cada PID: la línea fina va del mínimo al máximo, la banda es el promedio ± un desvío y el
        punto es el promedio. Es el resumen que guarda la base; la curva completa del escaneo no está
        disponible en el panel.
      </p>

      {suspectSession ? (
        <p className="rounded-lg border border-status-yellow/30 bg-status-yellow-bg p-3 text-sm text-status-yellow">
          Lectura dudosa: {formatInt(badPids.length)} PIDs tienen valores físicamente imposibles. Lo más
          probable es que el escáner haya leído basura — los valores de esta sesión no representan al
          auto, y el comparador la excluye.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {pids.map((pid) => {
          const m = telemetry.metrics[pid]
          if (!m) return null
          const reason = implausibleReason(pid, m)
          const notes = notEvaluableByPid.get(pid) ?? []
          return (
            <div key={pid} className="rounded-lg border border-border p-3">
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium">{pidLabel(pid)}</h3>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {formatInt(m.sampleCount)} muestras · desvío {fmtNum(m.stdDev)}
                </span>
              </div>
              <PidRangeChart
                pid={pid}
                labelWidth="0px"
                groups={[{ key: pid, rows: [{ key: pid, label: null, metric: m, suspect: reason }] }]}
              />
              {reason ? <p className="mt-1 text-xs text-status-yellow">Dudoso: {reason}.</p> : null}
              {notes.map((n) => (
                <p key={n.type} className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {n.justification}
                </p>
              ))}
            </div>
          )
        })}
      </div>

      {notEvaluableOther.length > 0 ? (
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Lo que no se pudo evaluar
          </h3>
          <ul className="space-y-1">
            {notEvaluableOther.map((n) => (
              <li key={n.type} className="text-xs leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">
                  {n.affectedPid ? pidLabel(n.affectedPid) : n.study}:
                </span>{' '}
                {n.justification}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function AnomalySection({ telemetry }: { telemetry: ScanTelemetryAnalysis }) {
  if (telemetry.anomalies.length === 0) {
    return <p className="text-sm text-muted-foreground">El análisis no detectó ninguna anomalía.</p>
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="tabular-nums">{formatInt(telemetry.totalAnomalies)} detectadas</span>
        {(['red', 'violet', 'yellow'] as const).map((sev) =>
          telemetry.bySeverity[sev] > 0 ? (
            <span
              key={sev}
              className={cn('inline-flex items-center rounded border px-1.5 py-0.5 text-xs', SEVERITY_CHIP[sev])}
            >
              {formatInt(telemetry.bySeverity[sev])} {(SEVERITY_LABEL[sev] ?? sev).toLowerCase()}
            </span>
          ) : null,
        )}
      </div>
      <ul className="space-y-3">
        {telemetry.anomalies.map((a, i) => (
          <AnomalyDetailCard key={`${a.type}-${a.pid ?? i}`} anomaly={a} />
        ))}
      </ul>
    </div>
  )
}

function AnomalyDetailCard({ anomaly: a }: { anomaly: ScanAnomalyDetail }) {
  const evidenceEntries = Object.entries(a.evidence)

  return (
    <li className="rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium',
            SEVERITY_CHIP[a.severity] ?? 'border-border text-muted-foreground',
          )}
        >
          {SEVERITY_LABEL[a.severity] ?? a.severity}
        </span>
        <span className="font-medium">{anomalyTypeLabel(a.type)}</span>
        {a.pid ? <span className="text-xs text-muted-foreground">{pidLabel(a.pid)}</span> : null}
      </div>

      <p className="mt-2 text-sm leading-relaxed">{a.justification}</p>

      {a.probableCauses.length > 0 ? (
        <div className="mt-2">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Causas probables
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {a.probableCauses.map((cause) => (
              <li key={cause}>{cause}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {evidenceEntries.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {evidenceEntries.map(([key, value]) => (
            <span key={key} className="tabular-nums">
              <span className="text-muted-foreground/70">{key}:</span>{' '}
              <span className="font-medium text-foreground">{fmtEvidenceValue(value)}</span>
            </span>
          ))}
        </div>
      ) : null}
    </li>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  )
}
