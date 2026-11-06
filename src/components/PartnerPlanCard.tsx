import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { formatDateTimeBuenosAires } from '~/lib/format'
import { capLabel, effectivePlans, isFounding, subscriptionStatusLabel } from '~/lib/partner-plans'
import type { PartnerPlansResult, PartnerSubscriptionInfo } from '~/lib/partner-plans'

/**
 * «Plan» de la ficha del proveedor — SÓLO LECTURA (desde el 05/11/26). El plan
 * lo contrata el dueño del taller por Mercado Pago (billing del backend); no
 * hay endpoint de admin para cambiarlo, y escribirlo por SQL se saltearía el
 * cobro. Antes era un editor contra un mock.
 *
 * Muestra el plan EFECTIVO (el que cuenta para el tope) y, aparte, la
 * suscripción viva: una pendiente o pausada existe pero no da acceso, y eso es
 * justo lo que hay que poder ver.
 */
export function PartnerPlanCard({
  partnerId,
  tier,
  result,
}: {
  partnerId: string
  tier: string
  result: PartnerPlansResult
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Plan</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {!result.available ? (
          <p className="text-muted-foreground">
            Esta base no tiene el billing del backend (subscription_plans / partner_subscriptions). No hay plan que
            mostrar.
          </p>
        ) : (
          <Body partnerId={partnerId} tier={tier} result={result} />
        )}
        <p className="text-xs text-muted-foreground">
          Lo contrata el dueño del taller por Mercado Pago. Desde el panel no se cambia.
        </p>
      </CardContent>
    </Card>
  )
}

function Body({
  partnerId,
  tier,
  result,
}: {
  partnerId: string
  tier: string
  result: Extract<PartnerPlansResult, { available: true }>
}) {
  const plan = effectivePlans(result, [partnerId]).get(partnerId) ?? null
  const sub = result.subscriptions.find((s) => s.partnerId === partnerId) ?? null
  const nameOf = (code: string) => result.catalog.find((p) => p.code === code)?.name ?? code

  return (
    <>
      {plan ? (
        <p>
          <span className="font-heading text-base font-semibold">{plan.name}</span>
          <span className="ml-2 text-muted-foreground">tope {capLabel(plan)}</span>
        </p>
      ) : (
        <p className="text-muted-foreground">Sin plan: el catálogo no tiene la fila «free».</p>
      )}
      {isFounding(tier) ? (
        <p className="text-xs text-muted-foreground">Aliado: sin límite por ahora, el tope es sólo referencia.</p>
      ) : null}
      {sub ? (
        <SubscriptionLine sub={sub} planName={nameOf(sub.planCode)} scheduledName={sub.scheduledPlanCode ? nameOf(sub.scheduledPlanCode) : null} />
      ) : (
        <p className="text-xs text-muted-foreground">Sin suscripción: queda en Gratis.</p>
      )}
    </>
  )
}

function SubscriptionLine({
  sub,
  planName,
  scheduledName,
}: {
  sub: PartnerSubscriptionInfo
  planName: string
  scheduledName: string | null
}) {
  const at = (iso: string | null) => (iso ? formatDateTimeBuenosAires(iso) : null)
  const details: Array<string> = []
  if (sub.status === 'trialing' && sub.trialEndsAt) details.push(`prueba hasta ${at(sub.trialEndsAt)}`)
  if (sub.cancelAtPeriodEnd && sub.accessUntil) details.push(`dada de baja: acceso hasta ${at(sub.accessUntil)}`)
  else if (sub.currentPeriodEnd) details.push(`período hasta ${at(sub.currentPeriodEnd)}`)
  if (scheduledName) details.push(`pasa a ${scheduledName}${sub.scheduledPlanAt ? ` el ${at(sub.scheduledPlanAt)}` : ''}`)

  return (
    <div className="space-y-0.5 text-xs">
      <p>
        Suscripción {planName} · {subscriptionStatusLabel(sub.status)}
        {!sub.grantsAccess ? (
          <span className="ml-1 text-status-yellow">— no da acceso: cuenta como Gratis</span>
        ) : null}
      </p>
      {details.length > 0 ? <p className="text-muted-foreground">{details.join(' · ')} (hora de Buenos Aires)</p> : null}
    </div>
  )
}
