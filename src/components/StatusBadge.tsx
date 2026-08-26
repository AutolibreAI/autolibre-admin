import { Badge } from '~/components/ui/badge'
import type { RecordStatus } from '~/lib/types'

/**
 * Status colours come from the mobile "Vehicle Health" ramp, not from shadcn's
 * default badge variants — a status in the panel must read as the same colour
 * the user already learned in the app.
 */
const STATUS_STYLES: Record<RecordStatus, { label: string; className: string }> = {
  active: {
    label: 'Activo',
    className: 'bg-status-green-bg text-status-green border-status-green/20',
  },
  pending: {
    label: 'Pendiente',
    className: 'bg-status-yellow-bg text-status-yellow border-status-yellow/20',
  },
  archived: {
    label: 'Archivado',
    className: 'bg-secondary text-muted-foreground border-border',
  },
}

export function StatusBadge({ status }: { status: RecordStatus }) {
  const { label, className } = STATUS_STYLES[status]
  return (
    <Badge variant="outline" className={className}>
      {label}
    </Badge>
  )
}
