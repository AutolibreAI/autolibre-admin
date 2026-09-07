import { Link } from '@tanstack/react-router'
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react'
import { TableHead } from '~/components/ui/table'
import { cn } from '~/lib/utils'

/**
 * Header de columna ordenable.
 *
 * El orden ES la URL — por eso es un `<Link>` y no un `<button>`: navegable,
 * clickeable con el botón del medio, compartible. Misma regla que vale para
 * `sort` en cualquier listado del panel.
 *
 * Este es el hogar compartido. `usuarios.index.tsx` y `leads.multas.tsx` tienen
 * cada uno un `SortableHeader`/`SortHeader` local que es PREVIO a este archivo y
 * hace exactamente lo mismo — migrarlos a este componente es pendiente, no
 * rediseño (la semántica de `firstClick` ya está calibrada para reproducir la
 * de cada uno: `'asc'` como en usuarios, `'desc'` como en multas). Mismo
 * criterio que `Filters.tsx`: si el control se ve distinto en dos pantallas,
 * una está mal y no hay forma de saber cuál.
 *
 * `firstClick` es la dirección del PRIMER click sobre una columna que todavía
 * no es la activa: `'desc'` para montos y fechas (lo que se quiere ver
 * primero), `'asc'` para texto. Clickear la columna ya activa siempre invierte.
 */
export function SortHeader({
  label,
  sortKey,
  active,
  dir,
  to,
  align,
  firstClick = 'asc',
}: {
  label: string
  sortKey: string
  active: boolean
  dir: 'asc' | 'desc'
  /** Ruta del listado. Se pasa como string; el `search` se actualiza funcional. */
  to: string
  align?: 'right'
  firstClick?: 'asc' | 'desc'
}) {
  const nextDir: 'asc' | 'desc' = active ? (dir === 'asc' ? 'desc' : 'asc') : firstClick

  /**
   * `to` es un string dinámico, así que TanStack no puede inferir la forma del
   * search y el updater tipado no encaja. El cast es a ese único punto: el
   * schema de zod de la ruta destino revalida `sort`/`dir` igual, así que un
   * valor imposible no llega a ningún lado. Es la misma concesión que hace
   * `PulseCard` en el dashboard con `<Link to={to}>`.
   */
  const updateSearch = (prev: Record<string, unknown>) => ({
    ...prev,
    sort: sortKey,
    dir: nextDir,
  })

  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <Link
        to={to}
        search={updateSearch as Parameters<typeof Link>[0]['search']}
        replace
        className={cn(
          'inline-flex items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          align === 'right' && 'flex-row-reverse',
          active && 'text-foreground',
        )}
      >
        {label}
        {active ? (
          dir === 'asc' ? (
            <ChevronUp className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" aria-hidden />
          )
        ) : (
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground/40" aria-hidden />
        )}
      </Link>
    </TableHead>
  )
}
