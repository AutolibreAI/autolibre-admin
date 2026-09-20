import {
  NOTIFICATION_SCHEDULE_KIND_LABELS,
  NOTIFICATION_SCHEDULE_KINDS,
  NOTIFICATION_SCHEDULE_MINUTES,
  NOTIFICATION_SCHEDULE_MONTH_DAY_MAX,
  NOTIFICATION_SCHEDULE_N_MAX,
  NOTIFICATION_SCHEDULE_N_MIN,
  WEEKDAY_SHORT_LABELS,
  defaultRecurrence,
  type NotificationScheduleKind,
  type NotificationScheduleRecurrence,
} from '~/lib/notification-schedules'
import { BROADCAST_BODY_MAX, BROADCAST_TITLE_MAX } from '~/lib/notifications'
import type { AudienceCondition } from '~/lib/audience'
import { AudienceBuilder } from '~/components/AudienceBuilder'
import { Chip } from '~/components/Filters'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'

/**
 * El formulario de una regla de notificación — compartido por el alta
 * (`ScheduleComposer`, en `/notificaciones/reglas`) y la edición (la ficha en
 * `/notificaciones/reglas/:id`). Mismo criterio que `Filters.tsx`: si el
 * formulario se ve distinto al crear y al editar, uno de los dos está mal.
 *
 * No valida con zod acá — el submit manda los valores tal cual y el error del
 * SP (traducido por `readableScheduleError`) es la fuente de verdad. Escribir
 * una segunda validación acá duplicaría los rangos de
 * `~/lib/notification-schedules` y de la migración 014, con las dos
 * divergiendo el día que alguien toque sólo una.
 */

export interface ScheduleFormValues {
  name: string
  title: string
  body: string
  conditions: Array<AudienceCondition>
  recurrence: NotificationScheduleRecurrence
  /** `YYYY-MM-DD` siempre; nunca `''`. */
  startsOn: string
  /** `''` = sin fecha de corte. */
  endsOn: string
  /** `''` = sin tope. */
  maxPerUser: string
  requireDevice: boolean
  excludeInternal: boolean
}

const LABEL_CLASS = 'block text-xs font-medium uppercase tracking-wider text-muted-foreground'

