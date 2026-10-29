import { FlaskConical } from 'lucide-react'

/**
 * El cartel de "datos de ejemplo". Va arriba de toda pantalla (o bloque) que
 * lea de `~/mocks`, y dice qué parte es inventada y qué falta del backend.
 * Regla dura 8 del repo: un dato fabricado se marca, no se disimula.
 */
export function MockBanner({
  title = 'Parte de esta pantalla usa datos de ejemplo',
  items,
}: {
  title?: string
  /** Qué dato es de ejemplo, uno por renglón. */
  items: ReadonlyArray<string>
}) {
  return (
    <div className="mb-4 flex gap-3 rounded-lg border border-status-yellow/40 bg-status-yellow-bg px-4 py-3 text-sm text-status-yellow">
      <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        <ul className="list-disc space-y-0.5 pl-4">
          {items.map((it) => (
            <li key={it}>{it}</li>
          ))}
        </ul>
        <p className="text-xs">
          Lo que falta del backend está en <code>docs/necesidades-backend-admin.md</code>.
        </p>
      </div>
    </div>
  )
}
