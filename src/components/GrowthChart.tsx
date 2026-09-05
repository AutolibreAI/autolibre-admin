import { GROWTH_UNIT_SINGULAR, type GrowthPoint, type GrowthUnit } from '~/lib/ops'
import { formatDate, formatInt } from '~/lib/format'

/**
 * El gráfico de crecimiento: barras de altas por período + una línea de
 * acumulado encima, en la misma caja.
 *
 * ── Por qué SVG a mano y no una librería ────────────────────────────────────
 *
 * Mismo motivo que `DailyChart` en `/ai-costos`: una dependencia de charts trae
 * su propia paleta y sus propias sombras, que es exactamente lo que el design
 * system prohíbe (superficies separadas por BORDES, `Shadows` es cero). Acá
 * además hace falta superponer una línea sobre barras, que con `<div>` y CSS es
 * más frágil que un `<polyline>`. Todo el color sale de tokens (`var(--color-*)`),
 * ningún hex a mano.
 *
 * ── Dos escalas en la misma caja ────────────────────────────────────────────
 *
 * Las barras se escalan a `max(added)` y la línea a `max(total)`. Una sola
 * escala haría las barras invisibles apenas el acumulado crece — que es siempre.
 * La leyenda dice cuál es cuál.
 */

const VIEW_W = 720
const VIEW_H = 220
const PAD = { top: 10, right: 6, bottom: 26, left: 6 }
const INNER_W = VIEW_W - PAD.left - PAD.right
const INNER_H = VIEW_H - PAD.top - PAD.bottom

export function GrowthChart({
  points,
  unit,
  label,
}: {
  points: Array<GrowthPoint>
  unit: GrowthUnit
  label: string
}) {
  if (points.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{label}</h2>
        <p className="mt-3 text-sm text-muted-foreground">
          Todavía no hay registros para graficar.
        </p>
      </div>
    )
  }

  const maxAdded = Math.max(...points.map((p) => p.added), 1)
  const maxTotal = Math.max(...points.map((p) => p.total), 1)

  const step = INNER_W / points.length
  const barW = Math.max(step * 0.62, 1)

  const x = (i: number) => PAD.left + i * step + step / 2
  const barY = (added: number) => PAD.top + INNER_H - (added / maxAdded) * INNER_H
  const lineY = (total: number) => PAD.top + INNER_H - (total / maxTotal) * INNER_H

  const linePoints = points.map((p, i) => `${x(i)},${lineY(p.total)}`).join(' ')

  const current = points[points.length - 1]!
  const lastAdded = current.added

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">{label}</h2>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block size-2 rounded-[2px]"
              style={{ background: 'var(--color-brand)' }}
              aria-hidden
            />
            altas por {GROWTH_UNIT_SINGULAR[unit]}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-3.5"
              style={{ background: 'var(--color-action)' }}
              aria-hidden
            />
            acumulado
          </span>
        </div>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        {formatInt(current.total)} en total · +{formatInt(lastAdded)} en el último{' '}
        {GROWTH_UNIT_SINGULAR[unit]}
      </p>

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full"
        style={{ height: 'auto' }}
        role="img"
        aria-label={`${label}: ${formatInt(current.total)} acumulados`}
      >
        {/* Base del eje X */}
        <line
          x1={PAD.left}
          y1={PAD.top + INNER_H}
          x2={PAD.left + INNER_W}
          y2={PAD.top + INNER_H}
          style={{ stroke: 'var(--color-border)' }}
          strokeWidth={1}
        />

        {/* Barras: altas del período */}
        {points.map((p, i) => {
          const h = PAD.top + INNER_H - barY(p.added)
          return (
            <rect
              key={p.bucket}
              x={x(i) - barW / 2}
              y={barY(p.added)}
              width={barW}
              height={Math.max(h, p.added > 0 ? 1.5 : 0)}
              rx={1.5}
              style={{ fill: 'var(--color-brand)' }}
            >
              <title>
                {formatDate(p.bucket)} · +{formatInt(p.added)} · {formatInt(p.total)} acumulado
              </title>
            </rect>
          )
        })}

        {/* Línea: acumulado */}
        {points.length > 1 ? (
          <polyline
            points={linePoints}
            fill="none"
            style={{ stroke: 'var(--color-action)' }}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        {points.map((p, i) => (
          <circle
            key={p.bucket}
            cx={x(i)}
            cy={lineY(p.total)}
            r={points.length > 40 ? 0 : 2.5}
            style={{ fill: 'var(--color-action)' }}
          >
            <title>
              {formatDate(p.bucket)} · {formatInt(p.total)} acumulado
            </title>
          </circle>
        ))}
      </svg>

      <div className="mt-1 flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>{formatDate(points[0]!.bucket)}</span>
        <span>{formatDate(current.bucket)}</span>
      </div>
    </div>
  )
}
