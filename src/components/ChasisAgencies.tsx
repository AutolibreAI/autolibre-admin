import { useEffect, useRef, useState } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { MapPin, MessageCircle, MessageSquarePlus, Phone, Plus, TriangleAlert } from 'lucide-react'
import {
  AGENCY_NEXT_STEP_SUGGESTIONS,
  AGENCY_OBJECTIONS,
  AGENCY_OBJECTION_LABELS,
  AGENCY_OFFERED_MODELS,
  AGENCY_OFFERED_MODEL_LABELS,
  AGENCY_STATUSES,
  AGENCY_STATUS_CLASSES,
  AGENCY_STATUS_LABELS,
  DATA_INTERESTS,
  DATA_INTEREST_LABELS,
  INTEGRATION_MODES,
  INTEGRATION_MODE_LABELS,
  addAgencyInteractionSchema,
  readableAgencyError,
} from '~/lib/chasis-agencies'
import {
  INTERACTION_CHANNELS,
  INTERACTION_CHANNEL_LABELS,
  REACTIONS,
  REACTION_CLASSES,
  REACTION_LABELS,
  normalizeArPhone,
  prospectWhatsAppUrl,
} from '~/lib/partner-prospects'
import {
  addAgencyInteractionFn,
  createAgencyFn,
  createProspectFromAgencyFn,
  updateAgencyFn,
} from '~/fn/chasis-agencies'
import { AutosaveText, FollowUpTag, SaveIndicator } from '~/components/ProspectCards'
import { FIELD_LABEL, Segmented, ToggleCheck, YesNo, baDayPlus } from '~/components/ProspectFields'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '~/components/ui/sheet'
import { cn } from '~/lib/utils'
import { formatDate, formatDateTimeBuenosAires, formatInt } from '~/lib/format'
import type {
  AddAgencyInteractionInput,
  AgencyFacets,
  AgencyInteraction,
  AgencyObjection,
  AgencyOfferedModel,
  AgencyPatch,
  AgencyStatus,
  AgencySummary,
  ChasisAgency,
} from '~/lib/chasis-agencies'
import type { InteractionChannel, Reaction } from '~/lib/partner-prospects'

/**
 * Las piezas de la pestaña API Chasis (`/comercial/api-chasis`, migración 031).
 * Mismo patrón que Contactos: la ficha se autoguarda por parche y las charlas
 * son append-only. → `.claude/rules/partner-prospects.md`, "API Chasis".
 */

const NO_OWNER = '__none__'
const CHANNEL_ICONS: Record<InteractionChannel, typeof Phone> = { call: Phone, whatsapp: MessageCircle, visit: MapPin }

export function AgencyStatusBadge({ status }: { status: AgencyStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium',
        AGENCY_STATUS_CLASSES[status],
      )}
    >
      {AGENCY_STATUS_LABELS[status]}
    </span>
  )
}

/** Cliente sin el referido cargado en Chasis: sin eso no se cobra la comisión. */
export function ReferralWarning({ agency: a }: { agency: ChasisAgency }) {
  if (a.status !== 'client' || a.referralLoaded) return null
  return (
    <p className="flex items-center gap-1.5 rounded-md border border-status-yellow/30 bg-status-yellow-bg px-3 py-2 text-sm text-status-yellow">
      <TriangleAlert className="size-4 shrink-0" aria-hidden />
      Es cliente y el referido no está cargado en Chasis: sin eso no se cobra la comisión.
    </p>
  )
}

// ── Resumen ───────────────────────────────────────────────────────────────

