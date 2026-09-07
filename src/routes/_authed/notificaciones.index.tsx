import { Link, createFileRoute } from '@tanstack/react-router'
import { Car, ChevronDown, ChevronUp, ChevronsUpDown, X } from 'lucide-react'
import {
  NOTIFICATION_SOURCE_LABELS,
  NOTIFICATION_STATE_FILTERS,
  NOTIFICATION_STATE_LABELS,
  NOTIFICATION_STATE_TONE,
  NOTIFICATION_TYPE_LABELS,
  notificationSearchSchema,
  type NotificationListItem,
  type NotificationSearch,
  type NotificationSortKey,
  type NotificationState,
  type NotificationStateTone,
} from '~/lib/notifications'
import { listAppNotificationFacets, listAppNotifications } from '~/fn/notifications'
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
import { formatDateTime, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

export const Route = createFileRoute('/_authed/notificaciones/')({
  /**
   * SSR completo, mismo criterio que `/usuarios` y `/chats`: es una pantalla de
   * ENTRADA. `/notificaciones?userId=…` pegado en un ticket de soporte ("no le
   * llegó el aviso de la VTV") suele ser el primer pintado de la sesión.
   */
  validateSearch: notificationSearchSchema,
  loaderDeps: ({ search }) => search,

  loader: async ({ deps, abortController }) => {
    const [notifications, facets] = await Promise.all([
      listAppNotifications({ data: deps, signal: abortController.signal }),
      listAppNotificationFacets(),
    ])
    return { notifications, facets }
  },

  head: () => ({ meta: [{ title: 'Notificaciones — AutoLibre' }] }),
  component: NotificationsList,
})

const TONE_CLASS: Record<NotificationStateTone, string> = {
  ok: 'bg-status-green-bg text-status-green border-status-green/20',
  warn: 'bg-status-yellow-bg text-status-yellow border-status-yellow/20',
  bad: 'bg-status-red-bg text-status-red border-status-red/20',
  neutral: 'bg-secondary text-muted-foreground border-border',
}

const typeLabel = (t: string) => NOTIFICATION_TYPE_LABELS[t] ?? t

/**
 * El listado de notificaciones enviadas.
 *
 * Reemplaza el `select * from notifications where user_id = '…'` — la única
 * forma que hay hoy de ver de qué le avisamos a una persona y si le llegó. El
 * censo de `/usuarios/:id` cuenta esa relación; `/operacion` la agrega; acá
 * está la fila, con el estado de entrega leído de las dos columnas que lo
 * definen (`status` + `delivery_status`). → `.claude/rules/notifications.md`
 */
function NotificationsList() {
  const { notifications, facets } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<NotificationSearch>) =>
    navigate({ search: { ...search, ...next }, replace: true })

  const filtered =
    Boolean(search.q) ||
    Boolean(search.notificationType) ||
    Boolean(search.channel) ||
    Boolean(search.notificationState) ||
    Boolean(search.userId)

  // Cuando se filtra por usuario mostramos su email — sale de las propias filas,
  // sin una consulta extra. Si el filtro no matchea nada, no hay email que
  // mostrar y el aviso queda genérico.
  const scopedEmail = search.userId ? (notifications[0]?.userEmail ?? null) : null

  return (
    <>
      <PageHeader
        title="Notificaciones"
        subtitle={`${formatInt(notifications.length)} ${filtered ? 'con este filtro' : 'en total'}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      {search.userId ? (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-sm">
          <span className="text-muted-foreground">
            Filtrando por{' '}
            {scopedEmail ? (
              <Link
                to="/usuarios/$userId"
                params={{ userId: search.userId }}
                className="font-medium text-foreground underline decoration-dotted hover:text-brand"
              >
                {scopedEmail}
              </Link>
            ) : (
              'un usuario'
            )}
          </span>
          <button
            type="button"
            onClick={() => setSearch({ userId: undefined })}
            className="ml-auto inline-flex items-center gap-1 rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <X className="size-3" aria-hidden />
            quitar
          </button>
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
            placeholder="Usuario, patente o texto"
            defaultValue={search.q ?? ''}
            className="w-64"
            onChange={(e) => {
              const value = e.currentTarget.value.trim()
              setSearch({ q: value === '' ? undefined : value })
            }}
          />
        </div>

        {facets.types.length > 0 ? (
          <FilterGroup label="Tipo">
            <Chip active={!search.notificationType} onClick={() => setSearch({ notificationType: undefined })}>
              Todos
            </Chip>
            {facets.types.map((t) => (
              <Chip key={t} active={search.notificationType === t} onClick={() => setSearch({ notificationType: t })}>
                {typeLabel(t)}
              </Chip>
            ))}
          </FilterGroup>
        ) : null}

        <FilterGroup label="Estado">
          <Chip active={!search.notificationState} onClick={() => setSearch({ notificationState: undefined })}>
            Todos
          </Chip>
          {NOTIFICATION_STATE_FILTERS.map((s) => (
            <Chip
              key={s}
              tone={
                NOTIFICATION_STATE_TONE[s] === 'bad' || NOTIFICATION_STATE_TONE[s] === 'warn'
                  ? 'warn'
                  : 'brand'
              }
              active={search.notificationState === s}
              onClick={() => setSearch({ notificationState: search.notificationState === s ? undefined : s })}
            >
              {NOTIFICATION_STATE_LABELS[s]}
            </Chip>
          ))}
        </FilterGroup>

        {/* Data-driven: hoy sólo hay `push`, pero el chip aparece solo el día
            que se encole un `email` o un `sms`. */}
        {facets.channels.length > 1 ? (
          <FilterGroup label="Canal">
            <Chip active={!search.channel} onClick={() => setSearch({ channel: undefined })}>
              Todos
            </Chip>
            {facets.channels.map((c) => (
              <Chip
                key={c}
                active={search.channel === c}
                onClick={() => setSearch({ channel: c })}
              >
                {c}
              </Chip>
            ))}
          </FilterGroup>
        ) : null}
      </div>

      {notifications.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-6 py-16 text-center">
          <p className="text-sm font-medium">Ninguna notificación con este filtro</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
            Probá con parte del email, la patente, o sacando algún filtro de
            estado.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHeader label="Usuario" sortKey="user" search={search} />
                <SortableHeader label="Tipo" sortKey="type" search={search} />
                <SortableHeader label="Vehículo" sortKey="vehicle" search={search} />
                <TableHead>Mensaje</TableHead>
                <SortableHeader label="Estado" sortKey="state" search={search} />
                <SortableHeader label="Programada · enviada (UTC)" sortKey="scheduledAt" search={search} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {notifications.map((n) => (
                <NotificationRow key={n.id} notification={n} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {notifications.length === 500 ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Cortado en 500 filas. Afiná la búsqueda — el listado no pagina a
          propósito, mismo criterio que Usuarios y Chats.
        </p>
      ) : null}
    </>
  )
}

function NotificationRow({ notification: n }: { notification: NotificationListItem }) {
  const tone = NOTIFICATION_STATE_TONE[n.state]

  return (
    <TableRow>
      <TableCell>
        <Link
          to="/usuarios/$userId"
          params={{ userId: n.userId }}
          className="rounded text-sm font-medium outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {n.userName ?? n.userEmail}
        </Link>
        {n.userName ? <div className="text-xs text-muted-foreground">{n.userEmail}</div> : null}
      </TableCell>

      <TableCell className="text-sm">
        <div>{typeLabel(n.type)}</div>
        <div className="text-xs text-muted-foreground">
          {n.sourceType ? (NOTIFICATION_SOURCE_LABELS[n.sourceType] ?? n.sourceType) : '—'}
          {n.channel !== 'push' ? <span className="ml-1">· {n.channel}</span> : null}
        </div>
      </TableCell>

      <TableCell className="text-sm">
        {n.vehiclePlate ? (
          <div className="flex items-center gap-1.5">
            <Car className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <div>
              <span className="font-mono font-medium tracking-wide">{n.vehiclePlate}</span>
              {n.vehicleBrand ? (
                <div className="text-xs text-muted-foreground">
                  {n.vehicleBrand} {n.vehicleModel}{' '}
                  <span className="tabular-nums">{n.vehicleYear}</span>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </TableCell>

      <TableCell className="max-w-[320px] text-sm">
        <div className="truncate font-medium" title={n.title}>
          {n.title}
        </div>
        <div className="truncate text-xs text-muted-foreground" title={n.body}>
          {n.body}
        </div>
      </TableCell>

      <TableCell>
        <Badge variant="outline" className={cn('font-normal', TONE_CLASS[tone])}>
          {NOTIFICATION_STATE_LABELS[n.state]}
        </Badge>
        {/* El error crudo del proveedor, sólo cuando la rechazó un receipt. */}
        {n.deliveryError ? (
          <div className="mt-1 max-w-[220px] text-xs leading-tight text-status-red/90">
            {n.deliveryError}
          </div>
        ) : null}
      </TableCell>

      <TableCell className="text-xs tabular-nums text-muted-foreground">
        <div>{formatDateTime(n.scheduledAt)}</div>
        <div className={cn(!n.sentAt && 'text-muted-foreground/40')}>
          {n.sentAt ? formatDateTime(n.sentAt) : 'sin enviar'}
        </div>
      </TableCell>
    </TableRow>
  )
}

/**
 * Headers de orden como links, no botones — mismo patrón que `/usuarios` y
 * `/chats`: el orden ES la URL, navegable y compartible.
 */
function SortableHeader({
  label,
  sortKey,
  search,
}: {
  label: string
  sortKey: NotificationSortKey
  search: NotificationSearch
}) {
  const active = search.sort === sortKey
  const nextDir = active && search.dir === 'asc' ? 'desc' : 'asc'

  return (
    <TableHead>
      <Link
        to="/notificaciones"
        search={(prev) => ({ ...prev, sort: sortKey, dir: nextDir })}
        replace
        className={cn(
          'inline-flex items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
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
