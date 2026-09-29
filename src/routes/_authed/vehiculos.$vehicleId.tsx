import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { ArrowLeft, BookOpen, MessageSquare } from 'lucide-react'
import {
  VEHICLE_CENSUS_ENTRIES,
  VEHICLE_CENSUS_GROUPS,
  vehicleTypeLabel,
  type VehicleAlert,
  type VehicleCensus,
  type VehicleCensusGroup,
  type VehicleChat,
  type VehicleDetail,
  type VehicleDtc,
  type VehicleFine,
  type VehicleScan,
  type VehicleTaxDebt,
} from '~/lib/vehicles'
import {
  NOTIFICATION_STATE_LABELS,
  NOTIFICATION_STATE_TONE,
  NOTIFICATION_TYPE_LABELS,
} from '~/lib/notifications'
import { SESSION_BUCKET_LABELS } from '~/lib/scanners'
import { getVehicleDetailFn } from '~/fn/vehicles'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { CopyableId } from '~/components/CopyableId'
import { MaintenanceTasks } from '~/components/MaintenanceTasks'
import { ExpiryCell, LocationCell } from '~/components/VehicleCells'
import { Badge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Separator } from '~/components/ui/separator'
import { formatArs, formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { ReactNode } from 'react'

/**
 * La ficha de un vehículo — "qué le está pasando a este auto".
 *
 * ── Qué reemplaza ───────────────────────────────────────────────────────────
 *
 * La docena de `select` sueltos por `vehicle_id` que hacen falta para contestar
 * "¿qué tan sano está este auto?" — contra `driving_sessions`, `conversations`,
 * `maintenance_occurrences`, `notifications`, `fines`, `insurances`,
 * `vehicle_inspections`, `registration_cards` y los snapshots de DTC. Es
 * `/usuarios/:id` invertido: ahí el auto es una fila del usuario; acá el
 * usuario es un campo del auto.
 *
 * Nació en la rama `listado-vehiculos` (2026-09-04) y se portó el 2026-09-28
 * — ver la cabecera de `vehicle-detail.repo.ts` para lo que cambió y por qué.
 *
 * Orden, el mismo que `/usuarios/:id`: quién es → documentos → todo lo que
 * tiene (el censo, incluso en cero) → el detalle. Solo lectura, entera.
 */
export const Route = createFileRoute('/_authed/vehiculos/$vehicleId')({
  /** SSR completo: se llega por link pegado (desde un ticket) tanto como por click. */
  loader: async ({ params, abortController }) => {
    const detail = await getVehicleDetailFn({
      data: params,
      signal: abortController.signal,
    }).catch((cause: unknown) => {
      // `NOT_FOUND:` es un 404 de Router; cualquier otro error sube.
      if (cause instanceof Error && cause.message.startsWith('NOT_FOUND:')) return null
      throw cause
    })

    if (!detail) throw notFound()
    return detail
  },

  head: ({ loaderData }) => ({
    meta: [{ title: loaderData ? `${loaderData.plate} · Vehículos — AutoLibre` : 'Vehículo — AutoLibre' }],
  }),

  component: VehicleDetailScreen,
})

const focusRing =
  'rounded outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'

function VehicleDetailScreen() {
  const vehicle = Route.useLoaderData()

  return (
    <>
      <Link
        to="/vehiculos/listado"
        className={cn('mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground', focusRing)}
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Listado
      </Link>

      <PageHeader
        title={vehicle.plate}
        subtitle={`${vehicle.brand} ${vehicle.model} ${vehicle.trim} · ${vehicle.year}${vehicle.alias ? ` · ${vehicle.alias}` : ''}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <Identity vehicle={vehicle} />
      <Documents vehicle={vehicle} />
      <Census census={vehicle.census} />

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-5">
        <div className="grid gap-4 lg:col-span-3">
          <Dtcs active={vehicle.activeDtcs} inactive={vehicle.inactiveDtcs} lastScanAt={vehicle.lastDtcScanAt} />
          <Scans scans={vehicle.scans} />
          <Fines fines={vehicle.fines} consultedAt={vehicle.fineConsultedAt} />
          <TaxDebts debts={vehicle.taxDebts} />
        </div>
        <div className="grid gap-4 lg:col-span-2">
          <Chats chats={vehicle.chats} />
          <Alerts alerts={vehicle.alerts} ownerId={vehicle.owner.id} />
        </div>
      </div>

      <div className="mt-4">
        <MaintenanceTasks tasks={vehicle.tasks} />
      </div>
    </>
  )
}

// ── Quién es ───────────────────────────────────────────────────────────────

function Identity({ vehicle }: { vehicle: VehicleDetail }) {
  return (
    <Card className="mb-4">
      <CardContent className="pt-6">
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Modelo del catálogo">
            <Link
              to="/vehiculos/catalogo/$catalogId"
              params={{ catalogId: vehicle.catalogId }}
              className={cn('inline-flex items-center gap-1.5 text-sm font-medium hover:text-brand hover:underline', focusRing)}
            >
              <BookOpen className="size-3.5 shrink-0" aria-hidden />
              {vehicle.brand} {vehicle.model} {vehicle.year}
            </Link>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {[vehicle.trim, vehicleTypeLabel(vehicle.vehicleType), vehicle.engine, vehicle.fuelType, vehicle.transmission]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </Field>

          <Field label="Dueño">
            <Link
              to="/usuarios/$userId"
              params={{ userId: vehicle.owner.id }}
              className={cn('text-sm font-medium hover:text-brand hover:underline', focusRing)}
            >
              {vehicle.owner.name ?? vehicle.owner.email}
            </Link>
            {vehicle.owner.name ? <div className="mt-0.5 text-xs text-muted-foreground">{vehicle.owner.email}</div> : null}
            {vehicle.owner.phone ? <div className="text-xs text-muted-foreground">{vehicle.owner.phone}</div> : null}
          </Field>

          <Field label="Kilometraje">
            {vehicle.odometerKm === 0 ? (
              <Missing>no cargado</Missing>
            ) : (
              <span className="tabular-nums">{formatInt(vehicle.odometerKm)} km</span>
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

          <Field label="Radicación">
            <LocationCell location={vehicle.location} />
          </Field>
          <Field label="Color">{vehicle.color}</Field>
          <Field label="VIN">
            {vehicle.vin ? <span className="font-mono text-xs">{vehicle.vin}</span> : <Missing>sin VIN</Missing>}
          </Field>
          <Field label="Nº de motor">
            {vehicle.engineNumber ? (
              <span className="font-mono text-xs">{vehicle.engineNumber}</span>
            ) : (
              <Missing>no cargado en el vehículo</Missing>
            )}
          </Field>

          {/*
            Km desde el último borrado de fallas: lo calcula el backend
            (`current_distance_since_dtc_clear_km`). Se muestra con CUÁNDO se
            tomó la lectura, porque el número solo no dice si es reciente.
          */}
          <Field label="Km desde borrado de fallas">
            {vehicle.distanceSinceDtcClearKm === null ? (
              <Missing>sin dato</Missing>
            ) : (
              <>
                <span className="tabular-nums">{formatInt(vehicle.distanceSinceDtcClearKm)} km</span>
                {vehicle.dtcClearReadingAt ? (
                  <div className="mt-0.5 text-xs text-muted-foreground">lectura del {formatDate(vehicle.dtcClearReadingAt)}</div>
                ) : null}
              </>
            )}
          </Field>
          <Field label="Patentado">
            {vehicle.registeredAt ? (
              <span className="tabular-nums">{formatDate(vehicle.registeredAt)}</span>
            ) : (
              <Missing>sin dato</Missing>
            )}
          </Field>
          <Field label="Alta">
            <span className="tabular-nums">{formatDate(vehicle.createdAt)}</span>
            <span className="ml-2 text-xs text-muted-foreground">mod. {formatDate(vehicle.updatedAt)}</span>
          </Field>
        </div>

        <Separator className="my-4" />
        <Field label="id — AutoLibre">
          <CopyableId value={vehicle.id} />
        </Field>
      </CardContent>
    </Card>
  )
}

// ── Documentos ─────────────────────────────────────────────────────────────

/**
 * Seguro, VTV y cédula: el más reciente no archivado. El vencimiento lo lee
 * `ExpiryCell` de la FECHA, no de `status` (`leads.md`, Seguros). El link a
 * `/documentos` sólo aparece si el documento pasó por OCR — es lo único que
 * esa pantalla muestra.
 */
function Documents({ vehicle }: { vehicle: VehicleDetail }) {
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-base">Documentos</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
          <Field label="Seguro">
            {!vehicle.insurance ? (
              <Missing>no cargado</Missing>
            ) : (
              <>
                <ExpiryCell iso={vehicle.insurance.expiresAt} />
                <div className="mt-0.5 text-xs text-muted-foreground">{vehicle.insurance.insurer ?? 'sin aseguradora'}</div>
                <DocLink docType="seguro" docId={vehicle.insurance.docId} />
              </>
            )}
          </Field>
          <Field label="VTV">
            {!vehicle.vtv ? (
              <Missing>no cargada</Missing>
            ) : (
              <>
                <ExpiryCell iso={vehicle.vtv.expiresAt} />
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {vehicle.vtv.facility ?? 'sin planta'}
                  {vehicle.vtv.fromProvider ? ' · consultada por patente, no subida' : ''}
                </div>
                <DocLink docType="vtv" docId={vehicle.vtv.docId} />
              </>
            )}
          </Field>
          <Field label="Cédula">
            {!vehicle.registrationCard ? (
              <Missing>no cargada</Missing>
            ) : (
              <>
                <span className="tabular-nums">cargada el {formatDate(vehicle.registrationCard.loadedAt)}</span>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {[vehicle.registrationCard.registrationNumber, vehicle.registrationCard.holderName]
                    .filter(Boolean)
                    .join(' · ') || 'sin número ni titular'}
                </div>
                <DocLink docType="cedula" docId={vehicle.registrationCard.docId} />
              </>
            )}
          </Field>
        </div>
      </CardContent>
    </Card>
  )
}

function DocLink({ docType, docId }: { docType: 'seguro' | 'vtv' | 'cedula'; docId: string | null }) {
  if (!docId) return null
  return (
    <Link
      to="/documentos/$docType/$docId"
      params={{ docType, docId }}
      className={cn('mt-1 inline-block text-xs text-brand hover:underline', focusRing)}
    >
      Ver lo que extrajo el OCR
    </Link>
  )
}

// ── Censo ──────────────────────────────────────────────────────────────────

/**
 * Mismo patrón que el censo de `/usuarios/:id`: todas las relaciones, incluso
 * en cero — acá el cero ES el síntoma que se vino a buscar. `null` es otra
 * cosa: la tabla no existe en la base conectada, y se dice.
 */
function Census({ census }: { census: VehicleCensus }) {
  const values = VEHICLE_CENSUS_ENTRIES.map((e) => census[e.key])
  const total = values.reduce<number>((sum, n) => sum + (n ?? 0), 0)
  const withData = values.filter((n) => (n ?? 0) > 0).length

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Todo lo que tiene</CardTitle>
        <span className="text-xs text-muted-foreground">
          <strong className="font-semibold tabular-nums text-foreground">{withData}</strong> de{' '}
          {VEHICLE_CENSUS_ENTRIES.length} relaciones con datos · <span className="tabular-nums">{formatInt(total)}</span> filas
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
  const withData = entries.filter((e) => (census[e.key] ?? 0) > 0).length

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
          return (
            <li key={entry.key} className="flex items-baseline gap-3 border-b border-border/50 py-1.5 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className={cn('truncate text-sm', !count && 'text-muted-foreground')}>{entry.label}</div>
                <div className="truncate text-[10px] leading-tight text-muted-foreground/70">
                  <code className="font-mono">{entry.table}</code>
                  {entry.via !== 'vehicle_id' ? ` · por ${entry.via}` : null}
                </div>
              </div>
              {count === null ? (
                <span className="shrink-0 text-xs text-muted-foreground/60" title="La tabla no existe en esta base">
                  no existe
                </span>
              ) : (
                <span
                  className={cn(
                    'shrink-0 tabular-nums text-sm',
                    count === 0 ? 'text-muted-foreground/50' : 'font-semibold text-foreground',
                  )}
                >
                  {formatInt(count)}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ── El detalle ─────────────────────────────────────────────────────────────

/**
 * "Activos" = los del snapshot del último escaneo. "Inactivos" = aparecieron
 * en algún escaneo anterior y ya no. Los dos salen de
 * `session_dtc_snapshots.codes` — todo lo que trajo cada escaneo, no sólo lo
 * que alguien buscó.
 */
function Dtcs({ active, inactive, lastScanAt }: { active: Array<VehicleDtc>; inactive: Array<VehicleDtc>; lastScanAt: string | null }) {
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
          <Empty>{lastScanAt ? 'Ningún escaneo trajo códigos DTC.' : 'Sin escaneos: no hay códigos que mostrar.'}</Empty>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            <DtcList
              title="Activos"
              hint="en el último escaneo"
              dtcs={active}
              empty={lastScanAt ? 'Ninguno: el último escaneo vino limpio.' : 'Sin último escaneo.'}
              warn
            />
            <DtcList
              title="Inactivos"
              hint="vistos antes, ya no"
              dtcs={inactive}
              empty="Ninguno: todo lo visto sigue activo."
              warn={false}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function DtcList({ title, hint, dtcs, empty, warn }: { title: string; hint: string; dtcs: Array<VehicleDtc>; empty: string; warn: boolean }) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title} ({formatInt(dtcs.length)})
        <span className="ml-1.5 normal-case tracking-normal text-muted-foreground/70">{hint}</span>
      </h4>
      {dtcs.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul className="space-y-2">
          {dtcs.map((d) => (
            <li key={d.code} className="text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span className={cn('font-mono font-semibold', warn && 'text-status-yellow')}>{d.code}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatDate(d.lastSeenAt)} · {formatInt(d.sessions)} escaneo{d.sessions === 1 ? '' : 's'}
                </span>
              </div>
              {d.title ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{d.title}</p>
              ) : (
                <p className="mt-0.5 text-xs text-status-yellow">sin título cargado</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Scans({ scans }: { scans: Array<VehicleScan> }) {
  const ok = scans.filter((s) => s.bucket === 'ok').length

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Escaneos</CardTitle>
        <span className="text-xs text-muted-foreground">
          {scans.length === 0 ? 'ninguno' : `${formatInt(ok)} con datos de ${formatInt(scans.length)}`}
        </span>
      </CardHeader>
      <CardContent>
        {scans.length === 0 ? (
          <Empty>Nunca se escaneó este vehículo con el escáner OBD.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="py-1.5 text-left font-medium">Inicio</th>
                  <th className="py-1.5 text-left font-medium">Resultado</th>
                  <th className="py-1.5 text-left font-medium">Escáner</th>
                  <th className="py-1.5 text-right font-medium">Lecturas</th>
                  <th className="py-1.5 text-right font-medium">DTCs</th>
                  <th className="py-1.5 text-right font-medium">Km s/ borrado</th>
                </tr>
              </thead>
              <tbody>
                {scans.map((s) => (
                  <tr key={s.id} className="border-b border-border/50 last:border-b-0">
                    <td className="py-1.5">
                      <Link
                        to="/escaneres/sesiones/$sessionId"
                        params={{ sessionId: s.id }}
                        className={cn('tabular-nums text-brand hover:underline', focusRing)}
                      >
                        {formatDate(s.startedAt)}
                      </Link>
                      {s.endedAt ? (
                        <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">
                          {Math.round((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 60_000)} min
                        </span>
                      ) : null}
                    </td>
                    <td className={cn('py-1.5 text-xs', s.bucket === 'ok' ? 'text-muted-foreground' : 'text-status-yellow')}>
                      {SESSION_BUCKET_LABELS[s.bucket]}
                    </td>
                    <td className="py-1.5 text-xs text-muted-foreground">
                      {s.scannerType}
                      {s.scannerFirmware ? ` · ${s.scannerFirmware}` : ' · sin identificar'}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatInt(s.totalReadings)}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {s.dtcCount === null ? <span className="text-muted-foreground/50">—</span> : formatInt(s.dtcCount)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                      {s.distanceSinceDtcClearKm === null ? '—' : formatInt(s.distanceSinceDtcClearKm)}
                    </td>
                  </tr>
                ))}
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
        <CardTitle className="text-base">Chats de diagnóstico</CardTitle>
        <span className="text-xs text-muted-foreground">{chats.length === 0 ? 'ninguno' : formatInt(chats.length)}</span>
      </CardHeader>
      <CardContent>
        {chats.length === 0 ? (
          <Empty>Nadie le escribió al asistente con este vehículo asociado.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {chats.map((c) => (
              <li key={c.id} className="py-2.5 first:pt-0 last:pb-0">
                <Link
                  to="/chats/$conversationId"
                  params={{ conversationId: c.id }}
                  className={cn('flex items-start gap-2 text-sm hover:text-brand', focusRing)}
                >
                  <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    {c.title ? (
                      <span className="line-clamp-1">{c.title}</span>
                    ) : (
                      <span className="text-muted-foreground/70">sin mensaje del usuario</span>
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

const TONE_CLASS = {
  ok: 'text-status-green',
  warn: 'text-status-yellow',
  bad: 'text-status-red',
  neutral: 'text-muted-foreground',
} as const

/** El estado es el derivado de `/notificaciones` — el mismo texto y el mismo color. */
function Alerts({ alerts, ownerId }: { alerts: Array<VehicleAlert>; ownerId: string }) {
  const unread = alerts.filter((a) => a.state !== 'leida').length

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between space-y-0">
        <CardTitle className="text-base">Avisos</CardTitle>
        <span className="text-xs text-muted-foreground">
          {alerts.length === 0 ? 'ninguno' : `${formatInt(unread)} sin leer de ${formatInt(alerts.length)}`}
        </span>
      </CardHeader>
      <CardContent>
        {alerts.length === 0 ? (
          <Empty>Nunca se le avisó nada sobre este vehículo.</Empty>
        ) : (
          <>
            <ul className="divide-y divide-border">
              {alerts.map((a) => (
                <li key={a.id} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{a.title}</span>
                    <span className={cn('shrink-0 text-xs', TONE_CLASS[NOTIFICATION_STATE_TONE[a.state]])}>
                      {NOTIFICATION_STATE_LABELS[a.state]}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {NOTIFICATION_TYPE_LABELS[a.type] ?? a.type} · {formatDate(a.scheduledAt)}
                  </div>
                </li>
              ))}
            </ul>
            <Link
              to="/notificaciones"
              search={{ userId: ownerId }}
              className={cn('mt-3 inline-block text-xs text-brand hover:underline', focusRing)}
            >
              Ver el historial del dueño en Notificaciones
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  )
}

const FINE_STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  paid: 'Pagada',
  appealed: 'Apelada',
}

/** `null` (nunca consultadas) ≠ consultadas sin multas — mismo gate que `/usuarios`. */
function Fines({ fines, consultedAt }: { fines: Array<VehicleFine>; consultedAt: string | null }) {
  const pending = fines.filter((f) => f.status === 'pending')
  const debt = pending.reduce((sum, f) => sum + f.amount, 0)

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Multas</CardTitle>
        <span className="text-xs text-muted-foreground">
          {consultedAt === null
            ? 'nunca consultadas'
            : `consultadas el ${formatDate(consultedAt)} · ${formatInt(pending.length)} pendiente(s)${debt > 0 ? ` · ${formatArs(debt)}` : ''}`}
        </span>
      </CardHeader>
      <CardContent>
        {fines.length === 0 ? (
          <Empty>{consultedAt === null ? 'Nunca se consultaron las multas de este auto.' : 'La última consulta no trajo multas.'}</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {fines.map((f) => (
              <li key={f.id} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="text-sm">{f.reason}</span>
                  <span className={cn('shrink-0 text-xs', f.status === 'pending' ? 'text-status-yellow' : 'text-muted-foreground')}>
                    {FINE_STATUS_LABELS[f.status] ?? f.status}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  <span className="tabular-nums">{formatArs(f.amount)}</span> · {formatDate(f.infractionDate)}
                  {f.jurisdiction ? ` · ${f.jurisdiction}` : ''}
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
          <Empty>Sin deudas de patente registradas. Sin una consulta completada, eso no quiere decir que no deba.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {debts.map((d) => (
              <li key={d.id} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="text-sm">
                    {d.jurisdiction} · {d.period}
                  </span>
                  {d.clearedAt ? (
                    <span className="text-xs text-muted-foreground">saldada {formatDate(d.clearedAt)}</span>
                  ) : (
                    <span className="text-xs text-status-yellow">sin saldar</span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  <span className="tabular-nums">{formatArs(d.amount)}</span>
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

// ── Piezas chicas ──────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  )
}

function Missing({ children }: { children: ReactNode }) {
  return <span className="text-sm text-muted-foreground/70">{children}</span>
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
}
