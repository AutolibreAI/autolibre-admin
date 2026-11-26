import { Link } from '@tanstack/react-router'
import { Megaphone } from 'lucide-react'
import { formatDateTimeBuenosAires } from '~/lib/format'
import { freePlanNoticeChannelLabel, type FreePlanNotice } from '~/lib/partner-free-plan-notice'
import { cn } from '~/lib/utils'

/**
 * El aviso del cambio de cobro en la ficha del partner (migración 042), de
 * SÓLO LECTURA: se marca en Partners › Aviso de cobro, donde está el control
 * de pisada y la lista entera. Desde el 2026-11-26 aplica a TODOS los
 * proveedores (no hay más planes). Sin la 042, no muestra nada.
 */
export function FreePlanNoticeLine({
  result,
}: {
  result: { available: boolean; notice: FreePlanNotice | null }
}) {
  if (!result.available) return null
  const n = result.notice

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
          <strong className="font-medium">Avisado del cambio de cobro</strong> el{' '}
          {formatDateTimeBuenosAires(n.notifiedAt)} por {n.notifiedByLabel ?? 'usuario borrado'} vía{' '}
          {freePlanNoticeChannelLabel(n.channel)}
          {n.note ? <span className="text-muted-foreground"> · «{n.note}»</span> : null}
        </span>
      ) : (
        <span className="text-status-yellow">
          Todavía <strong className="font-medium">sin avisar</strong> del cambio de cobro (sin planes: primer
          trabajo gratis, desde el segundo se cobra por trabajo o con un paquete).
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
