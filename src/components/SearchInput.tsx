import { useEffect, useRef, useState } from 'react'
import { Input } from '~/components/ui/input'
import { cn } from '~/lib/utils'

const SEARCH_DEBOUNCE_MS = 300

interface SearchInputProps {
  id?: string
  label?: string
  placeholder?: string
  value: string | undefined
  onSearch: (value: string | undefined) => void
  className?: string
}

/**
 * Buscador con demora. Reemplaza el `<Input type="search" onChange={...}>`
 * que estaba copiado en ~15 rutas y disparaba `navigate` en cada tecla.
 *
 * Dispara a los 300ms sin tipear. Enter dispara al instante (cancela el timer
 * pendiente). Vaciar el campo —incluida la ✕ nativa de `type="search"`—
 * también dispara al instante: no hay nada que esperar.
 *
 * Sincroniza con `value` cuando cambia desde afuera (un link, "Limpiar
 * todo", el botón atrás), pero NUNCA mientras hay un timer pendiente: si no,
 * la respuesta de una búsqueda vieja reescribiría el campo a la mitad de una
 * palabra.
 */
export function SearchInput({
  id = 'q',
  label,
  placeholder,
  value,
  onSearch,
  className,
}: SearchInputProps) {
  const [text, setText] = useState(value ?? '')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timerRef.current !== null) return
    setText(value ?? '')
  }, [value])

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }
  }, [])

  function clearPending() {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  function fire(raw: string) {
    const trimmed = raw.trim()
    onSearch(trimmed === '' ? undefined : trimmed)
  }

  return (
    <div className="w-full space-y-1.5 sm:w-auto">
      {label ? (
        <label
          htmlFor={id}
          className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
        >
          {label}
        </label>
      ) : null}
      <Input
        id={id}
        type="search"
        placeholder={placeholder}
        value={text}
        autoComplete="off"
        className={cn('w-full sm:w-64', className)}
        onChange={(e) => {
          const raw = e.currentTarget.value
          setText(raw)
          clearPending()
          if (raw.trim() === '') {
            fire(raw)
            return
          }
          timerRef.current = setTimeout(() => {
            timerRef.current = null
            fire(raw)
          }, SEARCH_DEBOUNCE_MS)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          clearPending()
          fire(text)
        }}
      />
    </div>
  )
}
