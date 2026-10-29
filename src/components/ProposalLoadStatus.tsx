import { formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { ProposalFactsLoad } from '~/components/useProposalFacts'

/** El progreso de `useProposalFacts`, y cuántos pedidos no se pudieron leer. */
export function ProposalLoadStatus({ load }: { load: ProposalFactsLoad }) {
  if (!load.loading && load.failed === 0) return null
  return (
    <p className={cn('mb-3 text-xs', load.failed > 0 ? 'text-status-yellow' : 'text-muted-foreground')}>
      {load.loading
        ? `Leyendo propuestas: ${formatInt(load.done)} de ${formatInt(load.total)} pedidos. Los números se completan solos.`
        : null}
      {load.failed > 0
        ? ` ${formatInt(load.failed)} pedidos no se pudieron leer: los totales pueden estar cortos. Recargá la página.`
        : null}
    </p>
  )
}
