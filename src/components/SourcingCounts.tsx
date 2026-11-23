import { monthLabel } from '~/lib/partner-prospects'
import { sourcerLabel, type SourcingCounts, type SourcingUnit } from '~/lib/team'
import { formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * Altas por persona, por semana o por mes (migración 035) — para el reporte de
 * los viernes y la liquidación. Se cuenta por la FECHA DE LA SOLICITUD, no por
 * cuándo se asignó: una alta vieja que alguien se asigna hoy cae en su semana
 * real. Las descartadas no cuentan. Sólo lectura.
 *
 * Las fechas llegan como `YYYY-MM-DD` armadas en Postgres (hora de Buenos
 * Aires) y se formatean como texto, sin `Date`: el título tiene que ser el
 * mismo en el servidor y en el navegador.
 */
export function SourcingCountsSection({
  data,
  onUnit,
}: {
  data: SourcingCounts
  onUnit: (unit: SourcingUnit) => void
}) {
  if (!data.available) {
    return (
      <section className="mb-8 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        Altas por persona: falta aplicar la migración 035 («Alta por») en esta base.
      </section>
    )
  }

  const hasUnassigned = data.periods.some((p) => (p.counts.none ?? 0) > 0)

  return (
    <section aria-labelledby="sourcing-counts" className="mb-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="sourcing-counts" className="font-heading text-sm font-semibold">
            Altas por persona
          </h2>
          <p className="text-xs text-muted-foreground">
            Solicitudes de alta por «Alta por», contadas por la fecha de la solicitud (no la de asignación). Sin las
            descartadas. {formatInt(data.unassigned)} de {formatInt(data.totalApplications)} todavía sin asignar.
          </p>
        </div>
        <div className="flex gap-1.5" role="group" aria-label="Agrupar por">
          {(['week', 'month'] as const).map((u) => (
            <button
              key={u}
              type="button"
              aria-pressed={data.unit === u}
              onClick={() => onUnit(u)}
              className={cn(
                'h-8 rounded-md border px-3 text-sm',
                data.unit === u ? 'border-brand bg-brand-soft text-brand' : 'border-border bg-card text-muted-foreground hover:text-foreground',
              )}
            >
              {u === 'week' ? 'Semana' : 'Mes'}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">{data.unit === 'week' ? 'Semana' : 'Mes'}</th>
              {data.members.map((m) => (
                <th key={m.memberId} className="px-3 py-2 text-right font-medium">
                  {sourcerLabel(m)}
                </th>
              ))}
              {hasUnassigned ? <th className="px-3 py-2 text-right font-medium">Sin asignar</th> : null}
              <th className="px-3 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.periods.map((p) => (
              <tr key={p.period} className="border-b border-border last:border-0">
                <td className="px-3 py-2 whitespace-nowrap">{periodLabel(p.period, data.unit)}</td>
                {data.members.map((m) => (
                  <td key={m.memberId} className="px-3 py-2 text-right tabular-nums">
                    <Count n={p.counts[m.memberId] ?? 0} />
                  </td>
                ))}
                {hasUnassigned ? (
                  <td className="px-3 py-2 text-right tabular-nums text-status-yellow">
                    {(p.counts.none ?? 0) > 0 ? formatInt(p.counts.none ?? 0) : <span className="text-muted-foreground">0</span>}
                  </td>
                ) : null}
                <td className="px-3 py-2 text-right font-medium tabular-nums">{formatInt(p.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Count({ n }: { n: number }) {
  return n > 0 ? <span className="font-medium">{formatInt(n)}</span> : <span className="text-muted-foreground">0</span>
}

/** `2026-11-16` → "sem. del 16/11/2026"; `2026-11-01` (mes) → "noviembre 2026". */
function periodLabel(period: string, unit: SourcingUnit): string {
  const [y, m, d] = period.split('-')
  if (unit === 'month') return monthLabel(`${y}-${m}`)
  return `sem. del ${d}/${m}/${y}`
}
