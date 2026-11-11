import { useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { MapPin, MessageCircle, MessageSquarePlus, Phone } from 'lucide-react'
import {
  INTERACTION_CHANNELS,
  INTERACTION_CHANNEL_LABELS,
  NEXT_STEP_SUGGESTIONS,
  OBJECTIONS,
  OBJECTION_LABELS,
  OFFERED_MODELS,
  OFFERED_MODEL_LABELS,
  PROSPECT_STATUSES,
  PROSPECT_STATUS_CLASSES,
  PROSPECT_STATUS_LABELS,
  REACTIONS,
  REACTION_CLASSES,
  REACTION_LABELS,
  TOLD_TOPICS,
  addInteractionSchema,
  readableProspectError,
} from '~/lib/partner-prospects'
import { addInteractionFn } from '~/fn/partner-prospects'
import { FIELD_LABEL, ProspectStatusBadge, Segmented, ToggleCheck, YesNo, baDayPlus } from '~/components/ProspectFields'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '~/components/ui/sheet'
import { cn } from '~/lib/utils'
import { formatDate, formatDateTimeBuenosAires } from '~/lib/format'
import type {
  AddInteractionInput,
  InteractionChannel,
  Objection,
  OfferedModel,
  PartnerProspect,
  ProspectInteraction,
  ProspectStatus,
  Reaction,
  ToldKey,
} from '~/lib/partner-prospects'

/**
 * Las charlas con un proveedor (migración 030): el formulario para cargarlas
 * y el historial. → `.claude/rules/partner-prospects.md`, "Charlas".
 *
 * El formulario está hecho para el celular, en la calle o al cortar una
 * llamada: arriba sólo lo obligatorio (canal, estado, próximo paso) con
 * botones de un toque y el estado precargado; la fecha la pone la base; todo
 * lo demás va plegado en "Más detalle".
 */

const CHANNEL_ICONS: Record<InteractionChannel, typeof Phone> = {
  call: Phone,
  whatsapp: MessageCircle,
  visit: MapPin,
}

const FOLLOW_UP_SHORTCUTS: ReadonlyArray<{ label: string; days: number }> = [
  { label: 'Mañana', days: 1 },
  { label: 'En 3 días', days: 3 },
  { label: 'En 1 semana', days: 7 },
]

interface Draft {
  channel: InteractionChannel | null
  answered: boolean | null
  talkedToDecider: boolean | null
  told: Record<ToldKey, boolean>
  offeredModel: OfferedModel | null
  offeredAmount: string
  reaction: Reaction | null
  questionsAnswers: string
  objection: Objection | null
  objectionOther: string
  jobsPerMonthToPay: string
  pitchNotes: string
  statusAfter: ProspectStatus
  discardReason: string
  nextStep: string
  nextFollowUpOn: string
  /** `datetime-local` en hora del teléfono. Vacío = ahora. */
  occurredAtLocal: string
}

function emptyDraft(p: PartnerProspect): Draft {
  return {
    channel: null,
    answered: null,
    talkedToDecider: null,
    told: { toldHowOrders: false, toldProfile: false, toldZoneDemand: false, toldAsistir24: false },
    offeredModel: null,
    offeredAmount: '',
    reaction: null,
    questionsAnswers: '',
    objection: null,
    objectionOther: '',
    jobsPerMonthToPay: '',
    pitchNotes: '',
    statusAfter: p.status,
    discardReason: p.discardReason ?? '',
    nextStep: '',
    nextFollowUpOn: '',
    occurredAtLocal: '',
  }
}

function toInput(prospectId: string, d: Draft): AddInteractionInput | { error: string; field: string } {
  const jobs = d.jobsPerMonthToPay.trim()
  if (jobs !== '' && !/^[0-9]{1,5}$/.test(jobs)) return { error: 'Tiene que ser un número entero.', field: 'jobsPerMonthToPay' }
  const parsed = addInteractionSchema.safeParse({
    prospectId,
    occurredAt: d.occurredAtLocal ? new Date(d.occurredAtLocal).toISOString() : undefined,
    channel: d.channel ?? undefined,
    answered: d.answered,
    talkedToDecider: d.talkedToDecider,
    ...d.told,
    offeredModel: d.offeredModel,
    offeredAmount: d.offeredAmount.trim() || undefined,
    reaction: d.reaction,
    questionsAnswers: d.questionsAnswers.trim() || undefined,
    objection: d.objection,
    objectionOther: d.objection === 'other' ? d.objectionOther.trim() : undefined,
    jobsPerMonthToPay: jobs === '' ? null : Number(jobs),
    pitchNotes: d.pitchNotes.trim() || undefined,
    statusAfter: d.statusAfter,
    discardReason: d.statusAfter === 'discarded' ? d.discardReason.trim() : undefined,
    nextStep: d.nextStep,
    nextFollowUpOn: d.nextFollowUpOn || undefined,
  })
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  return { error: issue?.message ?? 'Revisá el formulario.', field: String(issue?.path[0] ?? '') }
}

/**
 * "Registrar charla". `onSaved` recibe el contacto ya movido (estado, paso,
 * seguimiento) para que la tarjeta se actualice sin esperar la recarga.
 */
export function InteractionComposer({
  prospect,
  onSaved,
  triggerClassName,
}: {
  prospect: PartnerProspect
  onSaved?: (next: PartnerProspect) => void
  triggerClassName?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(prospect))
  const [error, setError] = useState<{ message: string; field: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingDate, setEditingDate] = useState(false)
  const inFlight = useRef(false)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))

  function reset() {
    setDraft(emptyDraft(prospect))
    setError(null)
    setEditingDate(false)
  }

  async function submit() {
    if (inFlight.current) return
    const input = toInput(prospect.id, draft)
    if ('error' in input) {
      setError({ message: input.error, field: input.field })
      return
    }
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const next = await addInteractionFn({ data: input })
      onSaved?.(next)
      setOpen(false)
      reset()
      void router.invalidate()
    } catch (cause) {
      setError({ message: readableProspectError(cause), field: '' })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const fieldError = (field: string) =>
    error && error.field === field ? (
      <p className="text-xs text-status-red" role="alert">
        {error.message}
      </p>
    ) : null

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) reset()
      }}
    >
      <SheetTrigger asChild>
        <Button size="sm" className={cn('h-9 gap-1.5', triggerClassName)}>
          <MessageSquarePlus className="size-4" aria-hidden /> Registrar charla
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full max-w-full bg-card sm:w-[30rem]">
        <form
          className="flex h-full min-h-0 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="border-b border-border px-4 py-3 pr-10">
            <SheetTitle>Charla con {prospect.name}</SheetTitle>
            <SheetDescription className="mt-0.5">
              {editingDate ? (
                'Elegí cuándo fue.'
              ) : (
                <>
                  Ahora ·{' '}
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={() => setEditingDate(true)}
                  >
                    fue otro día
                  </button>
                </>
              )}
            </SheetDescription>
            {editingDate ? (
              <Input
                type="datetime-local"
                aria-label="Cuándo fue la charla"
                className="mt-2 h-10 shadow-none"
                value={draft.occurredAtLocal}
                onChange={(e) => set('occurredAtLocal', e.target.value)}
              />
            ) : null}
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
            <section className="space-y-1.5">
              <span className={FIELD_LABEL}>Canal *</span>
              <Segmented
                ariaLabel="Canal"
                columns="grid-cols-3"
                options={INTERACTION_CHANNELS.map((c) => ({ value: c, label: INTERACTION_CHANNEL_LABELS[c] }))}
                value={draft.channel}
                onChange={(c) => set('channel', c)}
              />
              {fieldError('channel')}
            </section>

            <section className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <span className={FIELD_LABEL}>¿Atendió?</span>
                <YesNo ariaLabel="¿Atendió?" value={draft.answered} onChange={(v) => set('answered', v)} />
              </div>
              <div className="space-y-1.5">
                <span className={FIELD_LABEL}>¿Quien decide?</span>
                <YesNo
                  ariaLabel="¿Habló con quien decide?"
                  value={draft.talkedToDecider}
                  onChange={(v) => set('talkedToDecider', v)}
                />
              </div>
            </section>

            <section className="space-y-1.5">
              <span className={FIELD_LABEL}>Cómo queda *</span>
              <Segmented
                ariaLabel="Estado en que queda el contacto"
                columns="grid-cols-2"
                options={PROSPECT_STATUSES.map((s) => ({ value: s, label: PROSPECT_STATUS_LABELS[s] }))}
                value={draft.statusAfter}
                onChange={(s) => s && set('statusAfter', s)}
                optionClass={(s) => PROSPECT_STATUS_CLASSES[s]}
              />
              {draft.statusAfter === 'discarded' ? (
                <div className="space-y-1 pt-1">
                  <label htmlFor="pi-discard" className={FIELD_LABEL}>Motivo del descarte *</label>
                  <Input
                    id="pi-discard"
                    className="h-10 shadow-none"
                    value={draft.discardReason}
                    maxLength={500}
                    onChange={(e) => set('discardReason', e.target.value)}
                  />
                  {fieldError('discardReason')}
                </div>
              ) : null}
            </section>

            <section className="space-y-1.5">
              <label htmlFor="pi-next" className={FIELD_LABEL}>Próximo paso *</label>
              <Input
                id="pi-next"
                className="h-10 shadow-none"
                placeholder="Qué sigue"
                value={draft.nextStep}
                maxLength={300}
                onChange={(e) => set('nextStep', e.target.value)}
              />
              <div className="flex flex-wrap gap-1.5">
                {NEXT_STEP_SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => set('nextStep', s)}
                    className="min-h-8 rounded-md border border-border bg-surface-2 px-2.5 text-xs text-foreground outline-none hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {s}
                  </button>
                ))}
              </div>
              {fieldError('nextStep')}
            </section>

            <section className="space-y-1.5">
              <span className={FIELD_LABEL}>Próximo contacto</span>
              <div className="flex flex-wrap gap-1.5">
                {FOLLOW_UP_SHORTCUTS.map((s) => {
                  const day = baDayPlus(s.days)
                  return (
                    <button
                      key={s.label}
                      type="button"
                      aria-pressed={draft.nextFollowUpOn === day}
                      onClick={() => set('nextFollowUpOn', draft.nextFollowUpOn === day ? '' : day)}
                      className={cn(
                        'min-h-10 rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        draft.nextFollowUpOn === day
                          ? 'border-action bg-action text-primary-foreground'
                          : 'border-border bg-card text-foreground',
                      )}
                    >
                      {s.label}
                    </button>
                  )
                })}
                <Input
                  type="date"
                  aria-label="Fecha del próximo contacto"
                  className="h-10 w-auto shadow-none"
                  value={draft.nextFollowUpOn}
                  onChange={(e) => set('nextFollowUpOn', e.target.value)}
                />
              </div>
            </section>

            <details className="group rounded-md border border-border">
              <summary className="cursor-pointer select-none px-3 py-2.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Más detalle <span className="font-normal text-muted-foreground">(opcional)</span>
              </summary>
              <div className="space-y-5 border-t border-border px-3 py-4">
                <section className="space-y-1.5">
                  <span className={FIELD_LABEL}>Qué le contó</span>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {TOLD_TOPICS.map((t) => (
                      <ToggleCheck
                        key={t.key}
                        checked={draft.told[t.key]}
                        onChange={(v) => set('told', { ...draft.told, [t.key]: v })}
                      >
                        {t.label}
                      </ToggleCheck>
                    ))}
                  </div>
                </section>

                <section className="space-y-1.5">
                  <span className={FIELD_LABEL}>Modelo que le ofreció</span>
                  <Segmented
                    ariaLabel="Modelo que le ofreció"
                    allowClear
                    options={OFFERED_MODELS.map((m) => ({ value: m, label: OFFERED_MODEL_LABELS[m] }))}
                    value={draft.offeredModel}
                    onChange={(m) => set('offeredModel', m)}
                  />
                  <Input
                    aria-label="El número exacto que dijo"
                    placeholder="El número exacto que dijo (ej.: 8%, $15.000)"
                    className="h-10 shadow-none"
                    value={draft.offeredAmount}
                    maxLength={120}
                    onChange={(e) => set('offeredAmount', e.target.value)}
                  />
                </section>

                <section className="space-y-1.5">
                  <span className={FIELD_LABEL}>Reacción</span>
                  <Segmented
                    ariaLabel="Reacción"
                    allowClear
                    columns="grid-cols-3"
                    options={REACTIONS.map((r) => ({ value: r, label: REACTION_LABELS[r] }))}
                    value={draft.reaction}
                    onChange={(r) => set('reaction', r)}
                  />
                </section>

                <section className="space-y-1.5">
                  <span className={FIELD_LABEL}>Objeción principal</span>
                  <Segmented
                    ariaLabel="Objeción principal"
                    allowClear
                    options={OBJECTIONS.map((o) => ({ value: o, label: OBJECTION_LABELS[o] }))}
                    value={draft.objection}
                    onChange={(o) => set('objection', o)}
                  />
                  {draft.objection === 'other' ? (
                    <Input
                      aria-label="Cuál es la objeción"
                      placeholder="Cuál"
                      className="h-10 shadow-none"
                      value={draft.objectionOther}
                      maxLength={300}
                      onChange={(e) => set('objectionOther', e.target.value)}
                    />
                  ) : null}
                  {fieldError('objectionOther')}
                </section>

                <section className="space-y-1.5">
                  <label htmlFor="pi-jobs" className={FIELD_LABEL}>Trabajos por mes que necesitaría para pagar</label>
                  <Input
                    id="pi-jobs"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    className="h-10 w-32 shadow-none"
                    value={draft.jobsPerMonthToPay}
                    maxLength={5}
                    onChange={(e) => set('jobsPerMonthToPay', e.target.value)}
                  />
                  {fieldError('jobsPerMonthToPay')}
                </section>

                <section className="space-y-1.5">
                  <label htmlFor="pi-qa" className={FIELD_LABEL}>Qué preguntó y qué le respondió</label>
                  <Textarea
                    id="pi-qa"
                    rows={3}
                    className="shadow-none"
                    placeholder="Con sus palabras, entre comillas"
                    value={draft.questionsAnswers}
                    maxLength={5000}
                    onChange={(e) => set('questionsAnswers', e.target.value)}
                  />
                </section>

                <section className="space-y-1.5">
                  <label htmlFor="pi-pitch" className={FIELD_LABEL}>Notas para mejorar el pitch</label>
                  <Textarea
                    id="pi-pitch"
                    rows={2}
                    className="shadow-none"
                    value={draft.pitchNotes}
                    maxLength={5000}
                    onChange={(e) => set('pitchNotes', e.target.value)}
                  />
                </section>
              </div>
            </details>
          </div>

          <div className="space-y-2 border-t border-border px-4 py-3">
            {error && error.field === '' ? (
              <p className="text-sm text-status-red" role="alert">
                {error.message}
              </p>
            ) : null}
            <Button type="submit" className="h-11 w-full text-base" disabled={busy}>
              {busy ? 'Guardando…' : 'Guardar charla'}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

