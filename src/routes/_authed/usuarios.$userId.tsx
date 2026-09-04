import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { AlertTriangle, ArrowLeft, Car, CheckCircle2, ShieldAlert } from 'lucide-react'
import {
  CENSUS_ENTRIES,
  CENSUS_GROUPS,
  DOCUMENT_STATUS_LABELS,
  LEGAL_DOCUMENT_LABELS,
  NOTIFICATION_TYPE_LABELS,
  USER_ROLE_LABELS,
  VEHICLE_DATA_QUERY_STATUS_LABELS,
  deriveUserFlags,
  type CensusGroup,
  type MaintenanceTaskState,
  type UserDetail,
  type UserMaintenanceTask,
  type UserVehicle,
} from '~/lib/users'
import { getAppUser } from '~/fn/users'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { CopyableId } from '~/components/CopyableId'
import { Badge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Separator } from '~/components/ui/separator'
import { formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { ReactNode } from 'react'

export const Route = createFileRoute('/_authed/usuarios/$userId')({
  /**
   * SSR completo. Se llega desde el listado, sí, pero también por link pegado —
   * un uuid en un ticket de soporte es la forma normal de abrir esta pantalla, y
   * ahí es el primer pintado de la sesión.
   */
  loader: async ({ params, abortController }) => {
    const detail = await getAppUser({
      data: params,
      signal: abortController.signal,
    }).catch((cause: unknown) => {
      /**
       * `NOT_FOUND:` se traduce a un 404 de Router; cualquier otro error sube.
       * Tragarlos todos convertiría una caída de Postgres en "este usuario no
       * existe", que es la respuesta equivocada más tranquilizadora posible.
       */
      if (cause instanceof Error && cause.message.startsWith('NOT_FOUND:')) return null
      throw cause
    })

    if (!detail) throw notFound()
    return detail
  },

  head: ({ loaderData }) => ({
    meta: [{ title: loaderData ? `${loaderData.name ?? loaderData.email} — Usuarios` : 'Usuario' }],
  }),

  component: UserDetailScreen,
})

/**
 * El expediente de un usuario.
 *
 * Reemplaza la consulta que NADIE corría: para saber qué tiene alguien había que
 * pegar su uuid en veintipico de `select` sueltos, así que en la práctica se
 * miraba `vehicles`, capaz `conversations`, y nada más.
 *
 * ── El orden de la página es el orden de las preguntas ───────────────────────
 *
 * 1. **Quién es** — identidad, y los dos uuid listos para copiar, porque para
 *    todo lo que el panel no cubre el operador se va a DBeaver.
 * 2. **Qué no cierra** — las contradicciones ya cruzadas. Nadie abre una ficha
 *    de soporte para admirar los números: la abre porque algo no anda.
 * 3. **Qué tiene** — el censo completo de las 29 relaciones, incluso en cero.
 * 4. **El detalle** de lo que se decidió mostrar entero.
 *
 * Solo lectura, entera. Antes de agregar el primer botón que escriba, leer
 * `.claude/rules/ops-write-actions.md`.
 */
function UserDetailScreen() {
  const user = Route.useLoaderData()
  const legacyNative = user.authProvider === 'native'
  const flags = deriveUserFlags(user)

  return (
    <>
      <Link
        to="/usuarios"
        className="mb-3 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Usuarios
      </Link>

      <PageHeader
        title={user.name ?? user.email}
        subtitle={user.name ? user.email : undefined}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      {legacyNative && user.role === 'admin' ? (
        <Notice tone="warn" className="mb-4">
          <div className="text-sm font-medium">Cuenta native heredada</div>
          {/*
            Decía "si alguien migra esta identidad a Clerk, hereda el rol".
            Falso, corregido el 2026-09-04: el backend rechaza la migración por
            los dos caminos de provisioning, y `idx_users_email_unique` impide
            la segunda fila. El problema real es el que dice el texto de abajo.
          */}
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Figura como admin con <Code>auth_provider = native</Code>. No puede entrar
            al panel — el lookup exige <Code>clerk</Code> — y tampoco puede sacar cuenta
            nueva:{' '}
            <strong className="font-medium text-foreground">
              su registro por Clerk falla en silencio
            </strong>{' '}
            porque este email ya está tomado por esta misma fila. El rol admin no se
            hereda solo; para eso haría falta un <Code>UPDATE</Code> manual.
          </p>
        </Notice>
      ) : null}

      {/* ── 1. Quién es ───────────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardContent className="pt-6">
          <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Rol">
              <Badge
                variant="outline"
                className={
                  user.role === 'admin'
                    ? 'border-brand/25 bg-brand-soft text-brand'
                    : 'border-border bg-secondary text-muted-foreground'
                }
              >
                {USER_ROLE_LABELS[user.role]}
              </Badge>
            </Field>

            <Field label="Proveedor de identidad">
              <Code className={cn(legacyNative && 'text-status-yellow')}>
                {user.authProvider}
              </Code>
            </Field>

            <Field label="Teléfono">
              {/*
                El import del legacy_sheet dejó strings vacíos donde no había
                dato, así que "falta" se chequea contra `''` y no sólo contra
                null — la misma razón por la que todo el repo escribe
                `coalesce(x,'') = ''`.
              */}
              {user.phone && user.phone.trim() !== '' ? (
                user.phone
              ) : (
                <Missing>sin teléfono</Missing>
              )}
            </Field>

            <Field label="Alta">
              <span className="tabular-nums">{formatDate(user.createdAt)}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                mod. {formatDate(user.updatedAt)}
              </span>
            </Field>
          </div>

          {/*
            Los dos identificadores van juntos y abajo, separados por una regla.
            No son atributos que se leen: son la carga que se copia, y mezclarlos
            con el rol y el teléfono los perdía entre los datos legibles.
          */}
          <Separator className="my-4" />
          <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            <Field label="id — AutoLibre">
              <CopyableId value={user.id} />
            </Field>
            <Field label={`external_auth_id — ${user.authProvider}`}>
              <CopyableId value={user.externalAuthId} />
            </Field>
          </div>
        </CardContent>
      </Card>

      {/* ── 2. Qué no cierra ──────────────────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Qué no cierra</CardTitle>
          {flags.length > 0 ? (
            <span className="text-xs font-medium text-status-yellow">
              {flags.length} señal(es)
            </span>
          ) : null}
        </CardHeader>
        <CardContent>
          {flags.length === 0 ? (
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-status-green" aria-hidden />
              <p className="text-sm leading-relaxed text-muted-foreground">
                Ninguna contradicción entre los contadores. No quiere decir que el
                usuario no tenga un problema — quiere decir que no es uno de los
                que esta pantalla sabe cruzar.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {flags.map((f) => (
                <li key={f.key} className="flex items-start gap-2.5">
                  <AlertTriangle
                    className="mt-0.5 size-4 shrink-0 text-status-yellow"
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{f.title}</div>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {f.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── 3. Qué tiene ──────────────────────────────────────────────────── */}
      <Census census={user.census} />

      {/* ── 4. El detalle ─────────────────────────────────────────────────── */}
      <div className="mt-4 grid items-start gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Vehicles vehicles={user.vehicles} />
        </div>
        <div className="grid gap-4 lg:col-span-2">
          <Legal user={user} />
          <Licenses user={user} />
          <Notifications user={user} />
          <OwnedPartners user={user} />
        </div>
      </div>

      <div className="mt-4">
        <Tasks tasks={user.tasks} />
      </div>
    </>
  )
}

// ── Censo ────────────────────────────────────────────────────────────────────

/**
 * Las 29 relaciones alcanzables desde el usuario.
 *
 * ── Por qué son filas y no tarjetas ──────────────────────────────────────────
 *
 * La primera versión eran 29 cajas iguales en una grilla. Se veía prolijo y era
 * ilegible: veintinueve rectángulos del mismo tamaño y el mismo peso no tienen
 * jerarquía, así que el ojo no encuentra ni el número grande ni el cero — que
 * son las dos cosas que se vienen a buscar. Además eran tarjetas adentro de una
 * tarjeta, que es siempre un error.
 *
 * Ahora son filas densas agrupadas: el peso tipográfico separa "tiene" de "no
 * tiene", el contador del grupo (`5 / 6`) da el resumen sin leer una sola fila, y
 * la densidad es la que un panel de operación se puede permitir.
 *
 * ── Por qué el nombre de la tabla se muestra y el `via` casi nunca ───────────
 *
 * La tabla se muestra siempre: cuando un número no cierra, ese nombre es todo lo
 * que hace falta para reproducir la cuenta en DBeaver. El `via`, en cambio, es
 * `user_id` en 24 de las 29 — repetirlo 24 veces es ruido que tapa a las 5 que
 * importan. Se muestra sólo cuando NO es el camino obvio.
 */
function Census({ census }: { census: UserDetail['census'] }) {
  const total = CENSUS_ENTRIES.reduce((sum, e) => sum + census[e.key], 0)
  const withData = CENSUS_ENTRIES.filter((e) => census[e.key] > 0).length

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Todo lo que tiene</CardTitle>
        <span className="text-xs text-muted-foreground">
          <strong className="font-semibold text-foreground tabular-nums">{withData}</strong> de{' '}
          {CENSUS_ENTRIES.length} relaciones con datos ·{' '}
          <span className="tabular-nums">{formatInt(total)}</span> filas
        </span>
      </CardHeader>

      <CardContent>
        <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-3">
          {CENSUS_GROUPS.map((group) => (
            <CensusGroupBlock key={group} group={group} census={census} />
          ))}
        </div>

        <p className="mt-6 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
          Son {CENSUS_ENTRIES.length} y no 42 a propósito: <Code>users</Code> tiene 24
          FKs entrantes y <Code>vehicles</Code> otras 18, pero 15 de esas 18 también
          cuelgan de <Code>users</Code> por <Code>user_id</Code>. Contarlas por los dos
          caminos las duplicaría sin agregar una fila real.
        </p>
      </CardContent>
    </Card>
  )
}

