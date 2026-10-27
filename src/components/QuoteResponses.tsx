import { useId, useState, type ReactNode } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Receipt, Trash2, X } from 'lucide-react'
import {
  QUOTE_CURRENCIES,
  formatAmount,
  formatQuoteAmount,
  quoteCurrencyLabel,
  quoteItemsTotals,
  readableQuoteResponseError,
  type QuoteCurrency,
  type QuoteResponse,
} from '~/lib/quote-responses'
import { amountToInput, newItemKey, readAmounts, readItems, type ItemDraft } from '~/lib/amounts'
import { splitQuoteResponsesForMessage } from '~/lib/quote-templates'
import {
  addQuoteResponseFn,
  deleteQuoteResponseFn,
  reorderQuoteResponsesFn,
  updateQuoteResponseFn,
} from '~/fn/quote-responses'
import { Hint, ItemsEditor, ItemsSummary, PartnerCombobox } from '~/components/QuoteContentFields'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { formatDate, formatDateTime, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { PartnerOption } from '~/lib/partners'

/**
 * Lo que contestó cada taller para este pedido — `ops.quote_request_response`
 * (migración 015). La UI dice "Presupuestos" porque es la palabra del equipo;
 * el código dice `response` porque una fila puede no tener precio, y
 * `proposal` es el sustantivo del backend para una oferta CON precio.
 * → `.claude/rules/leads.md`
 *
 * Reemplaza anotar cada llamado como una línea de `internal_notes` ("Taller X:
 * $180.000, turno el jueves") y después rearmar el mensaje a mano leyendo el
 * hilo.
 *
 * ── Vive en la FICHA ───────────────────────────────────────────────────────
 *
 * Mismo criterio que `QuoteTemplates` y `PartnerCandidates`: una respuesta no
 * tiene sentido sin el pedido puntual al que pertenece.
 *
 * ── No mueve el estado del pedido ──────────────────────────────────────────
 *
 * Cargar una respuesta NO marca el pedido como respondido ni toca
 * `proposals_count`: eso es `ops.mark_quote_request_answered` (011), con su
 * guarda de estado, y sigue siendo un botón aparte en `QuoteRequestActions`.
 * Lo que sí hace esta tarjeta es AVISAR cuando los dos números no coinciden.
 */

const NO_PARTNER = '__free__'

interface FormState {
  partnerId: string
  providerName: string
  providerAddress: string
  providerPhone: string
  amountMin: string
  amountMax: string
  currency: QuoteCurrency
  detail: string
  validUntil: string
  /**
   * Sólo se ofrece en el FORM si la fila ya traía una (compatibilidad con lo
   * cargado antes de que este campo se ocultara). Una fila nueva nunca la
   * pide — es la nota interna POR presupuesto, distinta del hilo de notas del
   * pedido, y se decidió ocultarla para no duplicar dónde anotar algo.
   */
  internalNotes: string
  /**
   * El desglose (022). Con al menos un ítem, el precio lo deriva el SP (suma
   * de los no opcionales) y los campos «desde/hasta» no se usan.
   */
  items: Array<ItemDraft>
}

function emptyForm(): FormState {
  return {
    partnerId: NO_PARTNER,
    providerName: '',
    providerAddress: '',
    providerPhone: '',
    amountMin: '',
    amountMax: '',
    currency: 'ARS',
    detail: '',
    validUntil: '',
    internalNotes: '',
    items: [],
  }
}

function formFrom(r: QuoteResponse): FormState {
  return {
    partnerId: r.partnerId ?? NO_PARTNER,
    providerName: r.providerName ?? '',
    providerAddress: r.providerAddress ?? '',
    providerPhone: r.providerPhone ?? '',
    // Con desglose, el precio guardado es la suma de los ítems: no se siembra
    // en «desde/hasta» (si después se borran todos los ítems, arranca vacío).
    amountMin: r.amountMin === null || r.items.length > 0 ? '' : amountToInput(r.amountMin),
    // Un precio cerrado se guarda como `min === max`. Al editar, el "hasta" se
    // deja vacío para que se vea como se cargó: un solo número.
    amountMax:
      r.amountMax === null || r.amountMin === r.amountMax || r.items.length > 0 ? '' : amountToInput(r.amountMax),
    currency: (QUOTE_CURRENCIES as ReadonlyArray<string>).includes(r.currency)
      ? (r.currency as QuoteCurrency)
      : 'ARS',
    detail: r.detail,
    validUntil: r.validUntil ?? '',
    internalNotes: r.internalNotes ?? '',
    items: r.items.map((it) => ({
      key: newItemKey(),
      label: it.label,
      amount: amountToInput(it.amount),
      optional: it.optional,
    })),
  }
}

export function QuoteResponses({
  quoteRequestId,
  available,
  itemsAvailable,
  responses,
  partners,
  proposalsCount,
  status,
  hasAppSends = false,
}: {
  quoteRequestId: string
  /** `false` = falta aplicar la 015 en esta base. */
  available: boolean
  /** `false` = falta la 022: se cargan presupuestos, pero sin desglose por ítems. */
  itemsAvailable: boolean
  responses: Array<QuoteResponse>
  partners: Array<PartnerOption>
  /** `quote_requests.proposals_count`: lo que se le dijo a la persona que se le pasó. */
  proposalsCount: number | null
  status: string
  /**
   * Hubo envíos por la app («Propuestas en la app»). Desde el primero,
   * `proposals_count` lo escribe el BACKEND (= propuestas activas) y deja de
   * compararse contra las filas de acá: el aviso de abajo no aplica.
   */
  hasAppSends?: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!available) {
    return (
      <Card className="mb-4">
        <CardContent className="pt-6">
          <SectionHeader count={null} />
          <p className="mt-2 text-sm text-muted-foreground">
            Falta aplicar la migración 015 en esta base (<code className="font-mono">pnpm db:migrate</code>).
            Hasta entonces no se pueden cargar presupuestos acá.
          </p>
        </CardContent>
      </Card>
    )
  }

  // `proposals_count` lo escribe `ops.mark_quote_request_answered` y esta
  // tarjeta no lo toca (ver la cabecera). Que no coincidan es un dato, no un
  // error: ámbar, no rojo — mismo criterio que `stuck` y `atrasada`.
  const countMismatch = !hasAppSends && proposalsCount !== null && proposalsCount !== responses.length
  const { expired } = splitQuoteResponsesForMessage(responses)

  return (
    <Card className="mb-4">
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SectionHeader count={responses.length} />
          {!adding && editingId === null ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)} className="gap-1.5">
              <Plus className="size-3.5" aria-hidden />
              Cargar presupuesto
            </Button>
          ) : null}
        </div>

        {status === 'closed' ? (
          <Warn>
            Este pedido está cerrado. Se puede cargar igual —una respuesta que llegó tarde es un hecho real— pero
            no va a llegarle a la persona por acá.
          </Warn>
        ) : null}

        {countMismatch ? (
          <Warn>
            Hay {formatInt(responses.length)} {responses.length === 1 ? 'presupuesto cargado' : 'presupuestos cargados'} y
            al pedido se le anotaron {formatInt(proposalsCount)}. Los dos números son independientes:{' '}
            <code className="font-mono">proposals_count</code> lo escribe «Marcar respondido» y no se sincroniza solo.
          </Warn>
        ) : null}

        {hasAppSends ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Este pedido ya tuvo envíos por la app: desde el primero, «Propuestas devueltas» lo maneja el backend y es la
            cantidad de propuestas activas en la app — no la de presupuestos cargados acá.
          </p>
        ) : null}

        {expired.length > 0 ? (
          <Warn>
            {expired.length === 1 ? 'Un presupuesto venció' : `${formatInt(expired.length)} presupuestos vencieron`} y
            por eso {expired.length === 1 ? 'no entra' : 'no entran'} en el mensaje. Editales la vigencia o borralos.
          </Warn>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {responses.length === 0 && !adding ? (
          <p className="text-sm text-muted-foreground">
            Todavía no hay presupuestos cargados. A medida que los talleres te contesten —con precio o sin precio—
            cargalos acá: la plantilla «Presupuestos» de arriba se arma sola con lo que haya.
          </p>
        ) : null}

        {responses.length > 0 ? (
          <ol className="space-y-2">
            {responses.map((r, i) =>
              editingId === r.id ? (
                <li key={r.id}>
                  <ResponseForm
                    mode="edit"
                    response={r}
                    quoteRequestId={quoteRequestId}
                    partners={partners}
                    itemsAvailable={itemsAvailable}
                    onDone={() => setEditingId(null)}
                    onCancel={() => setEditingId(null)}
                    onError={setError}
                  />
                </li>
              ) : (
                <li key={r.id}>
                  <ResponseRow
                    response={r}
                    index={i}
                    total={responses.length}
                    allIds={responses.map((x) => x.id)}
                    quoteRequestId={quoteRequestId}
                    disabled={adding || editingId !== null}
                    onEdit={() => {
                      setError(null)
                      setEditingId(r.id)
                    }}
                    onError={setError}
                  />
                </li>
              ),
            )}
          </ol>
        ) : null}

        {adding ? (
          <ResponseForm
            mode="add"
            quoteRequestId={quoteRequestId}
            partners={partners}
            itemsAvailable={itemsAvailable}
            onDone={() => setAdding(false)}
            onCancel={() => setAdding(false)}
            onError={setError}
          />
        ) : null}

        <p className="border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
          El orden es el del mensaje y lo decidís vos con las flechas — no es por precio. Cada alta, corrección,
          borrado y reordenamiento corre un stored procedure de <code className="font-mono">ops</code> que deja el
          antes y el después en <code className="font-mono">ops.action_log</code> a tu nombre.
        </p>
      </CardContent>
    </Card>
  )
}

