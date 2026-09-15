import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import {
  QUOTE_REQUEST_ADMIN_CLOSE_REASONS,
  QUOTE_REQUEST_STATUSES,
  quoteCloseReasonLabel,
  quoteStatusLabel,
  readableAdvanceQuoteRequestError,
  type QuoteRequestStatus,
} from '~/lib/quote-requests'
import { advanceQuoteRequestFn } from '~/fn/quote-requests'
import { QuoteStatusBadge } from '~/components/QuoteRequestCells'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { cn } from '~/lib/utils'

/**
 * Cambiar el estado de un pedido — usado en `/leads/pedidos` (una fila) y en
 * `/leads/pedidos/:id` (la ficha). Un solo componente, no dos copias: mismo
 * criterio que `QuoteStatusBadge` en `QuoteRequestCells.tsx`, que este
 * componente reutiliza para el estado actual en vez de repintar el badge.
 *
 * ── Por qué "Respondido" y "Cerrado" no son un click directo ────────────────
 *
 * `ops.advance_quote_request` (migración 011) exige datos que un botón solo no
 * tiene: cuántas propuestas se devolvieron (la PRIMERA vez que se llega a
 * `answered`) y el motivo del cierre (siempre). Pedir el número por
 * `globalThis.prompt` es el mismo patrón que `leads.talleres.tsx` usa para
 * `lostReason` — un modal para un campo opcional sería más UI que problema.
 * El motivo de cierre SÍ es un desplegable: son 4 valores fijos
 * (`QUOTE_REQUEST_ADMIN_CLOSE_REASONS` — nunca `cancelled_by_user`, que lo
 * declara la persona al cancelar desde la app) y un `prompt()` obligaría a
 * tipear el valor exacto en inglés.
 *
 * ── Después de escribir, se invalida la ruta — no se arma el estado local ───
 *
 * `router.invalidate()` vuelve a correr el loader de lo que esté montado
 * (listado o ficha) y trae `uncontacted`, los tiempos y demás derivados YA
 * recalculados con el mismo SELECT que usa el resto de la pantalla. Mantener
 * una copia local del pedido actualizado a mano sería la misma clase de
 * duplicación que el repo evita en el propio `advanceQuoteRequest()`.
 */
export function QuoteStatusControl({
  quoteRequestId,
  status,
  proposalsCount,
  className,
}: {
  quoteRequestId: string
  status: string
  proposalsCount: number | null
  className?: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const [closeReasonCode, setCloseReasonCode] = useState<string>('')
  const [closedReason, setClosedReason] = useState('')

  async function advance(
    next: QuoteRequestStatus,
    extra?: { proposalsCount?: number; closeReasonCode?: string; closedReason?: string },
  ) {
    setBusy(true)
    setError(null)
    try {
      await advanceQuoteRequestFn({
        data: {
          quoteRequestId,
          status: next,
          proposalsCount: extra?.proposalsCount,
          closeReasonCode: extra?.closeReasonCode as (typeof QUOTE_REQUEST_ADMIN_CLOSE_REASONS)[number] | undefined,
          closedReason: extra?.closedReason,
        },
      })
      await router.invalidate()
      setClosing(false)
      setCloseReasonCode('')
      setClosedReason('')
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause)
      setError(readableAdvanceQuoteRequestError(raw))
    } finally {
      setBusy(false)
    }
  }

  function move(next: QuoteRequestStatus) {
    setError(null)
    if (next === 'closed') {
      setClosing(true)
      return
    }
    if (next === 'answered' && proposalsCount === null) {
      const raw = globalThis.prompt('¿Cuántas propuestas se devolvieron?')
      if (raw === null) return // Canceló el prompt.
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 0) {
        setError('Tiene que ser un número entero, 0 o más.')
        return
      }
      void advance(next, { proposalsCount: n })
      return
    }
    void advance(next)
  }

  return (
    <div className={cn('space-y-1.5', className)}>
      <QuoteStatusBadge status={status} />

      <div className="flex flex-wrap gap-1">
        {QUOTE_REQUEST_STATUSES.filter((s) => s !== status).map((s) => (
          <Button
            key={s}
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            className="h-auto px-2 py-1 text-xs"
            onClick={() => move(s)}
          >
            {quoteStatusLabel(s)}
          </Button>
        ))}
      </div>

      {closing ? (
        <div className="flex w-56 flex-col gap-1.5 rounded-md border border-border bg-secondary/40 p-2">
          <Select value={closeReasonCode} onValueChange={setCloseReasonCode}>
            <SelectTrigger size="sm" className="w-full text-xs">
              <SelectValue placeholder="Motivo del cierre…" />
            </SelectTrigger>
            <SelectContent>
              {QUOTE_REQUEST_ADMIN_CLOSE_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {quoteCloseReasonLabel(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={closedReason}
            onChange={(e) => setClosedReason(e.currentTarget.value)}
            placeholder="Nota interna (opcional)"
            className="h-8 text-xs"
          />
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              disabled={busy || !closeReasonCode}
              className="h-auto px-2 py-1 text-xs"
              onClick={() =>
                void advance('closed', {
                  closeReasonCode,
                  closedReason: closedReason.trim() === '' ? undefined : closedReason,
                })
              }
            >
              Confirmar cierre
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              className="h-auto px-2 py-1 text-xs"
              onClick={() => {
                setClosing(false)
                setCloseReasonCode('')
                setClosedReason('')
                setError(null)
              }}
            >
              Cancelar
            </Button>
          </div>
        </div>
      ) : null}

      {error ? <p className="max-w-56 text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
