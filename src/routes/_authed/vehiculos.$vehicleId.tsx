import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { ArrowLeft, BookOpen, MessageSquare } from 'lucide-react'
import {
  DOCUMENT_STATUS_LABELS,
  FINE_STATUS_LABELS,
  NOTIFICATION_TYPE_LABELS,
  VEHICLE_CENSUS_ENTRIES,
  VEHICLE_CENSUS_GROUPS,
  VEHICLE_TYPE_LABELS,
  type VehicleAlert,
  type VehicleCensus,
  type VehicleCensusGroup,
  type VehicleChat,
  type VehicleDetail,
  type VehicleDtc,
  type VehicleFine,
  type VehicleScan,
  type VehicleTask,
  type VehicleTaxDebt,
} from '~/lib/vehicles'
import { getAppVehicle } from '~/fn/vehicles'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { CopyableId } from '~/components/CopyableId'
import { Badge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Separator } from '~/components/ui/separator'
import { formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { ReactNode } from 'react'

export const Route = createFileRoute('/_authed/vehiculos/$vehicleId')({
  /** SSR completo — mismo criterio que `/usuarios/:userId`: se llega por link pegado tanto como por click. */
  loader: async ({ params, abortController }) => {
    const detail = await getAppVehicle({
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
    meta: [{ title: loaderData ? `${loaderData.plate} — Vehículos` : 'Vehículo' }],
  }),

  component: VehicleDetailScreen,
})

/**
 * El expediente de un vehículo — "todo lo que sepamos de él", en el mismo
 * orden que `/usuarios/:userId`:
 *
 * 1. **Quién es** — identidad del auto, del catálogo y del dueño.
 * 2. **Documentos** — seguro, VTV, cédula: cargado o no, vigente o no.
 * 3. **Qué tiene** — el censo completo de las 21 relaciones, incluso en cero.
 * 4. **El detalle** de lo que se decidió mostrar entero: DTCs, escaneos,
 *    chats, tareas, alertas, multas, deudas de patente.
 *
 * Solo lectura, entera — igual que `/usuarios/:userId`.
 */
function VehicleDetailScreen() {
  const vehicle = Route.useLoaderData()

  return (
    <>
      <Link
        to="/vehiculos"
        className="mb-3 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Vehículos
      </Link>

      <PageHeader
        title={vehicle.plate}
        subtitle={`${vehicle.brand} ${vehicle.model} ${vehicle.year} · ${vehicle.trim}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      {/* ── 1. Quién es ───────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardContent className="pt-6">
          <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Catálogo">
              <Link
                to="/catalogo/$catalogId"
                params={{ catalogId: vehicle.catalogId }}
                className="inline-flex items-center gap-1.5 rounded text-sm font-medium outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <BookOpen className="size-3.5 shrink-0" aria-hidden />
                {vehicle.brand} {vehicle.model} {vehicle.year}
              </Link>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {vehicle.trim} · {VEHICLE_TYPE_LABELS[vehicle.vehicleType] ?? vehicle.vehicleType}
                {vehicle.engine ? ` · ${vehicle.engine}` : ''}
                {vehicle.fuelType ? ` · ${vehicle.fuelType}` : ''}
                {vehicle.transmission ? ` · ${vehicle.transmission}` : ''}
              </div>
            </Field>

            <Field label="Dueño">
              <Link
                to="/usuarios/$userId"
                params={{ userId: vehicle.owner.id }}
                className="rounded text-sm font-medium outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {vehicle.owner.name ?? vehicle.owner.email}
              </Link>
              {vehicle.owner.name ? (
                <div className="mt-0.5 text-xs text-muted-foreground">{vehicle.owner.email}</div>
              ) : null}
            </Field>

            <Field label="Kilometraje">
              {vehicle.odometerValue === 0 ? (
                <Badge variant="outline" className="border-status-yellow/30 bg-status-yellow-bg text-status-yellow">
                  sin odómetro
                </Badge>
              ) : (
                <span className="tabular-nums">{formatInt(vehicle.odometerValue)} km</span>
              )}
            </Field>

            <Field label="Estado">
              {vehicle.archived ? (
                <Badge variant="outline" className="border-border bg-secondary text-muted-foreground">
                  Archivado
                </Badge>
              ) : (
                <Badge variant="outline" className="border-status-green/20 bg-status-green-bg text-status-green">
                  Activo
                </Badge>
              )}
            </Field>

            <Field label="Color">{vehicle.color}</Field>
            <Field label="VIN">
              {vehicle.vin ? <span className="font-mono text-xs">{vehicle.vin}</span> : <Missing>sin VIN</Missing>}
            </Field>
            <Field label="Nro. de motor">
              {vehicle.engineNumber ? (
                <span className="font-mono text-xs">{vehicle.engineNumber}</span>
              ) : (
                <Missing>sin cargar</Missing>
              )}
            </Field>
            <Field label="Alta">
              <span className="tabular-nums">{formatDate(vehicle.createdAt)}</span>
              <span className="ml-2 text-xs text-muted-foreground">mod. {formatDate(vehicle.updatedAt)}</span>
            </Field>
          </div>

          <Separator className="my-4" />

          {/*
            Km desde el último borrado de fallas — ya viene calculado por el
            backend (`current_distance_since_dtc_clear_km`); acá no se
            recalcula nada, sólo se muestra junto con CUÁNDO se tomó esa
            lectura, porque el número solo no dice si es reciente.
          */}
          <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Km desde borrado de fallas">
              {vehicle.distanceSinceDtcClearKm === null ? (
                <Missing>sin dato</Missing>
              ) : (
                <>
                  <span className="tabular-nums">{formatInt(vehicle.distanceSinceDtcClearKm)} km</span>
                  {vehicle.dtcClearReadingAt ? (
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      lectura del {formatDate(vehicle.dtcClearReadingAt)}
                    </div>
                  ) : null}
                </>
              )}
            </Field>
          </div>

          <Separator className="my-4" />
          <div className="grid gap-x-8 gap-y-3 sm:grid-cols-1">
            <Field label="id — AutoLibre">
              <CopyableId value={vehicle.id} />
            </Field>
          </div>
        </CardContent>
      </Card>

      {/* ── 2. Documentos ─────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Documentos</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            <DocumentChip
              label="Seguro"
              state={!vehicle.insurance ? 'missing' : vehicle.insurance.status === 'active' ? 'ok' : 'warn'}
              detail={
                !vehicle.insurance
                  ? 'no cargado'
                  : `${vehicle.insurance.insurer || 'sin asegurador'} · ${DOCUMENT_STATUS_LABELS[vehicle.insurance.status] ?? vehicle.insurance.status} · vence ${formatDate(vehicle.insurance.expiresAt)}`
              }
            />
            <DocumentChip
              label="VTV"
              state={!vehicle.vtv ? 'missing' : vehicle.vtv.status === 'active' ? 'ok' : 'warn'}
              detail={
                !vehicle.vtv
                  ? 'no cargada'
                  : `${DOCUMENT_STATUS_LABELS[vehicle.vtv.status] ?? vehicle.vtv.status} · vence ${formatDate(vehicle.vtv.expiresAt)}${vehicle.vtv.facility ? ` · ${vehicle.vtv.facility}` : ''}`
              }
            />
            <DocumentChip
              label="Cédula"
              state={vehicle.registrationCard ? 'ok' : 'missing'}
              detail={
                vehicle.registrationCard
                  ? `cargada ${formatDate(vehicle.registrationCard.loadedAt)}${vehicle.registrationCard.registrationNumber ? ` · ${vehicle.registrationCard.registrationNumber}` : ''}`
                  : 'no cargada'
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* ── 3. Qué tiene ──────────────────────────────────────────────────── */}
      <Census census={vehicle.census} />

      {/* ── 4. El detalle ─────────────────────────────────────────────────── */}
      <div className="mt-4 grid items-start gap-4 lg:grid-cols-5">
        <div className="grid gap-4 lg:col-span-3">
          <Dtcs active={vehicle.activeDtcs} inactive={vehicle.inactiveDtcs} lastScanAt={vehicle.lastDtcScanAt} />
          <Scans scans={vehicle.scans} />
          <Fines fines={vehicle.fines} />
          <TaxDebts debts={vehicle.taxDebts} />
        </div>
        <div className="grid gap-4 lg:col-span-2">
          <Chats chats={vehicle.chats} />
          <Alerts alerts={vehicle.alerts} />
        </div>
      </div>

      <div className="mt-4">
        <Tasks tasks={vehicle.tasks} />
      </div>
    </>
  )
}

// ── Censo ────────────────────────────────────────────────────────────────────

/** Mismo patrón que `Census` en `usuarios.$userId.tsx`, con las 21 relaciones de `~/lib/vehicles`. */
function Census({ census }: { census: VehicleCensus }) {
  const total = VEHICLE_CENSUS_ENTRIES.reduce((sum, e) => sum + census[e.key], 0)
  const withData = VEHICLE_CENSUS_ENTRIES.filter((e) => census[e.key] > 0).length

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Todo lo que tiene</CardTitle>
        <span className="text-xs text-muted-foreground">
          <strong className="font-semibold text-foreground tabular-nums">{withData}</strong> de{' '}
          {VEHICLE_CENSUS_ENTRIES.length} relaciones con datos ·{' '}
          <span className="tabular-nums">{formatInt(total)}</span> filas
        </span>
      </CardHeader>

      <CardContent>
        <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-3">
          {VEHICLE_CENSUS_GROUPS.map((group) => (
            <CensusGroupBlock key={group} group={group} census={census} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function CensusGroupBlock({ group, census }: { group: VehicleCensusGroup; census: VehicleCensus }) {
  const entries = VEHICLE_CENSUS_ENTRIES.filter((e) => e.group === group)
  const withData = entries.filter((e) => census[e.key] > 0).length

  return (
    <section>
      <header className="mb-1.5 flex items-baseline justify-between gap-2 border-b border-border pb-1.5">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{group}</h3>
        <span className={cn('shrink-0 text-xs tabular-nums', withData === 0 ? 'text-muted-foreground/60' : 'text-muted-foreground')}>
          {withData}/{entries.length}
        </span>
      </header>

      <ul>
        {entries.map((entry) => {
          const count = census[entry.key]
          const empty = count === 0

          return (
            <li key={entry.key} className="flex items-baseline gap-3 border-b border-border/50 py-1.5 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className={cn('truncate text-sm', empty && 'text-muted-foreground')}>{entry.label}</div>
                <div className="truncate text-[10px] leading-tight text-muted-foreground/70">
                  <code className="font-mono">{entry.table}</code>
                  {entry.via !== 'vehicle_id' ? ` · por ${entry.via}` : null}
                </div>
              </div>
              <span className={cn('shrink-0 tabular-nums', empty ? 'text-sm text-muted-foreground/50' : 'text-sm font-semibold text-foreground')}>
                {formatInt(count)}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ── Bloques del detalle ──────────────────────────────────────────────────────

/**
 * "Activos" = del último escaneo DTC. "Inactivos" = aparecieron alguna vez y
 * no están en ese escaneo. Ver `~/lib/vehicles` para la justificación
 * completa y el caso real que separa las dos columnas.
 */
function Dtcs({
  active,
  inactive,
  lastScanAt,
}: {
  active: Array<VehicleDtc>
  inactive: Array<VehicleDtc>
  lastScanAt: string | null
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Códigos DTC</CardTitle>
        <span className="text-xs text-muted-foreground">
          {lastScanAt ? `último escaneo ${formatDate(lastScanAt)}` : 'nunca se escaneó por DTC'}
        </span>
      </CardHeader>
      <CardContent>
        {active.length === 0 && inactive.length === 0 ? (
          <Empty>Sin códigos DTC leídos, ni activos ni históricos.</Empty>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Activos ({formatInt(active.length)})
              </h4>
              {active.length === 0 ? (
                <Empty>Ninguno en el último escaneo.</Empty>
              ) : (
                <ul className="space-y-2">
                  {active.map((d) => (
                    <DtcRow key={d.code} dtc={d} tone="warn" />
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Inactivos ({formatInt(inactive.length)})
              </h4>
              {inactive.length === 0 ? (
                <Empty>Ninguno — todo lo visto sigue activo o nunca hubo historial.</Empty>
              ) : (
                <ul className="space-y-2">
                  {inactive.map((d) => (
                    <DtcRow key={d.code} dtc={d} tone="neutral" />
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function DtcRow({ dtc, tone }: { dtc: VehicleDtc; tone: 'warn' | 'neutral' }) {
  return (
    <li className="text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className={cn('font-mono font-semibold', tone === 'warn' && 'text-status-yellow')}>{dtc.code}</span>
        <span className="text-xs tabular-nums text-muted-foreground">visto {formatDate(dtc.lastSeenAt)}</span>
      </div>
      {dtc.description ? <p className="mt-0.5 text-xs text-muted-foreground">{dtc.description}</p> : null}
    </li>
  )
}

function Scans({ scans }: { scans: Array<VehicleScan> }) {
  const ok = scans.filter((s) => s.status === 'completed' && s.totalReadings > 0).length

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Sesiones de escaneo</CardTitle>
        <span className="text-xs text-muted-foreground">
          {scans.length === 0 ? 'ninguna' : `${formatInt(ok)} con datos de ${formatInt(scans.length)}`}
        </span>
      </CardHeader>
      <CardContent>
        {scans.length === 0 ? (
          <Empty>Nunca se escaneó este vehículo con el escáner OBD.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="py-1.5 text-left font-medium">Inicio</th>
                  <th className="py-1.5 text-left font-medium">Duración</th>
                  <th className="py-1.5 text-left font-medium">Escáner</th>
                  <th className="py-1.5 text-right font-medium">Lecturas</th>
                  <th className="py-1.5 text-right font-medium">Km s/ borrado</th>
                </tr>
              </thead>
              <tbody>
                {scans.map((s) => {
                  const served = s.status === 'completed' && s.totalReadings > 0
                  const minutes = s.endedAt
                    ? Math.round((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 60_000)
                    : null
                  return (
                    <tr key={s.id} className="border-b border-border/50 last:border-b-0">
                      <td className="py-1.5 tabular-nums">{formatDate(s.startedAt)}</td>
                      <td className="py-1.5 tabular-nums text-muted-foreground">
                        {minutes === null ? 'sin terminar' : `${minutes} min`}
                      </td>
                      <td className="py-1.5 text-muted-foreground">
                        {s.scannerType}
                        {s.scannerFirmware ? ` · ${s.scannerFirmware}` : ' · sin identificar'}
                      </td>
                      <td className={cn('py-1.5 text-right tabular-nums', !served && 'text-status-yellow')}>
                        {formatInt(s.totalReadings)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                        {s.distanceSinceDtcClearKm === null ? '—' : formatInt(s.distanceSinceDtcClearKm)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Chats({ chats }: { chats: Array<VehicleChat> }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between space-y-0">
        <CardTitle className="text-base">Chats de IA de diagnóstico</CardTitle>
        <span className="text-xs text-muted-foreground">{chats.length === 0 ? 'ninguno' : formatInt(chats.length)}</span>
      </CardHeader>
      <CardContent>
        {chats.length === 0 ? (
          <Empty>Nunca se abrió el asistente con este vehículo asociado.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {chats.map((c) => (
              <li key={c.id} className="py-2.5 first:pt-0 last:pb-0">
                <Link
                  to="/chats/$conversationId"
                  params={{ conversationId: c.id }}
                  className="flex items-start gap-2 rounded text-sm outline-none hover:text-brand focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    {c.title ? (
                      <span className="line-clamp-1">{c.title}</span>
                    ) : (
                      <span className="text-muted-foreground/70">sin mensajes</span>
                    )}
                  </span>
                </Link>
                <div className="mt-0.5 pl-5 text-xs text-muted-foreground">
                  {formatDate(c.startedAt)} · {formatInt(c.userMessageCount)} del usuario, {formatInt(c.aiMessageCount)} de la IA
                  {c.model ? ` · ${c.model}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function Alerts({ alerts }: { alerts: Array<VehicleAlert> }) {
  const active = alerts.filter((a) => a.status !== 'read').length

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between space-y-0">
        <CardTitle className="text-base">Alertas</CardTitle>
        <span className="text-xs text-muted-foreground">
          {alerts.length === 0 ? 'ninguna' : `${formatInt(active)} activa(s) de ${formatInt(alerts.length)}`}
        </span>
      </CardHeader>
      <CardContent>
        {alerts.length === 0 ? (
          <Empty>Sin notificaciones generadas para este vehículo.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {alerts.map((a) => (
              <li key={a.id} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{a.title}</span>
                  {a.status !== 'read' ? (
                    <Badge variant="outline" className="shrink-0 border-status-yellow/30 bg-status-yellow-bg text-status-yellow">
                      {a.status}
                    </Badge>
                  ) : (
                    <span className="shrink-0 text-xs text-muted-foreground">leída</span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {NOTIFICATION_TYPE_LABELS[a.type] ?? a.type} · {a.channel} · {formatDate(a.scheduledAt)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

/** Mismo criterio que `Tasks` en `usuarios.$userId.tsx`: pendientes (con vencidas primero) y realizadas. */
function Tasks({ tasks }: { tasks: Array<VehicleTask> }) {
  const pending = tasks
    .filter((t) => t.state !== 'done')
    .sort((a, b) => {
      if (a.state === 'overdue' && b.state !== 'overdue') return -1
      if (b.state === 'overdue' && a.state !== 'overdue') return 1
      if (!a.dueDate && !b.dueDate) return 0
      if (!a.dueDate) return 1
      if (!b.dueDate) return -1
      return a.dueDate.localeCompare(b.dueDate)
    })
  const done = tasks.filter((t) => t.state === 'done')
  const overdueCount = pending.filter((t) => t.state === 'overdue').length

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Tareas de mantenimiento</CardTitle>
        <span className="text-xs text-muted-foreground">
          <span className="tabular-nums">{formatInt(pending.length)}</span> futura(s) ·{' '}
          <span className="tabular-nums">{formatInt(done.length)}</span> pasada(s)
        </span>
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <Empty>Sin tareas de mantenimiento cargadas, ni pasadas ni futuras.</Empty>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <h4 className="mb-2 flex flex-wrap items-baseline gap-x-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <span>Futuras</span>
                {overdueCount > 0 ? (
                  <span className="normal-case tracking-normal text-status-yellow">{formatInt(overdueCount)} vencida(s)</span>
                ) : null}
              </h4>
              {pending.length === 0 ? (
                <Empty>Ninguna pendiente.</Empty>
              ) : (
                <ul className="space-y-3">
                  {pending.map((t) => (
                    <TaskRow key={t.id} task={t} />
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Pasadas</h4>
              {done.length === 0 ? (
                <Empty>Ninguna marcada como realizada.</Empty>
              ) : (
                <ul className="space-y-3">
                  {done.map((t) => (
                    <TaskRow key={t.id} task={t} />
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function TaskRow({ task: t }: { task: VehicleTask }) {
  return (
    <li className={cn('text-sm', t.archived && 'opacity-60')}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="font-medium">{t.name}</span>
        <TaskStateTag task={t} />
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span>{t.itemType.replaceAll('_', ' ')}</span>
        {t.workshop ? (
          <>
            <Dot />
            <span>{t.workshop}</span>
          </>
        ) : null}
        {t.odometerAtService !== null ? (
          <>
            <Dot />
            <span className="tabular-nums">{formatInt(t.odometerAtService)} km</span>
          </>
        ) : null}
        {t.archived ? (
          <>
            <Dot />
            <span>archivada</span>
          </>
        ) : null}
      </div>
    </li>
  )
}

function TaskStateTag({ task: t }: { task: VehicleTask }) {
  if (t.state === 'overdue') {
    return (
      <Badge variant="outline" className="shrink-0 border-status-yellow/30 bg-status-yellow-bg text-status-yellow">
        vencida{t.dueDate ? ` · ${formatDate(t.dueDate)}` : ''}
      </Badge>
    )
  }
  if (t.state === 'undated') {
    return <span className="shrink-0 text-xs text-muted-foreground/60">sin fecha</span>
  }
  const when = t.state === 'done' ? t.performedAt : t.dueDate
  return <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{when ? formatDate(when) : ''}</span>
}

function Fines({ fines }: { fines: Array<VehicleFine> }) {
  const pending = fines.filter((f) => f.status === 'pending').length

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between space-y-0">
        <CardTitle className="text-base">Multas</CardTitle>
        <span className="text-xs text-muted-foreground">
          {fines.length === 0 ? 'ninguna' : `${formatInt(pending)} pendiente(s) de ${formatInt(fines.length)}`}
        </span>
      </CardHeader>
      <CardContent>
        {fines.length === 0 ? (
          <Empty>Sin multas registradas para este vehículo.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {fines.map((f) => (
              <li key={f.id} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="text-sm">{f.reason}</span>
                  <Badge
                    variant="outline"
                    className={
                      f.status === 'pending'
                        ? 'border-status-yellow/30 bg-status-yellow-bg text-status-yellow'
                        : 'border-border bg-secondary text-muted-foreground'
                    }
                  >
                    {FINE_STATUS_LABELS[f.status] ?? f.status}
                  </Badge>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  <span className="tabular-nums">${formatInt(f.amount)}</span> · {formatDate(f.infractionDate)}
                  {f.jurisdiction ? ` · ${f.jurisdiction}` : ''}
                  {f.dueDate ? ` · vence ${formatDate(f.dueDate)}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function TaxDebts({ debts }: { debts: Array<VehicleTaxDebt> }) {
  const pending = debts.filter((d) => !d.clearedAt).length

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between space-y-0">
        <CardTitle className="text-base">Deudas de patente</CardTitle>
        <span className="text-xs text-muted-foreground">
          {debts.length === 0 ? 'ninguna' : `${formatInt(pending)} sin saldar de ${formatInt(debts.length)}`}
        </span>
      </CardHeader>
      <CardContent>
        {debts.length === 0 ? (
          <Empty>Sin deudas de patente registradas.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {debts.map((d) => (
              <li key={d.id} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="text-sm">
                    {d.jurisdiction} · {d.period}
                  </span>
                  {d.clearedAt ? (
                    <span className="text-xs text-status-green">saldada {formatDate(d.clearedAt)}</span>
                  ) : (
                    <Badge variant="outline" className="border-status-yellow/30 bg-status-yellow-bg text-status-yellow">
                      pendiente
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  <span className="tabular-nums">${formatInt(d.amount)}</span>
                  {d.dueDate ? ` · vence ${formatDate(d.dueDate)}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ── Piezas chicas ────────────────────────────────────────────────────────────

function DocumentChip({ label, state, detail }: { label: string; state: 'ok' | 'warn' | 'missing'; detail: string }) {
  return (
    <span
      title={detail}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        state === 'ok' && 'border-status-green/20 bg-status-green-bg text-status-green',
        state === 'warn' && 'border-status-yellow/30 bg-status-yellow-bg text-status-yellow',
        state === 'missing' && 'border-border bg-secondary text-muted-foreground/70',
      )}
    >
      {label}
      <span className="font-normal opacity-80">· {detail}</span>
    </span>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  )
}

function Dot() {
  return (
    <span className="text-muted-foreground/40" aria-hidden>
      ·
    </span>
  )
}

function Missing({ children }: { children: ReactNode }) {
  return <span className="text-sm text-muted-foreground/70">{children}</span>
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
}
