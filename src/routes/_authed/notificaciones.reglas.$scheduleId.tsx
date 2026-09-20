import { useState } from 'react'
import { Link, createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { ArrowLeft, Pause, Play, Trash2 } from 'lucide-react'
import { describeRecurrence, type NotificationScheduleDetail } from '~/lib/notification-schedules'
import {
  deleteNotificationScheduleFn,
  getNotificationScheduleFn,
  readableScheduleError,
  setNotificationScheduleActiveFn,
  updateNotificationScheduleFn,
} from '~/fn/schedules'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { ScheduleForm, scheduleFormReady, type ScheduleFormValues } from '~/components/ScheduleForm'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'

/**
 * `/notificaciones/reglas/:id` — la ficha de una regla: definición completa,
 * editable, más pausar/reanudar y borrar.
 *
 * **No hay pantalla de "corridas" acá.** El plan (§9) ya lo prevé: cada
 * corrida es un `source_id` más de `notifications`, así que
 * `/notificaciones/envios` la va a mostrar sola apenas exista un motor que las
 * dispare (Fase 4 del plan, con su propio `LEFT JOIN` a
 * `ops.notification_schedule_run` para decir de qué regla vino). Repetir esa
 * vista acá sería la pantalla que la premisa del CLAUDE.md prohíbe: una que no
 * reemplaza ninguna consulta nueva.
 */
export const Route = createFileRoute('/_authed/notificaciones/reglas/$scheduleId')({
  loader: async ({ params, abortController }) => {
    const schedule = await getNotificationScheduleFn({
      data: { scheduleId: params.scheduleId },
      signal: abortController.signal,
    }).catch((cause: unknown) => {
      if (cause instanceof Error && cause.message.startsWith('SCHEDULE_NOT_FOUND')) return null
      throw cause
    })

    if (!schedule) throw notFound()
    return schedule
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.name ?? 'Regla'} — AutoLibre` }],
  }),
  component: ScheduleDetailPage,
})

function toFormValues(s: NotificationScheduleDetail): ScheduleFormValues {
  return {
    name: s.name,
    title: s.title,
    body: s.body,
    conditions: s.conditions,
    recurrence: s.recurrence,
    startsOn: s.startsOn,
    endsOn: s.endsOn ?? '',
    maxPerUser: s.maxPerUser === null ? '' : String(s.maxPerUser),
    requireDevice: s.requireDevice,
    excludeInternal: s.excludeInternal,
  }
}

function ScheduleDetailPage() {
  const schedule = Route.useLoaderData()
  const router = useRouter()

  const [values, setValues] = useState<ScheduleFormValues>(() => toFormValues(schedule))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  async function save() {
    if (!scheduleFormReady(values) || busy) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await updateNotificationScheduleFn({
        data: {
          scheduleId: schedule.id,
          name: values.name.trim(),
          title: values.title.trim(),
          body: values.body.trim(),
          conditions: values.conditions,
          recurrence: values.recurrence,
          startsOn: values.startsOn,
          endsOn: values.endsOn === '' ? undefined : values.endsOn,
          maxPerUser: values.maxPerUser === '' ? undefined : Number.parseInt(values.maxPerUser, 10),
          requireDevice: values.requireDevice,
          excludeInternal: values.excludeInternal,
        },
      })
      await router.invalidate()
      setSaved(true)
    } catch (cause) {
      setError(readableScheduleError(cause))
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive() {
    setBusy(true)
    setError(null)
    try {
      await setNotificationScheduleActiveFn({
        data: { scheduleId: schedule.id, active: !schedule.active },
      })
      await router.invalidate()
    } catch (cause) {
      setError(readableScheduleError(cause))
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete() {
    setBusy(true)
    setError(null)
    try {
      await deleteNotificationScheduleFn({ data: { scheduleId: schedule.id } })
      await router.navigate({ to: '/notificaciones/reglas' })
    } catch (cause) {
      setError(readableScheduleError(cause))
      setConfirmingDelete(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Link
        to="/notificaciones/reglas"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Reglas
      </Link>

      <PageHeader
        title={schedule.name}
        subtitle={describeRecurrence(schedule.recurrence)}
        actions={
          <>
            {schedule.active ? (
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
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void toggleActive()}
              className="gap-1.5"
            >
              {schedule.active ? (
                <>
                  <Pause className="size-3.5" aria-hidden />
                  Pausar
                </>
              ) : (
                <>
                  <Play className="size-3.5" aria-hidden />
                  Activar
                </>
              )}
            </Button>
            <SsrTag>ssr: full</SsrTag>
          </>
        }
      />

      <p className="mb-5 rounded-md border border-status-yellow/30 bg-status-yellow-bg px-3 py-2 text-xs leading-relaxed text-status-yellow">
        Activar una regla NO le manda un push a nadie todavía: el motor que evalúa las reglas y
        dispara los envíos es una fase aparte, que todavía no está implementada.
        → <code>.claude/plans/notificaciones-automaticas.md</code>
      </p>

      <div className="max-w-2xl rounded-lg border border-border bg-card p-5">
        <ScheduleForm values={values} onChange={setValues} disabled={busy} />

        {error ? (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {saved && !error ? (
          <p role="status" className="mt-4 text-sm text-status-green">
            Guardado.
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
          {confirmingDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">¿Borrar «{schedule.name}»?</span>
              <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void confirmDelete()}>
                Sí, borrar
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmingDelete(false)}>
                Cancelar
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
              className="gap-1.5 text-destructive hover:text-destructive"
            >
              <Trash2 className="size-3.5" aria-hidden />
              Borrar regla
            </Button>
          )}

          <Button
            type="button"
            size="sm"
            disabled={!scheduleFormReady(values) || busy}
            onClick={() => void save()}
          >
            {busy ? 'Guardando…' : 'Guardar cambios'}
          </Button>
        </div>
      </div>
    </>
  )
}
