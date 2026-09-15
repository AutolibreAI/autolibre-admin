import { useId, useState, type ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { CheckCheck, Lock, MessageSquarePlus, PhoneCall, XCircle } from 'lucide-react'
import {
  addQuoteRequestInternalNoteFn,
  closeQuoteRequestFn,
  markQuoteRequestAnsweredFn,
  markQuoteRequestContactedFn,
} from '~/fn/quote-requests'
import {
  OPEN_QUOTE_REQUEST_STATUSES,
  OPERATOR_CLOSE_REASONS,
  QUOTE_REQUEST_OUTCOMES,
  quoteCloseReasonLabel,
  quoteOutcomeLabel,
  quoteStatusLabel,
  readableQuoteRequestError,
  type OperatorCloseReason,
  type QuoteRequestOutcome,
} from '~/lib/quote-requests'
import { Chip, FilterGroup } from '~/components/Filters'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'

/**
 * Las transiciones del operador sobre un `QuoteRequest` — los SPs de `ops` de
 * la migración 011.
 *
 * ── Sólo se renderiza con la tabla disponible ──────────────────────────────
 *
 * Recibe campos de `QuoteRequestDetail`, que la ruta sólo tiene en la rama
 * `available: true`: sin tabla, la ficha corta antes en
 * `QuoteRequestsUnavailable` y esto no tiene con qué montarse. Igual el handler
 * de cada escritura re-chequea la disponibilidad — la UI no es el guard.
 *
 * ── El error vive ARRIBA, no en cada formulario ────────────────────────────
 *
 * Una transición inválida (la persona canceló desde la app mientras el
 * operador miraba) recarga la ficha para mostrar el estado real — y ese estado
 * nuevo desmonta el formulario que falló. Si el mensaje viviera adentro, se
 * iría con él. Por eso el componente queda montado en TODOS los estados
 * (cerrado incluido) y es dueño del error y del "hecho".
 */

const isOpen = (status: string) => (OPEN_QUOTE_REQUEST_STATUSES as ReadonlyArray<string>).includes(status)

type Flash = { kind: 'error' | 'done'; text: string } | null

function useQuoteAction() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<Flash>(null)

  async function run(action: () => Promise<unknown>, doneText: string): Promise<boolean> {
    setBusy(true)
    setFlash(null)
    try {
      await action()
      // El estado nuevo lo escribió Postgres (fechas, hilo de notas). Se relee;
      // una copia optimista inventaría lo que la base ya sabe.
      await router.invalidate()
      setFlash({ kind: 'done', text: doneText })
      return true
    } catch (cause) {
      setFlash({ kind: 'error', text: readableQuoteRequestError(cause) })
      // El pedido cambió por debajo: recargar deja la pantalla diciendo la verdad.
      if (cause instanceof Error && cause.message.includes('INVALID_QUOTE_REQUEST_TRANSITION')) {
        void router.invalidate()
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  return { busy, flash, run }
}

function FlashLine({ flash }: { flash: Flash }) {
  if (!flash) return null
  return flash.kind === 'error' ? (
    <p role="alert" className="mt-3 text-xs leading-relaxed text-destructive">
      {flash.text}
    </p>
  ) : (
    <p role="status" className="mt-3 text-xs text-status-green">
      {flash.text}
    </p>
  )
}

type RunFn = ReturnType<typeof useQuoteAction>['run']

export function QuoteRequestActions({
  quoteRequestId,
  status,
  closeReasonCode,
}: {
  quoteRequestId: string
  status: string
  closeReasonCode: string | null
}) {
  const { busy, flash, run } = useQuoteAction()

  if (!isOpen(status)) {
    return (
      <Card className="mb-4">
        <CardContent className="pt-6">
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              {status === 'closed'
                ? closeReasonCode === 'cancelled_by_user'
                  ? 'Cancelado por la persona desde la app. Un pedido cerrado no admite más transiciones ni notas internas, y no se reabre.'
                  : 'Pedido cerrado. No admite más transiciones ni notas internas, y no se reabre.'
                : `Estado «${quoteStatusLabel(status)}» desconocido para el panel: no se ofrecen acciones.`}
            </p>
          </div>
          <FlashLine flash={flash} />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Acciones</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-8 lg:grid-cols-2">
          <div>
            {status === 'received' ? (
              <ContactedForm quoteRequestId={quoteRequestId} busy={busy} run={run} />
            ) : status === 'contacted' ? (
              <AnsweredForm quoteRequestId={quoteRequestId} busy={busy} run={run} />
            ) : (
              <div>
                <FormTitle>Respondido</FormTitle>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Ya se le pasaron las propuestas. Lo que queda es cerrarlo cuando se sepa cómo terminó.
                </p>
              </div>
            )}
          </div>
          <CloseForm quoteRequestId={quoteRequestId} busy={busy} run={run} />
        </div>
        <p className="mt-6 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
          Cada acción corre un stored procedure de <code className="font-mono">ops</code> que valida el estado
          contra la fila bloqueada y deja el antes y el después en <code className="font-mono">ops.action_log</code>{' '}
          a tu nombre.
        </p>
        <FlashLine flash={flash} />
      </CardContent>
    </Card>
  )
}

// ── received → contacted ─────────────────────────────────────────────────────

function ContactedForm({ quoteRequestId, busy, run }: { quoteRequestId: string; busy: boolean; run: RunFn }) {
  const [auditNote, setAuditNote] = useState('')

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        void run(
          () => markQuoteRequestContactedFn({ data: { quoteRequestId, auditNote: auditNote.trim() || undefined } }),
          'Marcado como contactado.',
        )
      }}
    >
      <div>
        <FormTitle>Marcar contactado</FormTitle>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Ya le respondimos algo a la persona —un mensaje, una llamada, un «estamos buscando»—. La app se lo muestra,
          y mientras no esté respondido la persona todavía puede cancelarlo.
        </p>
      </div>
      <AuditNoteField value={auditNote} onChange={setAuditNote} />
      <Button type="submit" size="sm" disabled={busy} className="gap-1.5">
        <PhoneCall className="size-3.5" aria-hidden />
        {busy ? 'Guardando…' : 'Marcar contactado'}
      </Button>
    </form>
  )
}

// ── contacted → answered ─────────────────────────────────────────────────────

function AnsweredForm({ quoteRequestId, busy, run }: { quoteRequestId: string; busy: boolean; run: RunFn }) {
  const countId = useId()
  const [count, setCount] = useState('')
  const [auditNote, setAuditNote] = useState('')

  // Sólo dígitos: `Number('')` es 0, y un campo vacío mandado como cero diría
  // "no conseguimos nada" sin que nadie lo haya escrito.
  const valid = /^\d+$/.test(count.trim())

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        void run(
          () =>
            markQuoteRequestAnsweredFn({
              data: { quoteRequestId, proposalsCount: Number(count.trim()), auditNote: auditNote.trim() || undefined },
            }),
          'Marcado como respondido.',
        )
      }}
    >
      <div>
        <FormTitle>Marcar respondido</FormTitle>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Se le pasaron las propuestas que se consiguieron. La app muestra la cantidad y le habilita a la persona
          declarar si contrató.
        </p>
      </div>
      <div className="space-y-1">
        <label htmlFor={countId} className="block text-xs text-muted-foreground">
          Propuestas que se le pasaron
        </label>
        <Input
          id={countId}
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={count}
          onChange={(e) => {
            const value = e.currentTarget.value
            setCount(value)
          }}
          placeholder="0"
          className="w-28 text-xs tabular-nums"
        />
        <p className="text-xs text-muted-foreground">Cero es válido: llamamos y no conseguimos nada.</p>
      </div>
      <AuditNoteField value={auditNote} onChange={setAuditNote} />
      <Button type="submit" size="sm" disabled={busy || !valid} className="gap-1.5">
        <CheckCheck className="size-3.5" aria-hidden />
        {busy ? 'Guardando…' : 'Marcar respondido'}
      </Button>
    </form>
  )
}

