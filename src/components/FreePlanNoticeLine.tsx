import { Link } from '@tanstack/react-router'
import { Megaphone } from 'lucide-react'
import { formatDateTimeBuenosAires } from '~/lib/format'
import { FREE_PLAN_CODE, effectivePlans, type PartnerPlansResult } from '~/lib/partner-plans'
import { freePlanNoticeChannelLabel, type FreePlanNotice } from '~/lib/partner-free-plan-notice'
import { cn } from '~/lib/utils'

/**
 * El aviso del cambio del plan gratis en la ficha del partner (migración 042),
 * de SÓLO LECTURA: se marca en Partners › Aviso plan gratis, que es donde está
 * el control de pisada y el contexto (la lista entera). Se muestra si el plan
 * efectivo es gratis o si hay un aviso registrado (uno que pasó a pago lo
 * conserva). Sin la 042, no muestra nada.
 */
export function FreePlanNoticeLine({
  partnerId,
  plans,
  result,
}: {
  partnerId: string
  plans: PartnerPlansResult
  result: { available: boolean; notice: FreePlanNotice | null }
}) {
  if (!result.available) return null
  const isFree = effectivePlans(plans, [partnerId]).get(partnerId)?.code === FREE_PLAN_CODE
  const n = result.notice
  if (!isFree && !n) return null

  return (
    <div
      className={cn(
        'mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-2 text-sm',
        n ? 'border-border bg-card' : 'border-status-yellow/30 bg-status-yellow-bg',
      )}
    >
      <Megaphone className={cn('size-4', n ? 'text-muted-foreground' : 'text-status-yellow')} aria-hidden />
      {n ? (
        <span>
          <strong className="font-medium">Avisado del cambio del plan gratis</strong> el{' '}
          {formatDateTimeBuenosAires(n.notifiedAt)} por {n.notifiedByLabel ?? 'usuario borrado'} vía{' '}
          {freePlanNoticeChannelLabel(n.channel)}
          {n.note ? <span className="text-muted-foreground"> · «{n.note}»</span> : null}
        </span>
      ) : (
        <span className="text-status-yellow">
          Plan gratis: todavía <strong className="font-medium">sin avisar</strong> del cambio (primer trabajo gratis,
          desde el segundo se cobra por trabajo).
        </span>
      )}
      <Link
        to="/partners/plan-gratis"
        className="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        {n ? 'Ver avisos' : 'Marcar como avisado'}
      </Link>
    </div>
  )
}
