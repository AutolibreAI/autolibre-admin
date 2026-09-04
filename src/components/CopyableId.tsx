import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '~/lib/utils'

/**
 * Un identificador que se puede copiar.
 *
 * No es adorno: **copiar el uuid es la tarea real** de la mitad de las visitas a
 * una ficha. El panel cubre lo que cubre; para todo lo demás el operador se va a
 * DBeaver, y el primer paso de ese viaje es seleccionar 36 caracteres sin
 * comerse un guion. Un doble click sobre un uuid selecciona sólo un tramo — los
 * guiones cortan la palabra — así que a mano se falla seguido y en silencio.
 *
 * El feedback es un cambio de ícono, no un toast: el toast tapa contenido y pide
 * ser cerrado para confirmar algo que ya pasó.
 */
export function CopyableId({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  /**
   * El timer se limpia al desmontar. Sin esto, copiar y navegar dentro de los
   * dos segundos deja un `setState` sobre un componente que ya no existe — que
   * en React 19 no rompe, pero deja el warning y la fuga.
   */
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(id)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      /**
       * `navigator.clipboard` falla sin permiso y en contextos no seguros. El
       * fallback es no mentir: el ícono no cambia, y el valor sigue completo en
       * pantalla para seleccionarlo a mano. Un "copiado" falso es peor que
       * ningún feedback — el operador pega lo que tenía antes en el portapapeles
       * y consulta el usuario equivocado.
       */
    }
  }

  return (
    <span className={cn('inline-flex max-w-full items-center gap-1.5', className)}>
      <code className="min-w-0 break-all font-mono text-xs text-foreground">{value}</code>
      <button
        type="button"
        onClick={copy}
        // El nombre accesible dice QUÉ se copia, no "copiar": en una ficha hay
        // dos de estos botones y "Copiar" repetido no los distingue.
        aria-label={`Copiar ${value}`}
        className={cn(
          'shrink-0 rounded p-1 text-muted-foreground transition-colors',
          'hover:bg-secondary hover:text-foreground',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          copied && 'text-status-green hover:text-status-green',
        )}
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
      {/* El cambio de ícono es visual; el lector de pantalla necesita el texto. */}
      <span className="sr-only" role="status">
        {copied ? 'Copiado' : ''}
      </span>
    </span>
  )
}
