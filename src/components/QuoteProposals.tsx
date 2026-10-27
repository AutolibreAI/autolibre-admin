import { useId, useRef, useState, type ReactNode } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { Check, Pencil, Plus, SearchX, Smartphone, Star, Undo2, X } from 'lucide-react'
import {
  MAX_PROPOSAL_DESCRIPTION,
  MAX_PROPOSAL_INTERNAL_NOTES,
  MAX_PROPOSAL_PROVIDER_ADDRESS,
  MAX_PROPOSAL_PROVIDER_NAME,
  MAX_PROPOSAL_RECOMMENDATION_REASON,
  MAX_QUOTE_PROPOSAL_SLOTS,
  parseQuoteProposalError,
  quoteProposalContentSchema,
  readableQuoteProposalError,
  responseToProposalDraft,
  todayUtc,
  type QuoteProposal,
  type QuoteProposalContent,
  type QuoteProposalDraft,
  type QuoteProposalsResult,
} from '~/lib/quote-proposals'
import {
  QUOTE_CURRENCIES,
  formatAmount,
  formatQuoteAmount,
  quoteCurrencyLabel,
  quoteItemsTotals,
  type QuoteCurrency,
  type QuoteResponse,
} from '~/lib/quote-responses'
import { amountToInput, newItemKey, readAmounts, readItems, type ItemDraft } from '~/lib/amounts'
import {
  closeQuoteProposalsSearchFn,
  correctQuoteProposalFn,
  sendQuoteProposalsFn,
  withdrawQuoteProposalFn,
} from '~/fn/quote-proposals'
import { Hint, ItemsEditor, ItemsSummary, PartnerCombobox } from '~/components/QuoteContentFields'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '~/components/ui/sheet'
import { formatDate, formatDateTime, formatInt } from '~/lib/format'
import { quoteChannelLabel } from '~/lib/quote-requests'
import { cn } from '~/lib/utils'
import type { PartnerOption } from '~/lib/partners'

/**
 * «Propuestas en la app» — lo que se le PUBLICA a la persona en la app, con
 * push: hasta 3 propuestas activas por pedido en `public.quote_request_proposals`
 * (backend, 0120–0122). → `.claude/rules/quote-proposals.md`
 *
 * Desde el 2026-10-27 es el ÚNICO lugar donde el operador carga lo que
 * consiguió, llegue el pedido por la app o por WhatsApp: la tarjeta de
 * Presupuestos (`ops.quote_request_response`) se sacó de la ficha, y las
 * propuestas activas arman el mensaje «Presupuestos» de WhatsApp. Sin cuenta
 * no le llegan a ninguna app — se guardan igual y viajan por ese mensaje. Los
 * presupuestos viejos de `ops` todavía pueden SEMBRAR una propuesta (el
 * operador los tilda), nunca se publican solos.
 *
 * ── Lee por SQL, escribe por HTTP ───────────────────────────────────────────
 *
 * La lectura viene del loader (`listQuoteProposalsFn`). Cada escritura va al
 * backend hex con el token de Clerk del admin, y después se RELEE el loader
 * (`router.invalidate()`): sin movimiento optimista, lo que se ve es lo que
 * quedó guardado. Nada de acá escribe `quote_request_proposals` por SQL.
 *
 * ── Idempotencia: `sendId` y `closureId` los genera el CLIENTE ─────────────
 *
 * Mismo patrón que `broadcastId` en `BroadcastComposer`: el id se genera al
 * ABRIR (en el handler, nunca en SSR), se conserva ante un error, un cierre del
 * panel o un doble click, y se regenera SÓLO después de un éxito. Un timeout
 * puede haber guardado el envío: reintentar con el mismo id no lo duplica ni
 * le vuelve a sonar el teléfono a la persona.
 */

// ── La tarjeta ──────────────────────────────────────────────────────────────