function SectionHeader({ count }: { count: number | null }) {
  return (
    <div>
      <h2 className="flex items-center gap-1.5 font-heading text-base font-semibold">
        <Receipt className="size-4 text-muted-foreground" aria-hidden />
        Presupuestos
        {count !== null && count > 0 ? (
          <span className="text-sm font-normal text-muted-foreground">({formatInt(count)})</span>
        ) : null}
      </h2>
      <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">
        Lo que contestó cada taller. Puede no tener precio: un diagnóstico o un «traelo y lo vemos» también es una
        respuesta.
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

// ── Una fila ────────────────────────────────────────────────────────────────

function ResponseRow({
  response: r,
  index,
  total,
  allIds,
  quoteRequestId,
  disabled,
  onEdit,
  onError,
}: {
  response: QuoteResponse
  index: number
  total: number
  allIds: Array<string>
  quoteRequestId: string
  disabled: boolean
  onEdit: () => void
  onError: (message: string | null) => void
}) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    onError(null)
    try {
      await action()
      await router.invalidate()
    } catch (cause) {
      onError(readableQuoteResponseError(cause))
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Viaja la lista COMPLETA en el orden nuevo, no "mové éste uno arriba": con
   * un movimiento relativo, dos pestañas reordenando a la vez dejan un orden
   * que ninguna pidió. El SP rechaza una lista incompleta o con ajenos.
   */
  function move(delta: -1 | 1) {
    const next = [...allIds]
    const target = index + delta
    const a = next[index]
    const b = next[target]
    if (a === undefined || b === undefined) return
    next[index] = b
    next[target] = a
    void run(() => reorderQuoteResponsesFn({ data: { quoteRequestId, ids: next } }))
  }

  const amount = formatQuoteAmount(r)
  const [expanded, setExpanded] = useState(false)
  // Umbral de largo a partir del cual "ver más" tiene sentido — dos líneas de
  // un párrafo de este ancho rondan los 110-130 caracteres.
  const detailIsLong = r.detail.length > 140

  const contactLine = [r.address, r.phone, r.hours].filter((v): v is string => v !== null).join(' · ')

  return (
    <div className={cn('rounded-md border border-border bg-card px-3 py-2', r.expired === true && 'opacity-70')}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">{index + 1}.</span>
          {r.partnerId ? (
            <Link
              to="/partners/$partnerId"
              params={{ partnerId: r.partnerId }}
              className="truncate font-medium text-brand hover:underline"
            >
              {r.name}
            </Link>
          ) : (
            <span className="truncate font-medium">{r.name}</span>
          )}
          {r.partnerTier === 'founding' ? (
            <Badge variant="outline" className="shrink-0 border-brand/30 bg-brand-soft text-brand">
              Aliado
            </Badge>
          ) : null}
          {/* El partner pudo pausarse o archivarse DESPUÉS de contestar. No invalida la respuesta. */}
          {r.partnerStatus !== null && r.partnerStatus !== 'active' ? (
            <span className="shrink-0 text-xs text-status-yellow">
              {r.partnerStatus === 'paused' ? 'pausado' : r.partnerStatus}
            </span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-baseline gap-3">
          {/*
            Sin precio no hay renglón, igual que en el mensaje: un "—" acá se
            leería como "no sabemos". "Sin cargo" (precio 0) sí se muestra: es
            una respuesta.
          */}
          <span className={cn('text-sm tabular-nums', amount ? 'font-semibold' : 'text-muted-foreground')}>
            {amount ?? 'sin precio'}
          </span>
          {r.validUntil ? (
            <span className={cn('text-xs tabular-nums', r.expired ? 'text-status-yellow' : 'text-muted-foreground')}>
              {r.expired ? 'venció' : 'vig.'} {formatDate(`${r.validUntil}T00:00:00.000Z`)}
            </span>
          ) : null}
        </div>
      </div>

      {contactLine ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{contactLine}</p> : null}

      {r.items.length > 0 ? <ItemsSummary items={r.items} currency={r.currency} /> : null}

      <div className="mt-1">
        <p className={cn('whitespace-pre-wrap text-sm leading-relaxed', !expanded && detailIsLong && 'line-clamp-2')}>
          {r.detail}
        </p>
        {detailIsLong ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-0.5 rounded text-xs text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {expanded ? 'ver menos' : 'ver más'}
          </button>
        ) : null}
      </div>

      {r.internalNotes ? (
        <p className="mt-1 rounded border border-border bg-secondary px-2 py-1 text-xs leading-relaxed">
          <span className="text-muted-foreground">Nota interna: </span>
          {r.internalNotes}
        </p>
      ) : null}

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          cargado {formatDateTime(r.createdAt)} UTC
          {amount && r.currency !== 'ARS' ? ` · en ${quoteCurrencyLabel(r.currency).toLowerCase()}` : ''}
        </span>

        {!confirming ? (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || busy || index === 0}
              onClick={() => move(-1)}
              aria-label="Subir en el mensaje"
              className="size-6 p-0"
            >
              <ArrowUp className="size-3.5" aria-hidden />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || busy || index === total - 1}
              onClick={() => move(1)}
              aria-label="Bajar en el mensaje"
              className="size-6 p-0"
            >
              <ArrowDown className="size-3.5" aria-hidden />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || busy}
              onClick={onEdit}
              aria-label="Editar"
              className="size-6 p-0"
            >
              <Pencil className="size-3.5" aria-hidden />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || busy}
              onClick={() => setConfirming(true)}
              aria-label="Borrar"
              className="size-6 p-0 text-destructive hover:text-destructive"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          </div>
        ) : null}
      </div>

      {confirming ? (
        <div className="mt-2 rounded-md border border-status-yellow/30 bg-status-yellow-bg p-2">
          <p className="text-xs leading-relaxed text-status-yellow">
            Se borra de la base. Queda el registro en <code className="font-mono">ops.action_log</code>, pero la fila
            no se recupera desde el panel.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => deleteQuoteResponseFn({ data: { id: r.id } }))}
              className="h-7 gap-1.5 px-2.5 text-xs"
            >
              <Trash2 className="size-3.5" aria-hidden />
              {busy ? 'Borrando…' : 'Sí, borrar'}
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
    </div>
  )
}

