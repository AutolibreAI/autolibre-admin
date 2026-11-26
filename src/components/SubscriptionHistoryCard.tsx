import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { formatArs, formatDate } from '~/lib/format'
import {
  SUBSCRIPTION_END_REASON_LABELS,
  subscriptionStatusLabel,
  type SubscriptionHistoryEntry,
} from '~/lib/partner-plans'

/**
 * «Suscripción (histórico)» de la ficha del proveedor — SÓLO LECTURA.
 *
 * Desde el 2026-11-26 las suscripciones (Gratis / Plus / Plus Max) no se venden
 * más: se cobra por trabajo confirmado y por paquetes. Las que existen no se
 * borran ni se cancelan desde el panel (tampoco en Mercado Pago); se muestran
 * acá, con su estado y fechas, para resolver a mano lo que haga falta.
 */
export function SubscriptionHistoryCard({ entries }: { entries: Array<SubscriptionHistoryEntry> | null }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Suscripción (histórico)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {entries === null ? (
          <p className="text-muted-foreground">Esta base no tiene el billing del backend.</p>
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground">Nunca tuvo una suscripción.</p>
        ) : (
          <ul className="space-y-2">
            {entries.map((e) => (
              <li key={e.id} className="space-y-0.5">
                <div>
                  <span className="font-medium">{e.planName}</span>
                  {e.price !== null ? <span className="text-muted-foreground"> · {formatArs(e.price)}/mes</span> : null}
                  <span className="text-muted-foreground"> · {subscriptionStatusLabel(e.status)}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {[
                    e.createdAt ? `creada ${formatDate(e.createdAt)}` : null,
                    e.authorizedAt ? `autorizada ${formatDate(e.authorizedAt)}` : null,
                    e.trialEndsAt ? `prueba hasta ${formatDate(e.trialEndsAt)}` : null,
                    e.currentPeriodEnd ? `período hasta ${formatDate(e.currentPeriodEnd)}` : null,
                    e.accessUntil ? `acceso hasta ${formatDate(e.accessUntil)}` : null,
                    e.endedAt
                      ? `terminó ${formatDate(e.endedAt)}${e.endReason ? ` (${SUBSCRIPTION_END_REASON_LABELS[e.endReason] ?? e.endReason})` : ''}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Ya no se venden suscripciones. Desde el panel no se cambia ni se cancela nada en Mercado Pago.
        </p>
      </CardContent>
    </Card>
  )
}
