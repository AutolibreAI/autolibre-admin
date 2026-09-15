import { AlertTriangle, MessageCircle } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
import { quoteStatusLabel, quoteWhatsAppUrl, type QuoteRequestListItem } from '~/lib/quote-requests'

/**
 * Las piezas que el listado y el detalle de pedidos comparten. Viven acá y no
 * en un archivo de ruta porque un export extra en una ruta file-based le
 * complica el code-splitting a TanStack — y porque si el badge de "Contactado"
 * se ve distinto en la tabla y en la ficha, una de las dos está mal (mismo
 * criterio que `VehicleCells.tsx`).
 */

const STATUS_STYLES: Record<string, string> = {
  received: 'border-border bg-secondary text-foreground',
  contacted: 'border-status-violet/20 bg-status-violet-bg text-status-violet',
  answered: 'border-status-green/20 bg-status-green-bg text-status-green',
  closed: 'border-border bg-card text-muted-foreground',
}

/**
 * Un estado que el espejo no conoce sale con borde neutro y la etiqueta cruda,
 * no en blanco. Ninguno es rojo: `closed` no es una falla, es el final.
 */
export function QuoteStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={STATUS_STYLES[status] ?? 'border-border'}>
      {quoteStatusLabel(status)}
    </Badge>
  )
}

/**
 * El vehículo lo vincula el operador a mano, y puede quedar mal: un auto de
 * OTRA cuenta, uno archivado, o uno cuya patente no es la que tipeó la persona.
 * Se marca en ámbar —algo para mirar—, no se esconde ni se corrige.
 */
export function QuoteVehicleWarnings({
  row,
}: {
  row: Pick<QuoteRequestListItem, 'vehicleOwnerMismatch' | 'plateMismatch' | 'vehiclePlate' | 'vehicleArchived'>
}) {
  const warnings = [
    row.vehicleOwnerMismatch ? 'el auto es de otra cuenta' : null,
    row.plateMismatch ? `patente vinculada: ${row.vehiclePlate ?? '—'}` : null,
    row.vehicleArchived ? 'vehículo archivado' : null,
  ].filter((w): w is string => w !== null)

  if (warnings.length === 0) return null
  return (
    <div className="mt-0.5 flex items-start gap-1 text-xs font-medium text-status-yellow">
      <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
      <span>{warnings.join(' · ')}</span>
    </div>
  )
}

/**
 * Abre WhatsApp con el chat de la persona y un saludo que nombra el `AL-n`.
 *
 * Sin la forma canónica del teléfono no hay link (ver `quoteWhatsAppUrl`). En
 * la tabla eso no se anuncia —el número ya está a la vista—; en la ficha
 * (`explainMissing`) sí, para que la falta de botón no se lea como un bug.
 * Pestaña nueva y `noreferrer`: el panel no le pasa su URL a WhatsApp.
 */
export function QuoteWhatsAppLink({
  phone,
  publicNumber,
  contactName,
  explainMissing = false,
}: {
  phone: string
  publicNumber: number
  contactName: string | null
  explainMissing?: boolean
}) {
  const href = quoteWhatsAppUrl(phone, publicNumber, contactName)

  if (!href) {
    return explainMissing ? (
      <div className="mt-0.5 text-xs text-muted-foreground">
        No tiene el formato de móvil con código de país (549…): escribile a mano.
      </div>
    ) : null
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Escribirle por WhatsApp a ${contactName ?? phone}`}
      className="mt-0.5 inline-flex items-center gap-1 rounded text-xs font-medium text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <MessageCircle className="size-3.5 shrink-0" aria-hidden />
      Escribir por WhatsApp
    </a>
  )
}
