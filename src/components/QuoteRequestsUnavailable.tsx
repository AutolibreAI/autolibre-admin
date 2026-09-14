import { DatabaseZap } from 'lucide-react'
import type { QuoteRequestsAvailability } from '~/lib/quote-requests'

/**
 * El estado "el flujo de presupuestos no está desplegado en esta base".
 *
 * NO es `ComingSoonPipeline`: aquella dice "el producto no existe". Acá el
 * producto existe en el backend y la pantalla está escrita contra la tabla real
 * — lo que falta es que la migración llegue a la base a la que el panel está
 * conectado. Por eso dice CUÁL de las dos cosas falta, sin datos de ejemplo
 * (regla dura 8). Lo comparten la lista y el detalle.
 */
export function QuoteRequestsUnavailable({
  availability,
}: {
  availability: Exclude<QuoteRequestsAvailability, { available: true }>
}) {
  return (
    <div className="max-w-prose rounded-lg border border-border bg-card p-6">
      <div className="flex items-center gap-2 text-muted-foreground">
        <DatabaseZap className="size-4 shrink-0" aria-hidden />
        <span className="text-xs font-medium uppercase tracking-wider">No desplegado en esta base</span>
      </div>
      <p className="mt-3 text-sm leading-relaxed">
        El flujo de presupuestos todavía no está desplegado en esta base.
      </p>
      <p className="mt-3 border-t border-border pt-3 text-sm leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Qué falta: </span>
        {availability.reason === 'no_table' ? (
          <>
            la tabla <code className="font-mono text-foreground">quote_requests</code> no existe. La crea la
            migración del bounded context <code className="font-mono">quotes/</code> de{' '}
            <code className="font-mono">autolibre-backend-hex</code>, que todavía no se aplicó acá.
          </>
        ) : (
          <>
            la tabla existe pero le faltan columnas que esta pantalla lee (migración 0093 del backend):{' '}
            {availability.missingColumns.map((c, i) => (
              <span key={c}>
                {i > 0 ? ', ' : ''}
                <code className="font-mono text-foreground">{c}</code>
              </span>
            ))}
            .
          </>
        )}
      </p>
    </div>
  )
}
