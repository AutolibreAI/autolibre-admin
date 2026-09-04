import { Link, createFileRoute } from '@tanstack/react-router'
import { ShieldAlert } from 'lucide-react'
import {
  USER_ROLE_FILTERS,
  USER_ROLE_LABELS,
  userSearchSchema,
  type UserListItem,
  type UserRoleFilter,
} from '~/lib/users'
import { listAppUsers } from '~/fn/users'
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
function UsersList() {
  const users = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true })

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

  const filtered = search.q || search.role !== 'all' || search.onlyLegacyNative

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
            placeholder="Email o nombre"
            defaultValue={search.q ?? ''}
            className="w-64"
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
                <TableHead>Usuario</TableHead>
                <TableHead>Rol</TableHead>
                <TableHead className="text-right">Vehículos</TableHead>
                <TableHead className="text-right">Escaneos</TableHead>
                <TableHead>Alta</TableHead>
                <TableHead>Última actividad</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <Row key={u.id} user={u} />
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

function Row({ user }: { user: UserListItem }) {
  const legacyNative = user.authProvider === 'native'

  return (
    <TableRow className={cn(legacyNative && user.role === 'admin' && 'bg-status-yellow-bg/40')}>
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
    </TableRow>
  )
}
