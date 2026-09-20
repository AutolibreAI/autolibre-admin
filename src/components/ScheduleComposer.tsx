import { useState } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { createNotificationScheduleFn, readableScheduleError } from '~/fn/schedules'
import {
  ScheduleForm,
  emptyScheduleFormValues,
  scheduleFormReady,
  type ScheduleFormValues,
} from '~/components/ScheduleForm'
import { Button } from '~/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '~/components/ui/sheet'

/**
 * Crear una regla de notificación. Nace PAUSADA siempre — el SP
 * (`ops.create_notification_schedule`) no acepta otra cosa, y esto no lo
 * repite acá: no hay un checkbox "activar al crear" a propósito
 * (`.claude/plans/notificaciones-automaticas.md`, §8.7). Activarla es un paso
 * aparte, deliberado, desde la ficha.
 */
export function ScheduleComposer() {
  const router = useRouter()

  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<ScheduleFormValues>(emptyScheduleFormValues())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null)

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setValues(emptyScheduleFormValues())
      setError(null)
      setCreated(null)
    }
  }

  async function submit() {
    if (!scheduleFormReady(values) || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await createNotificationScheduleFn({
        data: {
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
      setCreated({ id: result.id, name: result.name })
      void router.invalidate()
    } catch (cause) {
      setError(readableScheduleError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Plus className="size-3.5" aria-hidden />
          Nueva regla
        </Button>
      </SheetTrigger>

      <SheetContent side="right" className="w-full max-w-full overflow-y-auto bg-card sm:w-[32rem]">
        <form
          className="flex h-full min-h-0 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="border-b border-border px-5 py-4 pr-10">
            <SheetTitle>Nueva regla</SheetTitle>
            <SheetDescription className="mt-0.5 leading-relaxed">
              Nace pausada. Vas a poder previsualizarla y activarla después, desde su ficha.
            </SheetDescription>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {created ? (
              <div className="rounded-md border border-status-green/30 bg-status-green-bg p-3 text-sm">
                <p className="font-medium text-status-green">«{created.name}» creada, pausada.</p>
                <Link
                  to="/notificaciones/reglas/$scheduleId"
                  params={{ scheduleId: created.id }}
                  className="mt-1 inline-block text-brand hover:underline"
                  onClick={() => setOpen(false)}
                >
                  Ver la ficha →
                </Link>
              </div>
            ) : (
              <ScheduleForm values={values} onChange={setValues} disabled={busy} />
            )}

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          {!created ? (
            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              <Button type="submit" disabled={!scheduleFormReady(values) || busy} className="gap-1.5">
                {busy ? 'Creando…' : 'Crear regla (pausada)'}
              </Button>
            </div>
          ) : null}
        </form>
      </SheetContent>
    </Sheet>
  )
}
