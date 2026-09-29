import { useState, type DragEvent } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { GripVertical, Lock } from 'lucide-react'
import { closeQuoteRequestFn, markQuoteRequestAnsweredFn, markQuoteRequestContactedFn } from '~/fn/quote-requests'
import {
  QUOTE_REQUEST_STATUSES,
  QUOTE_REQUEST_TRANSITIONS,
  canMoveQuoteRequest,
  quoteCancellationReasonLabel,
  quoteChannelLabel,
  quoteCloseReasonLabel,
  quoteOutcomeLabel,
  quotePublicCode,
  quoteStatusLabel,
  readableQuoteRequestError,
  type OperatorCloseReason,
  type QuoteRequestListItem,
  type QuoteRequestOutcome,
  type QuoteRequestStatus,
} from '~/lib/quote-requests'
import { CloseFields, ProposalsCountField, isValidProposalsCount } from '~/components/QuoteRequestActions'
import { QuoteVehicleWarnings, quoteAgeLabel } from '~/components/QuoteRequestCells'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog'
import { formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * El tablero de pedidos: una columna por estado, y la tarjeta se ARRASTRA para
 * moverla. Es la otra vista de `/leads/pedidos` (`quoteView=tablero`), sobre
 * las MISMAS filas que la lista.
 *
 * ── Escribe por los mismos SPs que la ficha ────────────────────────────────
 *
 * Soltar una tarjeta llama a `markQuoteRequestContactedFn` /
 * `markQuoteRequestAnsweredFn` / `closeQuoteRequestFn` — los SPs de `ops` de la
 * 011/016, con el actor de la sesión. No hay un segundo camino de escritura: la
 * 011 alternativa que movía de cualquier estado a cualquier estado se descartó
 * justamente por eso (`ops-write-actions.md`).
 *
 * ── Todo movimiento se confirma ─────────────────────────────────────────────
 *
 * Ningún SP retrocede y `closed` no se reabre, así que TODO movimiento es
 * irreversible. Soltar no escribe: abre un recuadro con «¿Estás seguro?» y
 * Sí / No, y ahí mismo pide lo que esa transición necesita (la cantidad de
 * propuestas para respondido; motivo, resultado y nota para cerrar). Los
 * campos son los de la ficha (`CloseFields`, `ProposalsCountField`).
 *
 * ── Sin movimiento optimista ────────────────────────────────────────────────
 *
 * La tarjeta no cambia de columna hasta que la base confirma y se relee. Con
 * «No» o con un error, nunca se movió: no hay nada que deshacer.
 *
 * ── Arrastre nativo; el click abre la ficha ─────────────────────────────────
 *
 * HTML5 drag & drop, sin librería. Las columnas que no aceptan la tarjeta se
 * apagan mientras se arrastra y dicen por qué. No hay alternativa por teclado
 * ni táctil para MOVER (se sacó «Mover a…» a pedido: no se usaba); para eso
 * está la ficha, que es adonde lleva el click en la tarjeta.
 */

type Move = { row: QuoteRequestListItem; to: QuoteRequestStatus }
type Flash = { kind: 'error' | 'done'; text: string } | null

export function QuoteBoard({ rows }: { rows: ReadonlyArray<QuoteRequestListItem> }) {
  const [dragging, setDragging] = useState<QuoteRequestListItem | null>(null)
  const [over, setOver] = useState<QuoteRequestStatus | null>(null)
  const [move, setMove] = useState<Move | null>(null)
  // Vive acá y no en el recuadro: al confirmar, el recuadro se cierra y la
  // tarjeta se muda de columna, pero el "hecho" se tiene que seguir viendo.
  const [flash, setFlash] = useState<Flash>(null)

  // Agrupa respetando el orden que ya trae el listado (`sort`/`dir` de la URL).
  const byStatus = new Map<string, Array<QuoteRequestListItem>>()
  for (const r of rows) {
    const list = byStatus.get(r.status) ?? []
    list.push(r)
    byStatus.set(r.status, list)
  }
  // Un estado que el espejo no conoce no tiene columna — se dice, no se esconde.
  const unknown = rows.filter((r) => !(QUOTE_REQUEST_STATUSES as ReadonlyArray<string>).includes(r.status))

  function openMove(row: QuoteRequestListItem, to: QuoteRequestStatus) {
    if (!canMoveQuoteRequest(row.status, to)) return
    setFlash(null)
    setMove({ row, to })
  }

  return (
    <div>
      {flash ? (
        <p
          role={flash.kind === 'error' ? 'alert' : 'status'}
          className={cn('mb-3 text-sm', flash.kind === 'error' ? 'text-destructive' : 'text-status-green')}
        >
          {flash.text}
        </p>
      ) : null}

      <div className="overflow-x-auto pb-2">
        <div className="grid min-w-[60rem] grid-cols-4 gap-3">
          {QUOTE_REQUEST_STATUSES.map((status) => {
            const cards = byStatus.get(status) ?? []
            const accepts = dragging !== null && canMoveQuoteRequest(dragging.status, status)
            const blocked = dragging !== null && dragging.status !== status && !accepts
            return (
              <section
                key={status}
                aria-label={`${quoteStatusLabel(status)}: ${cards.length} pedidos`}
                onDragOver={(e) => {
                  if (!accepts) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (over !== status) setOver(status)
                }}
                onDragLeave={(e) => {
                  // `dragleave` también dispara al pasar sobre un hijo: sólo se
                  // apaga si el puntero salió de la columna de verdad.
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const row = dragging
                  setDragging(null)
                  setOver(null)
                  if (row) openMove(row, status)
                }}
                className={cn(
                  'flex min-h-[12rem] flex-col rounded-lg border bg-surface-2 p-2 transition-colors',
                  accepts
                    ? over === status
                      ? 'border-brand bg-brand-soft'
                      : 'border-dashed border-brand/60'
                    : 'border-border',
                  blocked && 'opacity-50',
                )}
              >
                <header className="mb-2 flex items-baseline justify-between gap-2 px-1">
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {quoteStatusLabel(status)}
                  </h2>
                  <span className="text-xs tabular-nums text-muted-foreground">{formatInt(cards.length)}</span>
                </header>

                {blocked && dragging ? (
                  <p className="mb-2 px-1 text-xs text-muted-foreground">{blockedReason(dragging.status, status)}</p>
                ) : null}

                <div className="flex flex-1 flex-col gap-2">
                  {cards.length === 0 ? (
                    <p className="px-1 py-4 text-center text-xs text-muted-foreground/70">Sin pedidos</p>
                  ) : (
                    cards.map((row) => (
                      <BoardCard
                        key={row.id}
                        row={row}
                        dragging={dragging?.id === row.id}
                        onDragStart={(e) => {
                          // Firefox no arranca un arrastre sin `setData`.
                          e.dataTransfer.setData('text/plain', row.id)
                          e.dataTransfer.effectAllowed = 'move'
                          setFlash(null)
                          setDragging(row)
                        }}
                        onDragEnd={() => {
                          setDragging(null)
                          setOver(null)
                        }}
                      />
                    ))
                  )}
                </div>
              </section>
            )
          })}
        </div>
      </div>

      {unknown.length > 0 ? (
        <p className="mt-3 text-xs text-status-yellow">
          {formatInt(unknown.length)} pedidos en un estado que el panel no conoce (
          {[...new Set(unknown.map((r) => r.status))].join(', ')}): no tienen columna. Se ven en la lista.
        </p>
      ) : null}

      {move ? (
        <TransitionDialog
          // Un recuadro nuevo por movimiento: los campos arrancan vacíos siempre.
          key={`${move.row.id}:${move.to}`}
          move={move}
          onCancel={() => setMove(null)}
          onDone={(text) => {
            setMove(null)
            setFlash({ kind: 'done', text })
          }}
        />
      ) : null}
    </div>
  )
}

/** Por qué una columna no acepta la tarjeta que se está arrastrando. */
function blockedReason(from: string, to: string): string {
  if (from === 'closed') return 'Un pedido cerrado no se mueve.'
  if (from === 'received' && to === 'answered') return 'Primero hay que marcarlo contactado.'
  return 'No se vuelve a un estado anterior.'
}

// ── La tarjeta ───────────────────────────────────────────────────────────────

function BoardCard({
  row,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  row: QuoteRequestListItem
  dragging: boolean
  onDragStart: (e: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
}) {
  const targets = (QUOTE_REQUEST_TRANSITIONS as Record<string, ReadonlyArray<QuoteRequestStatus> | undefined>)[
    row.status
  ] ?? []
  const movable = targets.length > 0
  const cancelledByUser = row.closeReasonCode === 'cancelled_by_user'

  return (
    <article
      draggable={movable}
      onDragStart={movable ? onDragStart : undefined}
      onDragEnd={movable ? onDragEnd : undefined}
      className={cn(
        'relative rounded-md border border-border bg-card p-3 text-sm transition-colors hover:border-foreground/20',
        movable && 'cursor-grab active:cursor-grabbing',
        dragging && 'opacity-40',
        row.status === 'closed' && 'opacity-75',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/*
            El link se ESTIRA sobre toda la tarjeta (`after:absolute
            after:inset-0`): un click en cualquier lado abre la ficha, y sigue
            siendo un link de verdad —Tab lo alcanza, el botón del medio abre
            otra pestaña—, no un `onClick` sobre un `<article>`.
            `draggable={false}`: un link es arrastrable por sí mismo y
            arrastraría la URL; así el arrastre lo toma la tarjeta. El navegador
            no dispara `click` al terminar un arrastre, así que soltar no navega.
          */}
          <Link
            to="/leads/pedidos/$quoteRequestId"
            params={{ quoteRequestId: row.id }}
            draggable={false}
            aria-label={`Abrir el pedido ${quotePublicCode(row.publicNumber)}`}
            className="rounded font-mono font-semibold tracking-wide text-brand outline-none after:absolute after:inset-0 after:rounded-md after:content-[''] hover:underline focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-offset-2 focus-visible:after:ring-offset-background"
          >
            {quotePublicCode(row.publicNumber)}
          </Link>
          <div className="text-xs text-muted-foreground">
            {quoteAgeLabel(row.ageHours)} · {quoteChannelLabel(row.channel)}
            {row.enteredManually ? ' · a mano' : ''}
          </div>
        </div>
        {movable ? (
          <GripVertical className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" aria-hidden />
        ) : (
          <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
        )}
      </div>

      <div className="mt-2 truncate">{row.contactName ?? <span className="text-muted-foreground/70">sin nombre</span>}</div>
      <div className="text-xs">
        {row.plate ? <span className="font-mono font-semibold tracking-wider">{row.plate}</span> : null}
        {row.catalogLabel ? (
          <span className="text-muted-foreground">{row.plate ? ' · ' : ''}{row.catalogLabel}</span>
        ) : !row.vehicleId && row.vehicleText ? (
          <span className="text-muted-foreground">{row.plate ? ' · ' : ''}{row.vehicleText}</span>
        ) : !row.plate ? (
          <span className="text-muted-foreground/70">sin vehículo</span>
        ) : null}
      </div>
      {row.vehicleId ? <QuoteVehicleWarnings row={row} /> : null}

      <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground" title={row.description}>
        {row.description}
      </p>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {row.uncontacted ? <span className="font-medium text-status-yellow">sin contactar</span> : null}
        {row.responseCount !== null ? (
          <span className={cn(row.responseCount > 0 && 'font-medium text-foreground')}>
            {formatInt(row.responseCount)} {row.responseCount === 1 ? 'presupuesto' : 'presupuestos'}
          </span>
        ) : null}
        {row.noteCount > 0 ? <span>{formatInt(row.noteCount)} notas</span> : null}
        {row.closeReasonCode ? (
          <span className={cn(cancelledByUser && 'text-foreground')}>
            {quoteCloseReasonLabel(row.closeReasonCode)}
            {cancelledByUser && row.cancellationReason
              ? ` · ${quoteCancellationReasonLabel(row.cancellationReason)}`
              : ''}
          </span>
        ) : null}
        {row.status === 'closed' && row.outcome ? <span>{quoteOutcomeLabel(row.outcome)}</span> : null}
      </div>

    </article>
  )
}

// ── El recuadro de confirmación ──────────────────────────────────────────────

const CONSEQUENCE: Record<Exclude<QuoteRequestStatus, 'received'>, string> = {
  contacted:
    'Ya le respondimos algo a la persona —un mensaje, una llamada, un «estamos buscando»—. La app se lo muestra. No se puede volver a «Recibido».',
  answered:
    'Se le pasaron las propuestas que se consiguieron. La app muestra la cantidad y le habilita a la persona declarar si contrató. No se puede volver a «Contactado».',
  closed:
    'Cerrar es definitivo: el pedido no se reabre y no admite más notas internas. «Cancelado por el usuario» no se ofrece: lo pone sólo la app.',
}

function TransitionDialog({
  move,
  onCancel,
  onDone,
}: {
  move: Move
  onCancel: () => void
  onDone: (text: string) => void
}) {
  const router = useRouter()
  const { row, to } = move
  const code = quotePublicCode(row.publicNumber)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // respondido
  const [count, setCount] = useState('')
  // cerrar — `null` en outcome = «Sin preguntar», NO `no_response`
  const [reason, setReason] = useState<OperatorCloseReason | null>(null)
  const [outcome, setOutcome] = useState<QuoteRequestOutcome | null>(null)
  const [note, setNote] = useState('')

  const ready =
    to === 'contacted' || (to === 'answered' && isValidProposalsCount(count)) || (to === 'closed' && reason !== null)

  async function confirm() {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      const quoteRequestId = row.id
      if (to === 'contacted') {
        await markQuoteRequestContactedFn({ data: { quoteRequestId } })
      } else if (to === 'answered') {
        await markQuoteRequestAnsweredFn({ data: { quoteRequestId, proposalsCount: Number(count.trim()) } })
      } else if (to === 'closed' && reason) {
        await closeQuoteRequestFn({
          data: {
            quoteRequestId,
            closeReasonCode: reason,
            outcome: outcome ?? undefined,
            internalNote: note.trim() || undefined,
          },
        })
      }
      // El estado nuevo (fechas, hilo) lo escribió Postgres: se relee, no se
      // inventa una copia optimista.
      await router.invalidate()
      onDone(`${code} pasó a «${quoteStatusLabel(to)}».`)
    } catch (cause) {
      setError(readableQuoteRequestError(cause))
      // El pedido cambió por debajo (p. ej. la persona lo canceló desde la
      // app): el tablero se relee para mostrar dónde está de verdad.
      if (cause instanceof Error && cause.message.includes('INVALID_QUOTE_REQUEST_TRANSITION')) {
        void router.invalidate()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Mientras viaja la escritura no se cierra: el resultado se tiene que ver.
        if (!open && !busy) onCancel()
      }}
    >
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void confirm()
          }}
        >
          <DialogTitle>¿Estás seguro?</DialogTitle>
          <DialogDescription className="mt-1">
            <span className="font-mono font-semibold text-foreground">{code}</span>
            {row.contactName ? ` · ${row.contactName}` : ''} · {quoteStatusLabel(row.status)} →{' '}
            <strong className="text-foreground">{quoteStatusLabel(to)}</strong>
          </DialogDescription>

          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {to === 'received' ? null : CONSEQUENCE[to]}
          </p>

          <fieldset disabled={busy} className="mt-4 space-y-3 disabled:opacity-60">
            {to === 'answered' ? <ProposalsCountField value={count} onChange={setCount} /> : null}
            {to === 'closed' ? (
              <CloseFields
                code={reason}
                onCode={setReason}
                outcome={outcome}
                onOutcome={setOutcome}
                note={note}
                onNote={setNote}
              />
            ) : null}
          </fieldset>

          {error ? (
            <p role="alert" className="mt-3 text-xs leading-relaxed text-destructive">
              {error}
            </p>
          ) : null}

          {!ready && to === 'closed' ? (
            <p className="mt-3 text-xs text-muted-foreground">Elegí un motivo para poder cerrar.</p>
          ) : null}

          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCancel}>
              No
            </Button>
            <Button type="submit" size="sm" disabled={busy || !ready}>
              {busy ? 'Guardando…' : 'Sí'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
