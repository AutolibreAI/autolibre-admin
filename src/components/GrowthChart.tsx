import { GROWTH_UNIT_SINGULAR, type GrowthUnit } from '~/lib/ops'
import { formatDate, formatInt } from '~/lib/format'

/**
 * El gráfico de crecimiento: barras por período (una o apiladas) + una o dos
 * líneas encima, en la misma caja.
 *
 * ── Por qué SVG a mano y no una librería ────────────────────────────────────
 *
 * Mismo motivo que `DailyChart` en `/ai-costos`: una dependencia de charts trae
 * su propia paleta y sus propias sombras, que es exactamente lo que el design
 * system prohíbe (superficies separadas por BORDES, `Shadows` es cero). Todo
 * el color sale de tokens (`var(--color-*)`), ningún hex a mano.
 *
 * ── Generalizado el 2026-09-23 para la sección Pedidos ──────────────────────
 *
 * Antes tomaba `points: Array<GrowthPoint>` (una sola barra + acumulado fijo).
 * Se generalizó en vez de copiarlo a un componente nuevo: `bars` es un array
 * de 1 o 2 capas (2 = apiladas, como "con/sin vehículo" o "red/afuera") y
 * `lines` es opcional — sin él, la línea default sigue siendo el acumulado de
 * la suma de `bars`, así que Usuarios/Vehículos no cambiaron de forma.
 *
 * ── Dos escalas en la misma caja ────────────────────────────────────────────
 *
 * Las barras se escalan al máximo APILADO (`sum` de las capas por bucket).
 * Las líneas comparten UNA escala entre sí (`lineMax` fijo, o el máximo
 * observado) — las que conviven en un mismo gráfico están en la misma unidad
 * (horas, o %), así que compartir escala no mezcla peras con naranjas.
 *
 * ── Los números van SIEMPRE visibles, no sólo al pasar el mouse ─────────────
 *
 * Agregado el 2026-09-23: con pocos pedidos por bucket, una línea de mediana
 * es un puñado de puntos sueltos sin nada que los conecte — sin un número al
 * lado, esos puntos no dicen nada. Cada barra (el TOTAL apilado) y cada punto
 * de cada línea llevan su valor como `<text>`, además del `<title>` de hover
 * que ya existía (sigue ahí para quien SÍ pasa el mouse). Con muchos buckets
 * (`MAX_BUCKETS_WITH_LABELS`, la vista diaria de varios meses) los números se
 * pisan entre sí — ahí se cae a sólo-hover, igual que ya hacían los puntos.
 */

const VIEW_W = 720
const VIEW_H = 220
// `top` tiene margen extra para las etiquetas numéricas (barra y líneas), que
// pueden caer cerca del techo cuando el valor está cerca del máximo del eje.
const PAD = { top: 22, right: 6, bottom: 26, left: 6 }
const INNER_W = VIEW_W - PAD.left - PAD.right
const INNER_H = VIEW_H - PAD.top - PAD.bottom
const LABEL_FONT_SIZE = 9
/** Con más buckets que esto, los números se pisan — se vuelve a sólo-hover. */
const MAX_BUCKETS_WITH_LABELS = 40

export interface ChartBar {
  values: Array<number>
  color: string
  label: string
}

export interface ChartLine {
  /** `null` = sin dato ese bucket — la línea se corta ahí, no cae a 0. */
  values: Array<number | null>
  color: string
  label: string
  format: (v: number) => string
}

function cumulative(values: Array<number>): Array<number> {
  let sum = 0
  return values.map((v) => (sum += v))
}

/** Segmentos contiguos sin `null`, para no dibujar una línea que cruza un hueco. */
function lineSegments(values: Array<number | null>, x: (i: number) => number, y: (v: number) => number) {
  const segments: Array<string> = []
  let current: Array<string> = []
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length > 1) segments.push(current.join(' '))
      current = []
      return
    }
    current.push(`${x(i)},${y(v)}`)
  })
  if (current.length > 1) segments.push(current.join(' '))
  return segments
}

