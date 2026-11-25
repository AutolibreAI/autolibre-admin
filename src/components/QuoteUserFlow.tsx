import { useId, useRef, useState, type ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Check, PhoneCall, UserRound, Users } from 'lucide-react'
import {
  QUOTE_USER_OUTCOME_DECLARATIONS,
  QUOTE_USER_OUTCOME_DECLARATION_LABELS,
  actorLabel,
  canDeclareOutcomeOnBehalf,
  canSelectProposalOnBehalf,
  declareQuoteUserOutcomeOnBehalfSchema,
  performedOnBounds,
  provenanceSource,
  readableDeclareOutcomeError,
  readableSelectProposalError,
  type DeclareQuoteUserOutcomeOnBehalfInput,
  type QuoteUserFlowErrorAction,
  type QuoteUserFlowProvenance,
  type QuoteUserFlowStepProvenance,
  type QuoteUserOutcomeDeclaration,
} from '~/lib/quote-user-flow'
import { formatPlainDay, quoteUserOutcomeLabel, readableQuoteRequestError, type QuoteRequestDetail } from '~/lib/quote-requests'
import { declareQuoteUserOutcomeOnBehalfFn, selectQuoteProposalOnBehalfFn } from '~/fn/quote-user-flow'
import { Button } from '~/components/ui/button'
import { Card, CardContent } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { formatDateTime } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { QuoteProposal } from '~/lib/quote-proposals'

/**
 * «Completar en nombre de la persona» — el equipo la llama y carga desde la
 * ficha los dos pasos que dejó sin hacer en la app: elegir la propuesta y
 * declarar si fue al taller. Escribe por HTTP (`~/fn/quote-user-flow`) y
 * después RELEE el loader (`router.invalidate()`): sin movimiento optimista.
 *
 * Reseñar al taller en su nombre: NUNCA. No hay acción para eso, a propósito.
 * Sin cuenta: ninguna de las dos acciones aparece (`~/lib/quote-user-flow`).
 *
 * Se relaciona con `QuoteClosureCard` / `/leads/pedidos/cierres` (b2c5e45):
 * aquel es el diseño, con mocks, de un cierre declarado MÁS RICO (con quién,
 * monto, estado del trabajo, disputa). Esto no lo conecta ni lo reemplaza:
 * carga los dos datos que ya existen (`selected_proposal_id`, `user_outcome`),
 * que son justamente los que esa tarjeta lee como «lo real».
 */

function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-xs leading-relaxed text-destructive">
      {children}
    </p>
  )
}

/** Lo que la UI hace con un error: texto, y si hay que releer la ficha o se puede reintentar igual. */
function useFlowError() {
  const router = useRouter()
  const [error, setError] = useState<{ text: string; action: QuoteUserFlowErrorAction } | null>(null)
  async function fail(readable: { text: string; action: QuoteUserFlowErrorAction } | null, cause: unknown) {
    const e = readable ?? { text: readableQuoteRequestError(cause), action: 'fix' as const }
    setError(e)
    if (e.action === 'reload') await router.invalidate()
  }
  return { error, setError, fail }
}

// ── Procedencia ─────────────────────────────────────────────────────────────

/**
 * «Cargado por el equipo (admin, fecha)» vs «Declarado por la persona en la
 * app». Sólo se pinta si el paso TIENE dato (`hasValue`): sin elección o sin
 * resultado no hay procedencia que decir.
 */
export function QuoteUserFlowProvenanceLine({
  provenance,
  step,
  hasValue,
  at,
  className,
}: {
  provenance: QuoteUserFlowProvenance
  step: 'selection' | 'outcome'
  hasValue: boolean
  /** `selected_at` / `user_outcome_at`. */
  at: string | null
  className?: string
}) {
  if (!hasValue) return null
  if (!provenance.available)
    return (
      <span className={cn('block text-xs text-muted-foreground', className)}>
        Quién lo cargó: falta la migración del backend en esta base
      </span>
    )

  const p: QuoteUserFlowStepProvenance = provenance[step]
  const when = at ? `, ${formatDateTime(at)} UTC` : ''
  if (provenanceSource(p.source) === 'operator')
    return (
      <span className={cn('flex items-center gap-1 text-xs text-status-yellow', className)}>
        <Users className="size-3 shrink-0" aria-hidden />
        Cargado por el equipo ({actorLabel(p.by)}
        {when})
      </span>
    )
  return (
    <span className={cn('flex items-center gap-1 text-xs text-muted-foreground', className)}>
      <UserRound className="size-3 shrink-0" aria-hidden />
      {step === 'selection' ? 'Elegida por la persona en la app' : 'Declarado por la persona en la app'}
      {when}
    </span>
  )
}

// ── 1. Marcar la propuesta como elegida por la persona ──────────────────────