// ── abierto → closed ─────────────────────────────────────────────────────────

/**
 * Cerrar es irreversible (el SP no reabre y un cerrado no admite notas), así
 * que el botón no cierra: pide confirmación en línea, con el resumen de lo que
 * se va a guardar. Mientras se confirma, los campos quedan bloqueados — lo que
 * se confirma es exactamente lo que viaja.
 */
function CloseForm({ quoteRequestId, busy, run }: { quoteRequestId: string; busy: boolean; run: RunFn }) {
  const closedReasonId = useId()
  const outcomeNoteId = useId()
  const [code, setCode] = useState<OperatorCloseReason | null>(null)
  const [closedReason, setClosedReason] = useState('')
  // `null` = "Sin preguntar": no se sabe cómo terminó. NO es `no_response`.
  const [outcome, setOutcome] = useState<QuoteRequestOutcome | null>(null)
  const [outcomeNote, setOutcomeNote] = useState('')
  const [auditNote, setAuditNote] = useState('')
  const [confirming, setConfirming] = useState(false)

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!code || !confirming) return
        void run(
          () =>
            closeQuoteRequestFn({
              data: {
                quoteRequestId,
                closeReasonCode: code,
                closedReason: closedReason.trim() || undefined,
                outcome: outcome ?? undefined,
                outcomeNote: outcomeNote.trim() || undefined,
                auditNote: auditNote.trim() || undefined,
              },
            }),
          'Pedido cerrado.',
        ).then((ok) => {
          if (!ok) setConfirming(false)
        })
      }}
    >
      <div>
        <FormTitle>Cerrar pedido</FormTitle>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Desde cualquier estado abierto. «Cancelado por el usuario» no se ofrece: lo pone sólo la app.
        </p>
      </div>

      <fieldset disabled={confirming || busy} className="space-y-3 disabled:opacity-60">
        <FilterGroup label="Motivo">
          {OPERATOR_CLOSE_REASONS.map((r) => (
            <Chip key={r} active={code === r} onClick={() => setCode(r)}>
              {quoteCloseReasonLabel(r)}
            </Chip>
          ))}
        </FilterGroup>

        <div className="space-y-1">
          <label htmlFor={closedReasonId} className="block text-xs text-muted-foreground">
            Nota interna del cierre (opcional) — la persona nunca la ve
          </label>
          <Textarea
            id={closedReasonId}
            value={closedReason}
            onChange={(e) => {
              const value = e.currentTarget.value
              setClosedReason(value)
            }}
            maxLength={1000}
            rows={2}
            className="text-xs"
          />
        </div>

        <FilterGroup label="Resultado (según el operador)">
          <Chip active={outcome === null} onClick={() => setOutcome(null)}>
            Sin preguntar
          </Chip>
          {QUOTE_REQUEST_OUTCOMES.map((o) => (
            <Chip key={o} active={outcome === o} onClick={() => setOutcome(o)}>
              {quoteOutcomeLabel(o)}
            </Chip>
          ))}
        </FilterGroup>
        <p className="text-xs leading-relaxed text-muted-foreground">
          «Sin preguntar» es que no se sabe; «No respondió» es que se le preguntó y no contestó. Lo que declara la
          persona desde la app va aparte y esto no lo toca.
        </p>

        <div className="space-y-1">
          <label htmlFor={outcomeNoteId} className="block text-xs text-muted-foreground">
            Nota del resultado (opcional)
          </label>
          <Input
            id={outcomeNoteId}
            value={outcomeNote}
            onChange={(e) => {
              const value = e.currentTarget.value
              setOutcomeNote(value)
            }}
            maxLength={1000}
            autoComplete="off"
            className="text-xs"
          />
        </div>

        <AuditNoteField value={auditNote} onChange={setAuditNote} />
      </fieldset>

      {confirming && code ? (
        <div className="rounded-md border border-status-yellow/30 bg-status-yellow-bg p-3">
          <p className="text-xs leading-relaxed text-status-yellow">
            Cerrar es definitivo: el pedido no se reabre y no admite más notas internas. Motivo:{' '}
            <strong>{quoteCloseReasonLabel(code)}</strong> · Resultado:{' '}
            <strong>{outcome ? quoteOutcomeLabel(outcome) : 'Sin preguntar'}</strong>.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy} className="gap-1.5">
              <XCircle className="size-3.5" aria-hidden />
              {busy ? 'Cerrando…' : 'Sí, cerrar pedido'}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              Volver
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || code === null}
          onClick={() => setConfirming(true)}
          className="gap-1.5"
        >
          <XCircle className="size-3.5" aria-hidden />
          Cerrar pedido…
        </Button>
      )}
    </form>
  )
}