export function GrowthChart({
  buckets,
  unit,
  label,
  bars,
  lines,
  lineMax,
  emptyMessage = 'Todavía no hay registros para graficar.',
}: {
  buckets: Array<string>
  unit: GrowthUnit
  label: string
  bars: Array<ChartBar>
  /** Default: una línea de acumulado sobre la suma de `bars`, como antes. */
  lines?: Array<ChartLine>
  /** Escala fija de las líneas (por ejemplo 100 para un %). Si se omite, se usa el máximo observado. */
  lineMax?: number
  emptyMessage?: string
}) {
  if (buckets.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{label}</h2>
        <p className="mt-3 text-sm text-muted-foreground">{emptyMessage}</p>
      </div>
    )
  }

  const stackedTotals = buckets.map((_, i) => bars.reduce((sum, b) => sum + (b.values[i] ?? 0), 0))

  const resolvedLines: Array<ChartLine> =
    lines ??
    [
      {
        values: cumulative(stackedTotals),
        color: 'var(--color-action)',
        label: 'acumulado',
        format: formatInt,
      },
    ]

  const maxBar = Math.max(...stackedTotals, 1)
  const maxLine =
    lineMax ??
    Math.max(
      ...resolvedLines.flatMap((l) => l.values.filter((v): v is number => v !== null)),
      1,
    )

  const step = INNER_W / buckets.length
  const barW = Math.max(step * 0.62, 1)

  const x = (i: number) => PAD.left + i * step + step / 2
  const barTop = (stackedSoFar: number) => PAD.top + INNER_H - (stackedSoFar / maxBar) * INNER_H
  const lineY = (v: number) => PAD.top + INNER_H - (v / maxLine) * INNER_H

  const current = stackedTotals[stackedTotals.length - 1]!
  const currentBucket = buckets[buckets.length - 1]!
  const showLabels = buckets.length <= MAX_BUCKETS_WITH_LABELS

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">{label}</h2>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {bars.map((b) => (
            <span key={b.label} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block size-2 rounded-[2px]"
                style={{ background: b.color }}
                aria-hidden
              />
              {b.label}
            </span>
          ))}
          {resolvedLines.map((l) => (
            <span key={l.label} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3.5" style={{ background: l.color }} aria-hidden />
              {l.label}
            </span>
          ))}
        </div>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        +{formatInt(current)} en el último {GROWTH_UNIT_SINGULAR[unit]}
        {resolvedLines.map((l) => {
          const v = l.values[l.values.length - 1]!
          return v === null ? null : (
            <span key={l.label}>
              {' '}
              · {l.label}: {l.format(v)}
            </span>
          )
        })}
      </p>

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full"
        style={{ height: 'auto' }}
        role="img"
        aria-label={`${label}: ${formatInt(current)} en el último período`}
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

        {/* Barras: una capa por elemento de `bars`, apiladas de abajo hacia arriba */}
        {buckets.map((bucket, i) => {
          let stackedSoFar = 0
          const tooltip = bars
            .map((b) => `${b.label}: ${formatInt(b.values[i] ?? 0)}`)
            .join(' · ')
          return (
            <g key={bucket}>
              {bars.map((b) => {
                const v = b.values[i] ?? 0
                const yTop = barTop(stackedSoFar + v)
                const yBottom = barTop(stackedSoFar)
                stackedSoFar += v
                const h = yBottom - yTop
                return (
                  <rect
                    key={b.label}
                    x={x(i) - barW / 2}
                    y={yTop}
                    width={barW}
                    height={Math.max(h, v > 0 ? 1.5 : 0)}
                    rx={1.5}
                    style={{ fill: b.color }}
                  >
                    <title>
                      {formatDate(bucket)} · {tooltip}
                    </title>
                  </rect>
                )
              })}
            </g>
          )
        })}

        {/* Etiquetas de barra: el TOTAL apilado, siempre visible (no sólo al hover) */}
        {showLabels &&
          buckets.map((bucket, i) => {
            const v = stackedTotals[i]!
            if (v === 0) return null
            return (
              <text
                key={`bar-label-${bucket}`}
                x={x(i)}
                y={Math.max(barTop(v) - 4, PAD.top - 8)}
                textAnchor="middle"
                style={{ fontSize: LABEL_FONT_SIZE, fill: 'var(--color-muted-foreground)' }}
              >
                {formatInt(v)}
              </text>
            )
          })}

        {/* Líneas */}
        {resolvedLines.map((l) =>
          lineSegments(l.values, x, lineY).map((points, si) => (
            <polyline
              key={`${l.label}-${si}`}
              points={points}
              fill="none"
              style={{ stroke: l.color }}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )),
        )}
        {resolvedLines.map((l) =>
          l.values.map((v, i) =>
            v === null ? null : (
              <circle
                key={`${l.label}-${buckets[i]}`}
                cx={x(i)}
                cy={lineY(v)}
                r={buckets.length > 40 ? 0 : 2.5}
                style={{ fill: l.color }}
              >
                <title>
                  {formatDate(buckets[i]!)} · {l.label}: {l.format(v)}
                </title>
              </circle>
            ),
          ),
        )}

        {/* Etiquetas de línea: el valor de cada punto, siempre visible. Alterna
            arriba/abajo del punto por línea (índice par arriba, impar abajo)
            para que dos líneas en el mismo gráfico (ej. "Cuánto tardamos") no
            se pisen entre sí. */}
        {showLabels &&
          resolvedLines.map((l, li) =>
            l.values.map((v, i) =>
              v === null ? null : (
                <text
                  key={`line-label-${l.label}-${buckets[i]}`}
                  x={x(i)}
                  y={li % 2 === 0 ? Math.max(lineY(v) - 6, PAD.top - 8) : lineY(v) + 12}
                  textAnchor="middle"
                  style={{ fontSize: LABEL_FONT_SIZE, fill: l.color }}
                >
                  {l.format(v)}
                </text>
              ),
            ),
          )}
      </svg>

      <div className="mt-1 flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>{formatDate(buckets[0]!)}</span>
        <span>{formatDate(currentBucket)}</span>
      </div>
    </div>
  )
}
