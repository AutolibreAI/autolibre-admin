import { useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { MapPin, RotateCcw } from 'lucide-react'
import {
  QUOTE_LOCATION_ADDRESS_MAX,
  QUOTE_LOCATION_PLACE_MAX,
  canChangeQuoteLocation,
  parseCoordinate,
  parseCoordinatePair,
  quoteLocationSchema,
  readableQuoteLocationError,
  type QuoteLocation,
  type ReadableQuoteLocationError,
} from '~/lib/quote-location'
import { changeQuoteRequestLocationFn } from '~/fn/quote-location'
import type { QuoteRequestDetail } from '~/lib/quote-requests'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '~/components/ui/sheet'
import { cn } from '~/lib/utils'
import type { ReactNode } from 'react'

type Source = 'typed' | 'device'
type Step = 'form' | 'confirm'

/**
 * «Corregir ubicación» de un pedido — `PUT /admin/quote-requests/:id/location`
 * por HTTP (séptima excepción a la decisión 1). Es el ÚNICO camino de
 * escritura de la ubicación desde el panel: «Editar datos» ya no la toca (028).
 * → `.claude/rules/leads.md`, "Corregir la ubicación".
 *
 * ── Montado SIEMPRE, también con el pedido cerrado ─────────────────────────
 *
 * El error vive acá, y un `INVALID_STATE_TRANSITION` (la persona o el operador
 * cerró el pedido mientras tanto) relee la ficha: si este componente dependiera
 * del estado para montarse, el mensaje que explica por qué no se guardó se
 * desmontaría con él. Misma lección que `QuoteRequestActions`. Cerrado, en vez
 * del botón dice por qué no se ofrece.
 *
 * ── «Reintentar» reenvía EXACTAMENTE lo mismo ──────────────────────────────
 *
 * Un 5xx o un timeout pueden haber guardado la ubicación (lo que falla es
 * encolar el geocode). Reenviar el MISMO cuerpo re-encola sin duplicar, así que
 * el payload confirmado se guarda en `pending` y el reintento lo manda tal
 * cual — nunca se rearma desde el formulario, que pudo haber cambiado.
 */
export function QuoteRequestLocationEditor({
  detail,
  onTypedSaved,
}: {
  detail: QuoteRequestDetail
  /** Después de un 204 con `typed`: el backend encoló el geocode. Lo usa el sondeo de `QuoteLocationSection`. */
  onTypedSaved?: (address: string) => void
}) {
  const router = useRouter()
  const editable = canChangeQuoteLocation(detail.status)

  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('form')
  const [source, setSource] = useState<Source>('typed')
  const [address, setAddress] = useState('')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [pair, setPair] = useState('')
  const [accuracy, setAccuracy] = useState('')
  const [devAddress, setDevAddress] = useState('')
  const [devLocality, setDevLocality] = useState('')
  const [devProvince, setDevProvince] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  /** Lo que se confirmó y se manda (y se REENVÍA en un reintento). */
  const [pending, setPending] = useState<QuoteLocation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ReadableQuoteLocationError | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const inFlight = useRef(false)

  const canRetry = error?.action === 'retrySame' && pending !== null

  function seed() {
    const fromDevice = detail.locationSource === 'device'
    setSource('typed')
    setAddress(detail.locationSource === 'typed' ? (detail.locationAddress ?? '') : '')
    setLat(fromDevice && detail.locationLatitude !== null ? String(detail.locationLatitude) : '')
    setLng(fromDevice && detail.locationLongitude !== null ? String(detail.locationLongitude) : '')
    setPair('')
    setAccuracy('')
    setDevAddress(fromDevice ? (detail.locationAddress ?? '') : '')
    setDevLocality(fromDevice ? (detail.locationLocality ?? '') : '')
    setDevProvince(fromDevice ? (detail.locationProvince ?? '') : '')
    setFormError(null)
    setStep('form')
    setPending(null)
    setError(null)
  }

  function handleOpenChange(next: boolean) {
    if (busy) return
    if (next) {
      setNotice(null)
      // Con un reintento pendiente se reabre en la confirmación, con el MISMO
      // payload: el formulario no se vuelve a sembrar encima.
      if (canRetry) setStep('confirm')
      else seed()
    }
    setOpen(next)
  }

  function applyPair() {
    const parsed = parseCoordinatePair(pair)
    if (!parsed) {
      setFormError(
        'No pude leer ese par. Pegalo como lo copia Google Maps («-34.6037, -58.3816») o cargá latitud y longitud por separado.',
      )
      return
    }
    setLat(String(parsed.latitude))
    setLng(String(parsed.longitude))
    setPair('')
    setFormError(null)
  }

  function review() {
    setFormError(null)
    let raw: unknown
    if (source === 'typed') {
      raw = { source: 'typed', address }
    } else {
      const latitude = parseCoordinate(lat)
      const longitude = parseCoordinate(lng)
      if (latitude === null || longitude === null) {
        setFormError('Latitud y longitud tienen que ser números (coma o punto decimal, por ejemplo -34,6037).')
        return
      }
      let accuracyMeters: number | undefined
      if (accuracy.trim() !== '') {
        const n = parseCoordinate(accuracy)
        if (n === null) {
          setFormError('La precisión tiene que ser un número de metros, o quedar vacía.')
          return
        }
        accuracyMeters = n
      }
      raw = {
        source: 'device',
        latitude,
        longitude,
        ...(accuracyMeters !== undefined ? { accuracyMeters } : {}),
        address: devAddress,
        locality: devLocality,
        province: devProvince,
      }
    }
    const parsed = quoteLocationSchema.safeParse(raw)
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Revisá los datos.')
      return
    }
    setPending(parsed.data)
    setError(null)
    setStep('confirm')
  }

  async function send(payload: QuoteLocation) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await changeQuoteRequestLocationFn({ data: { quoteRequestId: detail.id, location: payload } })
      setPending(null)
      setOpen(false)
      setStep('form')
      setNotice('Ubicación actualizada.')
      // Con `typed` el backend re-geocodifica en segundo plano: el padre
      // (`QuoteLocationSection`) arranca el sondeo y muestra «Geocodificando…».
      if (payload.source === 'typed') onTypedSaved?.(payload.address)
      await router.invalidate()
    } catch (cause) {
      const readable = readableQuoteLocationError(cause)
      setError(readable)
      // Cerrado (también "se cerró mientras tanto"): se relee la ficha para
      // mostrar el estado real. Este componente no se desmonta, el mensaje queda.
      if (readable.action === 'closed') {
        setPending(null)
        await router.invalidate()
      }
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 space-y-2">
      {editable ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5 shadow-none"
          onClick={() => handleOpenChange(true)}
        >
          <MapPin className="size-3.5" aria-hidden />
          Corregir ubicación
        </Button>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          El pedido está cerrado: su ubicación ya no se corrige.
        </p>
      )}

      {notice ? (
        <p role="status" className="text-xs leading-relaxed text-status-green">
          {notice}
        </p>
      ) : null}

      {/* Con el panel cerrado, el error y el reintento siguen a la vista. */}
      {!open && error ? (
        <ErrorBox error={error}>
          {canRetry && editable ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1.5 shadow-none"
              disabled={busy}
              onClick={() => pending && void send(pending)}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              {busy ? 'Reintentando…' : 'Reintentar'}
            </Button>
          ) : null}
        </ErrorBox>
      ) : null}

      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="right" className="w-full max-w-full bg-card sm:w-[30rem]">
          <div className="flex h-full min-h-0 flex-col">
            <div className="border-b border-border px-5 py-4 pr-10">
              <SheetTitle>{step === 'form' ? 'Corregir ubicación' : 'Confirmar la ubicación nueva'}</SheetTitle>
              <SheetDescription className="mt-0.5 leading-relaxed">
                Reemplaza la ubicación del pedido en el backend, igual que si la cambiara la persona desde la app. No
                hay "borrar": sólo reemplazar.
              </SheetDescription>
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
              <CurrentLocation detail={detail} />

              {step === 'form' ? (
                <>
                  <fieldset className="space-y-2">
                    <legend className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Cómo la cargás
                    </legend>
                    <SourceOption
                      checked={source === 'typed'}
                      onSelect={() => setSource('typed')}
                      disabled={busy}
                      title="Dirección escrita"
                      hint="La calle y altura, o la zona. El backend la geocodifica solo."
                    />
                    <SourceOption
                      checked={source === 'device'}
                      onSelect={() => setSource('device')}
                      disabled={busy}
                      title="Coordenadas"
                      hint="Un punto exacto: por ejemplo, la ubicación que la persona mandó por WhatsApp."
                    />
                  </fieldset>

                  {source === 'typed' ? (
                    <TextField
                      id="qle-address"
                      label="Dirección o zona"
                      value={address}
                      onChange={setAddress}
                      disabled={busy}
                      maxLength={QUOTE_LOCATION_ADDRESS_MAX}
                      placeholder="Av. Cabildo 2000, Belgrano, CABA"
                    />
                  ) : (
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <FieldLabel htmlFor="qle-pair">Pegar de Google Maps</FieldLabel>
                        <div className="flex gap-2">
                          <Input
                            id="qle-pair"
                            value={pair}
                            disabled={busy}
                            autoComplete="off"
                            placeholder="-34.6037, -58.3816"
                            onChange={(e) => setPair(e.currentTarget.value)}
                            className="font-mono shadow-none"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            className="shadow-none"
                            disabled={busy || pair.trim() === ''}
                            onClick={applyPair}
                          >
                            Usar
                          </Button>
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          Clic derecho en el mapa copia «lat, lng». Llena los dos campos de abajo.
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <TextField
                          id="qle-lat"
                          label="Latitud"
                          value={lat}
                          onChange={setLat}
                          disabled={busy}
                          placeholder="-34,6037"
                          inputClassName="font-mono tabular-nums"
                        />
                        <TextField
                          id="qle-lng"
                          label="Longitud"
                          value={lng}
                          onChange={setLng}
                          disabled={busy}
                          placeholder="-58,3816"
                          inputClassName="font-mono tabular-nums"
                        />
                      </div>
                      <TextField
                        id="qle-accuracy"
                        label="Precisión en metros"
                        optional
                        value={accuracy}
                        onChange={setAccuracy}
                        disabled={busy}
                        inputClassName="tabular-nums"
                      />
                      <TextField
                        id="qle-dev-address"
                        label="Dirección"
                        optional
                        value={devAddress}
                        onChange={setDevAddress}
                        disabled={busy}
                        maxLength={QUOTE_LOCATION_ADDRESS_MAX}
                      />
                      <div className="grid grid-cols-2 gap-3">
                        <TextField
                          id="qle-dev-locality"
                          label="Localidad"
                          optional
                          value={devLocality}
                          onChange={setDevLocality}
                          disabled={busy}
                          maxLength={QUOTE_LOCATION_PLACE_MAX}
                        />
                        <TextField
                          id="qle-dev-province"
                          label="Provincia"
                          optional
                          value={devProvince}
                          onChange={setDevProvince}
                          disabled={busy}
                          maxLength={QUOTE_LOCATION_PLACE_MAX}
                        />
                      </div>
                    </div>
                  )}

                  {formError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {formError}
                    </p>
                  ) : null}
                </>
              ) : pending ? (
                <ConfirmSummary location={pending} detail={detail} />
              ) : null}

              {error ? <ErrorBox error={error} /> : null}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              {step === 'form' ? (
                <>
                  <Button type="button" variant="ghost" disabled={busy} onClick={() => handleOpenChange(false)}>
                    Cancelar
                  </Button>
                  <Button type="button" disabled={busy || !editable} onClick={review}>
                    Revisar
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      // Volver al formulario descarta el reintento: lo que se
                      // mande después sale de una confirmación nueva.
                      setError(null)
                      setPending(null)
                      setStep('form')
                    }}
                  >
                    Volver
                  </Button>
                  <Button
                    type="button"
                    disabled={busy || !pending || !editable}
                    onClick={() => pending && void send(pending)}
                  >
                    {busy ? 'Guardando…' : canRetry ? 'Reintentar (mismo envío)' : 'Confirmar y guardar'}
                  </Button>
                </>
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function CurrentLocation({ detail }: { detail: QuoteRequestDetail }) {
  return (
    <section className="rounded-md border border-border bg-secondary px-3 py-2 text-sm">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Hoy</div>
      {detail.locationSource === null ? (
        <div className="text-muted-foreground">Sin ubicación cargada</div>
      ) : (
        <>
          <div>{detail.locationAddress ?? <span className="text-muted-foreground">sin dirección</span>}</div>
          <div className="text-xs text-muted-foreground">
            {[detail.locationLocality, detail.locationProvince].filter(Boolean).join(', ') || 'sin localidad'}
            {' · '}
            {detail.locationSource === 'device'
              ? `GPS del teléfono${detail.locationLatitude !== null && detail.locationLongitude !== null ? ` (${detail.locationLatitude}, ${detail.locationLongitude})` : ''}`
              : 'tipeada'}
          </div>
        </>
      )}
    </section>
  )
}

