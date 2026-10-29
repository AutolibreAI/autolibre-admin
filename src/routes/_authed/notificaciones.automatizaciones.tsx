import { Link, createFileRoute } from '@tanstack/react-router'
import { Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { MockBanner } from '~/components/MockBanner'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '~/components/ui/sheet'
import { Textarea } from '~/components/ui/textarea'
import {
  deleteAutomationMock,
  listAutomationsMock,
  saveAutomationMock,
  setAutomationActiveMock,
} from '~/mocks/notification-automations'
import {
  AUTOMATION_CHANNELS,
  AUTOMATION_CHANNEL_BLOCKERS,
  AUTOMATION_CHANNEL_LABELS,
  AUTOMATION_VARIABLES,
  QUOTE_TRIGGERS,
  QUOTE_TRIGGER_LABELS,
  automationIssues,
  automationSchema,
  describeTrigger,
} from '~/lib/notification-automations'
import { BROADCAST_TITLE_MAX } from '~/lib/notifications'
import { cn } from '~/lib/utils'
import type {
  Automation,
  AutomationChannel,
  AutomationInput,
  AutomationTrigger,
  QuoteTrigger,
} from '~/lib/notification-automations'

/**
 * Automatizaciones por evento del pedido, con canal.
 *
 * Es la parte de "Configurar notificaciones desde el admin" que no existía: el
 * envío puntual vive en Historial («Nueva notificación») y los envíos por
 * calendario en Reglas. Acá va lo que se dispara por un hecho del pedido
 * (propuesta recibida, horas restantes, propuestas sin mirar) y en qué canal.
 *
 * `ssr: false`: todo el estado es del mock en memoria del navegador
 * (`~/mocks/notification-automations`). Renderizarlo en el servidor emitiría
 * una lista vacía distinta de la del cliente. El guard de sesión corre igual.
 */
export const Route = createFileRoute('/_authed/notificaciones/automatizaciones')({
  ssr: false,
  head: () => ({ meta: [{ title: 'Notificaciones · Automatizaciones — AutoLibre' }] }),
  component: AutomationsPage,
})

function emptyInput(): AutomationInput {
  return {
    name: '',
    trigger: { kind: 'proposal_received', ordinal: 1 },
    channel: 'push',
    title: '',
    body: '',
    sendFromHour: 9,
    sendToHour: 21,
    asksClosing: false,
  }
}

function AutomationsPage() {
  const [items, setItems] = useState<Array<Automation> | null>(null)
  const [editing, setEditing] = useState<{ id: string | null; values: AutomationInput } | null>(null)

  const reload = () => void listAutomationsMock().then(setItems)
  useEffect(reload, [])

  return (
    <>
      <PageHeader
        title="Automatizaciones"
        subtitle="Avisos que se disparan por un hecho del pedido, con canal y horario"
        actions={
          <>
            <Button size="sm" className="gap-1.5" onClick={() => setEditing({ id: null, values: emptyInput() })}>
              <Plus className="size-4" aria-hidden /> Nueva automatización
            </Button>
            <SsrTag>ssr: false</SsrTag>
          </>
        }
      />

      <MockBanner
        title="Esta pestaña es de ejemplo: no guarda ni manda nada"
        items={[
          'Las automatizaciones viven en memoria del navegador y se pierden al recargar. Activarlas no le manda nada a nadie.',
          'Falta en el backend: dónde guardarlas, el motor que las ejecute, los eventos del pedido y los canales mail y WhatsApp.',
        ]}
      />

      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        El envío puntual está en{' '}
        <Link to="/notificaciones" className="underline underline-offset-2">
          Historial › Nueva notificación
        </Link>{' '}
        (real). Los envíos por calendario están en{' '}
        <Link to="/notificaciones/reglas" className="underline underline-offset-2">
          Reglas
        </Link>
        . Las marcadas «Plantilla» son el seguimiento de pedidos abiertos: vienen pausadas y con un texto
        borrador para revisar, y avisan por el canal que eligió la persona al crear el pedido.
      </p>

      {items === null ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-6 py-16 text-center text-sm text-muted-foreground">
          Todavía no hay automatizaciones.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((a) => (
            <AutomationCard
              key={a.id}
              automation={a}
              onEdit={() => setEditing({ id: a.id, values: toInput(a) })}
              onToggle={() => void setAutomationActiveMock(a.id, !a.active).then(reload)}
              onDelete={() => void deleteAutomationMock(a.id).then(reload)}
            />
          ))}
        </div>
      )}

      <AutomationEditor
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          reload()
        }}
      />
    </>
  )
}