export function QuoteProposals({
  quoteRequestId,
  data,
  responses,
  partners,
  hasUser,
  channel,
  status,
}: {
  quoteRequestId: string
  data: QuoteProposalsResult
  /** Los presupuestos viejos de `ops` (antes del 2026-10-27), sólo para precargar. */
  responses: Array<QuoteResponse>
  partners: Array<PartnerOption>
  /** El pedido tiene cuenta de AutoLibre: hay a quién mandarle el push. */
  hasUser: boolean
  /** Por dónde entró, para decir por dónde le llegan las propuestas. */
  channel: string
  status: string
}) {
  if (!data.available) {
    return (
      <Card className="mb-4">
        <CardContent className="pt-6">
          <SectionHeader count={null} />
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">
            Esta base todavía no tiene las migraciones 0120–0122 del backend (la tabla de envíos y las columnas nuevas
            de <code className="font-mono">quote_request_proposals</code>). Hasta que se desplieguen, no se pueden
            cargar propuestas desde acá, y el mensaje «Presupuestos» sale sin ellas — el resto de la ficha funciona
            igual.
          </p>
        </CardContent>
      </Card>
    )
  }

  const closed = status === 'closed'
  const recommended = data.active.find((p) => p.isRecommended) ?? null
  const slots = Array.from({ length: MAX_QUOTE_PROPOSAL_SLOTS }, (_, i) => i + 1)

  return (
    <Card className="mb-4">
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SectionHeader count={data.active.length} />
          {!closed ? (
            <div className="flex shrink-0 flex-wrap gap-1.5">
              {data.freeSlots > 0 ? (
                <ProposalSheet
                  mode="send"
                  quoteRequestId={quoteRequestId}
                  freeSlots={data.freeSlots}
                  responses={responses}
                  partners={partners}
                  otherRecommended={recommended}
                  hasUser={hasUser}
                />
              ) : null}
              {data.searchClosedAt === null ? (
                <CloseSearchButton quoteRequestId={quoteRequestId} active={data.active.length} hasUser={hasUser} />
              ) : null}
            </div>
          ) : null}
        </div>

        {closed ? (
          <Warn>El pedido está cerrado: no admite propuestas nuevas ni cambios en las cargadas.</Warn>
        ) : data.freeSlots === 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Los {formatInt(MAX_QUOTE_PROPOSAL_SLOTS)} lugares están ocupados. Para cargar otra, retirá una de las
            activas.
          </p>
        ) : null}

        {!hasUser ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {channel === 'app' ? 'Entró por la app sin cuenta' : `Entró por ${quoteChannelLabel(channel)}`} y no tiene
            cuenta de AutoLibre: las propuestas se guardan pero no le llegan a ninguna app. Mandáselas con el mensaje
            «Presupuestos» de arriba, que se arma con estas mismas.
          </p>
        ) : null}

        {data.searchClosedAt !== null ? (
          <p className="rounded-md border border-border bg-secondary px-3 py-2 text-xs leading-relaxed">
            <span className="font-medium">Búsqueda cerrada</span> el {formatDateTime(data.searchClosedAt)} UTC: la
            persona ya no espera más propuestas. El pedido sigue en su estado — cerrarlo es otra acción.
          </p>
        ) : null}

        <ol className="space-y-2">
          {slots.map((position) => {
            const p = data.active.find((x) => x.position === position)
            return (
              <li key={position}>
                {p ? (
                  <ProposalRow
                    proposal={p}
                    quoteRequestId={quoteRequestId}
                    selected={data.selectedProposalId === p.id}
                    selectedAt={data.selectedProposalId === p.id ? data.selectedAt : null}
                    partners={partners}
                    otherRecommended={recommended !== null && recommended.id !== p.id ? recommended : null}
                    readOnly={closed}
                  />
                ) : (
                  <div className="flex items-baseline gap-1.5 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                    <span className="text-xs font-semibold tabular-nums">{position}.</span>
                    lugar libre
                  </div>
                )}
              </li>
            )
          })}
        </ol>

        {data.sends.length > 0 ? (
          <section>
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Envíos</h3>
            <ul className="mt-1 space-y-0.5 text-xs">
              {data.sends.map((s) => (
                <li key={s.id} className="flex flex-wrap gap-x-2">
                  <span className="tabular-nums">{formatDateTime(s.sentAt)} UTC</span>
                  <span className="text-muted-foreground">por {s.sentByEmail ?? 'un admin que ya no está'}</span>
                  {s.closesSearch ? <span className="text-muted-foreground">· cerró la búsqueda</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {data.withdrawn.length > 0 ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              {data.withdrawn.length === 1 ? 'Una propuesta retirada' : `${formatInt(data.withdrawn.length)} propuestas retiradas`}
            </summary>
            <ul className="mt-2 space-y-1">
              {data.withdrawn.map((p) => (
                <li key={p.id} className="rounded-md border border-border px-3 py-1.5 text-muted-foreground">
                  <span className="font-medium text-foreground">{p.providerName}</span>
                  {' · '}
                  {formatQuoteAmount(p) ?? 'a confirmar'}
                  {p.withdrawnAt ? ` · retirada ${formatDateTime(p.withdrawnAt)} UTC` : ''}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <p className="border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
          {hasUser
            ? 'Cada carga le llega a la persona como push y queda en la app; corregir no avisa de nuevo. '
            : ''}
          Las activas arman el mensaje «Presupuestos» de WhatsApp. El backend registra cada carga a tu nombre, y desde
          la primera «Propuestas devueltas» del pedido lo lleva él: es la cantidad de activas acá.
        </p>
      </CardContent>
    </Card>
  )
}

function SectionHeader({ count }: { count: number | null }) {
  return (
    <div>
      <h2 className="flex items-center gap-1.5 font-heading text-base font-semibold">
        <Smartphone className="size-4 text-muted-foreground" aria-hidden />
        Propuestas
        {count !== null && count > 0 ? (
          <span className="text-sm font-normal text-muted-foreground">
            ({formatInt(count)} de {formatInt(MAX_QUOTE_PROPOSAL_SLOTS)})
          </span>
        ) : null}
      </h2>
      <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">
        Lo que conseguiste para este pedido. Con cuenta, la persona las ve y elige en la app; siempre, arman el
        mensaje «Presupuestos» de WhatsApp. Hasta {formatInt(MAX_QUOTE_PROPOSAL_SLOTS)} activas por pedido.
      </p>
    </div>
  )
}

function Warn({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-status-yellow/30 bg-status-yellow-bg px-3 py-2 text-xs leading-relaxed text-status-yellow">
      {children}
    </p>
  )
}

function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-xs leading-relaxed text-destructive">
      {children}
    </p>
  )
}

const dayLabel = (yyyyMmDd: string) => formatDate(`${yyyyMmDd}T00:00:00.000Z`)

// ── Una propuesta activa ────────────────────────────────────────────────────

function ProposalRow({
  proposal: p,
  quoteRequestId,
  selected,
  selectedAt,
  partners,
  otherRecommended,
  readOnly,
}: {
  proposal: QuoteProposal
  quoteRequestId: string
  selected: boolean
  selectedAt: string | null
  partners: Array<PartnerOption>
  otherRecommended: QuoteProposal | null
  readOnly: boolean
}) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  /** Retirar es idempotente del lado del backend: un doble click no rompe nada, pero la ref ahorra el segundo request. */
  async function withdraw() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await withdrawQuoteProposalFn({ data: { quoteRequestId, proposalId: p.id } })
      setConfirming(false)
      await router.invalidate()
    } catch (cause) {
      setError(readableQuoteProposalError(cause))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const amount = formatQuoteAmount(p)
  const contact = p.partnerId === null ? [p.providerAddress, p.providerPhone].filter((v): v is string => !!v).join(' · ') : ''

  return (
    <div className={cn('rounded-md border bg-card px-3 py-2', selected ? 'border-brand/40' : 'border-border')}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-1.5">
          <span className="shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">{p.position}.</span>
          {p.partnerId ? (
            <Link
              to="/partners/$partnerId"
              params={{ partnerId: p.partnerId }}
              className="truncate font-medium text-brand hover:underline"
            >
              {p.providerName}
            </Link>
          ) : (
            <span className="truncate font-medium">{p.providerName}</span>
          )}
          {p.isRecommended ? (
            <Badge variant="outline" className="shrink-0 gap-1 border-brand/30 bg-brand-soft text-brand">
              <Star className="size-3" aria-hidden />
              Recomendada
            </Badge>
          ) : null}
          {selected ? (
            <Badge variant="outline" className="shrink-0 gap-1 border-brand/30 bg-brand-soft text-brand">
              <Check className="size-3" aria-hidden />
              Elegida{selectedAt ? ` el ${formatDateTime(selectedAt)} UTC` : ''}
            </Badge>
          ) : null}
        </div>
        <div className="flex shrink-0 items-baseline gap-3">
          <span className={cn('text-sm tabular-nums', amount ? 'font-semibold' : 'text-muted-foreground')}>
            {amount ?? 'a confirmar'}
          </span>
          {p.validUntil ? (
            <span className={cn('text-xs tabular-nums', p.expired ? 'text-status-yellow' : 'text-muted-foreground')}>
              {p.expired ? 'venció' : 'vig.'} {dayLabel(p.validUntil)}
            </span>
          ) : null}
        </div>
      </div>

      {contact ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{contact}</p> : null}
      {p.partnerId !== null && !p.partnerHasWhatsapp ? (
        <p className="mt-0.5 text-xs text-status-yellow">
          El partner no tiene WhatsApp en su ficha: la persona no va a tener por dónde escribirle.
        </p>
      ) : null}

      {p.items.length > 0 ? <ItemsSummary items={p.items} currency={p.currency} /> : null}

      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{p.description}</p>

      {p.isRecommended && p.recommendationReason ? (
        <p className="mt-1 text-xs leading-relaxed">
          <span className="text-muted-foreground">Por qué la recomendamos: </span>
          {p.recommendationReason}
        </p>
      ) : null}

      {p.internalNotes ? (
        <p className="mt-1 rounded border border-border bg-secondary px-2 py-1 text-xs leading-relaxed">
          <span className="text-muted-foreground">Nota interna (no la ve la persona): </span>
          {p.internalNotes}
        </p>
      ) : null}

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          enviada {formatDateTime(p.createdAt)} UTC
          {p.updatedAt && p.updatedAt !== p.createdAt ? ` · corregida ${formatDateTime(p.updatedAt)} UTC` : ''}
          {amount && p.currency !== 'ARS' ? ` · en ${quoteCurrencyLabel(p.currency).toLowerCase()}` : ''}
        </span>
        {!readOnly && !confirming ? (
          <div className="flex items-center gap-1">
            <ProposalSheet
              mode="edit"
              quoteRequestId={quoteRequestId}
              proposal={p}
              partners={partners}
              otherRecommended={otherRecommended}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setError(null)
                setConfirming(true)
              }}
              className="h-6 gap-1 px-1.5 text-xs text-destructive hover:text-destructive"
            >
              <Undo2 className="size-3.5" aria-hidden />
              Retirar
            </Button>
          </div>
        ) : null}
      </div>

      {confirming ? (
        <div className="mt-2 rounded-md border border-status-yellow/30 bg-status-yellow-bg p-2">
          <p className="text-xs leading-relaxed text-status-yellow">
            Desaparece de la app y libera el lugar {p.position}.
            {p.isRecommended ? ' Era la recomendada: la persona deja de ver la recomendación.' : ''}
            {selected ? (
              <>
                {' '}
                <strong>Es la que eligió la persona</strong>: retirarla le borra la elección y vuelve a «Sin elegir».
              </>
            ) : null}{' '}
            No se le manda ningún aviso.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void withdraw()}
              className="h-7 gap-1.5 px-2.5 text-xs"
            >
              <Undo2 className="size-3.5" aria-hidden />
              {busy ? 'Retirando…' : 'Sí, retirar'}
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
        </div>
      ) : null}

      {error ? <div className="mt-2"><ErrorText>{error}</ErrorText></div> : null}
    </div>
  )
}

// ── Cerrar la búsqueda (no el pedido) ───────────────────────────────────────

/**
 * "No buscamos más propuestas". NO cierra el pedido: el estado no se mueve, y
 * por eso el rótulo nunca dice «Cerrar pedido» — ése es otro botón, otro SP y
 * otra consecuencia. `closureId` sigue el mismo ciclo que `sendId`.
 */
function CloseSearchButton({
  quoteRequestId,
  active,
  hasUser,
}: {
  quoteRequestId: string
  active: number
  hasUser: boolean
}) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [closureId, setClosureId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  function open() {
    // En el handler, nunca en el render: `crypto.randomUUID()` no corre en SSR.
    if (!closureId) setClosureId(crypto.randomUUID())
    setError(null)
    setConfirming(true)
  }

  async function confirm() {
    if (!closureId || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await closeQuoteProposalsSearchFn({ data: { quoteRequestId, closureId } })
      setConfirming(false)
      setClosureId(null)
      await router.invalidate()
    } catch (cause) {
      // El id NO se toca: el reintento tiene que ser el mismo cierre.
      setError(readableQuoteProposalError(cause))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (!confirming) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={open} className="gap-1.5">
        <SearchX className="size-3.5" aria-hidden />
        Cerrar búsqueda
      </Button>
    )
  }

  return (
    <div className="w-full max-w-md rounded-md border border-status-yellow/30 bg-status-yellow-bg p-2 sm:w-auto">
      <p className="text-xs leading-relaxed text-status-yellow">
        Le dice a la persona que no vamos a mandar más propuestas. <strong>No cierra el pedido</strong>: sigue en su
        estado, y cerrarlo es «Cerrar pedido», más abajo.
      </p>
      <p className="mt-1 text-xs leading-relaxed text-status-yellow">
        {!hasUser
          ? 'El pedido no tiene cuenta de AutoLibre: no hay a quién notificar.'
          : active === 0
            ? 'No hay ninguna propuesta activa: la persona va a recibir un push avisándole que no conseguimos talleres para su pedido.'
            : `Las ${formatInt(active)} ${active === 1 ? 'propuesta activa sigue' : 'propuestas activas siguen'} en la app para que elija.`}
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
          <SearchX className="size-3.5" aria-hidden />
          {busy ? 'Cerrando…' : 'Sí, cerrar la búsqueda'}
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
      {error ? <div className="mt-2"><ErrorText>{error}</ErrorText></div> : null}
    </div>
  )
}

// ── El formulario de una propuesta ──────────────────────────────────────────

interface ProposalForm {
  /** Sólo para React. */
  key: string
  /** El presupuesto de `ops` del que se sembró, si vino de la precarga. */
  sourceResponseId: string | null
  partnerId: string | null
  providerName: string
  /** El nombre del partner cuando no está entre las opciones activas. */
  partnerLabel: string | null
  providerAddress: string
  providerPhone: string
  description: string
  amountMin: string
  amountMax: string
  currency: QuoteCurrency
  items: Array<ItemDraft>
  validUntil: string
  internalNotes: string
  isRecommended: boolean
  recommendationReason: string
  /** Lo que la precarga tuvo que recortar o completar. */
  warnings: Array<string>
}

let formSeq = 0
const newFormKey = () => `proposal-${++formSeq}`

function toCurrency(raw: string): QuoteCurrency {
  return (QUOTE_CURRENCIES as ReadonlyArray<string>).includes(raw) ? (raw as QuoteCurrency) : 'ARS'
}

function blankForm(): ProposalForm {
  return {
    key: newFormKey(),
    sourceResponseId: null,
    partnerId: null,
    providerName: '',
    partnerLabel: null,
    providerAddress: '',
    providerPhone: '',
    description: '',
    amountMin: '',
    amountMax: '',
    currency: 'ARS',
    items: [],
    validUntil: '',
    internalNotes: '',
    isRecommended: false,
    recommendationReason: '',
    warnings: [],
  }
}

/** Un precio cerrado (`min === max`) se siembra como un solo número, igual que en Presupuestos. */
function amountFields(min: number | null, max: number | null, itemized: boolean) {
  if (itemized || min === null) return { amountMin: '', amountMax: '' }
  return { amountMin: amountToInput(min), amountMax: max === null || max === min ? '' : amountToInput(max) }
}

function formFromDraft(draft: QuoteProposalDraft, sourceResponseId: string, label: string, warnings: Array<string>): ProposalForm {
  return {
    ...blankForm(),
    sourceResponseId,
    partnerId: draft.partnerId,
    providerName: draft.providerName,
    partnerLabel: draft.partnerId ? label : null,
    providerAddress: draft.providerAddress,
    providerPhone: draft.providerPhone,
    description: draft.description,
    ...amountFields(draft.amountMin, draft.amountMax, draft.items.length > 0),
    currency: draft.currency,
    items: draft.items.map((it) => ({ key: newItemKey(), label: it.label, amount: amountToInput(it.amount), optional: it.optional })),
    validUntil: draft.validUntil ?? '',
    warnings,
  }
}

function formFromProposal(p: QuoteProposal): ProposalForm {
  return {
    ...blankForm(),
    partnerId: p.partnerId,
    providerName: p.partnerId ? '' : p.providerName,
    partnerLabel: p.partnerId ? p.providerName : null,
    providerAddress: p.providerAddress ?? '',
    providerPhone: p.providerPhone ?? '',
    description: p.description,
    ...amountFields(p.amountMin, p.amountMax, p.items.length > 0),
    currency: toCurrency(p.currency),
    items: p.items.map((it) => ({ key: newItemKey(), label: it.label, amount: amountToInput(it.amount), optional: it.optional })),
    validUntil: p.validUntil ?? '',
    internalNotes: p.internalNotes ?? '',
    isRecommended: p.isRecommended,
    recommendationReason: p.recommendationReason ?? '',
  }
}

/**
 * Del formulario al contrato. Los opcionales vacíos NO viajan: el backend
 * rechaza un string en blanco, y la corrección es reemplazo completo (lo que no
 * viaja queda vacío). Devuelve el primer problema en castellano, o el contenido
 * ya validado por el MISMO schema que usa el server function.
 */
function buildContent(f: ProposalForm): { content: QuoteProposalContent } | { problem: string } {
  const isPartner = f.partnerId !== null
  const itemized = f.items.length > 0
  const parsedItems = readItems(f)
  if (parsedItems.invalid) return { problem: 'Revisá los ítems: cada uno necesita qué es y un precio (0 vale).' }
  const amounts = itemized ? { invalid: false as const, min: undefined, max: undefined } : readAmounts(f)
  if (amounts.invalid)
    return { problem: 'Revisá el precio: cargá «desde» (o las dos puntas, con desde ≤ hasta), o dejá los dos vacíos («a confirmar»).' }

  const opt = (v: string) => (v.trim() === '' ? undefined : v.trim())
  const parsed = quoteProposalContentSchema.safeParse({
    partnerId: f.partnerId ?? undefined,
    providerName: isPartner ? undefined : f.providerName.trim(),
    providerAddress: isPartner ? undefined : opt(f.providerAddress),
    providerPhone: isPartner ? undefined : opt(f.providerPhone),
    description: f.description.trim(),
    amountMin: amounts.min,
    amountMax: amounts.max,
    currency: f.currency,
    items: itemized ? parsedItems.items : undefined,
    validUntil: opt(f.validUntil),
    internalNotes: opt(f.internalNotes),
    isRecommended: f.isRecommended,
    recommendationReason: f.isRecommended ? opt(f.recommendationReason) : undefined,
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    if (!isPartner && f.providerName.trim() === '') return { problem: 'Falta el taller.' }
    return { problem: issue?.message ?? 'Revisá los campos.' }
  }
  return { content: parsed.data }
}

// ── El Sheet: enviar (1..freeSlots) o corregir (1) ──────────────────────────

type SheetProps =
  | {
      mode: 'send'
      quoteRequestId: string
      freeSlots: number
      responses: Array<QuoteResponse>
      partners: Array<PartnerOption>
      /** La activa que ya es recomendada: con ella, una 2ª daría 409. */
      otherRecommended: QuoteProposal | null
      /** Con cuenta, cargar = push a la persona. Sin cuenta, sólo queda guardada. */
      hasUser: boolean
    }
  | {
      mode: 'edit'
      quoteRequestId: string
      proposal: QuoteProposal
      partners: Array<PartnerOption>
      otherRecommended: QuoteProposal | null
    }

function ProposalSheet(props: SheetProps) {
  const router = useRouter()
  const { mode, quoteRequestId, partners, otherRecommended } = props
  const freeSlots = props.mode === 'send' ? props.freeSlots : 1
  const responses = props.mode === 'send' ? props.responses : []

  const [open, setOpen] = useState(false)
  const [sendId, setSendId] = useState<string | null>(null)
  const [forms, setForms] = useState<Array<ProposalForm>>(() =>
    props.mode === 'edit' ? [formFromProposal(props.proposal)] : [],
  )
  const [closesSearch, setClosesSearch] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** El error del backend, pintado en la propuesta que lo causó (por índice). */
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  /** Hubo al menos un intento con el `sendId` actual. */
  const [attempted, setAttempted] = useState(false)
  /** `busy` se aplica en el próximo render; dos clicks en el mismo tick pasarían los dos. */
  const inFlight = useRef(false)

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) return
    if (props.mode === 'send') {
      // Una vez por envío: se conserva al cerrar y ante un error.
      if (!sendId) setSendId(crypto.randomUUID())
      if (forms.length === 0) setForms([blankForm()])
    } else if (!attempted) {
      // La corrección se re-siembra con lo guardado cada vez que se abre, salvo
      // que haya un intento fallido a medio corregir.
      setForms([formFromProposal(props.proposal)])
      setError(null)
      setRowErrors({})
    }
  }

  const update = (key: string, patch: Partial<ProposalForm>) =>
    setForms((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)))

  /** Recomendada es exclusiva: marcar una desmarca las demás del envío. */
  function setRecommended(key: string, value: boolean) {
    setForms((prev) => prev.map((f) => (f.key === key ? { ...f, isRecommended: value } : value ? { ...f, isRecommended: false } : f)))
  }

  const tickedIds = new Set(forms.map((f) => f.sourceResponseId).filter((v): v is string => v !== null))
  const full = forms.length >= freeSlots

  function toggleResponse(r: QuoteResponse, checked: boolean) {
    if (!checked) {
      setForms((prev) => prev.filter((f) => f.sourceResponseId !== r.id))
      return
    }
    if (full) {
      // Si hay una en blanco sin tocar, la precarga la reemplaza en vez de rechazar el tilde.
      const blank = forms.findIndex((f) => f.sourceResponseId === null && isUntouched(f))
      if (blank === -1) return
      const { draft, warnings } = responseToProposalDraft(r)
      setForms((prev) => prev.map((f, i) => (i === blank ? formFromDraft(draft, r.id, r.name, warnings) : f)))
      return
    }
    const { draft, warnings } = responseToProposalDraft(r)
    setForms((prev) => [...prev.filter((f) => !(f.sourceResponseId === null && isUntouched(f))), formFromDraft(draft, r.id, r.name, warnings)])
  }

  const built = forms.map(buildContent)
  const problems = built.map((b) => ('problem' in b ? b.problem : null))
  const recommendedCount = forms.filter((f) => f.isRecommended).length
  const valid =
    forms.length > 0 &&
    forms.length <= freeSlots &&
    problems.every((p) => p === null) &&
    recommendedCount <= 1 &&
    !(recommendedCount > 0 && otherRecommended !== null)

  async function submit() {
    if (!valid || inFlight.current) return
    const contents = built.flatMap((b) => ('content' in b ? [b.content] : []))
    inFlight.current = true
    setBusy(true)
    setError(null)
    setRowErrors({})
    try {
      if (props.mode === 'send') {
        if (!sendId) return
        setAttempted(true)
        await sendQuoteProposalsFn({ data: { quoteRequestId, sendId, closesSearch, proposals: contents } })
        // Envío nuevo: borrador limpio e id nuevo.
        setForms([])
        setClosesSearch(false)
        setAttempted(false)
        setSendId(crypto.randomUUID())
      } else {
        const content = contents[0]
        if (!content) return
        setAttempted(true)
        await correctQuoteProposalFn({ data: { quoteRequestId, proposalId: props.proposal.id, content } })
        setAttempted(false)
      }
      setOpen(false)
      await router.invalidate()
    } catch (cause) {
      // El `sendId` NO se toca: reintentar tiene que ser el mismo envío.
      const parsed = parseQuoteProposalError(cause)
      const message = readableQuoteProposalError(cause)
      const target = parsed?.proposalIndex !== null && parsed?.proposalIndex !== undefined ? forms[parsed.proposalIndex] : undefined
      if (target) setRowErrors({ [target.key]: message })
      else if (mode === 'edit' && forms[0] && parsed) setRowErrors({ [forms[0].key]: message })
      else setError(message)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const trigger =
    mode === 'send' ? (
      <Button type="button" size="sm" className="gap-1.5">
        <Plus className="size-3.5" aria-hidden />
        Cargar propuesta
      </Button>
    ) : (
      <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-xs">
        <Pencil className="size-3.5" aria-hidden />
        Corregir
      </Button>
    )

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent side="right" className="w-full max-w-full bg-card sm:w-[40rem]">
        <form
          className="flex h-full min-h-0 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="border-b border-border px-5 py-4 pr-10">
            <SheetTitle>{mode === 'send' ? 'Cargar propuestas' : `Corregir la propuesta ${props.mode === 'edit' ? props.proposal.position : ''}`}</SheetTitle>
            <SheetDescription className="mt-0.5 leading-relaxed">
              {mode === 'send'
                ? `Hasta ${formatInt(freeSlots)} ${freeSlots === 1 ? 'propuesta' : 'propuestas'} (los lugares libres). ${
                    props.mode === 'send' && props.hasUser
                      ? 'Le llegan a la persona como push y las ve en la app; también arman el mensaje «Presupuestos».'
                      : 'Sin cuenta no le llegan a ninguna app: quedan guardadas y arman el mensaje «Presupuestos» para WhatsApp.'
                  }`
                : 'Se reemplaza la propuesta entera: lo que quede vacío se borra, el precio incluido. A la persona NO se le avisa del cambio.'}
            </SheetDescription>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {mode === 'send' && responses.length > 0 ? (
              <section className="space-y-1.5">
                <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Precargar desde presupuestos anteriores
                </h3>
                <Hint>
                  Lo que se había cargado en la tarjeta vieja de Presupuestos. Tildá los que quieras: siembran el
                  formulario y los revisás antes de cargar. Nada se carga solo.
                </Hint>
                <ul className="space-y-1">
                  {responses.map((r) => {
                    const ticked = tickedIds.has(r.id)
                    const expired = r.expired === true || (r.validUntil !== null && r.validUntil < todayUtc())
                    const disabled = !ticked && (expired || (full && !forms.some((f) => f.sourceResponseId === null && isUntouched(f))))
                    return (
                      <li key={r.id}>
                        <label className={cn('flex items-baseline gap-2 text-xs', disabled && !ticked && 'opacity-60')}>
                          <input
                            type="checkbox"
                            checked={ticked}
                            disabled={disabled || busy}
                            onChange={(e) => {
                              const v = e.currentTarget.checked
                              toggleResponse(r, v)
                            }}
                          />
                          <span className="font-medium">{r.name}</span>
                          <span className="tabular-nums text-muted-foreground">{formatQuoteAmount(r) ?? 'sin precio'}</span>
                          {expired && r.validUntil ? (
                            <span className="text-status-yellow">vencido el {dayLabel(r.validUntil)}: no se puede publicar</span>
                          ) : null}
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ) : null}

            {forms.map((f, i) => (
              <ProposalFields
                key={f.key}
                index={i}
                form={f}
                partners={partners}
                removable={mode === 'send' && forms.length > 1}
                problem={problems[i] ?? null}
                backendError={rowErrors[f.key] ?? null}
                recommendLocked={otherRecommended !== null}
                otherRecommended={otherRecommended}
                onChange={(patch) => update(f.key, patch)}
                onRecommended={(v) => setRecommended(f.key, v)}
                onRemove={() => setForms((prev) => prev.filter((x) => x.key !== f.key))}
              />
            ))}

            {mode === 'send' ? (
              <div className="space-y-3">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={full || busy}
                  onClick={() => setForms((prev) => [...prev, blankForm()])}
                  className="gap-1.5"
                >
                  <Plus className="size-3.5" aria-hidden />
                  Otra propuesta
                </Button>
                {full ? (
                  <Hint>
                    Llegaste a los {formatInt(freeSlots)} {freeSlots === 1 ? 'lugar libre' : 'lugares libres'}.
                  </Hint>
                ) : null}

                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={closesSearch}
                    onChange={(e) => {
                      const v = e.currentTarget.checked
                      setClosesSearch(v)
                    }}
                  />
                  <span>
                    Es el último envío: cerrar la búsqueda
                    <Hint>
                      La persona deja de esperar más propuestas. No cierra el pedido.
                    </Hint>
                  </span>
                </label>
              </div>
            ) : null}

            {recommendedCount > 0 && otherRecommended !== null ? (
              <Warn>
                Ya hay una recomendada activa (lugar {otherRecommended.position}, {otherRecommended.providerName}). Para
                recomendar otra, primero corregí esa o retirala.
              </Warn>
            ) : null}
          </div>

          <div className="space-y-2 border-t border-border px-5 py-4">
            {error ? <ErrorText>{error}</ErrorText> : null}
            {attempted && !busy && mode === 'send' ? (
              <Warn>
                El intento anterior pudo haberse guardado. Reintentar es seguro —es la misma carga y no se duplica—,
                pero si cambiaste el contenido y el primero sí se guardó, los cambios no se aplican: recargá y corregí
                desde la tarjeta.
              </Warn>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" disabled={busy || !valid} className="gap-1.5">
                <Check className="size-3.5" aria-hidden />
                {busy
                  ? mode === 'send'
                    ? 'Cargando…'
                    : 'Guardando…'
                  : mode === 'send'
                    ? `Cargar ${forms.length === 1 ? 'la propuesta' : `${formatInt(forms.length)} propuestas`}`
                    : 'Guardar corrección'}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)} className="gap-1.5">
                <X className="size-3.5" aria-hidden />
                Cerrar
              </Button>
              {!valid && forms.length === 0 ? (
                <span className="text-xs text-muted-foreground">Agregá al menos una propuesta.</span>
              ) : null}
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

/** Una propuesta en blanco que nadie tocó: la precarga la puede reemplazar. */
function isUntouched(f: ProposalForm): boolean {
  return (
    f.partnerId === null &&
    f.providerName === '' &&
    f.description === '' &&
    f.amountMin === '' &&
    f.amountMax === '' &&
    f.items.length === 0 &&
    f.providerPhone === '' &&
    f.providerAddress === ''
  )
}

function ProposalFields({
  index,
  form: f,
  partners,
  removable,
  problem,
  backendError,
  recommendLocked,
  otherRecommended,
  onChange,
  onRecommended,
  onRemove,
}: {
  index: number
  form: ProposalForm
  partners: Array<PartnerOption>
  removable: boolean
  problem: string | null
  backendError: string | null
  recommendLocked: boolean
  otherRecommended: QuoteProposal | null
  onChange: (patch: Partial<ProposalForm>) => void
  onRecommended: (value: boolean) => void
  onRemove: () => void
}) {
  const ids = {
    provider: useId(),
    address: useId(),
    phone: useId(),
    description: useId(),
    min: useId(),
    max: useId(),
    currency: useId(),
    validUntil: useId(),
    notes: useId(),
    reason: useId(),
  }
  const isPartner = f.partnerId !== null
  const partner = isPartner ? (partners.find((p) => p.id === f.partnerId) ?? null) : null
  const itemized = f.items.length > 0
  const totals = quoteItemsTotals(readItems(f).items)

  const setItem = (key: string, patch: Partial<Omit<ItemDraft, 'key'>>) =>
    onChange({ items: f.items.map((it) => (it.key === key ? { ...it, ...patch } : it)) })

  return (
    <fieldset
      className={cn(
        'space-y-3 rounded-md border bg-secondary p-3',
        backendError ? 'border-destructive/50' : 'border-border',
      )}
    >
      <legend className="sr-only">Propuesta {index + 1}</legend>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Propuesta {index + 1}</h3>
        {removable ? (
          <Button type="button" size="sm" variant="ghost" onClick={onRemove} className="h-6 gap-1 px-1.5 text-xs">
            <X className="size-3.5" aria-hidden />
            Sacar
          </Button>
        ) : null}
      </div>

      {f.warnings.length > 0 ? (
        <Warn>
          {f.warnings.map((w) => (
            <span key={w} className="block">
              {w}
            </span>
          ))}
        </Warn>
      ) : null}

      <Field label="Taller" htmlFor={ids.provider}>
        <PartnerCombobox
          inputId={ids.provider}
          partners={partners}
          partnerId={f.partnerId}
          providerName={f.providerName}
          selectedLabelFallback={f.partnerLabel}
          onChange={(next) => onChange({ partnerId: next.partnerId, providerName: next.providerName })}
        />
        {!isPartner && f.providerName.trim().length > MAX_PROPOSAL_PROVIDER_NAME ? (
          <Hint>El nombre pasa los {MAX_PROPOSAL_PROVIDER_NAME} caracteres que admite la app.</Hint>
        ) : null}
        {/* Aviso blando: el backend exige un celular que normalice; acá sólo se ve si falta. */}
        {partner !== null && !partner.hasWhatsapp ? (
          <p className="text-xs text-status-yellow">
            Este partner no tiene WhatsApp en su ficha: el backend va a rechazar la propuesta. Cargalo en el directorio
            o elegí otro taller.
          </p>
        ) : null}
      </Field>

      {!isPartner ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="WhatsApp del taller" htmlFor={ids.phone}>
            <Input
              id={ids.phone}
              value={f.providerPhone}
              onChange={(e) => {
                const v = e.currentTarget.value
                onChange({ providerPhone: v })
              }}
              maxLength={40}
              autoComplete="off"
              placeholder="11 2688-3183"
              className="text-xs tabular-nums"
            />
            <Hint>Obligatorio: es por donde la persona lo contacta. El backend lo normaliza a 549.</Hint>
          </Field>
          <Field label="Dirección (opcional)" htmlFor={ids.address}>
            <Input
              id={ids.address}
              value={f.providerAddress}
              onChange={(e) => {
                const v = e.currentTarget.value
                onChange({ providerAddress: v })
              }}
              maxLength={MAX_PROPOSAL_PROVIDER_ADDRESS}
              autoComplete="off"
              className="text-xs"
            />
          </Field>
        </div>
      ) : (
        <Hint>La dirección y el WhatsApp salen de la ficha del partner en el directorio.</Hint>
      )}

      <Field label="Qué ofrece" htmlFor={ids.description}>
        <Textarea
          id={ids.description}
          value={f.description}
          onChange={(e) => {
            const v = e.currentTarget.value
            onChange({ description: v })
          }}
          maxLength={MAX_PROPOSAL_DESCRIPTION}
          rows={3}
          className="text-xs"
        />
        <Hint>Es lo que lee la persona en la app. Obligatorio.</Hint>
      </Field>

      <ItemsEditor
        items={f.items}
        currency={f.currency}
        totals={totals}
        onChange={setItem}
        onAdd={(optional) => onChange({ items: [...f.items, { key: newItemKey(), label: '', amount: '', optional }] })}
        onRemove={(key) => onChange({ items: f.items.filter((it) => it.key !== key) })}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        {itemized ? (
          <div className="sm:col-span-2">
            <span className="mb-1 block text-xs uppercase tracking-wider text-muted-foreground">Precio</span>
            <p className="text-sm font-semibold tabular-nums">
              {totals.base === null ? 'sólo opcionales' : totals.base === 0 ? 'Sin cargo' : formatAmount(totals.base, f.currency)}
            </p>
            <Hint>La suma de los ítems que no son opcionales. La calcula el backend.</Hint>
          </div>
        ) : (
          <>
            <Field label="Precio desde" htmlFor={ids.min}>
              <Input
                id={ids.min}
                value={f.amountMin}
                onChange={(e) => {
                  const v = e.currentTarget.value
                  onChange({ amountMin: v })
                }}
                inputMode="decimal"
                autoComplete="off"
                placeholder="vacío = a confirmar"
                className="text-xs tabular-nums"
              />
            </Field>
            <Field label="Precio hasta" htmlFor={ids.max}>
              <Input
                id={ids.max}
                value={f.amountMax}
                onChange={(e) => {
                  const v = e.currentTarget.value
                  onChange({ amountMax: v })
                }}
                inputMode="decimal"
                autoComplete="off"
                placeholder="vacío = precio cerrado"
                className="text-xs tabular-nums"
              />
            </Field>
          </>
        )}
        <Field label="Moneda" htmlFor={ids.currency}>
          <Select value={f.currency} onValueChange={(v) => onChange({ currency: v as QuoteCurrency })}>
            <SelectTrigger id={ids.currency} className="shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {QUOTE_CURRENCIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {quoteCurrencyLabel(c)} ({c})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Vigente hasta (opcional)" htmlFor={ids.validUntil}>
          <Input
            id={ids.validUntil}
            type="date"
            min={todayUtc()}
            value={f.validUntil}
            onChange={(e) => {
              const v = e.currentTarget.value
              onChange({ validUntil: v })
            }}
            className="w-44 text-xs"
          />
        </Field>
        <Field label="Nota interna (opcional)" htmlFor={ids.notes}>
          <Input
            id={ids.notes}
            value={f.internalNotes}
            onChange={(e) => {
              const v = e.currentTarget.value
              onChange({ internalNotes: v })
            }}
            maxLength={MAX_PROPOSAL_INTERNAL_NOTES}
            autoComplete="off"
            className="text-xs"
          />
          <Hint>No la ve la persona.</Hint>
        </Field>
      </div>

      <div className="space-y-1.5">
        <label className={cn('flex items-center gap-2 text-sm', recommendLocked && !f.isRecommended && 'opacity-60')}>
          <input
            type="checkbox"
            checked={f.isRecommended}
            disabled={recommendLocked && !f.isRecommended}
            onChange={(e) => {
              const v = e.currentTarget.checked
              onRecommended(v)
            }}
          />
          Recomendada
        </label>
        {recommendLocked && !f.isRecommended && otherRecommended ? (
          <Hint>Ya está recomendada la del lugar {otherRecommended.position}: como mucho una por pedido.</Hint>
        ) : null}
        {f.isRecommended ? (
          <Field label="Por qué la recomendamos" htmlFor={ids.reason}>
            <Textarea
              id={ids.reason}
              value={f.recommendationReason}
              onChange={(e) => {
                const v = e.currentTarget.value
                onChange({ recommendationReason: v })
              }}
              maxLength={MAX_PROPOSAL_RECOMMENDATION_REASON}
              rows={2}
              className="text-xs"
            />
            <Hint>Obligatorio para la recomendada: la persona lo lee al lado.</Hint>
          </Field>
        ) : null}
      </div>

      {backendError ? <ErrorText>{backendError}</ErrorText> : problem ? <Hint>{problem}</Hint> : null}
    </fieldset>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={htmlFor} className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  )
}
