import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { ArrowLeft, Bot, Car, Cpu, Zap } from 'lucide-react'
import {
  anomalyTypeLabel,
  scanDurationLabel,
  type ScanAnomalyDetail,
  type ScanTelemetryAnalysis,
} from '~/lib/scan-sessions'
import { SESSION_BUCKET_LABELS, scannerTypeLabel } from '~/lib/scanners'
import { getScanSessionDetailFn } from '~/fn/scan-sessions'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { CopyableId } from '~/components/CopyableId'
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
import { formatDateTime, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { SessionBucket } from '~/lib/scanners'
import type { ReactNode } from 'react'

/**
 * Detalle de UNA sesión de escáner — todo lo que el panel sabe de ese escaneo.
 *
 * Qué reemplaza: hoy no hay pantalla, sólo la reconstrucción manual del
 * `SessionsPanel` de `/escaneres/compatibilidad` (que corta en contadores) o un
 * escaneo por vez a mano con un `select` por tabla. Acá se abre TODO: el jsonb
 * de `driving_telemetry_analysis` completo (justificación, causas probables,
 * evidencia, estudios no evaluables), las filas de `diagnostic_dtcs`, los N
 * diagnósticos de IA con su texto completo, y los chunks subidos.
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

/** Números de `metrics`/`evidence` son floats del análisis; enteros se muestran sin decimales. */
const fmtNum = (n: number): string =>
  Number.isInteger(n) ? formatInt(n) : n.toLocaleString('es-AR', { maximumFractionDigits: 2 })

const fmtEvidenceValue = (v: unknown): string => {
  if (typeof v === 'number') return fmtNum(v)
  if (Array.isArray(v)) return v.map(fmtEvidenceValue).join(', ')
  if (v === null || v === undefined) return '—'
  return String(v)
}

function ScanSessionDetailScreen() {
  const s = Route.useLoaderData()
  const duration = scanDurationLabel(s.durationSeconds)

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
        subtitle={`${s.plate}${s.alias ? ` · ${s.alias}` : ''} · iniciada ${formatDateTime(s.startedAt)}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

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
              <div className="mt-1 text-xs text-muted-foreground">
                {s.status} (según el backend)
              </div>
            </Field>

            <Field label="Usuario">
              <Link
                to="/usuarios/$userId"
                params={{ userId: s.userId }}
                className="rounded text-sm font-medium outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {s.userName ?? s.userEmail}
              </Link>
              {s.userName ? (
                <div className="text-xs text-muted-foreground">{s.userEmail}</div>
              ) : null}
            </Field>

            <Field label="Vehículo">
              <div className="flex items-center gap-1.5 text-sm">
                <Car className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="font-mono font-semibold tracking-wider">{s.plate}</span>
                {s.alias ? <span className="text-muted-foreground">· {s.alias}</span> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {s.catalogLabel ?? 'sin modelo de catálogo'}
              </div>
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

            <Field label="Duración">
              <span className="text-sm tabular-nums">
                {duration ?? <span className="text-muted-foreground/50">no cerró</span>}
              </span>
              <div className="text-xs text-muted-foreground">
                {formatDateTime(s.startedAt)}
                {s.endedAt ? ` → ${formatDateTime(s.endedAt)}` : ' → en curso'}
              </div>
            </Field>

            <Field label="Lecturas y chunks">
              <span className="text-sm tabular-nums">{formatInt(s.totalReadings)} lecturas</span>
              <div className="text-xs text-muted-foreground tabular-nums">
                {formatInt(s.chunksUploaded)}/{formatInt(s.totalChunks)} chunks ·{' '}
                {formatInt(s.chunkSize)} lecturas/chunk
              </div>
            </Field>

            <Field label="Batería · dist. desde borrado">
              <span className="text-sm tabular-nums">
                {s.batteryVoltage ?? <span className="text-muted-foreground/50">—</span>}
              </span>
              <div className="text-xs text-muted-foreground tabular-nums">
                {s.distanceSinceDtcClearKm === null
                  ? 'sin dato de distancia'
                  : `${formatInt(s.distanceSinceDtcClearKm)} km desde el borrado`}
              </div>
            </Field>

            <Field label="Identificadores">
              <CopyableId value={s.id} className="text-xs" />
              <div className="mt-1 text-xs text-muted-foreground">
                externa: <span className="font-mono">{s.externalSessionId}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                creada {formatDateTime(s.createdAt)}
              </div>
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">
            Códigos DTC {s.dtcCount > 0 ? `(${formatInt(s.dtcCount)})` : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {s.dtcCount === 0 ? (
            <p className="text-sm text-muted-foreground">
              Esta sesión no vio ningún código DTC.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-1.5">
                {s.dtcCodes.map((code) => (
                  <code
                    key={code}
                    className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs"
                  >
                    {code}
                  </code>
                ))}
              </div>

              {s.dtcDetails.length > 0 ? (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Código</TableHead>
                        <TableHead>Título</TableHead>
                        <TableHead>Sistema</TableHead>
                        <TableHead>Respuesta cruda</TableHead>
                        <TableHead>Cargado</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.dtcDetails.map((d) => (
                        <TableRow key={d.code}>
                          <TableCell className="font-mono font-semibold">{d.code}</TableCell>
                          <TableCell>
                            {d.title ?? d.standardDescription ?? (
                              <span className="text-status-yellow">sin título cargado</span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {d.system ?? <span className="text-muted-foreground/50">—</span>}
                          </TableCell>
                          <TableCell className="max-w-64 truncate text-xs text-muted-foreground">
                            {d.rawResponse ?? <span className="text-muted-foreground/50">—</span>}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                            {formatDateTime(d.createdAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Sin detalle en <code>diagnostic_dtcs</code> — sólo el snapshot de arriba.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Zap className="size-4" aria-hidden />
            Análisis de telemetría
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
            <TelemetrySection telemetry={s.telemetry} />
          )}
        </CardContent>
      </Card>

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
            <p className="text-sm text-muted-foreground">
              Esta sesión no produjo ningún diagnóstico de IA.
            </p>
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
                        <code
                          key={doc}
                          className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px]"
                        >
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Chunks subidos ({formatInt(s.chunksUploaded)}/{formatInt(s.totalChunks)})
          </CardTitle>
        </CardHeader>
        <CardContent>
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
                      <TableCell className="text-right tabular-nums">
                        {formatInt(c.readingCount)}
                      </TableCell>
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
        </CardContent>
      </Card>
    </>
  )
}

/**
 * Separado del componente de la ruta a propósito: `s.telemetry` es
 * `ScanTelemetryAnalysis | null`, y narrowearlo en el padre (`!s.telemetry ? … :
 * …`) no sobrevive dentro de un callback anidado como `.map()` — TS descarta el
 * narrowing de una propiedad de objeto al cruzar el borde de una función, por
 * las dudas de que cambie entre medio. Recibirlo como prop ya no-nullable
 * resuelve eso de raíz en vez de repetir `s.telemetry &&` en cada callback.
 */
function TelemetrySection({ telemetry }: { telemetry: ScanTelemetryAnalysis }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="tabular-nums">
          {formatInt(telemetry.totalAnomalies)} anomalías detectadas
        </span>
        {(['red', 'violet', 'yellow'] as const).map((sev) =>
          telemetry.bySeverity[sev] > 0 ? (
            <span
              key={sev}
              className={cn(
                'inline-flex items-center rounded border px-1.5 py-0.5 text-xs',
                SEVERITY_CHIP[sev],
              )}
            >
              {formatInt(telemetry.bySeverity[sev])} {(SEVERITY_LABEL[sev] ?? sev).toLowerCase()}
            </span>
          ) : null,
        )}
      </div>

      {telemetry.anomalies.length > 0 ? (
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Anomalías
          </h3>
          <ul className="space-y-3">
            {telemetry.anomalies.map((a, i) => (
              <AnomalyDetailCard key={`${a.type}-${a.pid ?? i}`} anomaly={a} />
            ))}
          </ul>
        </div>
      ) : null}

      {telemetry.notEvaluable.length > 0 ? (
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Estudios no evaluables ({formatInt(telemetry.notEvaluable.length)})
          </h3>
          <ul className="space-y-2">
            {telemetry.notEvaluable.map((n) => (
              <li
                key={n.type}
                className="rounded-lg border border-border bg-secondary/40 p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{n.study}</span>
                  <span className="text-xs text-muted-foreground">
                    {n.affectedPid ?? 'sin PID'} · {n.reason}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {n.justification}
                </p>
                {n.missingPidKeys.length > 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Falta: {n.missingPidKeys.join(', ')}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {Object.keys(telemetry.metrics).length > 0 ? (
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Métricas por PID
          </h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PID</TableHead>
                  <TableHead className="text-right">Prom.</TableHead>
                  <TableHead className="text-right">Mín.</TableHead>
                  <TableHead className="text-right">Máx.</TableHead>
                  <TableHead className="text-right">Desv. est.</TableHead>
                  <TableHead className="text-right">Muestras</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(telemetry.metrics).map(([pid, m]) => (
                  <TableRow key={pid}>
                    <TableCell className="font-mono text-xs">{pid}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(m.avg)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(m.min)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(m.max)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(m.stdDev)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatInt(m.sampleCount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}
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
        {a.pid ? (
          <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px]">{a.pid}</code>
        ) : null}
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
      <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div>{children}</div>
    </div>
  )
}
