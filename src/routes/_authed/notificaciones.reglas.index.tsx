import { Link, createFileRoute } from '@tanstack/react-router'
import {
  NOTIFICATION_SCHEDULE_STATE_FILTERS,
  describeRecurrence,
  notificationScheduleSearchSchema,
  type NotificationScheduleListItem,
  type NotificationScheduleStateFilter,
} from '~/lib/notification-schedules'
import { describeAudience } from '~/lib/audience'
import { listNotificationSchedulesFn } from '~/fn/schedules'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { ScheduleComposer } from '~/components/ScheduleComposer'
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

/**
 * `/notificaciones/reglas` — el listado de reglas de notificación.
 *
 * Qué reemplaza: nada todavía, y es a propósito — ver la cabecera de
 * `.claude/plans/notificaciones-automaticas.md`. Esta pantalla deja
 * DEFINIDA la audiencia y la recurrencia de un envío recurrente; el motor que
 * las evalúa y dispara es una fase aparte, bloqueada por una decisión de
 * autenticación (§3 del plan) que sigue abierta. Ninguna regla de acá le
 * manda un push a nadie todavía.
 *
 * SSR heredado (`true`), mismo criterio que `/notificaciones/envios`: es la
 * primera pintura al llegar acá.
 */
export const Route = createFileRoute('/_authed/notificaciones/reglas/')({
  validateSearch: notificationScheduleSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps, abortController }) =>
    listNotificationSchedulesFn({ data: deps, signal: abortController.signal }),
  head: () => ({ meta: [{ title: 'Reglas de notificación — AutoLibre' }] }),
  component: SchedulesList,
})

const STATE_LABELS: Record<NotificationScheduleStateFilter, string> = {
  all: 'Todas',
  active: 'Activas',
  paused: 'Pausadas',
}

function SchedulesList() {
  const schedules = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  return (
    <>
      <PageHeader
        title="Reglas"
        subtitle={`${formatInt(schedules.length)} ${search.q || search.scheduleState !== 'all' ? 'con este filtro' : 'en total'}`}
        actions={
          <>
            <ScheduleComposer />
            <SsrTag>ssr: full</SsrTag>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <label
            htmlFor="schedule-q"
            className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            Buscar
          </label>
          <Input
            id="schedule-q"
            type="search"
            placeholder="Nombre de la regla"
            defaultValue={search.q ?? ''}
            className="w-64"
            onChange={(e) => {
              const value = e.currentTarget.value.trim()
              setSearch({ q: value === '' ? undefined : value })
            }}
          />
        </div>

        <FilterGroup label="Estado">
          {NOTIFICATION_SCHEDULE_STATE_FILTERS.map((state) => (
            <Chip
              key={state}
              active={search.scheduleState === state}
              onClick={() => setSearch({ scheduleState: state })}
            >
              {STATE_LABELS[state]}
            </Chip>
          ))}
        </FilterGroup>
      </div>

      {schedules.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-6 py-16 text-center">
          <p className="text-sm font-medium">Todavía no hay reglas</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
            Una regla guarda una audiencia y una recurrencia — "a quiénes" y "cuándo". Nace pausada:
            crearla no le manda nada a nadie todavía.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Regla</TableHead>
                <TableHead>Audiencia</TableHead>
                <TableHead>Cuándo</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Actualizada</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.map((s) => (
                <ScheduleRow key={s.id} schedule={s} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  )
}

function ScheduleRow({ schedule: s }: { schedule: NotificationScheduleListItem }) {
  return (
    <TableRow>
      <TableCell className="max-w-[280px]">
        <Link
          to="/notificaciones/reglas/$scheduleId"
          params={{ scheduleId: s.id }}
          className="rounded text-sm font-medium outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {s.name}
        </Link>
        <div className="line-clamp-1 text-xs text-muted-foreground" title={s.title}>
          {s.title}
        </div>
      </TableCell>

      <TableCell className="max-w-[320px] text-xs text-muted-foreground">
        <span className="line-clamp-2">{describeAudience(s.conditions)}</span>
      </TableCell>

      <TableCell className="text-sm">{describeRecurrence(s.recurrence)}</TableCell>

      <TableCell>
        {s.active ? (
          <Badge
            variant="outline"
            className="border-status-green/20 bg-status-green-bg font-normal text-status-green"
          >
            Activa
          </Badge>
        ) : (
          <Badge variant="outline" className="font-normal text-muted-foreground">
            Pausada
          </Badge>
        )}
      </TableCell>

      <TableCell className="text-xs tabular-nums text-muted-foreground">
        {formatDateTime(s.updatedAt)}
      </TableCell>
    </TableRow>
  )
}
