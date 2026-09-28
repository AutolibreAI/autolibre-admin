import { useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { MapPin, Pencil } from 'lucide-react'
import {
  quoteChannelLabel,
  readableQuoteRequestDataError,
  type QuoteRequestDetail,
} from '~/lib/quote-requests'
import { updateQuoteRequestFn } from '~/fn/quote-requests'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '~/components/ui/sheet'
import { cn } from '~/lib/utils'
import type { ReactNode } from 'react'

/**
 * Editar los datos de un pedido ya creado — contacto, vehículo, qué necesita y
 * zona — vía `ops.update_quote_request` (migración 018).
 *
 * Existe porque el pedido casi nunca llega completo: por WhatsApp la persona
 * escribe "necesito un service" y el auto, la patente y dónde está los va
 * soltando en la charla. Sin esto no había dónde anotarlos más que en el hilo
 * de notas, y las plantillas y el panel de candidatos no los veían.
 *
 * ── Reemplazo completo ──────────────────────────────────────────────────────
 *
 * El formulario manda TODOS los campos y lo que queda guardado es lo que se ve:
 * vaciar un campo opcional lo borra. Se siembra con la ficha actual cada vez
 * que se abre, así que reabrir después de guardar muestra lo nuevo.
 *
 * ── Lo que NO se edita, y el formulario lo dice ─────────────────────────────
 *
 * - La ubicación que vino del GPS del teléfono: pisarla borraría las
 *   coordenadas (el único dato de cercanía para ordenar talleres). Se muestra
 *   y viaja tal cual; el SP rechaza un cambio con `LOCATION_FROM_DEVICE`.
 * - `raw_submission`: lo que mandó la persona queda intacto al pie de la
 *   ficha, así que corregir la descripción no pierde el original.
 * - Canal, cuenta, vehículo vinculado y estado: ver `updateQuoteRequestSchema`.
 */
export function QuoteRequestEditor({ detail }: { detail: QuoteRequestDetail }) {
  const router = useRouter()

  const [open, setOpen] = useState(false)
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [plate, setPlate] = useState('')
  const [vehicleText, setVehicleText] = useState('')
  const [description, setDescription] = useState('')
  const [declaredAmount, setDeclaredAmount] = useState('')
  const [locationAddress, setLocationAddress] = useState('')
  const [locationLocality, setLocationLocality] = useState('')
  const [locationProvince, setLocationProvince] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const fromDevice = detail.locationSource === 'device'
  // chk_quote_requests_user_has_plate: con cuenta, la base exige patente.
  const plateRequired = detail.userId !== null

  function seed() {
    setContactName(detail.contactName ?? '')
    setContactPhone(detail.contactPhone)
    setContactEmail(detail.contactEmail ?? '')
    setPlate(detail.plate ?? '')
    setVehicleText(detail.vehicleText ?? '')
    setDescription(detail.description)
    setDeclaredAmount(detail.declaredAmount === null ? '' : String(detail.declaredAmount))
    setLocationAddress(detail.locationAddress ?? '')
    setLocationLocality(detail.locationLocality ?? '')
    setLocationProvince(detail.locationProvince ?? '')
    setError(null)
  }

  function handleOpenChange(next: boolean) {
    if (next) seed()
    setOpen(next)
  }

  const canSave =
    contactPhone.trim() !== '' && description.trim() !== '' && (!plateRequired || plate.trim() !== '')

  async function save() {
    if (!canSave || inFlight.current) return

    const amount = declaredAmount.trim() === '' ? null : Number(declaredAmount)
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      setError('El monto tiene que ser un número, 0 o más.')
      return
    }

    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await updateQuoteRequestFn({
        data: {
          quoteRequestId: detail.id,
          contactPhone,
          description,
          contactName,
          contactEmail,
          plate,
          vehicleText,
          declaredAmount: amount,
          // Con GPS viaja lo que ya está: el SP exige que no cambie.
          locationAddress: fromDevice ? (detail.locationAddress ?? '') : locationAddress,
          locationLocality: fromDevice ? (detail.locationLocality ?? '') : locationLocality,
          locationProvince: fromDevice ? (detail.locationProvince ?? '') : locationProvince,
        },
      })
      await router.invalidate()
      setOpen(false)
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause)
      setError(readableQuoteRequestDataError(raw))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5 shadow-none">
          <Pencil className="size-3.5" aria-hidden />
          Editar datos
        </Button>
      </SheetTrigger>

      <SheetContent side="right" className="w-full max-w-full bg-card sm:w-[30rem]">
        <form
          className="flex h-full min-h-0 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="border-b border-border px-5 py-4 pr-10">
            <SheetTitle>Editar datos del pedido</SheetTitle>
            <SheetDescription className="mt-0.5 leading-relaxed">
              Para ir completando lo que la persona cuenta después. Lo que dejes vacío se borra. El estado, las notas y
              los presupuestos se manejan aparte.
            </SheetDescription>
          </div>

          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
            {!detail.enteredManually ? (
              <p className="rounded-md border border-border bg-secondary px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                Llegó por {quoteChannelLabel(detail.channel)}. Lo que mandó la persona queda tal cual en{' '}
                <code className="font-mono">raw_submission</code>, al pie de la ficha: editar acá no lo pisa.
              </p>
            ) : null}

            <Group title="Contacto">
              <div className="grid grid-cols-2 gap-3">
                <TextField id="qre-name" label="Nombre" optional value={contactName} onChange={setContactName} disabled={busy} />
                <TextField
                  id="qre-phone"
                  label="Teléfono"
                  value={contactPhone}
                  onChange={setContactPhone}
                  disabled={busy}
                  inputClassName="font-mono tabular-nums"
                />
              </div>
              <TextField
                id="qre-email"
                label="Email"
                optional
                type="email"
                value={contactEmail}
                onChange={setContactEmail}
                disabled={busy}
              />
            </Group>

            <Group title="Vehículo">
              <TextField
                id="qre-vehicle"
                label="Vehículo"
                optional
                value={vehicleText}
                onChange={setVehicleText}
                disabled={busy}
                maxLength={200}
                placeholder="Peugeot 208 1.6 2019"
                hint={
                  detail.vehicleId
                    ? 'Este pedido ya tiene un vehículo vinculado; si los dos están, las plantillas usan el vinculado.'
                    : 'Como lo cuente la persona. Lo usan las plantillas mientras no haya un vehículo vinculado.'
                }
              />
              <TextField
                id="qre-plate"
                label="Patente"
                optional={!plateRequired}
                value={plate}
                onChange={setPlate}
                disabled={busy}
                placeholder="AB123CD"
                inputClassName="font-mono uppercase"
                hint={plateRequired ? 'Obligatoria: el pedido está asociado a una cuenta de AutoLibre.' : undefined}
              />
            </Group>

            <Group title="Pedido">
              <div className="space-y-1.5">
                <FieldLabel htmlFor="qre-description">Qué necesita</FieldLabel>
                <Textarea
                  id="qre-description"
                  value={description}
                  disabled={busy}
                  rows={5}
                  onChange={(e) => setDescription(e.currentTarget.value)}
                  className="min-h-28 shadow-none"
                />
              </div>
              <TextField
                id="qre-amount"
                label="Monto declarado"
                optional
                type="number"
                value={declaredAmount}
                onChange={setDeclaredAmount}
                disabled={busy}
                hint="Lo que dice que le cotizaron en otro lado. Se asume ARS."
              />
            </Group>

            <Group title="Zona">
              {fromDevice ? (
                <div className="flex gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-sm">
                  <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0">
                    <div>{detail.locationAddress ?? '—'}</div>
                    <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      Vino del GPS del teléfono y no se edita: cambiarla borraría las coordenadas con las que se ordenan
                      los talleres por cercanía.
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <TextField
                    id="qre-address"
                    label="Dirección o zona"
                    optional
                    value={locationAddress}
                    onChange={setLocationAddress}
                    disabled={busy}
                    maxLength={300}
                    placeholder="Av. Cabildo 2000, Belgrano"
                    hint="Hace falta si cargás localidad o provincia. La ven las plantillas para la persona."
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <TextField
                      id="qre-locality"
                      label="Localidad"
                      optional
                      value={locationLocality}
                      onChange={setLocationLocality}
                      disabled={busy}
                      placeholder="Tigre"
                      hint="La que viaja en el pedido de cotización al taller."
                    />
                    <TextField
                      id="qre-province"
                      label="Provincia"
                      optional
                      value={locationProvince}
                      onChange={setLocationProvince}
                      disabled={busy}
                    />
                  </div>
                </>
              )}
            </Group>

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!canSave || busy}>
              {busy ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="font-heading text-sm font-semibold">{title}</h3>
      {children}
    </section>
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
  type = 'text',
  placeholder,
  maxLength,
  hint,
  inputClassName,
}: {
  id: string
  label: string
  optional?: boolean
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  type?: 'text' | 'email' | 'number'
  placeholder?: string
  maxLength?: number
  hint?: string
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
        type={type}
        value={value}
        disabled={disabled}
        autoComplete="off"
        placeholder={placeholder}
        maxLength={maxLength}
        min={type === 'number' ? 0 : undefined}
        step={type === 'number' ? '0.01' : undefined}
        aria-required={optional ? undefined : true}
        onChange={(e) => onChange(e.currentTarget.value)}
        className={cn('shadow-none', inputClassName)}
      />
      {hint ? <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
