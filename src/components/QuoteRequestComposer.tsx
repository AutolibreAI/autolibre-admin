import { useRef, useState } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { Phone, Plus } from 'lucide-react'
import {
  QUOTE_REQUEST_CHANNELS,
  quoteChannelLabel,
  quotePublicCode,
  readableCreateQuoteRequestError,
} from '~/lib/quote-requests'
import { createQuoteRequestFn } from '~/fn/quote-requests'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '~/components/ui/sheet'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'

/**
 * Cargar un pedido de presupuesto a mano — para el que llega de forma
 * INFORMAL (llamada, en persona, un referido) y nunca pasó por el POST
 * público de app/web/whatsapp.
 *
 * ── Por qué existe, en vez de "que lo cargue como si fuera de WhatsApp" ────
 *
 * `ops.create_quote_request` (migración 012) deja auditoría de QUIÉN del
 * equipo lo tipeó (`ops.action_log`), y la fila queda marcada
 * (`enteredManually`) para que la ficha y el listado lo digan en voz alta —
 * no se disfraza de una submission real. → `.claude/rules/leads.md`.
 *
 * ── El canal es una aproximación, no una mentira ────────────────────────────
 *
 * `quote_request_channel` sólo tiene `app | web | whatsapp` (es un enum del
 * backend, este repo no lo puede ampliar). No hay un valor "informal", así
 * que el formulario pide elegir el que más se parezca — default `whatsapp`,
 * el más cercano a un contacto directo — y lo dice en el texto de ayuda.
 *
 * ── Sin idempotencia, a propósito ───────────────────────────────────────────
 *
 * A diferencia de `BroadcastComposer` (que manda push a decenas de personas y
 * necesita un `broadcastId` para no duplicar un envío masivo), acá un
 * double-submit crea como mucho UN pedido de más — el mismo costo que
 * escribirlo dos veces en DBeaver. `inFlight` alcanza para evitar el click
 * doble; no hace falta una clave de idempotencia contra el servidor.
 */
