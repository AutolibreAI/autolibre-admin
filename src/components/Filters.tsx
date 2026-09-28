import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '~/lib/utils'
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

export function FilterGroup({
  label,
  onClear,
  children,
}: {
  label: string
  /**
   * Limpia TODO el grupo de un click. Opcional: sólo tiene sentido en grupos
   * multiselect, y sólo se muestra cuando el grupo tiene algo elegido — los
   * llamadores que ya usaban `FilterGroup` antes de esto no cambian.
   */
  onClear?: () => void
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            aria-label={`Limpiar filtro de ${label}`}
            className="rounded text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <X className="size-3" aria-hidden />
          </button>
        ) : null}
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
 * Un rango [desde, hasta] para una columna numérica o de fecha. Vino de la rama
 * `listado-vehiculos` (2026-09-04), con dos cambios al portarlo el 2026-09-28:
 *
 * - **Confirma al salir del campo o con Enter, no por tecla.** La versión
 *   original navegaba en cada tecla, y cada navegación relanza el loader: tipear
 *   "150000" eran seis consultas de 1000 filas. El borrador vive en estado
 *   local y se re-sincroniza si la URL cambia desde afuera («Limpiar todo»).
 * - Sigue valiendo lo que la rama decía: **`''` es "sin tope", nunca `0`.** Un
 *   campo vacío leído como cero excluiría todo y el filtro "funcionaría" a
 *   simple vista. `onCommit` entrega `undefined` para vacío.
 *
 * Los dos extremos son independientes: cargar uno solo filtra de un lado.
 */
export function RangeFilter({
  label,
  type,
  min,
  max,
  onCommit,
  unit,
}: {
  label: string
  type: 'number' | 'date'
  min: string | number | undefined
  max: string | number | undefined
  onCommit: (next: { min: string | undefined; max: string | undefined }) => void
  /** Texto chico al lado del label ("km", "min"). */
  unit?: string
}) {
  const toText = (v: string | number | undefined) => (v === undefined ? '' : String(v))
  const [draftMin, setDraftMin] = useState(toText(min))
  const [draftMax, setDraftMax] = useState(toText(max))

  useEffect(() => setDraftMin(toText(min)), [min])
  useEffect(() => setDraftMax(toText(max)), [max])

  const commit = () => {
    const next = { min: draftMin.trim() || undefined, max: draftMax.trim() || undefined }
    if (next.min === (toText(min) || undefined) && next.max === (toText(max) || undefined)) return
    onCommit(next)
  }

  const inputClass = cn(
    'h-8 rounded-md border border-border bg-card px-2 text-sm tabular-nums text-foreground outline-none',
    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    type === 'number' ? 'w-24' : 'w-[9.5rem]',
  )

  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        {unit ? <span className="ml-1 normal-case tracking-normal text-muted-foreground/70">({unit})</span> : null}
      </span>
      <div className="flex items-center gap-1.5">
        <input
          type={type}
          inputMode={type === 'number' ? 'numeric' : undefined}
          min={type === 'number' ? 0 : undefined}
          value={draftMin}
          onChange={(e) => setDraftMin(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
          placeholder="Desde"
          aria-label={`${label}, desde`}
          className={inputClass}
        />
        <span className="text-muted-foreground" aria-hidden>
          –
        </span>
        <input
          type={type}
          inputMode={type === 'number' ? 'numeric' : undefined}
          min={type === 'number' ? 0 : undefined}
          value={draftMax}
          onChange={(e) => setDraftMax(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
          placeholder="Hasta"
          aria-label={`${label}, hasta`}
          className={inputClass}
        />
      </div>
    </div>
  )
}