/** Exactamente lo que viaja, más lo que NO se rehace. */
function ConfirmSummary({ location, detail }: { location: QuoteLocation; detail: QuoteRequestDetail }) {
  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <h3 className="font-heading text-sm font-semibold">Se va a guardar</h3>
        {location.source === 'typed' ? (
          <dl className="space-y-1 text-sm">
            <Row label="Tipo">Dirección escrita</Row>
            <Row label="Dirección">{location.address}</Row>
          </dl>
        ) : (
          <dl className="space-y-1 text-sm">
            <Row label="Tipo">Coordenadas</Row>
            <Row label="Latitud">
              <span className="font-mono tabular-nums">{location.latitude}</span>
            </Row>
            <Row label="Longitud">
              <span className="font-mono tabular-nums">{location.longitude}</span>
            </Row>
            {location.accuracyMeters !== undefined ? <Row label="Precisión">{location.accuracyMeters} m</Row> : null}
            {location.address ? <Row label="Dirección">{location.address}</Row> : null}
            {location.locality ? <Row label="Localidad">{location.locality}</Row> : null}
            {location.province ? <Row label="Provincia">{location.province}</Row> : null}
          </dl>
        )}
        <pre className="overflow-x-auto rounded-md border border-border bg-secondary px-3 py-2 font-mono text-xs">
          {JSON.stringify({ location }, null, 2)}
        </pre>
      </section>

      <section className="space-y-1.5 rounded-md border border-status-yellow/40 bg-status-yellow-bg px-3 py-2 text-xs leading-relaxed text-status-yellow">
        <p className="font-medium">Antes de confirmar</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>
            Lo que ya se hizo con la ubicación anterior NO se rehace: los WhatsApp que se mandaron a talleres y las
            propuestas quedan como estaban.
          </li>
          {location.source === 'typed' ? (
            <li>
              El backend borra la geolocalización anterior y geocodifica esta dirección en segundo plano: por unos
              segundos el mapa va a decir «geocodificando…».
            </li>
          ) : (
            <li>Este punto pasa a ser el que se usa para ordenar talleres por cercanía.</li>
          )}
          {location.source === 'typed' && detail.locationSource === 'device' ? (
            <li>El pedido tenía el GPS del teléfono: esas coordenadas se reemplazan por la dirección.</li>
          ) : null}
          <li>Es la misma operación que la persona puede hacer desde la app: si los dos la cambian, queda la última.</li>
        </ul>
      </section>
    </div>
  )
}