export function QuoteRequestComposer() {
  const router = useRouter()

  const [open, setOpen] = useState(false)
  const [channel, setChannel] = useState<(typeof QUOTE_REQUEST_CHANNELS)[number]>('whatsapp')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [plate, setPlate] = useState('')
  const [description, setDescription] = useState('')
  const [declaredAmount, setDeclaredAmount] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ id: string; publicNumber: number } | null>(null)

  const inFlight = useRef(false)

  const canSubmit = contactPhone.trim() !== '' && plate.trim() !== '' && description.trim() !== ''

  function reset() {
    setChannel('whatsapp')
    setContactName('')
    setContactPhone('')
    setContactEmail('')
    setPlate('')
    setDescription('')
    setDeclaredAmount('')
    setError(null)
    setCreated(null)
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) reset()
  }

  async function submit() {
    if (!canSubmit || inFlight.current) return

    inFlight.current = true
    setBusy(true)
    setError(null)

    try {
      const amount = declaredAmount.trim() === '' ? undefined : Number(declaredAmount)
      if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) {
        setError('El monto tiene que ser un número, 0 o más.')
        return
      }

      const result = await createQuoteRequestFn({
        data: {
          channel,
          contactPhone: contactPhone.trim(),
          plate: plate.trim(),
          description: description.trim(),
          contactName: contactName.trim() === '' ? undefined : contactName.trim(),
          contactEmail: contactEmail.trim() === '' ? undefined : contactEmail.trim(),
          declaredAmount: amount,
        },
      })

      setCreated(result)
      void router.invalidate()
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause)
      setError(readableCreateQuoteRequestError(raw))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Plus className="size-3.5" aria-hidden />
          Cargar pedido
        </Button>
      </SheetTrigger>

      <SheetContent side="right" className="w-full max-w-full bg-card sm:w-[28rem]">
        <form
          className="flex h-full min-h-0 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="border-b border-border px-5 py-4 pr-10">
            <SheetTitle>Cargar pedido a mano</SheetTitle>
            <SheetDescription className="mt-0.5 leading-relaxed">
              Para el que llega de forma informal — llamada, en persona, un referido — y nunca pasó
              por la app, la web o WhatsApp.
            </SheetDescription>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {created ? (
              <div className="rounded-md border border-status-green/30 bg-status-green-bg p-3 text-sm">
                <p className="font-medium text-status-green">
                  {quotePublicCode(created.publicNumber)} cargado.
                </p>
                <Link
                  to="/leads/pedidos/$quoteRequestId"
                  params={{ quoteRequestId: created.id }}
                  className="mt-1 inline-block text-brand hover:underline"
                  onClick={() => setOpen(false)}
                >
                  Ver la ficha →
                </Link>
              </div>
            ) : null}

            <section className="space-y-1.5">
              <label
                htmlFor="qrc-channel"
                className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                Canal
              </label>
              <Select
                value={channel}
                onValueChange={(v) => setChannel(v as (typeof QUOTE_REQUEST_CHANNELS)[number])}
              >
                <SelectTrigger id="qrc-channel" className="w-full shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUOTE_REQUEST_CHANNELS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {quoteChannelLabel(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs leading-relaxed text-muted-foreground">
                No hay un canal "informal" del lado del backend — elegí el que más se parezca.
              </p>
            </section>

            <section className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label
                  htmlFor="qrc-name"
                  className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
                >
                  Nombre <span className="normal-case tracking-normal text-muted-foreground/70">(opcional)</span>
                </label>
                <Input
                  id="qrc-name"
                  value={contactName}
                  disabled={busy}
                  autoComplete="off"
                  onChange={(e) => setContactName(e.currentTarget.value)}
                  className="shadow-none"
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="qrc-phone"
                  className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
                >
                  Teléfono
                </label>
                <Input
                  id="qrc-phone"
                  value={contactPhone}
                  disabled={busy}
                  autoComplete="off"
                  placeholder="+54 11…"
                  aria-required
                  onChange={(e) => setContactPhone(e.currentTarget.value)}
                  className="shadow-none"
                />
              </div>
            </section>

            <section className="space-y-1.5">
              <label
                htmlFor="qrc-email"
                className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                Email <span className="normal-case tracking-normal text-muted-foreground/70">(opcional)</span>
              </label>
              <Input
                id="qrc-email"
                type="email"
                value={contactEmail}
                disabled={busy}
                autoComplete="off"
                onChange={(e) => setContactEmail(e.currentTarget.value)}
                className="shadow-none"
              />
            </section>

            <section className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label
                  htmlFor="qrc-plate"
                  className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
                >
                  Patente
                </label>
                <Input
                  id="qrc-plate"
                  value={plate}
                  disabled={busy}
                  autoComplete="off"
                  placeholder="AB123CD"
                  aria-required
                  onChange={(e) => setPlate(e.currentTarget.value)}
                  className="font-mono uppercase shadow-none"
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="qrc-amount"
                  className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
                >
                  Monto declarado{' '}
                  <span className="normal-case tracking-normal text-muted-foreground/70">(opcional)</span>
                </label>
                <Input
                  id="qrc-amount"
                  type="number"
                  min={0}
                  step="0.01"
                  value={declaredAmount}
                  disabled={busy}
                  onChange={(e) => setDeclaredAmount(e.currentTarget.value)}
                  className="shadow-none"
                />
              </div>
            </section>

            <section className="space-y-1.5">
              <label
                htmlFor="qrc-description"
                className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                Qué necesita
              </label>
              <Textarea
                id="qrc-description"
                value={description}
                disabled={busy}
                rows={4}
                placeholder="Ruido en la suspensión delantera, service de los 10.000…"
                onChange={(e) => setDescription(e.currentTarget.value)}
                className="min-h-24 shadow-none"
              />
            </section>

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
            <Button
              type="submit"
              disabled={!canSubmit || busy}
              className="gap-1.5"
            >
              <Phone className="size-3.5" aria-hidden />
              {busy ? 'Cargando…' : 'Cargar pedido'}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
