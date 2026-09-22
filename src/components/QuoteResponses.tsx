import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { ArrowDown, ArrowUp, Check, ChevronDown, Pencil, Plus, Receipt, Trash2, X } from 'lucide-react'
import { normalizeForMatch } from '~/lib/catalog'
import {
  MAX_QUOTE_AMOUNT,
  QUOTE_CURRENCIES,
  formatQuoteAmount,
  quoteCurrencyLabel,
  readableQuoteResponseError,
  type QuoteCurrency,
  type QuoteResponse,
} from '~/lib/quote-responses'
import { splitQuoteResponsesForMessage } from '~/lib/quote-templates'
import {
  addQuoteResponseFn,
  deleteQuoteResponseFn,
  reorderQuoteResponsesFn,
  updateQuoteResponseFn,
} from '~/fn/quote-responses'
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
  internalNotes: string
  auditNote: string
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
    auditNote: '',
  }
}

function formFrom(r: QuoteResponse): FormState {
  return {
    partnerId: r.partnerId ?? NO_PARTNER,
    providerName: r.providerName ?? '',
    providerAddress: r.providerAddress ?? '',
    providerPhone: r.providerPhone ?? '',
    amountMin: r.amountMin === null ? '' : String(r.amountMin),
    // Un precio cerrado se guarda como `min === max`. Al editar, el "hasta" se
    // deja vacío para que se vea como se cargó: un solo número.
    amountMax: r.amountMax === null || r.amountMin === r.amountMax ? '' : String(r.amountMax),
    currency: (QUOTE_CURRENCIES as ReadonlyArray<string>).includes(r.currency)
      ? (r.currency as QuoteCurrency)
      : 'ARS',
    detail: r.detail,
    validUntil: r.validUntil ?? '',
    internalNotes: r.internalNotes ?? '',
    auditNote: '',
  }
}

/**
 * Lee un monto tipeado en castellano rioplatense: `180.000` son ciento ochenta
 * mil, `180,50` son ciento ochenta con cincuenta. El punto es separador de
 * miles y la coma es decimal — al revés que el default de `Number()`, que
 * leería `180.000` como ciento ochenta.
 *
 * `0` es un valor VÁLIDO y significa "sin cargo"; el vacío es "no pasó
 * precio", y de eso se ocupa el llamador, no esta función.
 */
function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[\s.]/g, '').replace(',', '.')
  if (cleaned === '' || !/^\d+(\.\d+)?$/.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) && n >= 0 && n <= MAX_QUOTE_AMOUNT ? n : null
}

/**
 * Las dos puntas del precio, o `undefined` en las dos si el taller no pasó
 * ninguno. `invalid` separa "no cargó precio" (válido) de "cargó algo que no
 * es un precio" (hay que avisar).
 */
function readAmounts(f: FormState): { min?: number; max?: number; invalid: boolean } {
  const rawMin = f.amountMin.trim()
  const rawMax = f.amountMax.trim()
  if (rawMin === '' && rawMax === '') return { invalid: false }
  // "Hasta" sin "desde" no es un rango ni un precio cerrado: falta la punta
  // que la base necesita para las dos columnas.
  if (rawMin === '') return { invalid: true }
  const min = parseAmount(rawMin)
  if (min === null) return { invalid: true }
  if (rawMax === '') return { min, max: min, invalid: false }
  const max = parseAmount(rawMax)
  if (max === null || min > max) return { invalid: true }
  return { min, max, invalid: false }
}