export function AgencySummaryBlock({ summary: s }: { summary: AgencySummary }) {
  const max = Math.max(1, ...s.objections.map((o) => o.agencies))
  return (
    <div className="mb-6 space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {AGENCY_STATUSES.map((st) => (
          <div key={st} className="rounded-lg border border-border bg-card px-4 py-3">
            <AgencyStatusBadge status={st} />
            <p className="mt-2 font-heading text-2xl font-semibold tabular-nums">{formatInt(s.byStatus[st])}</p>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Referidos cargados</p>
          <p className="mt-1 font-heading text-2xl font-semibold tabular-nums">{formatInt(s.referralsLoaded)}</p>
          {s.clientsWithoutReferral > 0 ? (
            <p className="text-xs text-status-yellow">
              {formatInt(s.clientsWithoutReferral)} {s.clientsWithoutReferral === 1 ? 'cliente' : 'clientes'} sin cargar
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">todos los clientes cargados</p>
          )}
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Consultas/mes del pipeline</p>
          <p className="mt-1 font-heading text-2xl font-semibold tabular-nums">{formatInt(s.pipelineVolume)}</p>
          <p className="text-xs text-muted-foreground">
            de {formatInt(s.pipelineVolumeN)} {s.pipelineVolumeN === 1 ? 'agencia abierta' : 'agencias abiertas'} con el dato
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Consultas/mes de clientes</p>
          <p className="mt-1 font-heading text-2xl font-semibold tabular-nums">{formatInt(s.clientVolume)}</p>
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Objeciones más repetidas · {formatInt(s.interactions)} {s.interactions === 1 ? 'charla' : 'charlas'}
        </p>
        {s.objections.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Ninguna charla con objeción cargada.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {s.objections.map((o) => (
              <li key={o.objection} className="space-y-1">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span>{AGENCY_OBJECTION_LABELS[o.objection] ?? o.objection}</span>
                  <span className="shrink-0 tabular-nums">
                    <strong className="font-semibold">{formatInt(o.agencies)}</strong>
                    <span className="text-muted-foreground">
                      {' '}
                      {o.agencies === 1 ? 'agencia' : 'agencias'} · {formatInt(o.interactions)}{' '}
                      {o.interactions === 1 ? 'charla' : 'charlas'}
                    </span>
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-surface-2" aria-hidden>
                  <div className="h-1.5 rounded-full bg-action" style={{ width: `${(o.agencies / max) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {s.otherObjections.length > 0 ? (
          <ul className="mt-3 space-y-1 border-t border-border pt-2 text-sm">
            {s.otherObjections.map((o) => (
              <li key={o.text} className="flex justify-between gap-3">
                <span>Otra: {o.text}</span>
                <span className="tabular-nums text-muted-foreground">×{formatInt(o.count)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

// ── Autoguardado ──────────────────────────────────────────────────────────

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }

/** Mismo contrato que `useProspectAutosave`: parches encolados en orden, error a la vista. */
export function useAgencyAutosave(initial: ChasisAgency, onSaved?: (patch: AgencyPatch) => void) {
  const [agency, setAgency] = useState(initial)
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  const queue = useRef<Promise<void>>(Promise.resolve())
  const pending = useRef(0)
  const lastError = useRef<string | null>(null)

  useEffect(() => {
    if (pending.current === 0) setAgency(initial)
  }, [initial.updatedAt])

  function save(patch: AgencyPatch) {
    if (pending.current === 0) lastError.current = null
    pending.current += 1
    setState({ kind: 'saving' })
    queue.current = queue.current.then(async () => {
      try {
        const next = await updateAgencyFn({ data: { id: initial.id, patch } })
        setAgency(next)
        onSaved?.(patch)
      } catch (cause) {
        lastError.current = readableAgencyError(cause)
      } finally {
        pending.current -= 1
        if (pending.current === 0)
          setState(lastError.current ? { kind: 'error', message: lastError.current } : { kind: 'saved' })
      }
    })
  }

  function accept(next: ChasisAgency) {
    if (pending.current === 0) setAgency(next)
  }

  return { agency, state, save, accept }
}

// ── La tarjeta del listado ────────────────────────────────────────────────

export function AgencyCard({ agency: a, facets }: { agency: ChasisAgency; facets: AgencyFacets }) {
  const waUrl = prospectWhatsAppUrl(a.phoneDigits)
  const owner = a.ownerId ? (facets.owners.find((o) => o.id === a.ownerId)?.name ?? 'usuario borrado') : 'sin asignar'
  return (
    <article className="space-y-2 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="font-heading text-base font-semibold leading-tight">
            <Link
              to="/comercial/api-chasis/$agencyId"
              params={{ agencyId: a.id }}
              className="underline-offset-2 hover:underline"
            >
              {a.name}
            </Link>
          </h3>
          <p className="text-sm text-muted-foreground">
            {[a.contactName, a.locality, a.monthlyVolume !== null ? `${formatInt(a.monthlyVolume)} consultas/mes` : null]
              .filter(Boolean)
              .join(' · ') || 'sin contacto ni zona'}
          </p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {a.phone ? <span className="tabular-nums">{a.phone}</span> : <span className="text-muted-foreground">sin teléfono</span>}
            {waUrl ? (
              <Button asChild size="sm" variant="outline" className="h-7 gap-1 px-2 shadow-none">
                <a href={waUrl} target="_blank" rel="noreferrer">
                  <MessageCircle className="size-3.5" aria-hidden /> WhatsApp
                </a>
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <AgencyStatusBadge status={a.status} />
          <FollowUpTag days={a.followUpInDays} date={a.nextFollowUpOn} />
        </div>
      </div>
      <ReferralWarning agency={a} />
      <p className="text-sm">
        {a.status === 'discarded' && a.discardReason ? (
          <>
            <span className="text-muted-foreground">Descartada: </span>
            {a.discardReason}
          </>
        ) : (
          <>
            <span className="text-muted-foreground">Próximo paso: </span>
            {a.nextStep ?? 'sin definir'}
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <AgencyInteractionComposer agency={a} />
          <Button asChild size="sm" variant="outline" className="h-9 shadow-none">
            <Link to="/comercial/api-chasis/$agencyId" params={{ agencyId: a.id }}>
              Ficha e historial{a.interactionCount > 0 ? ` (${formatInt(a.interactionCount)})` : ''}
            </Link>
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">Conseguido por {owner}</span>
      </div>
    </article>
  )
}

// ── Alta ──────────────────────────────────────────────────────────────────

/** Alta rápida: el nombre es lo único obligatorio; el resto se completa en la ficha. */
export function AgencyComposer({ facets, currentUserId }: { facets: AgencyFacets; currentUserId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [contactName, setContactName] = useState('')
  const [phone, setPhone] = useState('')
  const [locality, setLocality] = useState('')
  const [ownerId, setOwnerId] = useState<string | null>(currentUserId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const digits = normalizeArPhone(phone)

  function reset() {
    setName('')
    setContactName('')
    setPhone('')
    setLocality('')
    setOwnerId(currentUserId)
    setError(null)
  }

  async function submit() {
    if (name.trim() === '' || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const created = await createAgencyFn({ data: { name: name.trim(), contactName, phone, locality, ownerId } })
      setOpen(false)
      reset()
      await router.navigate({ to: '/comercial/api-chasis/$agencyId', params: { agencyId: created.id } })
    } catch (cause) {
      setError(readableAgencyError(cause))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <SheetTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Plus className="size-3.5" aria-hidden /> Nueva agencia
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full max-w-full bg-card sm:w-[28rem]">
        <form
          className="flex h-full min-h-0 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="border-b border-border px-5 py-4 pr-10">
            <SheetTitle>Nueva agencia</SheetTitle>
            <SheetDescription className="mt-0.5">Lo demás se completa en la ficha.</SheetDescription>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
            <div className="space-y-1">
              <label htmlFor="ca-name" className={FIELD_LABEL}>Nombre *</label>
              <Input id="ca-name" className="h-10 shadow-none" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="ca-contact" className={FIELD_LABEL}>Contacto</label>
              <Input id="ca-contact" className="h-10 shadow-none" value={contactName} maxLength={200} onChange={(e) => setContactName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="ca-phone" className={FIELD_LABEL}>Teléfono</label>
              <Input
                id="ca-phone"
                inputMode="tel"
                className="h-10 shadow-none"
                placeholder="11 2512-0472"
                value={phone}
                maxLength={60}
                onChange={(e) => setPhone(e.target.value)}
              />
              {phone.trim() !== '' && !digits ? (
                <p className="text-xs text-status-yellow">No es un celular reconocible: se guarda, sin WhatsApp ni chequeo de duplicado.</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <label htmlFor="ca-loc" className={FIELD_LABEL}>Zona</label>
              <Input id="ca-loc" className="h-10 shadow-none" value={locality} maxLength={200} onChange={(e) => setLocality(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="ca-owner" className={FIELD_LABEL}>Conseguido por</label>
              <OwnerSelect id="ca-owner" facets={facets} value={ownerId} onChange={setOwnerId} />
            </div>
          </div>
          <div className="space-y-2 border-t border-border px-5 py-4">
            {error ? <p className="text-sm text-status-red" role="alert">{error}</p> : null}
            <Button type="submit" className="h-11 w-full" disabled={busy || name.trim() === ''}>
              {busy ? 'Guardando…' : 'Cargar agencia'}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function OwnerSelect({
  id,
  facets,
  value,
  onChange,
}: {
  id: string
  facets: AgencyFacets
  value: string | null
  onChange: (next: string | null) => void
}) {
  return (
    <Select value={value ?? NO_OWNER} onValueChange={(v) => onChange(v === NO_OWNER ? null : v)}>
      <SelectTrigger id={id} className="h-10 w-full shadow-none">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_OWNER}>Sin asignar</SelectItem>
        {facets.owners.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ── Estado (con motivo para descartar) ────────────────────────────────────

export function AgencyStatusSelect({ agency: a, onSave }: { agency: ChasisAgency; onSave: (patch: AgencyPatch) => void }) {
  const [discarding, setDiscarding] = useState(false)
  const [reason, setReason] = useState('')
  return (
    <div className="flex flex-col items-end gap-1.5">
      <Select
        value={discarding ? 'discarded' : a.status}
        onValueChange={(v) => {
          if (v === 'discarded') setDiscarding(true)
          else {
            setDiscarding(false)
            onSave({ status: v as AgencyStatus })
          }
        }}
      >
        <SelectTrigger aria-label="Estado" className={cn('h-9 w-56 shadow-none', AGENCY_STATUS_CLASSES[discarding ? 'discarded' : a.status])}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AGENCY_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {AGENCY_STATUS_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {discarding ? (
        <form
          className="flex w-full max-w-xs gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (reason.trim() === '') return
            onSave({ status: 'discarded', discardReason: reason.trim() })
            setDiscarding(false)
            setReason('')
          }}
        >
          <Input
            autoFocus
            aria-label="Motivo del descarte"
            placeholder="Motivo (obligatorio)"
            className="h-9 shadow-none"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button type="submit" size="sm" className="h-9" disabled={reason.trim() === ''}>
            Descartar
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-9" onClick={() => setDiscarding(false)}>
            No
          </Button>
        </form>
      ) : null}
    </div>
  )
}

// ── La ficha ──────────────────────────────────────────────────────────────

/**
 * Todo lo que se sabe de la agencia, autoguardado campo por campo. "Usa
 * Carbufy: sí" descarta con ese motivo (la 031 lo hace en la misma operación):
 * se pide confirmación antes de guardar.
 */
export function AgencyFichaEditor({
  agency: a,
  facets,
  save,
}: {
  agency: ChasisAgency
  facets: AgencyFacets
  save: (patch: AgencyPatch) => void
}) {
  const idp = `ca-${a.id}`
  const [confirmCarbufy, setConfirmCarbufy] = useState(false)
  const [volume, setVolume] = useState(a.monthlyVolume === null ? '' : String(a.monthlyVolume))
  useEffect(() => setVolume(a.monthlyVolume === null ? '' : String(a.monthlyVolume)), [a.monthlyVolume])

  function commitVolume() {
    const t = volume.trim()
    if (t === '' && a.monthlyVolume === null) return
    if (t !== '' && !/^[0-9]{1,8}$/.test(t)) return
    const next = t === '' ? null : Number(t)
    if (next !== a.monthlyVolume) save({ monthlyVolume: next })
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${idp}-name`} label="Nombre">
          <AutosaveText id={`${idp}-name`} value={a.name} maxLength={200} onCommit={(t) => save({ name: t })} />
        </Field>
        <Field id={`${idp}-contact`} label="Contacto">
          <AutosaveText id={`${idp}-contact`} value={a.contactName} maxLength={200} onCommit={(t) => save({ contactName: t })} />
        </Field>
        <Field id={`${idp}-phone`} label="Teléfono">
          <AutosaveText id={`${idp}-phone`} value={a.phone} maxLength={60} placeholder="11 2512-0472" onCommit={(t) => save({ phone: t })} />
        </Field>
        <Field id={`${idp}-loc`} label="Zona">
          <AutosaveText id={`${idp}-loc`} value={a.locality} maxLength={200} onCommit={(t) => save({ locality: t })} />
        </Field>
        <Field id={`${idp}-owner`} label="Conseguido por">
          <OwnerSelect id={`${idp}-owner`} facets={facets} value={a.ownerId} onChange={(ownerId) => save({ ownerId })} />
        </Field>
        <div className="space-y-1.5">
          <span className={FIELD_LABEL}>¿Habló con quien decide?</span>
          <YesNo ariaLabel="¿Habló con quien decide?" value={a.talkedToDecider} onChange={(v) => save({ talkedToDecider: v })} />
        </div>
      </div>

      <div className="space-y-1.5">
        <span className={FIELD_LABEL}>¿Usa Carbufy?</span>
        <YesNo
          ariaLabel="¿Usa Carbufy?"
          value={a.usesCarbufy}
          onChange={(v) => {
            if (v === true && a.status !== 'discarded') setConfirmCarbufy(true)
            else save({ usesCarbufy: v })
          }}
        />
        {confirmCarbufy ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-status-yellow/30 bg-status-yellow-bg px-3 py-2 text-sm text-status-yellow">
            Si usa Carbufy, la agencia queda descartada con ese motivo.
            <Button
              size="sm"
              className="h-8"
              onClick={() => {
                save({ usesCarbufy: true })
                setConfirmCarbufy(false)
              }}
            >
              Sí, descartar
            </Button>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setConfirmCarbufy(false)}>
              Cancelar
            </Button>
          </div>
        ) : null}
      </div>

      <Field id={`${idp}-use`} label="Para qué lo usaría">
        <AutosaveText id={`${idp}-use`} multiline value={a.useCase} maxLength={1000} onCommit={(t) => save({ useCase: t })} />
      </Field>

      <div className="space-y-1.5">
        <span className={FIELD_LABEL}>Qué datos le importan</span>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {DATA_INTERESTS.map((d) => (
            <ToggleCheck
              key={d}
              checked={a.dataInterests.includes(d)}
              onChange={(on) =>
                save({ dataInterests: on ? [...a.dataInterests, d] : a.dataInterests.filter((x) => x !== d) })
              }
            >
              {DATA_INTEREST_LABELS[d]}
            </ToggleCheck>
          ))}
        </div>
        {a.dataInterests.includes('other') ? (
          <AutosaveText
            id={`${idp}-other`}
            value={a.dataInterestsOther}
            maxLength={300}
            placeholder="Cuáles"
            onCommit={(t) => save({ dataInterestsOther: t })}
          />
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${idp}-vol`} label="Autos o consultas por mes">
          <Input
            id={`${idp}-vol`}
            inputMode="numeric"
            pattern="[0-9]*"
            className="shadow-none"
            value={volume}
            maxLength={8}
            onChange={(e) => setVolume(e.target.value)}
            onBlur={commitVolume}
          />
        </Field>
        <div className="space-y-1.5">
          <span className={FIELD_LABEL}>Lo integraría</span>
          <Segmented
            ariaLabel="Cómo lo integraría"
            allowClear
            options={INTEGRATION_MODES.map((m) => ({ value: m, label: INTEGRATION_MODE_LABELS[m] }))}
            value={a.integrationMode}
            onChange={(v) => save({ integrationMode: v })}
          />
        </div>
        <Field id={`${idp}-sol`} label="Cómo lo resuelve hoy">
          <AutosaveText id={`${idp}-sol`} value={a.currentSolution} maxLength={1000} onCommit={(t) => save({ currentSolution: t })} />
        </Field>
        <Field id={`${idp}-prov`} label="Con qué proveedor">
          <AutosaveText id={`${idp}-prov`} value={a.currentProvider} maxLength={200} onCommit={(t) => save({ currentProvider: t })} />
        </Field>
      </div>

      <Field id={`${idp}-more`} label="Le interesa algo más de AutoLibre">
        <AutosaveText id={`${idp}-more`} value={a.otherInterest} maxLength={1000} onCommit={(t) => save({ otherInterest: t })} />
      </Field>

      <div className="space-y-1.5">
        <span className={FIELD_LABEL}>¿Tiene taller, lubricentro o gomería propios?</span>
        <YesNo ariaLabel="¿Tiene taller, lubricentro o gomería propios?" value={a.hasWorkshop} onChange={(v) => save({ hasWorkshop: v })} />
      </div>

      <div className="space-y-1.5">
        <span className={FIELD_LABEL}>Comisión</span>
        <ToggleCheck checked={a.referralLoaded} onChange={(v) => save({ referralLoaded: v })}>
          Referido cargado en Chasis
        </ToggleCheck>
      </div>

      <Field id={`${idp}-notes`} label="Notas">
        <AutosaveText id={`${idp}-notes`} multiline value={a.notes} maxLength={5000} onCommit={(t) => save({ notes: t })} />
      </Field>
    </div>
  )
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className={FIELD_LABEL}>
        {label}
      </label>
      {children}
    </div>
  )
}

/**
 * "Crear contacto de proveedor": sólo si la agencia tiene taller propio y
 * todavía no tiene contacto. Si el teléfono ya era un contacto, lo linkea y lo
 * dice, en vez de duplicar (031).
 */
export function AgencyProspectLink({ agency: a }: { agency: ChasisAgency }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  if (a.prospectId) {
    return (
      <p className="rounded-md border border-status-green/30 bg-status-green-bg px-3 py-2 text-sm text-status-green">
        Contacto de proveedor:{' '}
        <Link to="/comercial/contactos/$prospectId" params={{ prospectId: a.prospectId }} className="font-medium underline underline-offset-2">
          {a.prospectName ?? 'ver contacto'}
        </Link>
        {message ? <span className="block text-xs">{message}</span> : null}
      </p>
    )
  }
  if (a.hasWorkshop !== true) return null

  async function create() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const r = await createProspectFromAgencyFn({ data: { id: a.id } })
      setMessage(
        r.created
          ? 'Se creó en Contactos con frente Corredor Norte.'
          : 'Ese teléfono ya era un contacto: se vinculó a ése, sin duplicar.',
      )
      await router.invalidate()
    } catch (cause) {
      setError(readableAgencyError(cause))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1">
      <Button variant="outline" className="h-10 shadow-none" disabled={busy} onClick={() => void create()}>
        {busy ? 'Creando…' : 'Crear contacto de proveedor'}
      </Button>
      <p className="text-xs text-muted-foreground">
        Tiene taller, lubricentro o gomería: lo pasa a Contactos con frente Corredor Norte y estos datos.
      </p>
      {error ? <p className="text-xs text-status-red" role="alert">{error}</p> : null}
    </div>
  )
}

// ── La charla ─────────────────────────────────────────────────────────────

interface Draft {
  channel: InteractionChannel | null
  answered: boolean | null
  talkedToDecider: boolean | null
  offeredModel: AgencyOfferedModel | null
  offeredAmount: string
  reaction: Reaction | null
  questionsAnswers: string
  objection: AgencyObjection | null
  objectionOther: string
  pitchNotes: string
  statusAfter: AgencyStatus
  discardReason: string
  nextStep: string
  nextFollowUpOn: string
  occurredAtLocal: string
}

const emptyDraft = (a: ChasisAgency): Draft => ({
  channel: null,
  answered: null,
  talkedToDecider: null,
  offeredModel: null,
  offeredAmount: '',
  reaction: null,
  questionsAnswers: '',
  objection: null,
  objectionOther: '',
  pitchNotes: '',
  statusAfter: a.status,
  discardReason: a.discardReason ?? '',
  nextStep: '',
  nextFollowUpOn: '',
  occurredAtLocal: '',
})

/**
 * "Registrar charla" con una agencia. Mismo formulario de celular que el de
 * proveedores (obligatorios canal, estado y próximo paso; el resto plegado),
 * con su modelo (suscripción / pack + precio dicho) y sus objeciones.
 */
export function AgencyInteractionComposer({
  agency,
  onSaved,
}: {
  agency: ChasisAgency
  onSaved?: (next: ChasisAgency) => void
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [d, setD] = useState<Draft>(() => emptyDraft(agency))
  const [error, setError] = useState<{ message: string; field: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingDate, setEditingDate] = useState(false)
  const inFlight = useRef(false)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }))

  async function submit() {
    if (inFlight.current) return
    const parsed = addAgencyInteractionSchema.safeParse({
      agencyId: agency.id,
      occurredAt: d.occurredAtLocal ? new Date(d.occurredAtLocal).toISOString() : undefined,
      channel: d.channel ?? undefined,
      answered: d.answered,
      talkedToDecider: d.talkedToDecider,
      offeredModel: d.offeredModel,
      offeredAmount: d.offeredAmount.trim() || undefined,
      reaction: d.reaction,
      questionsAnswers: d.questionsAnswers.trim() || undefined,
      objection: d.objection,
      objectionOther: d.objection === 'other' ? d.objectionOther.trim() : undefined,
      pitchNotes: d.pitchNotes.trim() || undefined,
      statusAfter: d.statusAfter,
      discardReason: d.statusAfter === 'discarded' ? d.discardReason.trim() : undefined,
      nextStep: d.nextStep,
      nextFollowUpOn: d.nextFollowUpOn || undefined,
    } satisfies Partial<AddAgencyInteractionInput>)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      setError({ message: issue?.message ?? 'Revisá el formulario.', field: String(issue?.path[0] ?? '') })
      return
    }
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const next = await addAgencyInteractionFn({ data: parsed.data })
      onSaved?.(next)
      setOpen(false)
      void router.invalidate()
    } catch (cause) {
      setError({ message: readableAgencyError(cause), field: '' })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const fieldError = (field: string) =>
    error && error.field === field ? <p className="text-xs text-status-red" role="alert">{error.message}</p> : null

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setD(emptyDraft(agency))
          setError(null)
          setEditingDate(false)
        }
      }}
    >
      <SheetTrigger asChild>
        <Button size="sm" className="h-9 gap-1.5">
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
            <SheetTitle>Charla con {agency.name}</SheetTitle>
            <SheetDescription className="mt-0.5">
              {editingDate ? (
                'Elegí cuándo fue.'
              ) : (
                <>
                  Ahora ·{' '}
                  <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setEditingDate(true)}>
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
                value={d.occurredAtLocal}
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
                value={d.channel}
                onChange={(c) => set('channel', c)}
              />
              {fieldError('channel')}
            </section>

            <section className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <span className={FIELD_LABEL}>¿Atendió?</span>
                <YesNo ariaLabel="¿Atendió?" value={d.answered} onChange={(v) => set('answered', v)} />
              </div>
              <div className="space-y-1.5">
                <span className={FIELD_LABEL}>¿Quien decide?</span>
                <YesNo ariaLabel="¿Habló con quien decide?" value={d.talkedToDecider} onChange={(v) => set('talkedToDecider', v)} />
              </div>
            </section>

            <section className="space-y-1.5">
              <span className={FIELD_LABEL}>Cómo queda *</span>
              <Segmented
                ariaLabel="Estado en que queda la agencia"
                columns="grid-cols-2"
                options={AGENCY_STATUSES.map((s) => ({ value: s, label: AGENCY_STATUS_LABELS[s] }))}
                value={d.statusAfter}
                onChange={(s) => s && set('statusAfter', s)}
                optionClass={(s) => AGENCY_STATUS_CLASSES[s]}
              />
              {d.statusAfter === 'discarded' ? (
                <div className="space-y-1 pt-1">
                  <label htmlFor="cai-discard" className={FIELD_LABEL}>Motivo del descarte *</label>
                  <Input
                    id="cai-discard"
                    className="h-10 shadow-none"
                    value={d.discardReason}
                    maxLength={500}
                    onChange={(e) => set('discardReason', e.target.value)}
                  />
                  {fieldError('discardReason')}
                </div>
              ) : null}
            </section>

            <section className="space-y-1.5">
              <label htmlFor="cai-next" className={FIELD_LABEL}>Próximo paso *</label>
              <Input
                id="cai-next"
                className="h-10 shadow-none"
                placeholder="Qué sigue"
                value={d.nextStep}
                maxLength={300}
                onChange={(e) => set('nextStep', e.target.value)}
              />
              <div className="flex flex-wrap gap-1.5">
                {AGENCY_NEXT_STEP_SUGGESTIONS.map((s) => (
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
                {[
                  { label: 'Mañana', days: 1 },
                  { label: 'En 3 días', days: 3 },
                  { label: 'En 1 semana', days: 7 },
                ].map((s) => {
                  const day = baDayPlus(s.days)
                  return (
                    <button
                      key={s.label}
                      type="button"
                      aria-pressed={d.nextFollowUpOn === day}
                      onClick={() => set('nextFollowUpOn', d.nextFollowUpOn === day ? '' : day)}
                      className={cn(
                        'min-h-10 rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        d.nextFollowUpOn === day ? 'border-action bg-action text-primary-foreground' : 'border-border bg-card text-foreground',
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
                  value={d.nextFollowUpOn}
                  onChange={(e) => set('nextFollowUpOn', e.target.value)}
                />
              </div>
            </section>

            <details className="rounded-md border border-border">
              <summary className="cursor-pointer select-none px-3 py-2.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Más detalle <span className="font-normal text-muted-foreground">(opcional)</span>
              </summary>
              <div className="space-y-5 border-t border-border px-3 py-4">
                <section className="space-y-1.5">
                  <span className={FIELD_LABEL}>Modelo que le ofreció</span>
                  <Segmented
                    ariaLabel="Modelo que le ofreció"
                    allowClear
                    options={AGENCY_OFFERED_MODELS.map((m) => ({ value: m, label: AGENCY_OFFERED_MODEL_LABELS[m] }))}
                    value={d.offeredModel}
                    onChange={(m) => set('offeredModel', m)}
                  />
                  <Input
                    aria-label="El precio que dijo"
                    placeholder="El precio que dijo (ej.: $80.000 por mes)"
                    className="h-10 shadow-none"
                    value={d.offeredAmount}
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
                    value={d.reaction}
                    onChange={(r) => set('reaction', r)}
                  />
                </section>
                <section className="space-y-1.5">
                  <span className={FIELD_LABEL}>Objeción principal</span>
                  <Segmented
                    ariaLabel="Objeción principal"
                    allowClear
                    options={AGENCY_OBJECTIONS.map((o) => ({ value: o, label: AGENCY_OBJECTION_LABELS[o] }))}
                    value={d.objection}
                    onChange={(o) => set('objection', o)}
                  />
                  {d.objection === 'other' ? (
                    <Input
                      aria-label="Cuál es la objeción"
                      placeholder="Cuál"
                      className="h-10 shadow-none"
                      value={d.objectionOther}
                      maxLength={300}
                      onChange={(e) => set('objectionOther', e.target.value)}
                    />
                  ) : null}
                  {fieldError('objectionOther')}
                </section>
                <section className="space-y-1.5">
                  <label htmlFor="cai-qa" className={FIELD_LABEL}>Qué preguntó y qué le respondió</label>
                  <Textarea
                    id="cai-qa"
                    rows={3}
                    className="shadow-none"
                    placeholder="Con sus palabras, entre comillas"
                    value={d.questionsAnswers}
                    maxLength={5000}
                    onChange={(e) => set('questionsAnswers', e.target.value)}
                  />
                </section>
                <section className="space-y-1.5">
                  <label htmlFor="cai-pitch" className={FIELD_LABEL}>Notas para mejorar el pitch</label>
                  <Textarea
                    id="cai-pitch"
                    rows={2}
                    className="shadow-none"
                    value={d.pitchNotes}
                    maxLength={5000}
                    onChange={(e) => set('pitchNotes', e.target.value)}
                  />
                </section>
              </div>
            </details>
          </div>

          <div className="space-y-2 border-t border-border px-4 py-3">
            {error && error.field === '' ? <p className="text-sm text-status-red" role="alert">{error.message}</p> : null}
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

export function AgencyInteractionHistory({ interactions }: { interactions: ReadonlyArray<AgencyInteraction> }) {
  if (interactions.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card px-4 py-5 text-sm text-muted-foreground">
        Todavía no hay charlas cargadas con esta agencia.
      </p>
    )
  }
  return (
    <ol className="space-y-3">
      {interactions.map((i) => {
        const Icon = CHANNEL_ICONS[i.channel]
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
              <AgencyStatusBadge status={i.statusAfter} />
            </div>
            <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {facts.length > 0 ? <Row label="Con quién">{facts.join(' · ')}</Row> : null}
              {i.reaction ? (
                <Row label="Reacción">
                  <span className={REACTION_CLASSES[i.reaction]}>{REACTION_LABELS[i.reaction]}</span>
                </Row>
              ) : null}
              {i.offeredModel || i.offeredAmount ? (
                <Row label="Le ofreció">
                  {[i.offeredModel ? AGENCY_OFFERED_MODEL_LABELS[i.offeredModel] : null, i.offeredAmount].filter(Boolean).join(' · ')}
                </Row>
              ) : null}
              {i.objection ? (
                <Row label="Objeción">
                  {i.objection === 'other' ? `Otra: ${i.objectionOther ?? ''}` : AGENCY_OBJECTION_LABELS[i.objection]}
                </Row>
              ) : null}
              {i.discardReason ? <Row label="Motivo del descarte">{i.discardReason}</Row> : null}
            </dl>
            {i.questionsAnswers ? <Block label="Qué preguntó y qué le respondió">{i.questionsAnswers}</Block> : null}
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