// ── El formulario, compartido por alta y edición ────────────────────────────

/**
 * Alta y edición usan el MISMO formulario, y no por ahorrar código: los dos SP
 * validan con el mismo helper de plpgsql (`ops._normalize_quote_response`), así
 * que dos formularios distintos serían dos maneras de mandar los mismos campos
 * — y la que se olvide de un `trim` falla contra una regla que el otro respeta.
 *
 * La edición es REEMPLAZO COMPLETO: lo que se ve en pantalla es exactamente lo
 * que queda guardado, un opcional vaciado se borra. Incluido el precio, que así
 * se puede quitar si se cargó por error.
 */
function ResponseForm({
  mode,
  response,
  quoteRequestId,
  partners,
  onDone,
  onCancel,
  onError,
  itemsAvailable,
}: {
  mode: 'add' | 'edit'
  response?: QuoteResponse
  quoteRequestId: string
  partners: Array<PartnerOption>
  itemsAvailable: boolean
  onDone: () => void
  onCancel: () => void
  onError: (message: string | null) => void
}) {
  const router = useRouter()
  const ids = {
    provider: useId(),
    address: useId(),
    phone: useId(),
    min: useId(),
    max: useId(),
    detail: useId(),
    validUntil: useId(),
    notes: useId(),
  }
  const [f, setF] = useState<FormState>(() => (response ? formFrom(response) : emptyForm()))
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setF((prev) => ({ ...prev, [key]: value }))

  const usesPartner = f.partnerId !== NO_PARTNER
  const itemized = f.items.length > 0
  const parsedItems = readItems(f)
  // Con desglose, «desde/hasta» no cuentan: el precio sale de los ítems.
  const amounts = itemized ? { invalid: false } : readAmounts(f)
  const totals = quoteItemsTotals(parsedItems.items)
  const providerOk = usesPartner || f.providerName.trim() !== ''
  const valid = providerOk && !amounts.invalid && !parsedItems.invalid && f.detail.trim() !== ''

  const setItem = (key: string, patch: Partial<Omit<ItemDraft, 'key'>>) =>
    setF((prev) => ({ ...prev, items: prev.items.map((it) => (it.key === key ? { ...it, ...patch } : it)) }))
  const addItem = (optional: boolean) =>
    setF((prev) => ({ ...prev, items: [...prev.items, { key: newItemKey(), label: '', amount: '', optional }] }))
  const removeItem = (key: string) => setF((prev) => ({ ...prev, items: prev.items.filter((it) => it.key !== key) }))

  async function submit() {
    if (!valid) return
    setBusy(true)
    onError(null)
    const fields = {
      partnerId: usesPartner ? f.partnerId : undefined,
      providerName: usesPartner ? undefined : f.providerName.trim(),
      // El contacto tipeado sólo existe para el taller de afuera: el del
      // directorio lo tiene en `partners`, y el SP rechaza una copia acá.
      providerAddress: usesPartner ? undefined : f.providerAddress.trim() || undefined,
      providerPhone: usesPartner ? undefined : f.providerPhone.trim() || undefined,
      amountMin: itemized ? undefined : amounts.min,
      amountMax: itemized ? undefined : amounts.max,
      // Con la 022, viajan siempre (`[]` = sin desglose): la edición es reemplazo
      // completo. Sin la 022 no se mandan: el SP de la 015 no los conoce.
      items: itemsAvailable ? parsedItems.items : undefined,
      currency: f.currency,
      detail: f.detail.trim(),
      internalNotes: f.internalNotes.trim() || undefined,
      validUntil: f.validUntil.trim() || undefined,
    }
    try {
      if (mode === 'edit' && response) {
        await updateQuoteResponseFn({ data: { id: response.id, ...fields } })
      } else {
        await addQuoteResponseFn({ data: { quoteRequestId, ...fields } })
      }
      await router.invalidate()
      onDone()
    } catch (cause) {
      onError(readableQuoteResponseError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="space-y-3 rounded-md border border-border bg-secondary p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <h3 className="text-sm font-medium">
        {mode === 'edit' ? 'Corregir presupuesto' : 'Cargar un presupuesto'}
      </h3>

      <Field label="Taller" htmlFor={ids.provider}>
        <PartnerCombobox
          inputId={ids.provider}
          partners={partners}
          partnerId={usesPartner ? f.partnerId : null}
          providerName={f.providerName}
          selectedLabelFallback={response?.partnerId ? response.name : null}
          onChange={(next) =>
            setF((prev) => ({
              ...prev,
              partnerId: next.partnerId ?? NO_PARTNER,
              providerName: next.providerName,
            }))
          }
        />
      </Field>

      {/*
        Dirección y teléfono SÓLO para el taller de afuera. Para uno del
        directorio salen de `partners` —así siguen al directorio si los
        corrigen— y el SP rechaza una copia tipeada acá.
      */}
      {!usesPartner ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Dirección" htmlFor={ids.address}>
            <Input
              id={ids.address}
              value={f.providerAddress}
              onChange={(e) => {
                const v = e.currentTarget.value
                set('providerAddress', v)
              }}
              maxLength={300}
              autoComplete="off"
              placeholder="Monseñor Larumbe 929, Martínez"
              className="text-xs"
            />
            <Hint>Va en el mensaje con 📍. Si no la sabés, dejala vacía y el renglón no aparece.</Hint>
          </Field>
          <Field label="Teléfono" htmlFor={ids.phone}>
            <Input
              id={ids.phone}
              value={f.providerPhone}
              onChange={(e) => {
                const v = e.currentTarget.value
                set('providerPhone', v)
              }}
              maxLength={40}
              autoComplete="off"
              placeholder="91126883183"
              className="text-xs tabular-nums"
            />
            <Hint>Se guarda y se muestra tal cual lo escribas: no se completa ninguna característica.</Hint>
          </Field>
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          La dirección, el teléfono y los horarios salen de la ficha del partner, así que el mensaje siempre muestra
          lo que hay en el directorio. Si están mal, corregilos ahí.
        </p>
      )}

      <Field label="Qué contestó" htmlFor={ids.detail}>
        <Textarea
          id={ids.detail}
          value={f.detail}
          onChange={(e) => {
            const v = e.currentTarget.value
            set('detail', v)
          }}
          maxLength={2000}
          rows={3}
          placeholder="Ofrecen diagnóstico sin cargo y lo pueden ver en el día. Turnos disponibles para la semana que viene."
          className="text-xs"
        />
        <Hint>
          Es el párrafo que lee la persona: qué ofrece, qué dijo del problema, cuándo lo puede ver. Obligatorio.
        </Hint>
      </Field>

      {itemsAvailable ? (
        <ItemsEditor
          items={f.items}
          currency={f.currency}
          totals={totals}
          onChange={setItem}
          onAdd={addItem}
          onRemove={removeItem}
        />
      ) : (
        // Esconderlo en silencio hacía creer que la función no existía: se dice por qué no está.
        <p className="rounded-md border border-status-yellow/30 bg-status-yellow-bg px-3 py-2 text-xs leading-relaxed text-status-yellow">
          Detalle por ítems y opcionales: todavía no disponible en esta base — falta aplicar la migración 022
          (<code className="font-mono">pnpm db:migrate</code>, o el próximo deploy de producción).
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        {itemized ? (
          <div className="sm:col-span-2">
            <span className="mb-1 block text-xs uppercase tracking-wider text-muted-foreground">Precio</span>
            <p className="text-sm">
              {totals.base === null ? (
                <span className="text-muted-foreground">sin precio base — sólo opcionales</span>
              ) : (
                <span className="font-semibold tabular-nums">
                  {totals.base === 0 ? 'Sin cargo' : formatAmount(totals.base, f.currency)}
                </span>
              )}
            </p>
            <Hint>Es la suma de los ítems que no son opcionales. Se calcula solo.</Hint>
          </div>
        ) : (
          <>
            <Field label="Precio desde" htmlFor={ids.min}>
              <Input
                id={ids.min}
                value={f.amountMin}
                onChange={(e) => {
                  const v = e.currentTarget.value
                  set('amountMin', v)
                }}
                inputMode="decimal"
                autoComplete="off"
                placeholder="vacío = sin precio"
                className="text-xs tabular-nums"
              />
              <Hint>Vacío si el taller no pasó precio. `0` es «sin cargo», que sí es una respuesta.</Hint>
            </Field>

            <Field label="Precio hasta" htmlFor={ids.max}>
              <Input
                id={ids.max}
                value={f.amountMax}
                onChange={(e) => {
                  const v = e.currentTarget.value
                  set('amountMax', v)
                }}
                inputMode="decimal"
                autoComplete="off"
                placeholder="vacío = precio cerrado"
                className="text-xs tabular-nums"
              />
              <Hint>El punto es separador de miles y la coma, decimal.</Hint>
            </Field>
          </>
        )}

        <Field label="Moneda" htmlFor={`${ids.min}-currency`}>
          <Select value={f.currency} onValueChange={(v) => set('currency', v as QuoteCurrency)}>
            <SelectTrigger id={`${ids.min}-currency`} className="shadow-none">
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
          <Hint>No se convierte nada entre monedas.</Hint>
        </Field>
      </div>

      <Field label="Vigente hasta (opcional)" htmlFor={ids.validUntil}>
        <Input
          id={ids.validUntil}
          type="date"
          value={f.validUntil}
          onChange={(e) => {
            const v = e.currentTarget.value
            set('validUntil', v)
          }}
          className="w-44 text-xs"
        />
        <Hint>Una vez vencida, el presupuesto deja de entrar en el mensaje.</Hint>
      </Field>

      {/*
        La nota interna POR presupuesto se ocultó del form: la única nota que
        queda para cargar es el hilo de notas del pedido. Una fila cargada
        antes de este cambio la sigue mostrando —sólo lectura, para no perder
        el dato— y `submit()` la reenvía tal cual porque el reemplazo del SP es
        completo.
      */}
      {f.internalNotes.trim() !== '' ? (
        <Field label="Nota interna (de antes)" htmlFor={ids.notes}>
          <p id={ids.notes} className="text-xs leading-relaxed">
            {f.internalNotes}
          </p>
          <Hint>Ya no se puede editar desde acá — es sólo lectura. No sale en el mensaje.</Hint>
        </Field>
      ) : null}

      {mode === 'edit' ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Se guarda exactamente lo que se ve acá: un campo opcional que quede vacío se borra, el precio incluido.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || !valid} className="gap-1.5">
          <Check className="size-3.5" aria-hidden />
          {busy ? 'Guardando…' : mode === 'edit' ? 'Guardar cambios' : 'Cargar presupuesto'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel} className="gap-1.5">
          <X className="size-3.5" aria-hidden />
          Cancelar
        </Button>
        {!valid ? (
          <span className="self-center text-xs text-muted-foreground">
            {!providerOk
              ? 'Falta el taller.'
              : parsedItems.invalid
                ? 'Revisá los ítems: cada uno necesita qué es y un precio (0 vale).'
                : amounts.invalid
                ? 'Revisá el precio: cargá «desde» (o las dos puntas, con desde ≤ hasta), o dejá los dos vacíos.'
                : 'Falta qué contestó el taller.'}
          </span>
        ) : null}
      </div>
    </form>
  )
}

// ── Piezas ──────────────────────────────────────────────────────────────────

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
