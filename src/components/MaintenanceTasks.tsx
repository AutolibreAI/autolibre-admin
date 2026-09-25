import { Badge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { UserMaintenanceTask } from '~/lib/users'
import type { ReactNode } from 'react'

/**
 * Las tareas de mantenimiento — `maintenance_occurrences`.
 *
 * Extraído de `/usuarios/:id` (donde nació, como "las de TODOS los vehículos
 * de ese usuario") el 2026-09-25 para que `/leads/pedidos/:id` lo reuse tal
 * cual con las tareas de UN solo vehículo — `.claude/plans/pedidos-ficha-2026-09-25.md`,
 * Fase 4. Si "vencida" o el orden de pendientes se ve distinto en las dos
 * pantallas, una de las dos está mal.
 *
 * Reemplaza "pasadas y futuras" como se las nombraba antes, pero la base
 * tiene un tercer caso que ese vocabulario no cubre: una tarea sin `due_date`
 * ni `performed_at`. Esconderla sería mentir por omisión, así que entra en
 * «Pendientes» con su propia etiqueta.
 *
 * Y separado adentro de «Pendientes»: una vencida (`due_date` ya pasado y
 * nadie la marcó hecha) es la que un operador necesita ver primero — misma
 * familia que `stuck` en `/operacion`.
 */
export function MaintenanceTasks({ tasks, title = 'Tareas de mantenimiento' }: { tasks: Array<UserMaintenanceTask>; title?: string }) {
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
        <CardTitle className="text-base">{title}</CardTitle>
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

export function TaskRow({ task: t }: { task: UserMaintenanceTask }) {
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

export function TaskStateTag({ task: t }: { task: UserMaintenanceTask }) {
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

function Dot() {
  return (
    <span className="text-muted-foreground/40" aria-hidden>
      ·
    </span>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
}
