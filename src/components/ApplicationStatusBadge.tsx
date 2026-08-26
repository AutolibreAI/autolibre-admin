import { Badge } from '~/components/ui/badge'
import { STATUS_LABELS, type ApplicationStatus } from '~/lib/partners'

/**
 * Colores del ramp "Vehicle Health" de mobile, no las variantes default de
 * shadcn: un estado tiene que leerse con el mismo color en el panel que en la
 * app.
 *
 * `verbal_agreement` va en verde de marca porque es el único estado que
 * significa "esto ya se publicó" — es un resultado, no un paso del embudo.
 */
const STYLES: Record<ApplicationStatus, string> = {
  not_contacted: 'bg-secondary text-muted-foreground border-border',
  contacted: 'bg-status-yellow-bg text-status-yellow border-status-yellow/20',
  in_conversation: 'bg-status-violet-bg text-status-violet border-status-violet/20',
  verbal_agreement: 'bg-brand-soft text-brand border-brand/25',
  discarded: 'bg-status-red-bg text-status-red border-status-red/20',
}

export function ApplicationStatusBadge({ status }: { status: ApplicationStatus }) {
  return (
    <Badge variant="outline" className={STYLES[status]}>
      {STATUS_LABELS[status]}
    </Badge>
  )
}