export function QuoteResponses({
  quoteRequestId,
  available,
  responses,
  partners,
  proposalsCount,
  status,
}: {
  quoteRequestId: string
  /** `false` = falta aplicar la 015 en esta base. */
  available: boolean
  responses: Array<QuoteResponse>
  partners: Array<PartnerOption>
  /** `quote_requests.proposals_count`: lo que se le dijo a la persona que se le pasó. */
  proposalsCount: number | null
  status: string
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
  const countMismatch = proposalsCount !== null && proposalsCount !== responses.length
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

  return (
    <div className={cn('rounded-md border border-border bg-card p-3', r.expired === true && 'opacity-70')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2">
          <span className="mt-0.5 shrink-0 text-sm font-semibold tabular-nums text-muted-foreground">
            {index + 1}.
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {r.partnerId ? (
                <Link
                  to="/partners/$partnerId"
                  params={{ partnerId: r.partnerId }}
                  className="font-medium text-brand hover:underline"
                >
                  {r.name}
                </Link>
              ) : (
                <span className="font-medium">{r.name}</span>
              )}
              <Badge variant="outline" className="border-border text-muted-foreground">
                {r.partnerId ? 'del directorio' : 'taller de afuera'}
              </Badge>
              {/*
                El partner pudo pausarse o archivarse DESPUÉS de contestar. No
                invalida la respuesta: se avisa y se sigue mostrando.
              */}
              {r.partnerStatus !== null && r.partnerStatus !== 'active' ? (
                <span className="text-xs text-status-yellow">
                  el taller está {r.partnerStatus === 'paused' ? 'pausado' : r.partnerStatus} en el directorio
                </span>
              ) : null}
            </div>

            <div className="space-y-0.5 text-xs text-muted-foreground">
              {r.address ? <div>📍 {r.address}</div> : null}
              {r.phone ? <div className="tabular-nums">📞 {r.phone}</div> : null}
              {r.hours ? <div>🕘 {r.hours}</div> : null}
            </div>

            <p className="whitespace-pre-wrap text-sm leading-relaxed">{r.detail}</p>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>cargado {formatDateTime(r.createdAt)} UTC</span>
              {r.validUntil ? (
                <span className={cn(r.expired ? 'text-status-yellow' : undefined)}>
                  {r.expired ? 'venció' : 'vigente hasta'} el {formatDate(`${r.validUntil}T00:00:00.000Z`)}
                </span>
              ) : null}
              {amount && r.currency !== 'ARS' ? <span>en {quoteCurrencyLabel(r.currency).toLowerCase()}</span> : null}
            </div>

            {r.internalNotes ? (
              <p className="rounded border border-border bg-secondary px-2 py-1 text-xs leading-relaxed">
                <span className="text-muted-foreground">Nota interna: </span>
                {r.internalNotes}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {/*
            Sin precio no hay renglón, igual que en el mensaje: un "—" acá se
            leería como "no sabemos", y lo que pasa es que el taller no pasó
            número. "Sin cargo" (precio 0) sí se muestra: es una respuesta.
          */}
          <span className={cn('text-sm tabular-nums', amount ? 'font-semibold' : 'text-muted-foreground')}>
            {amount ?? 'sin precio'}
          </span>

          {!confirming ? (
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || busy || index === 0}
                onClick={() => move(-1)}
                aria-label="Subir en el mensaje"
                className="h-7 w-7 p-0"
              >
                <ArrowUp className="size-3.5" aria-hidden />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || busy || index === total - 1}
                onClick={() => move(1)}
                aria-label="Bajar en el mensaje"
                className="h-7 w-7 p-0"
              >
                <ArrowDown className="size-3.5" aria-hidden />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || busy}
                onClick={onEdit}
                className="h-7 gap-1.5 px-2.5 text-xs"
              >
                <Pencil className="size-3.5" aria-hidden />
                Editar
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || busy}
                onClick={() => setConfirming(true)}
                className="h-7 gap-1.5 px-2.5 text-xs"
              >
                <Trash2 className="size-3.5" aria-hidden />
                Borrar
              </Button>
            </div>
          ) : null}
        </div>
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
}: {
  mode: 'add' | 'edit'
  response?: QuoteResponse
  quoteRequestId: string
  partners: Array<PartnerOption>
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
    audit: useId(),
  }
  const [f, setF] = useState<FormState>(() => (response ? formFrom(response) : emptyForm()))
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setF((prev) => ({ ...prev, [key]: value }))

  const usesPartner = f.partnerId !== NO_PARTNER
  const amounts = readAmounts(f)
  const providerOk = usesPartner || f.providerName.trim() !== ''
  const valid = providerOk && !amounts.invalid && f.detail.trim() !== ''

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
      amountMin: amounts.min,
      amountMax: amounts.max,
      currency: f.currency,
      detail: f.detail.trim(),
      internalNotes: f.internalNotes.trim() || undefined,
      validUntil: f.validUntil.trim() || undefined,
      auditNote: f.auditNote.trim() || undefined,
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

      <div className="grid gap-3 sm:grid-cols-3">
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

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Vigente hasta (opcional)" htmlFor={ids.validUntil}>
          <Input
            id={ids.validUntil}
            type="date"
            value={f.validUntil}
            onChange={(e) => {
              const v = e.currentTarget.value
              set('validUntil', v)
            }}
            className="text-xs"
          />
          <Hint>Una vez vencida, el presupuesto deja de entrar en el mensaje.</Hint>
        </Field>

        <Field label="Nota interna (opcional)" htmlFor={ids.notes}>
          <Input
            id={ids.notes}
            value={f.internalNotes}
            onChange={(e) => {
              const v = e.currentTarget.value
              set('internalNotes', v)
            }}
            maxLength={2000}
            autoComplete="off"
            placeholder="Lo atendió Juan"
            className="text-xs"
          />
          <Hint>Para vos. NO sale en el mensaje.</Hint>
        </Field>
      </div>

      <Field label="Nota de auditoría (opcional)" htmlFor={ids.audit}>
        <Input
          id={ids.audit}
          value={f.auditNote}
          onChange={(e) => {
            const v = e.currentTarget.value
            set('auditNote', v)
          }}
          maxLength={500}
          autoComplete="off"
          placeholder="Por qué, si no es obvio"
          className="text-xs"
        />
        <Hint>
          Queda en <code className="font-mono">ops.action_log</code>, no en la fila ni en el hilo del pedido.
        </Hint>
      </Field>

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
              : amounts.invalid
                ? 'Revisá el precio: cargá «desde» (o las dos puntas, con desde ≤ hasta), o dejá los dos vacíos.'
                : 'Falta qué contestó el taller.'}
          </span>
        ) : null}
      </div>
    </form>
  )
}