function ErrorBox({ error, children }: { error: ReadableQuoteLocationError; children?: ReactNode }) {
  const retry = error.action === 'retrySame'
  return (
    <div
      role="alert"
      className={cn(
        'space-y-2 rounded-md border px-3 py-2 text-sm leading-relaxed',
        retry
          ? 'border-status-yellow/40 bg-status-yellow-bg text-status-yellow'
          : 'border-status-red/40 bg-status-red-bg text-status-red',
      )}
    >
      <p>{error.text}</p>
      {children}
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function SourceOption({
  checked,
  onSelect,
  disabled,
  title,
  hint,
}: {
  checked: boolean
  onSelect: () => void
  disabled?: boolean
  title: string
  hint: string
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer gap-2.5 rounded-md border px-3 py-2',
        checked ? 'border-primary bg-secondary' : 'border-border',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        type="radio"
        name="qle-source"
        className="mt-1 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs leading-relaxed text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </label>
  )
}

function TextField({
  id,
  label,
  optional,
  value,
  onChange,
  disabled,
  placeholder,
  maxLength,
  inputClassName,
}: {
  id: string
  label: string
  optional?: boolean
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  placeholder?: string
  maxLength?: number
  inputClassName?: string
}) {
  return (
    <div className="space-y-1.5">
      <FieldLabel htmlFor={id}>
        {label}
        {optional ? <span className="normal-case tracking-normal text-muted-foreground/70"> (opcional)</span> : null}
      </FieldLabel>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        autoComplete="off"
        placeholder={placeholder}
        maxLength={maxLength}
        aria-required={optional ? undefined : true}
        onChange={(e) => onChange(e.currentTarget.value)}
        className={cn('shadow-none', inputClassName)}
      />
    </div>
  )
}
