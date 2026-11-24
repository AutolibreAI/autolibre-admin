import { useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { CarFront, RotateCcw } from 'lucide-react'
import { identifyQuoteRequestVehicleFn } from '~/fn/quote-plate'
import { applyQuoteVehicleSuggestionFn } from '~/fn/quote-vehicle'
import {
  canIdentifyQuoteVehicle,
  canonicalPlate,
  readableQuotePlateError,
  readableApplyVehicleError,
  readableQuotePlateResult,
  readableVehicleFill,
  type ReadableQuotePlateError,
  type ReadableQuotePlateResult,
} from '~/lib/quote-plate'
import type { QuoteRequestDetail } from '~/lib/quote-requests'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { cn } from '~/lib/utils'

const TONE_CLASS: Record<ReadableQuotePlateResult['tone'], string> = {
  green: 'text-status-green',
  yellow: 'text-status-yellow',
  red: 'text-status-red',
}

/**
 * «Identificar vehículo»: la patente del pedido → el modelo de catálogo que
 * exige el despacho por WhatsApp. → `~/lib/quote-plate`
 *
 * Se ofrece sólo con el pedido abierto y SIN modelo: el vehículo de un pedido
 * no cambia, así que con modelo la tarjeta sólo lo muestra. Montado siempre (con
 * `key` por pedido) para que el aviso del resultado sobreviva al
 * `router.invalidate()` que relee la ficha y el borrador del despacho.
 */
export function QuotePlateIdentifier({ detail }: { detail: QuoteRequestDetail }) {
  const router = useRouter()
  const catalog = detail.requestVehicleCatalog
  const [plate, setPlate] = useState(detail.plate ?? '')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ReadableQuotePlateResult | null>(null)
  const [error, setError] = useState<ReadableQuotePlateError | null>(null)
  const [fillNote, setFillNote] = useState<string | null>(null)
  const [applyBusy, setApplyBusy] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const inFlight = useRef(false)

  // La patente del pedido precarga el campo. Si cambia (se cargó en «Editar
  // datos» o al identificar), el campo la sigue.
  useEffect(() => {
    setPlate(detail.plate ?? '')
  }, [detail.plate])

  if (!catalog.available) return null

  // «Usar este vehículo»: lo identificado difiere de lo escrito a mano. Si el
  // campo está vacío, identificar ya lo completa solo; acá queda el botón por
  // si eso no pasó (pedido identificado antes de la 036, o desde la app).
  const suggestion = detail.vehicleSuggestion
  const norm = (v: string | null) => (v ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  const offerSuggestion =
    suggestion !== null && suggestion.writable && norm(suggestion.text) !== norm(detail.vehicleText)

  async function applySuggestion() {
    if (inFlight.current) return
    inFlight.current = true
    setApplyBusy(true)
    setApplyError(null)
    try {
      await applyQuoteVehicleSuggestionFn({ data: { quoteRequestId: detail.id, expected: detail.vehicleText } })
      setFillNote(null)
      await router.invalidate()
    } catch (cause) {
      setApplyError(readableApplyVehicleError(cause))
      await router.invalidate()
    } finally {
      inFlight.current = false
      setApplyBusy(false)
    }
  }

  const editable = canIdentifyQuoteVehicle(detail.status, catalog.vehicleCatalogId)
  const valid = canonicalPlate(plate) !== null

  async function identify() {
    if (inFlight.current || !valid) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setResult(null)
    setFillNote(null)
    setApplyError(null)
    try {
      const res = await identifyQuoteRequestVehicleFn({ data: { quoteRequestId: detail.id, plate } })
      setResult(readableQuotePlateResult(res.status))
      setFillNote(readableVehicleFill(res.vehicleFill))
      await router.invalidate()
    } catch (cause) {
      const readable = readableQuotePlateError(cause)
      setError(readable)
      if (readable.action === 'stale') await router.invalidate()
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1.5">
      {catalog.vehicleCatalogId ? (
        <p className="text-sm">
          {catalog.label ?? 'Modelo asignado'}
          <span className="block text-xs text-muted-foreground">
            Modelo del pedido: es el que usa el despacho. No se cambia.
          </span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Sin modelo todavía: sin él no se puede despachar por WhatsApp.
        </p>
      )}

      {editable ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void identify()
          }}
        >
          <Input
            aria-label="Patente del vehículo"
            value={plate}
            disabled={busy}
            autoComplete="off"
            placeholder="AB123CD"
            maxLength={20}
            onChange={(e) => setPlate(e.currentTarget.value)}
            className="h-8 w-36 font-mono uppercase tracking-wider shadow-none"
          />
          <Button type="submit" size="sm" variant="outline" className="gap-1.5 shadow-none" disabled={busy || !valid}>
            {error?.action === 'retry' ? (
              <RotateCcw className="size-3.5" aria-hidden />
            ) : (
              <CarFront className="size-3.5" aria-hidden />
            )}
            {busy ? 'Consultando…' : error?.action === 'retry' ? 'Reintentar' : 'Identificar vehículo'}
          </Button>
          {plate.trim() !== '' && !valid ? (
            <span className="w-full text-xs text-status-red">No es una patente válida (ej.: AB123CD o ABC123).</span>
          ) : null}
          {busy ? (
            <span className="w-full text-xs text-muted-foreground" role="status">
              Consultando al proveedor de patentes, puede tardar unos segundos…
            </span>
          ) : null}
        </form>
      ) : null}

      {offerSuggestion && suggestion ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-xs">
          <span>
            Identificado: <span className="font-medium">{suggestion.text}</span>
            {detail.vehicleText ? (
              <span className="text-muted-foreground"> · escrito a mano: «{detail.vehicleText}»</span>
            ) : null}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 shadow-none"
            disabled={applyBusy}
            onClick={() => void applySuggestion()}
          >
            {applyBusy ? 'Guardando…' : 'Usar este vehículo'}
          </Button>
        </div>
      ) : null}
      {applyError ? (
        <p role="alert" className="text-xs leading-relaxed text-status-red">
          {applyError}
        </p>
      ) : null}
      {fillNote ? (
        <p role="status" className="text-xs leading-relaxed text-muted-foreground">
          {fillNote}
        </p>
      ) : null}
      {result ? (
        <p role="status" className={cn('text-xs leading-relaxed', TONE_CLASS[result.tone])}>
          {result.text}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className={cn('text-xs leading-relaxed', error.action === 'retry' ? 'text-status-yellow' : 'text-status-red')}
        >
          {error.text}
        </p>
      ) : null}
    </div>
  )
}