// ── El buscador de taller ───────────────────────────────────────────────────

/** Cuántas opciones se ven sin scrollear. El resto sigue ahí, con scroll. */
const VISIBLE_OPTIONS = 8

/**
 * Un solo campo para las dos clases de taller que admite la tabla.
 *
 * El `<Select>` que había acá era una lista de 50 partners activos en orden
 * fijo, más una opción "otro taller" que recién entonces mostraba un input
 * aparte: dos controles para una decisión, y 50 renglones para scrollear. Acá
 * se tipea el nombre y la lista se filtra.
 *
 * ── El filtrado es en el CLIENTE, no una búsqueda al servidor ──────────────
 *
 * Al 2026-09-22 hay 50 partners activos y ya vienen enteros en el loader de la
 * ficha (`listPartnerOptions`). Filtrar sobre un array de 50 es instantáneo y
 * no tiene estados de carga, de error ni de carrera — a diferencia del picker
 * de destinatarios de `BroadcastComposer`, que SÍ va al servidor con debounce
 * porque su universo son miles de usuarios y no se pueden traer todos. El día
 * que el directorio tenga cientos, esto pasa a ser un `searchPartnersFn` con
 * la misma forma que aquél.
 *
 * `normalizeForMatch` (de `~/lib/catalog`) saca acentos y puntuación, así que
 * "perez" encuentra "Pérez" y "cars service" encuentra "H&G Cars Service". Es
 * el mismo normalizador que usa el matcheo de rubros declarados en la
 * aprobación de partners.
 *
 * ── Tipear NO vincula: vincular es elegir de la lista ──────────────────────
 *
 * Escribir "Autech" deja un taller de AFUERA llamado "Autech", aunque Autech
 * esté en el directorio — `partner_id` sólo se setea eligiendo una opción. Eso
 * puede sorprender, así que el campo dice en qué modo está en todo momento, y
 * si el texto tipeado coincide con un partner real lo avisa y ofrece
 * vincularlo. La alternativa —adivinar el id por nombre— es exactamente lo que
 * `partner-approval.md` ya desaconseja con `nameCollisions`: dos partners se
 * pueden llamar igual.
 */