// ── Nota interna ─────────────────────────────────────────────────────────────

/**
 * Agrega una línea al hilo de `internal_notes`. Va en la tarjeta de Notas, al
 * pie del hilo que alimenta. Montado en todos los estados por la misma razón
 * que `QuoteRequestActions`: si el pedido se cerró por debajo, el error y el
 * estado nuevo se tienen que ver acá mismo.
 */
export function QuoteRequestNoteComposer({ quoteRequestId, status }: { quoteRequestId: string; status: string }) {
  const textId = useId()
  const { busy, flash, run } = useQuoteAction()
  const [text, setText] = useState('')

  if (!isOpen(status)) {
    return (
      <div className="mt-4 border-t border-border pt-3">
        <p className="text-xs text-muted-foreground">Un pedido cerrado no admite notas internas nuevas.</p>
        <FlashLine flash={flash} />
      </div>
    )
  }

  return (
    <form
      className="mt-4 space-y-2 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (text.trim() === '') return
        void run(
          () => addQuoteRequestInternalNoteFn({ data: { quoteRequestId, text } }),
          'Nota agregada.',
        ).then((ok) => {
          if (ok) setText('')
        })
      }}
    >
      <label htmlFor={textId} className="block text-xs text-muted-foreground">
        Agregar nota interna
      </label>
      <Textarea
        id={textId}
        value={text}
        onChange={(e) => {
          const value = e.currentTarget.value
          setText(value)
        }}
        maxLength={2000}
        rows={3}
        placeholder="Taller X: $180.000, turno el jueves"
        className="text-xs"
      />
      <p className="text-xs leading-relaxed text-muted-foreground">
        Se agrega al final con la hora de Buenos Aires y no se edita ni se borra. Una nota es un renglón: los saltos de
        línea se unen al guardar.
      </p>
      <Button type="submit" size="sm" disabled={busy || text.trim() === ''} className="gap-1.5">
        <MessageSquarePlus className="size-3.5" aria-hidden />
        {busy ? 'Guardando…' : 'Agregar nota'}
      </Button>
      <FlashLine flash={flash} />
    </form>
  )
}

// ── Piezas ───────────────────────────────────────────────────────────────────

function FormTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-1 text-sm font-medium">{children}</h3>
}

/**
 * `p_note` del SP. Rotulado para que no se confunda con la nota interna: esta
 * NO aparece en el hilo del pedido.
 */
function AuditNoteField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId()
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs text-muted-foreground">
        Nota de auditoría (opcional)
      </label>
      <Input
        id={id}
        value={value}
        onChange={(e) => {
          const v = e.currentTarget.value
          onChange(v)
        }}
        maxLength={500}
        autoComplete="off"
        placeholder="Por qué, si no es obvio"
        className="text-xs"
      />
      <p className="text-xs text-muted-foreground">
        Queda en <code className="font-mono">ops.action_log</code>, no en el hilo de notas internas del pedido.
      </p>
    </div>
  )
}
