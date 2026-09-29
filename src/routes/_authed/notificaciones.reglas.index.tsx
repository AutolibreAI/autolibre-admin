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
import { listNotificationRulesFn } from '~/fn/notification-rules'
import { NotificationRuleCards } from '~/components/NotificationRuleCards'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { ScheduleComposer } from '~/components/ScheduleComposer'
import { Chip, FilterGroup } from '~/components/Filters'
import { Badge } from '~/components/ui/badge'
import { SearchInput } from '~/components/SearchInput'
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
 * `/notificaciones/reglas` — las DOS clases de regla de notificación, en dos
 * secciones:
 *
 * 1. **Recordatorios de vencimiento** (`public.notification_rules`, del
 *    backend). Reemplaza el `select * from notification_rules` + el
 *    `count(*) … group by rule_id` contra `notifications` que nadie corría.
 *    Sólo lectura: `.claude/plans/reglas-de-vencimiento.md`.
 * 2. **Envíos programados** (`ops.notification_schedule`, migración 014).
 *    Los filtros de la URL (`q`, `scheduleState`) son SÓLO de esta sección, y
 *    por eso viven adentro de ella y no en el header de la página.
 *
 * Sobre la sección 2 — qué reemplaza: nada todavía, y es a propósito — ver la cabecera de
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
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal
    // En paralelo. Las reglas de vencimiento no dependen de los filtros, pero
    // son 22 filas: separarlas en otro loader no ahorra nada que se note.
    const [schedules, rules] = await Promise.all([
      listNotificationSchedulesFn({ data: deps, signal }),
      listNotificationRulesFn({ signal }),
    ])
    return { schedules, rules }
  },
  head: () => ({ meta: [{ title: 'Reglas de notificación — AutoLibre' }] }),
  component: SchedulesList,
})

const STATE_LABELS: Record<NotificationScheduleStateFilter, string> = {
  all: 'Todas',
  active: 'Activas',
  paused: 'Pausadas',
}

function SchedulesList() {
  const { schedules, rules } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  return (
    <>
      <PageHeader
        title="Reglas"
        subtitle={`${formatInt(rules.length)} recordatorio${rules.length === 1 ? '' : 's'} de vencimiento · ${formatInt(schedules.length)} envío${schedules.length === 1 ? '' : 's'} programado${schedules.length === 1 ? '' : 's'}${search.q || search.scheduleState !== 'all' ? ' con este filtro' : ''}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <section className="mb-10">
        <div className="mb-3">
          <h2 className="font-heading text-lg font-semibold">Recordatorios de vencimiento</h2>
          <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
            Los arma y los manda el backend, cada hora: cuando falta lo indicado para que venza un
            documento o un mantenimiento, le llega un push a su dueño.
          </p>
        </div>

        <NotificationRuleCards rules={rules} />

        <div className="mt-4 rounded-lg border border-status-yellow/40 bg-status-yellow-bg px-4 py-3">
          <p className="text-sm font-medium text-status-yellow">
            Pausar, agregar o cambiar estos avisos todavía no se puede desde acá
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Está pedido al backend: primero hay que confirmar que un deploy no los vuelva a
            activar solo y qué pasa con los avisos atrasados al crear uno nuevo.
          </p>
        </div>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="font-heading text-lg font-semibold">Envíos programados</h2>
            <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
              Reglas del panel: a quiénes y cada cuánto. Nacen pausadas.
            </p>
          </div>
          <ScheduleComposer />
        </div>

        <div className="mb-4 flex flex-wrap items-end gap-4">
          <SearchInput
            id="schedule-q"
            label="Buscar"
            placeholder="Nombre de la regla"
            value={search.q}
            onSearch={(q) => setSearch({ q })}
          />

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
            <p className="text-sm font-medium">Todavía no hay envíos programados</p>
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
      </section>
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