function PartnerCombobox({
  inputId,
  partners,
  partnerId,
  providerName,
  selectedLabelFallback,
  onChange,
}: {
  inputId: string
  partners: Array<PartnerOption>
  /** `null` = taller de afuera; el nombre vive en `providerName`. */
  partnerId: string | null
  providerName: string
  /** El nombre del partner cuando NO está en las opciones (p. ej. se pausó). */
  selectedLabelFallback: string | null
  onChange: (next: { partnerId: string | null; providerName: string }) => void
}) {
  const listId = `${inputId}-list`
  const boxRef = useRef<HTMLDivElement>(null)
  const selected = partnerId === null ? null : (partners.find((p) => p.id === partnerId) ?? null)
  const selectedLabel =
    partnerId === null ? null : (selected?.name ?? selectedLabelFallback ?? 'taller del directorio')

  const [query, setQuery] = useState(() => selectedLabel ?? providerName)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)

  const matches = useMemo(() => {
    const needle = normalizeForMatch(query)
    if (needle === '') return partners
    return partners.filter((p) => normalizeForMatch(`${p.name} ${p.coverageZone}`).includes(needle))
  }, [partners, query])

  // Cerrar al clickear afuera. Sin esto la lista queda abierta tapando el
  // resto del formulario, que en una tarjeta angosta es peor que inútil.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function pickPartner(p: PartnerOption) {
    setQuery(p.name)
    setOpen(false)
    onChange({ partnerId: p.id, providerName: '' })
  }

  const trimmed = query.trim()
  // El partner que se llama EXACTAMENTE como lo tipeado, si hay uno y todavía
  // no se vinculó. Comparación normalizada: "autech" y "Autech" son el mismo.
  const exact =
    partnerId === null && trimmed !== ''
      ? (partners.find((p) => normalizeForMatch(p.name) === normalizeForMatch(trimmed)) ?? null)
      : null

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <Input
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[highlight] ? `${listId}-${highlight}` : undefined}
          autoComplete="off"
          maxLength={200}
          value={query}
          placeholder="Buscar en el directorio, o escribir el nombre"
          onChange={(e) => {
            const v = e.currentTarget.value
            setQuery(v)
            setHighlight(0)
            setOpen(true)
            // Tipear DESVINCULA: el id que había dejaría de corresponderse con
            // lo que se lee en pantalla, y ese desacuerdo es invisible.
            onChange({ partnerId: null, providerName: v })
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              if (!open) {
                setOpen(true)
                return
              }
              if (matches.length === 0) return
              const delta = e.key === 'ArrowDown' ? 1 : -1
              setHighlight((h) => (h + delta + matches.length) % matches.length)
              return
            }
            if (e.key === 'Enter') {
              // Sólo intercepta con la lista abierta y algo resaltado: si no,
              // deja que el Enter mande el formulario, como en cualquier input.
              const candidate = open ? matches[highlight] : undefined
              if (candidate) {
                e.preventDefault()
                pickPartner(candidate)
              }
              return
            }
            if (e.key === 'Escape' && open) {
              e.preventDefault()
              setOpen(false)
            }
          }}
          className="pr-8 text-xs"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={() => setOpen((o) => !o)}
          className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground"
        >
          <ChevronDown className="size-3.5" />
        </button>
      </div>

      {open ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 w-full overflow-y-auto rounded-md border border-border bg-card py-1"
          style={{ maxHeight: `${VISIBLE_OPTIONS * 2.25}rem` }}
        >
          {matches.length === 0 ? (
            <li className="px-3 py-1.5 text-xs text-muted-foreground">
              Ningún taller del directorio coincide con «{trimmed}». Se guarda como taller de afuera.
            </li>
          ) : (
            matches.map((p, i) => (
              <li key={p.id} id={`${listId}-${i}`} role="option" aria-selected={i === highlight}>
                <button
                  type="button"
                  // `onMouseDown` y no `onClick`: el blur del input llega
                  // primero y cerraría la lista antes de que el click resuelva.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickPartner(p)
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    'flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-xs',
                    i === highlight ? 'bg-secondary' : undefined,
                  )}
                >
                  <span className="truncate">{p.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {p.tier === 'founding' ? 'Aliado · ' : ''}
                    {p.coverageZone || 'sin zona'}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}

      {partnerId !== null ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="border-brand/30 bg-brand-soft text-brand">
            del directorio
          </Badge>
          <button
            type="button"
            onClick={() => {
              const text = selectedLabel ?? ''
              setQuery(text)
              setOpen(false)
              onChange({ partnerId: null, providerName: text })
            }}
            className="rounded text-xs text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            desvincular
          </button>
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="border-border text-muted-foreground">
            taller de afuera
          </Badge>
          {exact ? (
            <button
              type="button"
              onClick={() => pickPartner(exact)}
              className="rounded text-xs text-status-yellow underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              «{exact.name}» está en el directorio — vincularlo
            </button>
          ) : null}
        </div>
      )}
    </div>
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

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
}
