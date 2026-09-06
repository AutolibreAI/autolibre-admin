import { Construction } from 'lucide-react'

/**
 * El estado "todavía no" de una línea de captación que existe como plan pero
 * no tiene de dónde leer.
 *
 * No es una pantalla fabricada (regla dura 8): no inventa datos ni entidades.
 * Es un cartel honesto que dice qué línea es y qué falta para que tenga
 * pantalla de verdad. La decisión de MOSTRARLAS —en vez de esconderlas hasta
 * que existan— se tomó el 2026-09-06. → `.claude/rules/leads.md`
 */
export function ComingSoonPipeline({
  what,
  blocker,
}: {
  /** Qué haría esta pestaña si tuviera datos. */
  what: string
  /** Qué falta, concreto, para que exista. */
  blocker: string
}) {
  return (
    <div className="max-w-prose rounded-lg border border-border bg-card p-6">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Construction className="size-4 shrink-0" aria-hidden />
        <span className="text-xs font-medium uppercase tracking-wider">Todavía no</span>
      </div>
      <p className="mt-3 text-sm leading-relaxed">{what}</p>
      <p className="mt-3 border-t border-border pt-3 text-sm leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Qué falta: </span>
        {blocker}
      </p>
    </div>
  )
}