// ── El historial ──────────────────────────────────────────────────────────

const yesNo = (v: boolean | null) => (v === null ? null : v ? 'sí' : 'no')

/**
 * Cada charla, de la más nueva a la más vieja. Nunca se pisa una anterior:
 * es append-only (030). La fecha va en hora de Buenos Aires, con el formateador
 * fijo de `~/lib/format` (la ficha es SSR).
 */
export function InteractionHistory({ interactions }: { interactions: ReadonlyArray<ProspectInteraction> }) {
  if (interactions.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card px-4 py-5 text-sm text-muted-foreground">
        Todavía no hay charlas cargadas con este proveedor.
      </p>
    )
  }
  return (
    <ol className="space-y-3">
      {interactions.map((i) => {
        const Icon = CHANNEL_ICONS[i.channel]
        const told = TOLD_TOPICS.filter((t) => i[t.key]).map((t) => t.label)
        const facts = [
          i.answered !== null ? `atendió: ${yesNo(i.answered)}` : null,
          i.talkedToDecider !== null ? `habló con quien decide: ${yesNo(i.talkedToDecider)}` : null,
        ].filter(Boolean)
        return (
          <li key={i.id} className="rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Icon className="size-4 text-muted-foreground" aria-hidden />
                {INTERACTION_CHANNEL_LABELS[i.channel]}
                <span className="font-normal text-muted-foreground">
                  · {formatDateTimeBuenosAires(i.occurredAt)}
                  {i.actorName ? ` · ${i.actorName}` : ''}
                </span>
              </div>
              <ProspectStatusBadge status={i.statusAfter} />
            </div>

            <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {facts.length > 0 ? <Row label="Con quién">{facts.join(' · ')}</Row> : null}
              {i.reaction ? (
                <Row label="Reacción">
                  <span className={REACTION_CLASSES[i.reaction]}>{REACTION_LABELS[i.reaction]}</span>
                </Row>
              ) : null}
              {told.length > 0 ? <Row label="Qué le contó">{told.join(' · ')}</Row> : null}
              {i.offeredModel || i.offeredAmount ? (
                <Row label="Le ofreció">
                  {[i.offeredModel ? OFFERED_MODEL_LABELS[i.offeredModel] : null, i.offeredAmount]
                    .filter(Boolean)
                    .join(' · ')}
                </Row>
              ) : null}
              {i.objection ? (
                <Row label="Objeción">
                  {i.objection === 'other' ? `Otra: ${i.objectionOther ?? ''}` : OBJECTION_LABELS[i.objection]}
                </Row>
              ) : null}
              {i.jobsPerMonthToPay !== null ? (
                <Row label="Trabajos/mes para pagar">{i.jobsPerMonthToPay}</Row>
              ) : null}
              {i.discardReason ? <Row label="Motivo del descarte">{i.discardReason}</Row> : null}
            </dl>

            {i.questionsAnswers ? (
              <Block label="Qué preguntó y qué le respondió">{i.questionsAnswers}</Block>
            ) : null}
            {i.pitchNotes ? <Block label="Notas para el pitch">{i.pitchNotes}</Block> : null}

            <p className="mt-3 border-t border-border pt-2 text-sm">
              <span className="text-muted-foreground">Próximo paso: </span>
              {i.nextStep}
              {i.nextFollowUpOn ? (
                <span className="text-muted-foreground"> · {formatDate(`${i.nextFollowUpOn}T12:00:00Z`)}</span>
              ) : null}
            </p>
          </li>
        )
      })}
    </ol>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="whitespace-pre-wrap text-sm">{children}</p>
    </div>
  )
}