export function ScheduleForm({
  values,
  onChange,
  disabled,
}: {
  values: ScheduleFormValues
  onChange: (next: ScheduleFormValues) => void
  disabled: boolean
}) {
  const set = <K extends keyof ScheduleFormValues>(key: K, value: ScheduleFormValues[K]) =>
    onChange({ ...values, [key]: value })

  const r = values.recurrence

  function setRecurrenceKind(kind: NotificationScheduleKind) {
    set('recurrence', defaultRecurrence(kind))
  }

  function setTime(atHour: number, atMinute: number) {
    set('recurrence', { ...r, atHour, atMinute } as NotificationScheduleRecurrence)
  }

  return (
    <div className="space-y-5">
      <section className="space-y-1.5">
        <label htmlFor="sf-name" className={LABEL_CLASS}>
          Nombre de la regla
        </label>
        <Input
          id="sf-name"
          value={values.name}
          disabled={disabled}
          placeholder="Sin vehículo, día por medio"
          onChange={(e) => set('name', e.currentTarget.value)}
          className="shadow-none"
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Es interno, para que el equipo la identifique en la lista — no lo ve el usuario.
        </p>
      </section>

      <section className="space-y-1.5">
        <label htmlFor="sf-title" className={LABEL_CLASS}>
          Título del push
        </label>
        <Input
          id="sf-title"
          value={values.title}
          disabled={disabled}
          maxLength={BROADCAST_TITLE_MAX}
          onChange={(e) => set('title', e.currentTarget.value)}
          className="shadow-none"
        />
      </section>

      <section className="space-y-1.5">
        <label htmlFor="sf-body" className={LABEL_CLASS}>
          Mensaje
        </label>
        <Textarea
          id="sf-body"
          value={values.body}
          disabled={disabled}
          maxLength={BROADCAST_BODY_MAX}
          rows={3}
          onChange={(e) => set('body', e.currentTarget.value)}
          className="min-h-16 shadow-none"
        />
      </section>

      <section className="space-y-1.5">
        <span className={LABEL_CLASS}>A quién</span>
        <AudienceBuilder
          disabled={disabled}
          mode="schedule"
          initialConditions={values.conditions}
          onConditionsChange={(conditions) => set('conditions', conditions)}
        />
      </section>

      <section className="space-y-2 rounded-md border border-border p-3">
        <span className={LABEL_CLASS}>Cuándo</span>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={r.kind} disabled={disabled} onValueChange={(v) => setRecurrenceKind(v as NotificationScheduleKind)}>
            <SelectTrigger className="h-8 w-48 shadow-none" aria-label="Tipo de recurrencia">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NOTIFICATION_SCHEDULE_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {NOTIFICATION_SCHEDULE_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {r.kind === 'everyNDays' ? (
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-muted-foreground">Cada</span>
              <Input
                type="number"
                inputMode="numeric"
                min={NOTIFICATION_SCHEDULE_N_MIN}
                max={NOTIFICATION_SCHEDULE_N_MAX}
                value={r.n}
                disabled={disabled}
                onChange={(e) => {
                  const n = Number.parseInt(e.currentTarget.value, 10)
                  if (!Number.isNaN(n)) set('recurrence', { ...r, n })
                }}
                className="h-8 w-16 shadow-none"
              />
              <span className="text-sm text-muted-foreground">días</span>
            </div>
          ) : null}

          {r.kind === 'monthlyDay' ? (
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-muted-foreground">Día</span>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={NOTIFICATION_SCHEDULE_MONTH_DAY_MAX}
                value={r.day}
                disabled={disabled}
                onChange={(e) => {
                  const day = Number.parseInt(e.currentTarget.value, 10)
                  if (!Number.isNaN(day)) set('recurrence', { ...r, day })
                }}
                className="h-8 w-16 shadow-none"
              />
              <span className="text-sm text-muted-foreground">del mes (1–{NOTIFICATION_SCHEDULE_MONTH_DAY_MAX})</span>
            </div>
          ) : null}
        </div>

        {r.kind === 'weekly' ? (
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAY_SHORT_LABELS.map((label, day) => (
              <Chip
                key={day}
                active={r.weekdays.includes(day)}
                onClick={() => {
                  const next = r.weekdays.includes(day)
                    ? r.weekdays.filter((d) => d !== day)
                    : [...r.weekdays, day]
                  if (next.length > 0) set('recurrence', { ...r, weekdays: next })
                }}
              >
                {label}
              </Chip>
            ))}
          </div>
        ) : null}

        <div className="flex items-center gap-1.5">
          <span className="text-sm text-muted-foreground">A las</span>
          <Select
            value={String(r.atHour)}
            disabled={disabled}
            onValueChange={(v) => setTime(Number(v), r.atMinute)}
          >
            <SelectTrigger className="h-8 w-20 shadow-none" aria-label="Hora">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 24 }, (_, h) => (
                <SelectItem key={h} value={String(h)}>
                  {String(h).padStart(2, '0')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">:</span>
          <Select
            value={String(r.atMinute)}
            disabled={disabled}
            onValueChange={(v) => setTime(r.atHour, Number(v))}
          >
            <SelectTrigger className="h-8 w-20 shadow-none" aria-label="Minuto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NOTIFICATION_SCHEDULE_MINUTES.map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {String(m).padStart(2, '0')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">hora de Buenos Aires</span>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <label htmlFor="sf-starts" className={LABEL_CLASS}>
            Empieza
          </label>
          <Input
            id="sf-starts"
            type="date"
            value={values.startsOn}
            disabled={disabled}
            onChange={(e) => set('startsOn', e.currentTarget.value)}
            className="shadow-none"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="sf-ends" className={LABEL_CLASS}>
            Corta <span className="normal-case tracking-normal text-muted-foreground/70">(opcional)</span>
          </label>
          <Input
            id="sf-ends"
            type="date"
            value={values.endsOn}
            disabled={disabled}
            onChange={(e) => set('endsOn', e.currentTarget.value)}
            className="shadow-none"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="sf-max" className={LABEL_CLASS}>
            Tope por persona <span className="normal-case tracking-normal text-muted-foreground/70">(opcional)</span>
          </label>
          <Input
            id="sf-max"
            type="number"
            inputMode="numeric"
            min={1}
            value={values.maxPerUser}
            disabled={disabled}
            placeholder="sin tope"
            onChange={(e) => set('maxPerUser', e.currentTarget.value)}
            className="shadow-none"
          />
        </div>
      </section>

      <section className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={values.requireDevice}
            disabled={disabled}
            onChange={(e) => set('requireDevice', e.currentTarget.checked)}
          />
          Sólo a quien tenga un dispositivo registrado
        </label>
        <p className="pl-6 text-xs leading-relaxed text-muted-foreground">
          Si se destilda, la fila se crea igual para quien no tiene token y queda «Sin token»,
          reintentando cada minuto para siempre.
        </p>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={values.excludeInternal}
            disabled={disabled}
            onChange={(e) => set('excludeInternal', e.currentTarget.checked)}
          />
          Excluir cuentas internas y admins
        </label>
      </section>
    </div>
  )
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function emptyScheduleFormValues(): ScheduleFormValues {
  return {
    name: '',
    title: '',
    body: '',
    conditions: [{ field: 'vehicles', op: 'eq', value: 0 }],
    recurrence: defaultRecurrence('everyNDays'),
    startsOn: todayIsoDate(),
    endsOn: '',
    maxPerUser: '',
    requireDevice: true,
    excludeInternal: true,
  }
}

/** ¿Alcanza lo que hay para mandar al servidor? Sólo lo mínimo — el resto lo valida el SP. */
export function scheduleFormReady(values: ScheduleFormValues): boolean {
  return values.name.trim() !== '' && values.title.trim() !== '' && values.body.trim() !== ''
}