function CensusGroupBlock({
  group,
  census,
}: {
  group: CensusGroup
  census: UserDetail['census']
}) {
  const entries = CENSUS_ENTRIES.filter((e) => e.group === group)
  const withData = entries.filter((e) => census[e.key] > 0).length

  return (
    <section>
      <header className="mb-1.5 flex items-baseline justify-between gap-2 border-b border-border pb-1.5">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {group}
        </h3>
        <span
          className={cn(
            'shrink-0 text-xs tabular-nums',
            withData === 0 ? 'text-muted-foreground/60' : 'text-muted-foreground',
          )}
        >
          {withData}/{entries.length}
        </span>
      </header>

      <ul>
        {entries.map((entry) => {
          const count = census[entry.key]
          const empty = count === 0

          return (
            <li
              key={entry.key}
              className="flex items-baseline gap-3 border-b border-border/50 py-1.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className={cn('truncate text-sm', empty && 'text-muted-foreground')}>
                  {entry.label}
                </div>
                <div className="truncate text-[10px] leading-tight text-muted-foreground/70">
                  <code className="font-mono">{entry.table}</code>
                  {/* 24 de 29 son `user_id`. Repetirlo taparía a las 5 que no lo son. */}
                  {entry.via !== 'user_id' ? ` · por ${entry.via}` : null}
                </div>
              </div>

              <span
                className={cn(
                  'shrink-0 tabular-nums',
                  empty
                    ? 'text-sm text-muted-foreground/50'
                    : 'text-sm font-semibold text-foreground',
                )}
              >
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

function Vehicles({ vehicles }: { vehicles: Array<UserVehicle> }) {
  const active = vehicles.filter((v) => !v.archived).length

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between space-y-0">
        <CardTitle className="text-base">Vehículos</CardTitle>
        <span className="text-xs text-muted-foreground">
          {vehicles.length === 0
            ? 'ninguno'
            : `${formatInt(active)} activo(s) de ${formatInt(vehicles.length)}`}
        </span>
      </CardHeader>
      <CardContent>
        {vehicles.length === 0 ? (
          <Empty>
            Sin vehículos cargados. En una cuenta con actividad esto es el síntoma,
            no el estado: casi toda la app cuelga del vehículo.
          </Empty>
        ) : (
          <ul className="divide-y divide-border">
            {vehicles.map((v) => (
              <li
                key={v.id}
                className={cn('py-3 first:pt-0 last:pb-0', v.archived && 'opacity-60')}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <div className="flex items-center gap-2">
                    <Car className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {/*
                      La patente es el identificador que el operador tipea en
                      cualquier otro sistema. Va en mono y con tracking: siete
                      caracteres alfanuméricos en la tipografía de texto se leen
                      mal, y confundir un 0 con una O manda a consultar otro auto.
                    */}
                    <span className="font-mono text-sm font-semibold tracking-wider">
                      {v.plate}
                    </span>
                    {v.alias ? (
                      <span className="text-sm text-muted-foreground">«{v.alias}»</span>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-2">
                    {v.odometerValue === 0 ? (
                      <Badge
                        variant="outline"
                        className="border-status-yellow/30 bg-status-yellow-bg text-status-yellow"
                      >
                        sin odómetro
                      </Badge>
                    ) : (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {formatInt(v.odometerValue)} km
                      </span>
                    )}
                    {v.archived ? (
                      <Badge
                        variant="outline"
                        className="border-border bg-secondary text-muted-foreground"
                      >
                        Archivado
                      </Badge>
                    ) : null}
                  </div>
                </div>

                <div className="mt-1 text-sm">
                  {v.brand} {v.model} <span className="tabular-nums">{v.year}</span>
                </div>

                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span>{v.trim}</span>
                  <Dot />
                  <span>{v.color}</span>
                  <Dot />
                  <span>{v.vehicleType}</span>
                  {v.fuelType ? (
                    <>
                      <Dot />
                      <span>{v.fuelType}</span>
                    </>
                  ) : null}
                  {v.transmission ? (
                    <>
                      <Dot />
                      <span>{v.transmission}</span>
                    </>
                  ) : null}
                </div>

                <VehicleTramites vehicle={v} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Los cuatro trámites de este auto, en una fila de chips.
 *
 * Dos preguntas DISTINTAS conviven acá y hay que no confundirlas:
 *
 *  - **VTV y multas** son la CONSULTA automática contra el proveedor —
 *    `vehicle_data_queries` y `vehicle_fine_syncs`. Un chip gris no dice "está
 *    mal", dice "nunca se pidió". No es lo mismo que el disco de VTV cargado
 *    (eso ya está en «Todo lo que tiene», tabla `vehicle_inspections`).
 *  - **Seguro y cédula** son el DOCUMENTO cargado — presencia, no consulta.
 *
 * Mezclar las dos categorías en una sola fila fue deliberado: son las cuatro
 * preguntas que un operador de soporte hace en el mismo orden cuando alguien
 * llama por un trámite.
 */
function VehicleTramites({ vehicle: v }: { vehicle: UserVehicle }) {
  const vtvWhen = v.vtvQueryCompletedAt ?? v.vtvQueryCreatedAt
  const vtvLabel = v.vtvQueryStatus ? (VEHICLE_DATA_QUERY_STATUS_LABELS[v.vtvQueryStatus] ?? v.vtvQueryStatus) : null

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      <TramiteChip
        label="VTV"
        state={v.vtvQueryStatus === null ? 'missing' : v.vtvQueryStatus === 'completed' ? 'ok' : 'warn'}
        detail={
          v.vtvQueryStatus === null
            ? 'nunca se consultó'
            : `${vtvLabel}${vtvWhen ? ` · ${formatDate(vtvWhen)}` : ''}`
        }
      />

      <TramiteChip
        label="Multas"
        state={v.finesSyncedAt === null ? 'missing' : v.finesCount > 0 ? 'warn' : 'ok'}
        detail={
          v.finesSyncedAt === null
            ? 'nunca se consultaron'
            : v.finesCount > 0
              ? `${formatInt(v.finesCount)} encontrada(s) · ${formatDate(v.finesSyncedAt)}`
              : `sin multas · consultado ${formatDate(v.finesSyncedAt)}`
        }
      />

      <TramiteChip
        label="Seguro"
        state={
          v.insuranceStatus === null ? 'missing' : v.insuranceStatus === 'active' ? 'ok' : 'warn'
        }
        detail={
          v.insuranceStatus === null || !v.insuranceExpiresAt
            ? 'no cargado'
            : `${DOCUMENT_STATUS_LABELS[v.insuranceStatus] ?? v.insuranceStatus} · vence ${formatDate(v.insuranceExpiresAt)}`
        }
      />

      <TramiteChip
        label="Cédula"
        state={v.registrationCardLoadedAt === null ? 'missing' : 'ok'}
        detail={
          v.registrationCardLoadedAt === null
            ? 'no cargada'
            : `cargada ${formatDate(v.registrationCardLoadedAt)}`
        }
      />
    </div>
  )
}

function TramiteChip({
  label,
  state,
  detail,
}: {
  label: string
  state: 'ok' | 'warn' | 'missing'
  detail: string
}) {
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

function Legal({ user }: { user: UserDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Consentimientos legales</CardTitle>
      </CardHeader>
      <CardContent>
        {user.legalAcceptances.length === 0 ? (
          <Empty>
            No aceptó ningún documento. Si la cuenta tiene actividad, alguien entró
            sin pasar por el gate legal — eso se mira, no se asume.
          </Empty>
        ) : (
          <ul className="space-y-2">
            {user.legalAcceptances.map((a) => (
              <li
                key={`${a.document}-${a.version}`}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm"
              >
                <span>{LEGAL_DOCUMENT_LABELS[a.document] ?? a.document}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  v{a.version} · {formatDate(a.acceptedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * "El registro" — la licencia de conducir. A diferencia de `OwnedPartners`
 * (donde el cero es normal para el 99% de los usuarios y por eso se esconde),
 * acá el cero SÍ se muestra: es exactamente la pregunta "¿cargaron su
 * registro o no?", y una tarjeta que desaparece no la contesta.
 */
function Licenses({ user }: { user: UserDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Licencia de conducir</CardTitle>
      </CardHeader>
      <CardContent>
        {user.driverLicenses.length === 0 ? (
          <Missing>sin registro cargado</Missing>
        ) : (
          <ul className="space-y-3">
            {user.driverLicenses.map((l) => (
              <li key={l.id} className={cn('text-sm', l.archived && 'opacity-60')}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono font-medium tracking-wide">{l.licenseNumber}</span>
                  <Badge
                    variant="outline"
                    className={
                      l.status === 'active'
                        ? 'border-status-green/20 bg-status-green-bg text-status-green'
                        : 'border-status-red/20 bg-status-red-bg text-status-red'
                    }
                  >
                    {DOCUMENT_STATUS_LABELS[l.status] ?? l.status}
                  </Badge>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {l.category ? `Categoría ${l.category} · ` : ''}
                  vence <span className="tabular-nums">{formatDate(l.expirationDate)}</span>
                  {l.archived ? ' · archivada' : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function Notifications({ user }: { user: UserDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Notificaciones</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/*
          Las dos mitades van JUNTAS y no en tarjetas separadas: el diagnóstico
          está en cruzarlas. El aviso de "pidió y no le llega" ya vive arriba en
          «Qué no cierra» — acá quedan los datos crudos que lo sustentan, y no se
          repite el texto: decir lo mismo dos veces en la misma pantalla enseña a
          ignorar las dos.
        */}
        <div>
          <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Dispositivos
          </h4>
          {user.pushTokens.length === 0 ? (
            <Missing>ningún token push registrado</Missing>
          ) : (
            <ul className="space-y-1 text-sm">
              {user.pushTokens.map((t) => (
                <li key={t.id} className="flex items-baseline justify-between gap-2">
                  {/*
                    El token en sí NO se muestra. Es una credencial de envío: con
                    ella se le puede mandar un push a esa persona desde afuera de
                    AutoLibre. La plataforma y el device alcanzan para el
                    diagnóstico, y son los datos que no comprometen a nadie.
                  */}
                  <span>{t.platform ?? 'plataforma desconocida'}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {t.deviceId ? `${t.deviceId.slice(0, 8)}… · ` : ''}
                    {formatDate(t.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Separator />

        <div>
          <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Preferencias
          </h4>
          {user.notificationPreferences.length === 0 ? (
            <Missing>sin preferencias cargadas</Missing>
          ) : (
            <ul className="space-y-1 text-sm">
              {user.notificationPreferences.map((p) => (
                <li
                  key={`${p.notificationType}-${p.channel}`}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span>
                    {NOTIFICATION_TYPE_LABELS[p.notificationType] ?? p.notificationType}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{p.channel}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Sólo aparece si el usuario administra algún partner. Es la excepción a mostrar
 * el cero: acá el cero es lo normal —el 99% de los usuarios no tiene taller— y el
 * censo de arriba ya lo dice en `partners`.
 */
function OwnedPartners({ user }: { user: UserDetail }) {
  if (user.ownedPartners.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Partners que administra</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {user.ownedPartners.map((p) => (
            <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-2">
              <Link
                to="/partners/$partnerId"
                params={{ partnerId: p.id }}
                className="rounded text-sm font-medium outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {p.name}
              </Link>
              <span className="text-xs text-muted-foreground">
                {p.coverageZone} · {p.status}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

/**
 * Las tareas de mantenimiento — `maintenance_occurrences` de todos sus
 * vehículos. Reemplaza "pasadas y futuras" como el pedido las nombró, pero la
 * base tiene un tercer caso que ese vocabulario no cubre: una tarea sin
 * `due_date` ni `performed_at` (10 de 51 al 2026-09-04). Esconderla sería
 * mentir por omisión, así que entra en «Pendientes» con su propia etiqueta.
 *
 * Y separado adentro de «Pendientes»: una vencida (`due_date` ya pasado y
 * nadie la marcó hecha) es la que un operador necesita ver primero, y es
 * exactamente el tipo de señal que no avisa sola — misma familia que `stuck`
 * en `/operacion`.
 */
function Tasks({ tasks }: { tasks: Array<UserMaintenanceTask> }) {
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

  // Ya vienen ordenadas por `performed_at desc` desde el SQL.
  const done = tasks.filter((t) => t.state === 'done')

  const overdueCount = pending.filter((t) => t.state === 'overdue').length

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Tareas de mantenimiento</CardTitle>
        <span className="text-xs text-muted-foreground">
          <span className="tabular-nums">{formatInt(pending.length)}</span> pendiente(s) ·{' '}
          <span className="tabular-nums">{formatInt(done.length)}</span> realizada(s)
        </span>
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <Empty>Sin tareas de mantenimiento cargadas, ni pendientes ni realizadas.</Empty>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <h4 className="mb-2 flex flex-wrap items-baseline gap-x-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <span>Pendientes (futuras)</span>
                {overdueCount > 0 ? (
                  <span className="normal-case tracking-normal text-status-yellow">
                    {formatInt(overdueCount)} vencida(s)
                  </span>
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
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Realizadas (pasadas)
              </h4>
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

function TaskRow({ task: t }: { task: UserMaintenanceTask }) {
  return (
    <li className={cn('text-sm', t.archived && 'opacity-60')}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="font-medium">{t.name}</span>
        <TaskStateTag task={t} />
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="font-mono tracking-wide">{t.vehiclePlate}</span>
        <Dot />
        <span>{t.itemType.replaceAll('_', ' ')}</span>
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

function TaskStateTag({ task: t }: { task: UserMaintenanceTask }) {
  if (t.state === 'overdue') {
    return (
      <Badge
        variant="outline"
        className="shrink-0 border-status-yellow/30 bg-status-yellow-bg text-status-yellow"
      >
        vencida{t.dueDate ? ` · ${formatDate(t.dueDate)}` : ''}
      </Badge>
    )
  }

  if (t.state === 'undated') {
    return <span className="shrink-0 text-xs text-muted-foreground/60">sin fecha</span>
  }

  const when = t.state === 'done' ? t.performedAt : t.dueDate
  return (
    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
      {when ? formatDate(when) : ''}
    </span>
  )
}

// ── Piezas chicas ────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  )
}

/**
 * Un valor literal de la base — un enum, un nombre de columna, un identificador.
 * Se distingue del texto en prosa porque es lo que se tipea en otro lado tal
 * cual, sin traducir.
 */
function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        'rounded bg-secondary px-1 py-0.5 font-mono text-[0.85em] text-foreground',
        className,
      )}
    >
      {children}
    </code>
  )
}

/** Separador de metadatos en línea. `aria-hidden` porque no se lee. */
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

/** Aviso de bloque. Un solo tono por ahora; se amplía cuando haga falta otro. */
function Notice({
  tone,
  className,
  children,
}: {
  tone: 'warn'
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-md border p-3',
        tone === 'warn' && 'border-status-yellow/30 bg-status-yellow-bg',
        className,
      )}
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-status-yellow" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  )
}