function toInput(a: Automation): AutomationInput {
  const { id: _id, active: _active, fromTemplate: _t, updatedAt: _u, ...input } = a
  return input
}

function AutomationCard({
  automation: a,
  onEdit,
  onToggle,
  onDelete,
}: {
  automation: Automation
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  const issues = automationIssues(a)
  return (
    <article className={cn('rounded-lg border border-border bg-card p-4', !a.active && 'bg-surface-2')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-heading text-sm font-semibold">{a.name}</h3>
            <Badge
              variant="outline"
              className={a.active ? 'border-status-green/40 text-status-green' : 'text-muted-foreground'}
            >
              {a.active ? 'Activa (de ejemplo)' : 'Pausada'}
            </Badge>
            {a.fromTemplate ? <Badge variant="outline">Plantilla</Badge> : null}
            {a.asksClosing ? <Badge variant="outline">Pregunta de cierre</Badge> : null}
          </div>
          <p className="text-sm">
            <span className="text-muted-foreground">Cuándo:</span> {describeTrigger(a.trigger)}
          </p>
          <p className="text-sm">
            <span className="text-muted-foreground">Canal:</span> {AUTOMATION_CHANNEL_LABELS[a.channel]} ·{' '}
            <span className="text-muted-foreground">Horario:</span> de {a.sendFromHour} a {a.sendToHour} h
          </p>
          <div className="mt-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
            <p className="font-medium">{a.title}</p>
            <p className="whitespace-pre-wrap text-muted-foreground">{a.body}</p>
          </div>
          <ul className="mt-2 space-y-0.5 text-xs text-status-yellow">
            {issues.map((i) => (
              <li key={i}>Falta: {i}</li>
            ))}
          </ul>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="outline" onClick={onToggle} className="gap-1.5">
            {a.active ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
            {a.active ? 'Pausar' : 'Activar'}
          </Button>
          <Button size="icon-sm" variant="outline" onClick={onEdit} aria-label={`Editar ${a.name}`}>
            <Pencil className="size-3.5" aria-hidden />
          </Button>
          <Button size="icon-sm" variant="outline" onClick={onDelete} aria-label={`Borrar ${a.name}`}>
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>
    </article>
  )
}

function defaultTrigger(kind: QuoteTrigger): AutomationTrigger {
  switch (kind) {
    case 'open_reminder':
      return { kind, afterHours: 24 }
    case 'proposal_received':
      return { kind, ordinal: 1 }
    case 'hours_left':
      return { kind, hoursLeft: 12 }
    case 'proposals_unviewed':
      return { kind, afterHours: 24 }
  }
}

function AutomationEditor({
  editing,
  onClose,
  onSaved,
}: {
  editing: { id: string | null; values: AutomationInput } | null
  onClose: () => void
  onSaved: () => void
}) {
  const [values, setValues] = useState<AutomationInput>(emptyInput())
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (editing) {
      setValues(editing.values)
      setError(null)
    }
  }, [editing])

  const set = (patch: Partial<AutomationInput>) => setValues((v) => ({ ...v, ...patch }))
  const t = values.trigger

  async function submit() {
    const parsed = automationSchema.safeParse(values)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Revisá los campos.')
      return
    }
    await saveAutomationMock(parsed.data, editing?.id ?? null)
    onSaved()
  }

  return (
    <Sheet open={editing !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <SheetContent side="right" className="w-full max-w-full overflow-y-auto bg-card sm:w-[32rem]">
        <form
          className="flex h-full min-h-0 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="border-b border-border px-5 py-4 pr-10">
            <SheetTitle>{editing?.id ? 'Editar automatización' : 'Nueva automatización'}</SheetTitle>
            <SheetDescription className="mt-0.5 leading-relaxed">
              De ejemplo: se guarda en memoria del navegador y nace pausada.
            </SheetDescription>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
            <Field label="Nombre" htmlFor="auto-name">
              <Input id="auto-name" value={values.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} />
            </Field>

            <Field label="Disparador">
              <Select
                value={t.kind}
                onValueChange={(v) => set({ trigger: defaultTrigger(v as QuoteTrigger) })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUOTE_TRIGGERS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {QUOTE_TRIGGER_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {t.kind === 'proposal_received' ? (
                <Select
                  value={String(t.ordinal)}
                  onValueChange={(v) => set({ trigger: { kind: 'proposal_received', ordinal: Number(v) as 1 | 2 | 3 } })}
                >
                  <SelectTrigger className="mt-2 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Primera propuesta</SelectItem>
                    <SelectItem value="2">Segunda propuesta</SelectItem>
                    <SelectItem value="3">Tercera propuesta</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <HoursInput
                  label={t.kind === 'hours_left' ? 'Horas que le quedan al pedido' : 'Horas después'}
                  value={t.kind === 'hours_left' ? t.hoursLeft : t.afterHours}
                  onChange={(n) =>
                    set({
                      trigger:
                        t.kind === 'hours_left' ? { kind: 'hours_left', hoursLeft: n } : { kind: t.kind, afterHours: n },
                    })
                  }
                />
              )}
              <p className="mt-1 text-xs text-muted-foreground">{describeTrigger(t)}</p>
            </Field>

            <Field label="Canal">
              <Select value={values.channel} onValueChange={(v) => set({ channel: v as AutomationChannel })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUTOMATION_CHANNELS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {AUTOMATION_CHANNEL_LABELS[c]}
                      {AUTOMATION_CHANNEL_BLOCKERS[c] ? ' (todavía no)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {AUTOMATION_CHANNEL_BLOCKERS[values.channel] ? (
                <p className="mt-1 text-xs text-status-yellow">{AUTOMATION_CHANNEL_BLOCKERS[values.channel]}</p>
              ) : null}
            </Field>

            <Field label={`Título (hasta ${BROADCAST_TITLE_MAX})`} htmlFor="auto-title">
              <Input
                id="auto-title"
                value={values.title}
                onChange={(e) => set({ title: e.target.value })}
                maxLength={BROADCAST_TITLE_MAX}
              />
              <p className="mt-1 text-right text-xs text-muted-foreground">
                {values.title.length}/{BROADCAST_TITLE_MAX}
              </p>
            </Field>

            <Field label="Mensaje" htmlFor="auto-body">
              <Textarea id="auto-body" rows={4} value={values.body} onChange={(e) => set({ body: e.target.value })} />
              <p className="mt-1 text-xs text-muted-foreground">
                Variables: {AUTOMATION_VARIABLES.map((v) => `{{${v.key}}} (${v.label.toLowerCase()})`).join(' · ')}
              </p>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <HoursInput label="Mandar desde (h)" value={values.sendFromHour} min={0} max={23} onChange={(n) => set({ sendFromHour: n })} />
              <HoursInput label="Hasta (h)" value={values.sendToHour} min={1} max={24} onChange={(n) => set({ sendToHour: n })} />
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={values.asksClosing}
                onChange={(e) => set({ asksClosing: e.target.checked })}
              />
              Termina con la pregunta de cierre (¿contrataste? ¿con quién?)
            </label>

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit">Guardar (de ejemplo)</Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}

function HoursInput({
  label,
  value,
  onChange,
  min = 1,
  max = 71,
}: {
  label: string
  value: number
  onChange: (n: number) => void
  min?: number
  max?: number
}) {
  return (
    <label className="mt-2 block space-y-1 text-xs text-muted-foreground">
      {label}
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isInteger(n)) onChange(Math.min(max, Math.max(min, n)))
        }}
      />
    </label>
  )
}