/**
 * Va en cada propuesta ACTIVA no elegida. La confirmación dice qué se está
 * afirmando (que la persona la eligió, por teléfono) y, si ya había otra
 * elegida, que se reemplaza.
 */
export function MarkProposalSelectedButton({
  quoteRequestId,
  proposal,
  facts,
  currentSelection,
}: {
  quoteRequestId: string
  proposal: QuoteProposal
  facts: QuoteRequestDetail
  /** La propuesta elegida hoy, si hay otra. */
  currentSelection: QuoteProposal | null
}) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const { error, setError, fail } = useFlowError()
  const inFlight = useRef(false)

  if (!canSelectProposalOnBehalf(facts)) return null

  async function confirm() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await selectQuoteProposalOnBehalfFn({ data: { quoteRequestId, proposalId: proposal.id } })
      setConfirming(false)
      await router.invalidate()
    } catch (cause) {
      await fail(readableSelectProposalError(cause), cause)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (!confirming)
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setError(null)
            setConfirming(true)
          }}
          className="h-6 gap-1 px-1.5 text-xs"
        >
          <PhoneCall className="size-3.5" aria-hidden />
          Marcar como elegida por el usuario
        </Button>
        {error ? <ErrorText>{error.text}</ErrorText> : null}
      </div>
    )

  return (
    <div className="mt-2 w-full rounded-md border border-status-yellow/30 bg-status-yellow-bg p-2">
      <p className="text-xs leading-relaxed text-status-yellow">
        Vas a registrar que <strong>la persona eligió «{proposal.providerName}»</strong>, porque te lo dijo. Queda
        cargado por el equipo, a tu nombre, y en la app se ve como su elección.
        {currentSelection ? (
          <>
            {' '}
            <strong>Reemplaza la elección actual</strong> («{currentSelection.providerName}»).
          </>
        ) : null}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void confirm()}
          className="h-7 gap-1.5 px-2.5 text-xs"
        >
          <Check className="size-3.5" aria-hidden />
          {busy ? 'Guardando…' : 'Sí, la eligió'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => setConfirming(false)}
          className="h-7 px-2.5 text-xs"
        >
          Volver
        </Button>
      </div>
      {error ? (
        <div className="mt-2">
          <ErrorText>{error.text}</ErrorText>
        </div>
      ) : null}
    </div>
  )
}

// ── 2. Declarar si fue al taller ────────────────────────────────────────────

/**
 * La tarjeta del resultado de la persona: lo que hay hoy (con quién lo cargó)
 * y, si el pedido lo admite, «Declarar si fue». Oculta del todo sin cuenta: el
 * resultado de un pedido sin cuenta es el del operador, en «Cerrar pedido».
 */
