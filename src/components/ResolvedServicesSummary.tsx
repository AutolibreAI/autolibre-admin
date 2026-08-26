import { AlertTriangle, Check } from 'lucide-react'
import { cn } from '~/lib/utils'
import type { ResolvedServices } from '~/lib/partners'

/**
 * Qué va a pasar al aprobar, resuelto ANTES de aprobar.
 *
 * Este componente es la razón de ser de la pantalla. El flujo tiene un modo de
 * falla silencioso — un partner activo con cero rubros queda listado sin filtro
 * e invisible bajo todo chip — y el runbook de DBeaver solo lo detecta DESPUÉS,
 * con el partner ya creado. Acá se ve antes de tocar el botón.
 */
export function ResolvedServicesSummary({
  resolved,
  declaredCount,
  compact = false,
}: {
  resolved: ResolvedServices
  declaredCount: number
  compact?: boolean
}) {
  const willBeInvisible = resolved.totalServices === 0

  if (compact) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-sm',
          willBeInvisible ? 'text-status-red' : 'text-muted-foreground',
        )}
      >
        {willBeInvisible ? (
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <Check className="size-3.5 shrink-0 text-status-green" aria-hidden />
        )}
        {willBeInvisible
          ? declaredCount === 0
            ? 'No declaró rubros'
            : 'Nada reconocido'
          : `${resolved.totalServices} rubros`}
      </span>
    )
  }

  return (
    <div className="space-y-3">
      {resolved.matchedFamilies.length > 0 ? (
        <div>
          <p className="mb-1.5 text-xs uppercase tracking-wider text-muted-foreground">
            Se cargarán {resolved.totalServices}{' '}
            {resolved.totalServices === 1 ? 'rubro' : 'rubros'}
          </p>
          <ul className="space-y-1">
            {resolved.matchedFamilies.map((f) => (
              <li key={f.slug} className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2">
                  <Check className="size-3.5 shrink-0 text-status-green" aria-hidden />
                  {f.name}
                </span>
                <span className="text-muted-foreground">
                  {f.serviceCount} {f.serviceCount === 1 ? 'rubro' : 'rubros'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {resolved.unknownSlugs.length > 0 ? (
        <div>
          <p className="mb-1.5 text-xs uppercase tracking-wider text-muted-foreground">
            Declarado que no reconocemos
          </p>
          <ul className="space-y-1">
            {resolved.unknownSlugs.map((slug) => (
              <li key={slug} className="flex items-center gap-2 text-sm text-status-red">
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                <span className="font-mono text-xs">{slug}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Suele ser un label del formulario viejo, o un rubro o familia dados de baja
            después de que los declararon. La carga automática los ignora en silencio.
          </p>
        </div>
      ) : null}

      {declaredCount === 0 ? (
        <p className="text-sm text-status-red">
          La solicitud no declaró ningún rubro.
        </p>
      ) : null}
    </div>
  )
}
