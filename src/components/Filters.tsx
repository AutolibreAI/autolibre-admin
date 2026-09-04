import { cn } from '~/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import type { ReactNode } from 'react'

/**
 * Los filtros de las pantallas de listado.
 *
 * Vivían dentro de `ai-costos.tsx`, y cuando Usuarios necesitó lo mismo la
 * tentación fue copiar veinte líneas. Un chip copiado no se ve mal el día uno:
 * se ve mal el día que uno de los dos cambia el borde activo y nadie nota que el
 * otro quedó atrás. **Si el botón de filtrar se ve distinto en dos pantallas,
 * una de las dos está mal**, y no hay forma de saber cuál.
 *
 * Así que el patrón es uno solo y vive acá.
 */

export function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

export function Chip({
  active,
  onClick,
  tone = 'brand',
  children,
}: {
  active: boolean
  onClick: () => void
  /**
   * `warn` existe para un solo caso y conviene que sea el único: un filtro que
   * acota a filas PROBLEMÁTICAS (los admins `native` heredados). Pintarlo del
   * verde de marca diría "seleccionado y todo bien", que es lo contrario de lo
   * que ese filtro significa.
   */
  tone?: 'brand' | 'warn'
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors',
        // El anillo de foco no se hereda de ningún lado: `<button>` sin estilo
        // trae el outline del navegador, que no pertenece a ningún sistema de
        // diseño. Se pinta desde el token, y `focus-visible` para que no aparezca
        // al hacer click con el mouse.
        'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        active
          ? tone === 'warn'
            ? 'border-status-yellow/40 bg-status-yellow-bg text-status-yellow'
            : 'border-brand bg-brand-soft text-brand'
          : 'border-border bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/**
 * Un rango [min, max] para una columna numérica o de fecha. Los dos extremos
 * son independientes — cargar sólo uno filtra de un lado, igual que
 * `pushIntRange`/`pushDateRange` del lado del servidor.
 *
 * `''` (vacío) es "sin tope", nunca `0`: un input numérico vacío que se leyera
 * como cero excluiría de silencio todo lo que tenga menos de cero, que es
 * nada — el bug se notaría tarde porque el filtro "funcionaría" igual.
 */
export function RangeFilter({
  label,
  type,
  min,
  max,
  onChange,
}: {
  label: string
  type: 'number' | 'date'
  min: string
  max: string
  onChange: (next: { min?: string; max?: string }) => void
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type={type}
          value={min}
          onChange={(e) => onChange({ min: e.currentTarget.value })}
          placeholder="Min"
          className={cn(
            'h-8 rounded-md border border-border bg-card px-2 text-sm text-foreground outline-none',
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            type === 'number' ? 'w-20' : 'w-[9.5rem]',
          )}
        />
        <span className="text-muted-foreground" aria-hidden>
          –
        </span>
        <input
          type={type}
          value={max}
          onChange={(e) => onChange({ max: e.currentTarget.value })}
          placeholder="Max"
          className={cn(
            'h-8 rounded-md border border-border bg-card px-2 text-sm text-foreground outline-none',
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            type === 'number' ? 'w-20' : 'w-[9.5rem]',
          )}
        />
      </div>
    </div>
  )
}

/** Un dropdown de valor único con "Todos" como opción para volver a `undefined`. */
export function SelectFilter({
  label,
  value,
  onChange,
  options,
  placeholder = 'Todos',
}: {
  label: string
  value: string | undefined
  onChange: (value: string | undefined) => void
  options: ReadonlyArray<string>
  placeholder?: string
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <Select value={value ?? '__all'} onValueChange={(v) => onChange(v === '__all' ? undefined : v)}>
        <SelectTrigger size="sm" className="h-8 w-40 bg-card text-sm">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">{placeholder}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