export function QuoteUserOutcomeCard({
  detail: d,
  provenance,
  selectedProposal,
}: {
  detail: QuoteRequestDetail
  provenance: QuoteUserFlowProvenance
  /** La propuesta elegida, como contexto («taller: X»). */
  selectedProposal: QuoteProposal | null
}) {
  if (d.userId === null) return null
  const declarable = canDeclareOutcomeOnBehalf(d)

  return (
    <Card className="mb-4">
      <CardContent className="space-y-3 pt-6">
        <div>
          <h2 className="flex items-center gap-1.5 font-heading text-base font-semibold">
            <PhoneCall className="size-4 text-muted-foreground" aria-hidden />
            ¿Fue al taller?
          </h2>
          <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">
            Lo que la persona declara en la app después de recibir propuestas. Si no lo hizo, llamala y cargalo acá en
            su nombre. La reseña del taller la deja ella sola, nunca el equipo.
          </p>
        </div>

        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="mb-0.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Resultado</dt>
            <dd>
              {d.userOutcome ? quoteUserOutcomeLabel(d.userOutcome) : <span className="text-muted-foreground">No declaró</span>}
              <QuoteUserFlowProvenanceLine
                provenance={provenance}
                step="outcome"
                hasValue={d.userOutcome !== null}
                at={d.userOutcomeAt}
                className="mt-0.5"
              />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="mb-0.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Fecha del trabajo</dt>
            <dd>
              {provenance.available && provenance.outcome.performedOn ? (
                formatPlainDay(provenance.outcome.performedOn)
              ) : (
                <span className="text-muted-foreground">{provenance.available ? '—' : 'falta la migración del backend'}</span>
              )}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="mb-0.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Taller elegido</dt>
            <dd>{selectedProposal ? selectedProposal.providerName : <span className="text-muted-foreground">ninguno</span>}</dd>
          </div>
        </dl>

        {declarable ? (
          <DeclareOutcomeForm key={d.id} detail={d} selectedProposal={selectedProposal} />
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {d.closeReasonCode === 'cancelled_by_user'
              ? 'La persona canceló el pedido desde la app: no hay resultado que declarar.'
              : 'Todavía no se le respondió (falta «Respondido»): hasta entonces no hay nada que declarar.'}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function DeclareOutcomeForm({
  detail: d,
  selectedProposal,
}: {
  detail: QuoteRequestDetail
  selectedProposal: QuoteProposal | null
}) {
  const router = useRouter()
  const formId = useId()
  const [open, setOpen] = useState(false)
  const [outcome, setOutcome] = useState<QuoteUserOutcomeDeclaration | null>(null)
  const [performedOn, setPerformedOn] = useState('')
  const [invalid, setInvalid] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // El payload que salió: «Reintentar» reenvía ESTE, nunca lo rearma del formulario.
  const [sent, setSent] = useState<DeclareQuoteUserOutcomeOnBehalfInput | null>(null)
  const { error, setError, fail } = useFlowError()
  const inFlight = useRef(false)

  // Calculado al abrir (handler), no en el render: el "hoy" del SSR no es el del navegador.
  const [bounds, setBounds] = useState<{ min: string; max: string } | null>(null)

  function start() {
    setBounds(performedOnBounds(d.createdAt))
    setOutcome(null)
    setPerformedOn('')
    setInvalid(null)
    setError(null)
    setSent(null)
    setOpen(true)
  }

  async function send(payload: DeclareQuoteUserOutcomeOnBehalfInput) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setSent(payload)
    try {
      await declareQuoteUserOutcomeOnBehalfFn({ data: payload })
      setOpen(false)
      setSent(null)
      await router.invalidate()
    } catch (cause) {
      await fail(readableDeclareOutcomeError(cause), cause)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  function submit() {
    if (!outcome) {
      setInvalid('Elegí qué te dijo.')
      return
    }
    if (outcome === 'hired' && bounds && performedOn && (performedOn < bounds.min || performedOn > bounds.max)) {
      setInvalid(`La fecha va del ${formatPlainDay(bounds.min)} (cuando entró el pedido) a hoy.`)
      return
    }
    const parsed = declareQuoteUserOutcomeOnBehalfSchema.safeParse({
      quoteRequestId: d.id,
      outcome,
      ...(outcome === 'hired' && performedOn ? { performedOn } : {}),
    })
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? 'Revisá los datos.')
      return
    }
    setInvalid(null)
    void send(parsed.data)
  }

  if (!open)
    return (
      <Button type="button" size="sm" variant="outline" onClick={start} className="gap-1.5">
        <PhoneCall className="size-3.5" aria-hidden />
        {d.userOutcome ? 'Corregir lo que declaró' : 'Declarar si fue'}
      </Button>
    )

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {selectedProposal ? (
          <>
            Taller: <span className="font-medium text-foreground">{selectedProposal.providerName}</span> (la propuesta
            elegida).{' '}
          </>
        ) : (
          'No hay propuesta elegida. Si fue a un taller que no estaba entre las propuestas, contalo en una nota interna. '
        )}
        Queda cargado por el equipo, a tu nombre.
      </p>

      <fieldset>
        <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          ¿Qué te dijo?
        </legend>
        <div className="flex flex-wrap gap-2" role="radiogroup">
          {QUOTE_USER_OUTCOME_DECLARATIONS.map((o) => (
            <Button
              key={o}
              type="button"
              size="sm"
              role="radio"
              aria-checked={outcome === o}
              variant={outcome === o ? 'default' : 'outline'}
              disabled={busy}
              onClick={() => {
                setOutcome(o)
                setInvalid(null)
              }}
            >
              {QUOTE_USER_OUTCOME_DECLARATION_LABELS[o]}
            </Button>
          ))}
        </div>
      </fieldset>

      {outcome === 'hired' && bounds ? (
        <div>
          <label htmlFor={`${formId}-performed-on`} className="mb-1 block text-xs font-medium text-muted-foreground">
            ¿Qué día se hizo el trabajo? (obligatorio)
          </label>
          <Input
            id={`${formId}-performed-on`}
            type="date"
            required
            min={bounds.min}
            max={bounds.max}
            value={performedOn}
            disabled={busy}
            onChange={(e) => {
              setPerformedOn(e.target.value)
              setInvalid(null)
            }}
            className="w-44"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            La fecha real, no la de hoy: del {formatPlainDay(bounds.min)} a hoy.
          </p>
        </div>
      ) : null}

      {invalid ? <ErrorText>{invalid}</ErrorText> : null}
      {error ? <ErrorText>{error.text}</ErrorText> : null}

      <div className="flex flex-wrap gap-2">
        {error?.action === 'retry' && sent ? (
          <Button type="button" size="sm" disabled={busy} onClick={() => void send(sent)}>
            {busy ? 'Reintentando…' : 'Reintentar'}
          </Button>
        ) : (
          <Button type="button" size="sm" disabled={busy || error?.action === 'reload'} onClick={submit}>
            {busy ? 'Guardando…' : 'Guardar'}
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}
