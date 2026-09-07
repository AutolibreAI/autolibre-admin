import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown, ShieldAlert } from 'lucide-react'
import {
  USER_LICENSE_FILTERS,
  USER_ROLE_FILTERS,
  USER_ROLE_LABELS,
  USER_VEHICLE_FILTERS,
  VEHICLE_DATA_QUERY_STATUS_LABELS,
  userSearchSchema,
  type UserLicenseFilter,
  type UserListItem,
  type UserRoleFilter,
  type UserSearch,
  type UserSortKey,
  type UserVehicleFilter,
  type UserVehicleSummary,
} from '~/lib/users'
import { getUserVehicleSummaries, listAppUsers } from '~/fn/users'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { Badge } from '~/components/ui/badge'
import { Input } from '~/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { CountOrNeverCell, ExpiryCell, FineDebtCell } from '~/components/VehicleCells'
import { formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

export const Route = createFileRoute('/_authed/usuarios/')({
  /**
   * SSR completo (el default de `start.ts`), y es deliberado: ésta es una
   * pantalla de ENTRADA. Se llega buscando a alguien por email —
   * `/usuarios?q=…` pegado en un ticket de soporte— así que suele ser el primer
   * pintado de la sesión, donde `data-only` te deja mirando el shell vacío
   * mientras baja el bundle.
   */
  validateSearch: userSearchSchema,
  loaderDeps: ({ search }) => search,

  loader: ({ deps, abortController }) =>
    listAppUsers({ data: deps, signal: abortController.signal }),

  head: () => ({ meta: [{ title: 'Usuarios — AutoLibre' }] }),
  component: UsersList,
})

const ROLE_FILTER_LABELS: Record<UserRoleFilter, string> = {
  all: 'Todos',
  user: 'Usuarios',
  admin: 'Admins',
  provider: 'Provider (legacy)',
}

const VEHICLE_FILTER_LABELS: Record<UserVehicleFilter, string> = {
  all: 'Todos',
  yes: 'Con vehículos',
  no: 'Sin vehículos',
}

const LICENSE_FILTER_LABELS: Record<UserLicenseFilter, string> = {
  all: 'Todos',
  valid: 'Vigente',
  expired: 'Vencido',
  missing: 'Sin cargar',
}

/**
 * El listado de usuarios.
 *
 * Reemplaza el `select * from users where email ilike '%…%'` que hoy se corre en
 * DBeaver cada vez que llega un reclamo por soporte, y le agrega las dos
 * columnas que en ese select no están y hay que ir a buscar aparte: cuántos
 * vehículos tiene y cuándo fue la última vez que hizo algo.
 *
 * El orden por defecto es por alta descendente. Los que se registraron recién
 * son los que más se consultan (onboarding roto, mail que no llegó), y son
 * también los que un orden alfabético esconde para siempre.
 */
/**
 * El estado del panel por fila: nunca pedido, pidiéndose, o resuelto (con
 * datos o con error). Es un `Record` en memoria del componente y NO search
 * params — a diferencia del resto de los filtros de esta pantalla, abrir una
 * fila no es un estado que valga la pena compartir por URL, y guardarlo ahí
 * obligaría a validar una lista de uuids en cada carga por algo que dura un
 * click.
 */
type VehicleSummaryState =
  | { status: 'loading' }
  | { status: 'ok'; vehicles: Array<UserVehicleSummary> }
  | { status: 'error' }

function UsersList() {
  const users = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true })

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [summaries, setSummaries] = useState<Record<string, VehicleSummaryState>>({})

  /**
   * Pide el detalle SÓLO la primera vez que se abre una fila — es la razón de
   * ser de este endpoint aparte: no está en el `loader`, así que 499 usuarios
   * que nadie despliega nunca pagan el costo de esta consulta.
   */
  const toggleRow = (userId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })

    if (summaries[userId]) return

    setSummaries((prev) => ({ ...prev, [userId]: { status: 'loading' } }))
    getUserVehicleSummaries({ data: { userId } })
      .then((vehicles) => {
        setSummaries((prev) => ({ ...prev, [userId]: { status: 'ok', vehicles } }))
      })
      .catch(() => {
        setSummaries((prev) => ({ ...prev, [userId]: { status: 'error' } }))
      })
  }

  /**
   * El riesgo abierto del CLAUDE.md, calculado y no recordado.
   *
   * La regla del repo es explícita: si un número de la base aparece en un `.md`,
   * es porque todavía no tiene pantalla. Éste ya la tiene — se cuenta contra la
   * base a la que el panel esté conectado, sea cual sea.
   */
  const legacyNativeAdmins = users.filter(
    (u) => u.authProvider === 'native' && u.role === 'admin',
  ).length

  const filtered =
    search.q ||
    search.role !== 'all' ||
    search.onlyLegacyNative ||
    search.hasVehicles !== 'all' ||
    search.onlyScanFailures ||
    search.onlyNeverActive ||
    search.license !== 'all'

  return (
    <>
      <PageHeader
        title="Usuarios"
        subtitle={`${formatInt(users.length)} ${filtered ? 'con este filtro' : 'en total'}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      {/*
        El aviso aparece sólo cuando hay algo que avisar Y el filtro no está
        puesto. Con el filtro activo el chip ya muestra el estado, y repetir el
        banner arriba sería decir lo mismo dos veces en la misma pantalla.
      */}
      {legacyNativeAdmins > 0 && !search.onlyLegacyNative ? (
        <div className="mb-4 flex items-start gap-3 rounded-md border border-status-yellow/30 bg-status-yellow-bg p-3">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-status-yellow" aria-hidden />
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {formatInt(legacyNativeAdmins)} admin(s) con{' '}
              <code className="rounded bg-surface px-1 py-0.5 font-mono text-[0.85em]">
                auth_provider = native
              </code>
            </div>
            {/*
              Esta copia decía "el día que alguien migre una cuenta a Clerk,
              hereda admin". Era falso y se corrigió el 2026-09-04: los dos
              caminos de provisioning del backend rechazan en vez de migrar, y
              `idx_users_email_unique` impide la segunda fila. El problema real
              es el opuesto, y es el que se describe acá.
            */}
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              No pueden entrar al panel: el lookup de sesión está acotado a{' '}
              <code className="font-mono">clerk</code>. Y tampoco pueden sacar
              cuenta nueva —{' '}
              <strong className="font-medium text-foreground">
                su registro por Clerk falla en silencio
              </strong>
              , porque el email ya está tomado por la fila native. Quedan con
              sesión de Clerk y sin usuario de AutoLibre. El arreglo es una
              auditoría de datos del lado del backend.
            </p>
            <button
              type="button"
              onClick={() => setSearch({ onlyLegacyNative: true })}
              className="mt-1.5 rounded text-xs font-medium text-foreground underline underline-offset-2 outline-none hover:text-status-yellow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Ver solo los native
            </button>
          </div>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-end gap-5">
        <div className="w-full space-y-1.5 sm:w-auto">
          <label
            htmlFor="q"
            className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            Buscar
          </label>
          <Input
            id="q"
            type="search"
            placeholder="Email o nombre"
            defaultValue={search.q ?? ''}
            className="w-full sm:w-64"
            onChange={(e) => {
              const value = e.currentTarget.value.trim()
              setSearch({ q: value === '' ? undefined : value })
            }}
          />
        </div>

        <FilterGroup label="Rol">
          {USER_ROLE_FILTERS.map((role) => (
            <Chip key={role} active={search.role === role} onClick={() => setSearch({ role })}>
              {ROLE_FILTER_LABELS[role]}
            </Chip>
          ))}
        </FilterGroup>

        {/*
          Tono `warn` y no el verde de marca: este filtro acota a filas
          PROBLEMÁTICAS. En verde diría "seleccionado y todo bien", que es lo
          contrario de lo que significa.
        */}
        <FilterGroup label="Auditoría">
          <Chip
            tone="warn"
            active={search.onlyLegacyNative}
            onClick={() => setSearch({ onlyLegacyNative: !search.onlyLegacyNative })}
          >
            <ShieldAlert className="size-3.5" aria-hidden />
            Solo native
          </Chip>
        </FilterGroup>

        <FilterGroup label="Vehículos">
          {USER_VEHICLE_FILTERS.map((v) => (
            <Chip key={v} active={search.hasVehicles === v} onClick={() => setSearch({ hasVehicles: v })}>
              {VEHICLE_FILTER_LABELS[v]}
            </Chip>
          ))}
        </FilterGroup>

        {/*
          Mismo criterio de tono que «Auditoría»: acota a fallas, no a un
          estado neutro. Nunca escaneó no entra acá — no es un problema, es
          la mayoría de la base.
        */}
        <FilterGroup label="Escaneos">
          <Chip
            tone="warn"
            active={search.onlyScanFailures}
            onClick={() => setSearch({ onlyScanFailures: !search.onlyScanFailures })}
          >
            Sólo fallidos
          </Chip>
        </FilterGroup>

        <FilterGroup label="Actividad">
          <Chip
            active={search.onlyNeverActive}
            onClick={() => setSearch({ onlyNeverActive: !search.onlyNeverActive })}
          >
            Nunca activos
          </Chip>
        </FilterGroup>

        <FilterGroup label="Registro">
          {USER_LICENSE_FILTERS.map((l) => (
            <Chip
              key={l}
              tone={l === 'expired' ? 'warn' : 'brand'}
              active={search.license === l}
              onClick={() => setSearch({ license: l })}
            >
              {LICENSE_FILTER_LABELS[l]}
            </Chip>
          ))}
        </FilterGroup>
      </div>

      {users.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-6 py-16 text-center">
          <p className="text-sm font-medium">Ningún usuario con este filtro</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
            {search.onlyLegacyNative
              ? 'No hay cuentas native en esta base. Es lo que se quiere ver: el riesgo de admins heredados acá no existe.'
              : 'Probá con parte del email — la búsqueda es por coincidencia parcial, no por igualdad.'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <SortableHeader label="Usuario" sortKey="name" search={search} />
                <SortableHeader label="Rol" sortKey="role" search={search} />
                <SortableHeader label="Vehículos" sortKey="vehicles" search={search} align="right" />
                <SortableHeader label="Escaneos" sortKey="scans" search={search} align="right" />
                <SortableHeader label="Alta" sortKey="createdAt" search={search} />
                <SortableHeader label="Última actividad" sortKey="lastActivity" search={search} />
                <SortableHeader label="Registro" sortKey="license" search={search} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <Row
                  key={u.id}
                  user={u}
                  expanded={expanded.has(u.id)}
                  onToggle={() => toggleRow(u.id)}
                  vehicleState={summaries[u.id]}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {users.length === 500 ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Cortado en 500 filas. Afiná la búsqueda — el listado no pagina a
          propósito: paginar sin buscar es hojear un padrón, y nadie encuentra a
          nadie así.
        </p>
      ) : null}
    </>
  )
}

function Row({
  user,
  expanded,
  onToggle,
  vehicleState,
}: {
  user: UserListItem
  expanded: boolean
  onToggle: () => void
  vehicleState: VehicleSummaryState | undefined
}) {
  const legacyNative = user.authProvider === 'native'

  return (
    <>
      <TableRow className={cn(legacyNative && user.role === 'admin' && 'bg-status-yellow-bg/40')}>
        <TableCell className="pr-0">
          {/*
            Sin toggle cuando no hay ningún vehículo: desplegar una tabla
            vacía no informa nada que `Vehículos: 0` no diga ya, y un botón
            que abre a la nada entrena a no confiar en el resto.
          */}
          {user.vehicleCount > 0 ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-label={expanded ? 'Ocultar vehículos' : 'Ver vehículos'}
              className="flex size-6 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {expanded ? (
                <ChevronDown className="size-4" aria-hidden />
              ) : (
                <ChevronRight className="size-4" aria-hidden />
              )}
            </button>
          ) : null}
        </TableCell>
        <TableCell>
          <Link
            to="/usuarios/$userId"
            params={{ userId: user.id }}
            className="rounded font-medium outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {/* El nombre es nullable; el email no. El fallback es el dato que siempre está. */}
            {user.name ?? user.email}
          </Link>
          {user.name ? <div className="text-xs text-muted-foreground">{user.email}</div> : null}
        </TableCell>

        <TableCell>
          {/*
            La columna «Identidad» se eliminó y `native` vive acá, al lado del rol.
            El motivo es el mismo que en el censo: 68 de 72 filas dicen `clerk`, así
            que una columna entera repitiéndolo tapa a las cuatro que no. Y el
            cruce que importa —native + admin— sólo se ve si los dos datos están
            juntos.
          */}
          <div className="flex flex-wrap items-center gap-1.5">
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
            {legacyNative ? (
              <span
                className="font-mono text-[10px] font-medium uppercase tracking-wider text-status-yellow"
                title="auth_provider = native"
              >
                native
              </span>
            ) : null}
          </div>
        </TableCell>

        <TableCell className="text-right tabular-nums">
          {user.vehicleCount === 0 ? (
            <span className="text-muted-foreground/50">0</span>
          ) : (
            user.vehicleCount
          )}
        </TableCell>

        {/*
          Escaneos: los que TRAJERON DATOS sobre los intentados.

          El denominador no es adorno. Al 2026-09-04, 6 de las 17 sesiones de la
          base quedaron `completed` con cero lecturas y cero minutos: el escáner
          nunca enganchó. Mostrar sólo el total presentaría esos fracasos como
          uso, y el usuario con "4 escaneos" que en realidad son 4 fracasos es
          justamente el que va a llamar a soporte.

          Cuando ninguno sirvió se pinta ámbar. No rojo: el problema puede ser el
          escáner del usuario y no la app, y esta pantalla no sabe cuál de los dos.
        */}
        <TableCell className="text-right tabular-nums">
          {user.scansTotal === 0 ? (
            <span className="text-muted-foreground/50" title="Nunca usó el escáner">
              —
            </span>
          ) : (
            <span
              className={cn(user.scansOk === 0 && 'text-status-yellow')}
              title={
                user.scansOk === 0
                  ? `${user.scansTotal} ${user.scansTotal === 1 ? 'intento' : 'intentos'}, ninguno trajo datos`
                  : `${user.scansOk} de ${user.scansTotal} trajeron datos`
              }
            >
              {user.scansOk}
              <span className="text-muted-foreground"> / {user.scansTotal}</span>
            </span>
          )}
        </TableCell>

        <TableCell className="tabular-nums text-muted-foreground">
          {formatDate(user.createdAt)}
        </TableCell>

        <TableCell className="tabular-nums text-muted-foreground">
          {/*
            `null` NO es "hace mucho": es "se registró y no hizo nada más". Un texto
            los distingue de un usuario activo cuya última señal es vieja — una
            fecha vieja y ninguna fecha son diagnósticos distintos.
          */}
          {user.lastActivityAt ? (
            formatDate(user.lastActivityAt)
          ) : (
            <span className="text-xs text-muted-foreground/70">sin actividad</span>
          )}
        </TableCell>

        <TableCell className="tabular-nums">
          <LicenseCell
            expiresAt={user.driverLicenseExpiresAt}
            days={user.driverLicenseDaysUntilExpiration}
          />
        </TableCell>
      </TableRow>

      {expanded ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={8} className="whitespace-normal bg-canvas p-0">
            <VehicleSummaryPanel state={vehicleState} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}

/**
 * "Registro" — la licencia de conducir del USUARIO, no del auto (por eso vive
 * en el listado principal y no en el toggle de vehículos). `days` viene
 * PRECALCULADO por Postgres (`listUsers` en `users.repo.ts`): esta pantalla
 * es SSR completo, así que restar contra `new Date()` acá adentro arriesgaría
 * un mismatch de hidratación si el render de servidor y el de cliente caen a
 * los dos lados de una medianoche UTC.
 */
function LicenseCell({ expiresAt, days }: { expiresAt: string | null; days: number | null }) {
  if (!expiresAt || days === null) {
    return <span className="text-xs text-muted-foreground/70">sin cargar</span>
  }

  if (days < 0) {
    return (
      <span className="text-sm text-status-yellow" title={formatDate(expiresAt)}>
        vencido hace {formatInt(Math.abs(days))} día{Math.abs(days) === 1 ? '' : 's'}
      </span>
    )
  }

  if (days === 0) {
    return (
      <span className="text-sm text-status-yellow" title={formatDate(expiresAt)}>
        vence hoy
      </span>
    )
  }

  return (
    <span className="text-sm text-muted-foreground" title={formatDate(expiresAt)}>
      vence en {formatInt(days)} día{days === 1 ? '' : 's'}
    </span>
  )
}

/**
 * Los headers de orden son links, no botones: el orden ES la URL, así que
 * tiene que ser navegable, clickeable con el botón del medio y compartible —
 * misma regla que ya vale para `sort` en cualquier listado del panel.
 * Clickear el mismo header invierte la dirección; clickear otro arranca en
 * `asc`.
 */
function SortableHeader({
  label,
  sortKey,
  search,
  align,
}: {
  label: string
  sortKey: UserSortKey
  search: UserSearch
  align?: 'right'
}) {
  const active = search.sort === sortKey
  const nextDir = active && search.dir === 'asc' ? 'desc' : 'asc'

  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <Link
        to="/usuarios"
        search={(prev) => ({ ...prev, sort: sortKey, dir: nextDir })}
        replace
        className={cn(
          'inline-flex items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
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

// ── El panel por vehículo, adentro de la fila ───────────────────────────────

/**
 * "Qué está haciendo" con cada auto — no "qué trámites tiene" (eso es la
 * ficha, `/usuarios/:id`). Se renderiza SOLO del lado del cliente: nace de un
 * click, nunca de SSR, así que las cuentas de "días hasta vencer" que hacen
 * `ExpiryCell` y compañía usan `new Date()` sin ningún riesgo de mismatch de
 * hidratación — no hay HTML de servidor con el que compararse.
 */
function VehicleSummaryPanel({ state }: { state: VehicleSummaryState | undefined }) {
  if (!state || state.status === 'loading') {
    return <p className="px-4 py-3 text-sm text-muted-foreground">Cargando vehículos…</p>
  }

  if (state.status === 'error') {
    return (
      <p className="px-4 py-3 text-sm text-status-yellow">
        No se pudo traer el detalle de los vehículos. Cerrá y volvé a abrir la fila para reintentar.
      </p>
    )
  }

  if (state.vehicles.length === 0) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">Sin vehículos.</p>
  }

  return (
    <div className="overflow-x-auto p-3">
      <table className="w-full min-w-[1400px] text-xs">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="px-2 py-1.5 text-left font-medium">Vehículo</th>
            <th className="px-2 py-1.5 text-left font-medium">VTV</th>
            <th className="px-2 py-1.5 text-right font-medium">Chats IA diagnóstico</th>
            <th className="px-2 py-1.5 text-left font-medium">Deuda de patente</th>
            <th className="px-2 py-1.5 text-left font-medium">Multas consultadas</th>
            <th className="px-2 py-1.5 text-right font-medium">Monto adeudado</th>
            <th className="px-2 py-1.5 text-left font-medium">Seguro</th>
            <th className="px-2 py-1.5 text-right font-medium">Escaneos</th>
            <th className="px-2 py-1.5 text-right font-medium">DTCs activos</th>
            <th className="px-2 py-1.5 text-right font-medium">Tareas pasadas</th>
            <th className="px-2 py-1.5 text-right font-medium">Tareas pendientes</th>
            <th className="px-2 py-1.5 text-right font-medium">Anomalías activas</th>
          </tr>
        </thead>
        <tbody>
          {state.vehicles.map((v) => (
            <VehicleSummaryTableRow key={v.id} vehicle={v} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function VehicleSummaryTableRow({ vehicle: v }: { vehicle: UserVehicleSummary }) {
  return (
    <tr className={cn('border-b border-border/50 last:border-b-0', v.archived && 'opacity-60')}>
      <td className="px-2 py-1.5">
        <span className="font-mono font-semibold tracking-wider">{v.plate}</span>
        <div className="text-muted-foreground">
          {v.brand} {v.model} <span className="tabular-nums">{v.year}</span>
        </div>
      </td>

      <td className="px-2 py-1.5">
        <ExpiryCell iso={v.vtvExpiresAt} />
      </td>

      <td className="px-2 py-1.5 text-right tabular-nums">
        {v.diagnosticChatCount === 0 ? (
          <span className="text-muted-foreground/50">0</span>
        ) : (
          formatInt(v.diagnosticChatCount)
        )}
      </td>

      <td className="px-2 py-1.5">
        <LastQueryCell status={v.taxDebtQueryStatus} at={v.taxDebtQueryAt} />
      </td>

      <td className="px-2 py-1.5">
        {v.fineQueryAt ? (
          formatDate(v.fineQueryAt)
        ) : (
          <span className="text-muted-foreground/50">nunca</span>
        )}
      </td>

      <td className="px-2 py-1.5 text-right tabular-nums">
        <FineDebtCell amount={v.fineDebtAmount} />
      </td>

      <td className="px-2 py-1.5">
        <ExpiryCell iso={v.insuranceExpiresAt} />
      </td>

      <td className="px-2 py-1.5 text-right tabular-nums">
        {v.scansTotal === 0 ? (
          <span className="text-muted-foreground/50" title="Nunca usó el escáner">
            —
          </span>
        ) : (
          <span className={cn(v.scansOk === 0 && 'text-status-yellow')}>
            {formatInt(v.scansOk)}
            <span className="text-muted-foreground"> / {formatInt(v.scansTotal)}</span>
          </span>
        )}
      </td>

      <td className="px-2 py-1.5 text-right tabular-nums">
        <CountOrNeverCell value={v.activeDtcCount} title="del último escaneo DTC" />
      </td>

      <td className="px-2 py-1.5 text-right tabular-nums">
        {v.pastTasksCount === 0 ? (
          <span className="text-muted-foreground/50">0</span>
        ) : (
          formatInt(v.pastTasksCount)
        )}
      </td>

      <td className="px-2 py-1.5 text-right tabular-nums">
        {v.pendingTasksCount === 0 ? (
          <span className="text-muted-foreground/50">0</span>
        ) : (
          formatInt(v.pendingTasksCount)
        )}
      </td>

      <td className="px-2 py-1.5 text-right tabular-nums">
        <CountOrNeverCell value={v.activeAnomalyCount} title="del último análisis de telemetría" />
      </td>
    </tr>
  )
}

function LastQueryCell({ status, at }: { status: string | null; at: string | null }) {
  if (!status) return <span className="text-muted-foreground/50">nunca</span>

  const label = VEHICLE_DATA_QUERY_STATUS_LABELS[status] ?? status

  return (
    <span className={cn(status === 'failed' && 'text-status-yellow')}>
      {label}
      {at ? <span className="text-muted-foreground"> · {formatDate(at)}</span> : null}
    </span>
  )
}

