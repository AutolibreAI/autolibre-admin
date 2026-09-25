import { useId, useMemo, useState } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import { normalizeForMatch } from '~/lib/catalog'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import { cn } from '~/lib/utils'

/**
 * Un selector de VARIOS valores de una lista cerrada: trigger con resumen
 * ("Motor, Frenos +1"), popover con casillas + buscador, «Limpiar», contador.
 *
 * Generico a propósito — no sabe nada de rubros ni de zonas. Primer uso: el
 * filtro de zona de `PartnerCandidates` (antes chips sueltas, que no
 * escalaban a las ~30 zonas que declara el directorio) y el multiselect de
 * rubros del mismo componente.
 *
 * No usa un buscador con debounce al servidor —a diferencia del picker de
 * destinatarios de `BroadcastComposer`— porque las listas que alimenta este
 * componente son chicas (decenas de opciones) y ya vienen enteras: filtrar en
 * el cliente es instantáneo y no necesita estados de carga.
 */

export interface MultiSelectOption {
  value: string
  label: string
}

export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  placeholder = 'Elegir…',
  searchPlaceholder = 'Buscar…',
  className,
}: {
  /** Para el `aria-label` del trigger — no se muestra como texto visible. */
  label: string
  options: ReadonlyArray<MultiSelectOption>
  selected: ReadonlyArray<string>
  onChange: (next: Array<string>) => void
  placeholder?: string
  searchPlaceholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const listId = useId()

  const selectedSet = new Set(selected)
  const selectedLabels = options.filter((o) => selectedSet.has(o.value)).map((o) => o.label)

  const matches = useMemo(() => {
    const needle = normalizeForMatch(query)
    if (needle === '') return options
    return options.filter((o) => normalizeForMatch(o.label).includes(needle))
  }, [options, query])

  function toggle(value: string) {
    onChange(selectedSet.has(value) ? selected.filter((v) => v !== value) : [...selected, value])
  }

  const summary =
    selectedLabels.length === 0
      ? placeholder
      : selectedLabels.length <= 2
        ? selectedLabels.join(', ')
        : `${selectedLabels.slice(0, 2).join(', ')} +${selectedLabels.length - 2}`

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={label}
          className={cn(
            'h-8 justify-between gap-1.5 font-normal shadow-none',
            selected.length === 0 ? 'text-muted-foreground' : undefined,
            className,
          )}
        >
          <span className="truncate">{summary}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder={searchPlaceholder}
            aria-controls={listId}
            className="h-8 text-xs"
          />
        </div>
        <ul id={listId} role="listbox" aria-multiselectable className="max-h-64 overflow-y-auto p-1">
          {matches.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">Nada coincide con «{query}».</li>
          ) : (
            matches.map((o) => {
              const checked = selectedSet.has(o.value)
              return (
                <li key={o.value}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-secondary">
                    <Checkbox checked={checked} onCheckedChange={() => toggle(o.value)} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {checked ? <Check className="size-3.5 shrink-0 text-brand" aria-hidden /> : null}
                  </label>
                </li>
              )
            })
          )}
        </ul>
        <div className="flex items-center justify-between gap-2 border-t border-border p-2">
          <span className="text-xs text-muted-foreground">
            {selected.length === 0 ? 'Nada elegido' : `${selected.length} elegido(s)`}
          </span>
          {selected.length > 0 ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3" aria-hidden />
              Limpiar
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
