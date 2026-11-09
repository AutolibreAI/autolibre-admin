import { useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Crosshair, RotateCcw } from 'lucide-react'
import { changeQuoteRequestLocationFn } from '~/fn/quote-location'
import {
  canChangeQuoteLocation,
  readableQuoteLocationError,
  type ReadableQuoteLocationError,
} from '~/lib/quote-location'
import type { QuoteRequestDetail } from '~/lib/quote-requests'
import { Button } from '~/components/ui/button'
import { QuoteRequestLocationEditor } from '~/components/QuoteRequestLocationEditor'
import { cn } from '~/lib/utils'

/** Cada cuánto se relee la ficha mientras el backend geocodifica. Mismo ritmo que `/conocimiento`. */
const GEOCODE_POLL_MS = 5_000
/** Cuánto se espera antes de decir "todavía no". */
const GEOCODE_POLL_MAX_MS = 60_000

/**
 * La ubicación de un pedido en la ficha: el estado de la geocodificación del
 * BACKEND (0140) + «Geocodificar» + «Corregir ubicación». Reemplaza a «Ubicar
 * en el mapa» (el geocoder propio del panel, 021, retirado el 2026-11-09).
 *
 * ── «Geocodificar» es un PUT de ubicación con el cuerpo IDÉNTICO ────────────
 *
 * No `POST …/geocode`: ése usa un jobId fijo por pedido, y BullMQ ignora en
 * silencio un job igual completado en la última hora. El PUT con la misma
 * dirección no escribe nada pero re-encola si `geocoded_at` es NULL (jobId con
 * timestamp). Reusa el server function y los errores de «Corregir ubicación».
 *
 * ── El sondeo ──────────────────────────────────────────────────────────────
 *
 * El panel sólo sabe que acaba de encolar algo cuando él mismo lo encoló (un
 * 204 de «Geocodificar» o de «Corregir ubicación» con `typed`). Ahí relee la
 * ficha cada 5 s hasta que `geocoded_at` cambie respecto del valor de antes, o
 * hasta 60 s; si no, dice que todavía no y por qué puede ser. Es un efecto: sólo
 * corre en el browser, y se limpia al desmontar.
 *
 * Montado siempre (también cerrado): un error de "se cerró mientras tanto"
 * relee la ficha y el mensaje no se puede desmontar con el botón.
 */
export function QuoteLocationSection({ detail }: { detail: QuoteRequestDetail }) {
  const router = useRouter()
  const geocode = detail.geocode
  const open = canChangeQuoteLocation(detail.status)

  /** `before` = `geocoded_at` antes de encolar; termina cuando cambia (a un valor no nulo). */
  const [watch, setWatch] = useState<{ before: string | null; startedAt: number } | null>(null)
  const [timedOut, setTimedOut] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ReadableQuoteLocationError | null>(null)
  const inFlight = useRef(false)

  const done = watch !== null && geocode.geocodedAt !== null && geocode.geocodedAt !== watch.before

  useEffect(() => {
    if (done) setWatch(null)
  }, [done])

  useEffect(() => {
    if (!watch || done) return
    const id = window.setInterval(() => {
      if (Date.now() - watch.startedAt >= GEOCODE_POLL_MAX_MS) {
        setWatch(null)
        setTimedOut(true)
        return
      }
      void router.invalidate()
    }, GEOCODE_POLL_MS)
    return () => window.clearInterval(id)
  }, [watch, done, router])

  function startWatching() {
    setTimedOut(false)
    setWatch({ before: geocode.geocodedAt, startedAt: Date.now() })
  }

  /**
   * Lo llama «Corregir ubicación» después de un 204 con `typed`. Si la
   * dirección es la misma y ya tenía `geocoded_at`, el backend no re-encola
   * nada (sólo se re-geocodifica cambiando la dirección): no hay qué esperar.
   */
  function onTypedSaved(address: string) {
    if (address === (detail.locationAddress ?? '').trim() && geocode.geocodedAt !== null) return
    startWatching()
  }

  async function geocodeNow() {
    const address = (detail.locationAddress ?? '').trim()
    if (inFlight.current || address === '') return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await changeQuoteRequestLocationFn({
        data: { quoteRequestId: detail.id, location: { source: 'typed', address } },
      })
      startWatching()
      await router.invalidate()
    } catch (cause) {
      const readable = readableQuoteLocationError(cause)
      setError(readable)
      if (readable.action === 'closed') await router.invalidate()
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const geocoding = watch !== null && !done
  const canGeocode = open && (geocode.status === 'pending' || geocode.status === 'legacy') && !geocoding

  return (
    <div className="space-y-1">
      <StatusLine
        status={geocode.status}
        geocoding={geocoding}
        timedOut={timedOut && geocode.geocodedAt === null}
        backendColumns={geocode.backendColumns}
      />

      {canGeocode ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-1 gap-1.5 shadow-none"
          disabled={busy}
          onClick={() => void geocodeNow()}
        >
          {error?.action === 'retrySame' ? (
            <RotateCcw className="size-3.5" aria-hidden />
          ) : (
            <Crosshair className="size-3.5" aria-hidden />
          )}
          {busy ? 'Pidiendo…' : error?.action === 'retrySame' ? 'Reintentar' : 'Geocodificar'}
        </Button>
      ) : null}

      {error ? (
        <p
          role="alert"
          className={cn(
            'text-xs leading-relaxed',
            error.action === 'retrySame' ? 'text-status-yellow' : 'text-status-red',
          )}
        >
          {error.text}
        </p>
      ) : null}

      <QuoteRequestLocationEditor detail={detail} onTypedSaved={onTypedSaved} />
    </div>
  )
}

function StatusLine({
  status,
  geocoding,
  timedOut,
  backendColumns,
}: {
  status: QuoteRequestDetail['geocode']['status']
  geocoding: boolean
  timedOut: boolean
  backendColumns: boolean
}) {
  const base = 'text-xs leading-relaxed'
  if (geocoding)
    return <p className={cn(base, 'text-muted-foreground')} role="status">Geocodificando…</p>
  if (timedOut)
    return (
      <p className={cn(base, 'text-status-yellow')} role="status">
        Todavía no se ubicó: puede ser que el backend no tenga la clave de Google; reintentá más tarde.
      </p>
    )
  switch (status) {
    case 'device':
    case 'no_location':
      return null
    case 'located':
      return <p className={cn(base, 'text-status-green')}>Ubicada en el mapa por el backend (Google).</p>
    case 'not_found':
      return (
        <p className={cn(base, 'text-status-red')}>
          No se pudo ubicar: corregí la dirección con «Corregir ubicación».
        </p>
      )
    case 'legacy':
      return (
        <p className={cn(base, 'text-status-yellow')}>
          En el mapa: ubicación aproximada del panel (anterior al geocodificador del backend).
        </p>
      )
    case 'pending':
      return (
        <p className={cn(base, 'text-status-yellow')}>
          Sin ubicar todavía.
          {backendColumns ? '' : ' Esta base no tiene las columnas de geocodificación del backend (0140).'}
        </p>
      )
  }
}
