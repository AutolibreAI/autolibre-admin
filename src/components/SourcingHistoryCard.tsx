import { History } from 'lucide-react'
import { formatDateTimeBuenosAires } from '~/lib/format'
import { sourcerLabel, type ApplicationSourcing, type SourcerRef } from '~/lib/team'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'

/**
 * "Alta por" en la ficha de una solicitud: quién la tiene hoy y el historial
 * completo (antes → después, quién y cuándo). Sólo lectura: el selector va
 * arriba, junto al estado. Horas en Buenos Aires (es lo que lee el equipo).
 */
export function SourcingHistoryCard({ sourcing }: { sourcing: ApplicationSourcing }) {
  const { current, history } = sourcing
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="size-4 text-muted-foreground" aria-hidden />
          Alta por
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {current ? (
          <p>
            <strong className="font-medium">{sourcerLabel(current)}</strong>
            <span className="block text-xs text-muted-foreground">
              Asignada el {formatDateTimeBuenosAires(current.assignedAt)}
              {current.assignedByLabel ? ` por ${current.assignedByLabel}` : ''}
            </span>
          </p>
        ) : (
          <p className="text-muted-foreground">Sin asignar. Elegí quién la trajo en el selector de arriba.</p>
        )}

        {history.length > 0 ? (
          <div>
            <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Historial</h3>
            <ol className="space-y-2 border-l border-border pl-3">
              {history.map((h) => (
                <li key={h.id} className="text-xs">
                  <span className="text-foreground">
                    <Who ref_={h.before} /> → <Who ref_={h.after} />
                  </span>
                  <span className="block text-muted-foreground">
                    {formatDateTimeBuenosAires(h.at)} · {h.actorLabel ?? 'usuario borrado'}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function Who({ ref_ }: { ref_: SourcerRef | null }) {
  if (!ref_) return <span className="text-muted-foreground">sin asignar</span>
  return <span className="font-medium">{sourcerLabel(ref_)}</span>
}
