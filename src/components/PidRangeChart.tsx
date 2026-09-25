import type { ReactNode } from 'react'
import type { ScanMetric } from '~/lib/scan-sessions'
import {
  PID_INFO,
  formatPidValue,
  pidUnit,
  type GroupStats,
} from '~/lib/scan-pids'
import { formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * Gráfico de RANGO de un PID: una fila por escaneo, con lo único que la base
 * guarda de cada uno — `min`–`max` (línea fina), `avg ± stdDev` (banda) y
 * `avg` (punto). No es la curva en el tiempo: esa vive en DigitalOcean y el
 * panel no la lee (`~/lib/scan-pids`).
 *
 * Decisiones que salen de la guía de visualización y del design system:
 *
 * - **Un solo eje, compartido por todas las filas** del mismo PID: comparar
 *   dos escaneos es comparar posiciones. Un PID por gráfico — nunca dos
 *   unidades en el mismo eje.
 * - **Sin color categórico.** El sistema no tiene una paleta categórica que
 *   pase la validación (Action Dark y los grises no leen como color, y los de
 *   estado están reservados). Las características se comparan AGRUPANDO
 *   (bloques con su propia mediana), no pintando.
 * - **Los números están a la vista** en la columna derecha de cada fila, y el
 *   `title` repite el detalle al pasar el mouse: el gráfico nunca es la única
 *   forma de leer el dato.
 * - **Una lectura imposible** (`suspect`) se dibuja en ámbar y NO estira el
 *   eje: un LTFT en −100 aplastaría al resto contra el borde. Si se sale de
 *   la escala, se marca con una flecha en el borde.
 * - **Sin sombras**, separación por bordes (`design-system.md`).
 */

export interface PidRangeRow {
  key: string
  label: ReactNode
  /** Texto chico debajo del label (fecha, km…). */
  sublabel?: ReactNode
  metric: ScanMetric
  /** Motivo por el que esta lectura no es creíble, o `null`. */
  suspect?: string | null
}

export interface PidRangeGroup {
  key: string
  /** `undefined` = gráfico sin agrupar (una sola lista de filas). */
  title?: ReactNode
  rows: Array<PidRangeRow>
  /**
   * La referencia del grupo: mediana y rango intercuartil de las MEDIAS por
   * escaneo. Se dibuja detrás de las filas. `byVehicle` es la misma cuenta
   * con un valor por auto (la mediana de sus escaneos), para que un auto con
   * 7 escaneos no pese 7 veces más.
   */
  stats?: { bySession: GroupStats; byVehicle?: GroupStats } | null
}

export function PidRangeChart({
  pid,
  groups,
  labelWidth = '11rem',
}: {
  pid: string
  groups: Array<PidRangeGroup>
  labelWidth?: string
}) {
  const info = PID_INFO[pid]
  const unit = pidUnit(pid)
  const rows = groups.flatMap((g) => g.rows)
  const credible = rows.filter((r) => !r.suspect)

  const [lo, hi] = niceDomain(
    Math.min(info?.domain[0] ?? Infinity, ...credible.map((r) => r.metric.min)),
    Math.max(info?.domain[1] ?? -Infinity, ...credible.map((r) => r.metric.max)),
    // Sin dominio conocido ni filas creíbles: un eje de 0 a 1 antes que NaN.
    rows,
  )
  const ticks = niceTicks(lo, hi)
  const pos = (v: number) => ((clamp(v, lo, hi) - lo) / (hi - lo || 1)) * 100
  const showZero = Boolean(info?.zero) && lo < 0 && hi > 0

  const gridCols = { gridTemplateColumns: `minmax(0, ${labelWidth}) minmax(8rem, 1fr) auto` }

  return (
    <div className="text-sm">
      {groups.map((g) => {
        const ref = g.stats?.bySession
        const hasRef = ref && ref.median !== null && ref.q1 !== null && ref.q3 !== null
        return (
          <div key={g.key} className="mb-3 last:mb-0">
            {g.title !== undefined ? (
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 border-b border-border pb-1">
                <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {g.title}
                </div>
                {hasRef ? <GroupSummary stats={g.stats ?? null} unit={unit} /> : null}
              </div>
            ) : null}

            <div className="relative">
              {/* La referencia del grupo va DETRÁS de las filas, sólo en la columna del eje. */}
              <div className="pointer-events-none absolute inset-0 grid" style={gridCols} aria-hidden>
                <div />
                <div className="relative">
                  {hasRef ? (
                    <>
                      <div
                        className="absolute inset-y-0 bg-brand-soft"
                        style={{
                          left: `${pos(ref.q1 as number)}%`,
                          width: `${Math.max(pos(ref.q3 as number) - pos(ref.q1 as number), 0.5)}%`,
                        }}
                      />
                      <div
                        className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-brand"
                        style={{ left: `${pos(ref.median as number)}%` }}
                      />
                    </>
                  ) : null}
                  {showZero ? (
                    <div
                      className="absolute inset-y-0 border-l border-dashed border-muted-foreground/40"
                      style={{ left: `${pos(0)}%` }}
                    />
                  ) : null}
                </div>
                <div />
              </div>

              <ul className="relative">
                {g.rows.map((r) => (
                  <li
                    key={r.key}
                    className="grid items-center gap-x-3 border-b border-border/60 py-1 last:border-b-0"
                    style={gridCols}
                    title={rowTitle(r, unit)}
                  >
                    <div className="min-w-0">
                      <div className="truncate">{r.label}</div>
                      {r.sublabel ? (
                        <div className="truncate text-xs text-muted-foreground">{r.sublabel}</div>
                      ) : null}
                    </div>
                    <RangeTrack metric={r.metric} suspect={Boolean(r.suspect)} pos={pos} lo={lo} hi={hi} />
                    <div
                      className={cn(
                        'whitespace-nowrap text-right text-xs tabular-nums',
                        r.suspect ? 'text-status-yellow' : 'text-muted-foreground',
                      )}
                    >
                      <span className="font-medium text-foreground">{formatPidValue(r.metric.avg)}</span>{' '}
                      {unit} · {formatPidValue(r.metric.min)}–{formatPidValue(r.metric.max)}
                      {r.suspect ? ' · dudosa' : ''}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )
      })}

      <div className="grid gap-x-3" style={gridCols} aria-hidden>
        <div />
        <div className="relative h-4 border-t border-border">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute top-0.5 -translate-x-1/2 text-[10px] tabular-nums text-muted-foreground"
              style={{ left: `${pos(t)}%` }}
            >
              {formatPidValue(t)}
            </span>
          ))}
        </div>
        <div className="text-[10px] text-muted-foreground">{unit}</div>
      </div>
    </div>
  )
}

function RangeTrack({
  metric: m,
  suspect,
  pos,
  lo,
  hi,
}: {
  metric: ScanMetric
  suspect: boolean
  pos: (v: number) => number
  lo: number
  hi: number
}) {
  const bandLeft = pos(m.avg - m.stdDev)
  const bandWidth = Math.max(pos(m.avg + m.stdDev) - bandLeft, 0)
  return (
    <div className="relative h-6">
      {/* min–max */}
      <div
        className={cn(
          'absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full',
          suspect ? 'bg-status-yellow/60' : 'bg-muted-foreground/60',
        )}
        style={{ left: `${pos(m.min)}%`, width: `${Math.max(pos(m.max) - pos(m.min), 0.4)}%` }}
      />
      {/* avg ± desvío */}
      {bandWidth > 0 ? (
        <div
          className={cn(
            'absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm',
            suspect ? 'bg-status-yellow-bg' : 'bg-brand-muted',
          )}
          style={{ left: `${bandLeft}%`, width: `${bandWidth}%` }}
        />
      ) : null}
      {/* avg — con anillo del color de la superficie para que se separe de la banda */}
      <div
        className={cn(
          'absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card',
          suspect ? 'bg-status-yellow' : 'bg-action',
        )}
        style={{ left: `${pos(m.avg)}%` }}
      />
      {m.min < lo ? <OffScale side="left" /> : null}
      {m.max > hi ? <OffScale side="right" /> : null}
    </div>
  )
}

function OffScale({ side }: { side: 'left' | 'right' }) {
  return (
    <span
      className={cn(
        'absolute top-1/2 -translate-y-1/2 text-[10px] leading-none text-status-yellow',
        side === 'left' ? 'left-0' : 'right-0',
      )}
      aria-label="fuera de escala"
    >
      {side === 'left' ? '◀' : '▶'}
    </span>
  )
}

function GroupSummary({
  stats,
  unit,
}: {
  stats: { bySession: GroupStats; byVehicle?: GroupStats } | null
  unit: string
}) {
  if (!stats) return null
  const s = stats.bySession
  const v = stats.byVehicle
  return (
    <div className="text-xs tabular-nums text-muted-foreground">
      mediana{' '}
      <span className="font-medium text-foreground">
        {formatPidValue(s.median as number)} {unit}
      </span>{' '}
      (IQR {formatPidValue(s.q1 as number)}–{formatPidValue(s.q3 as number)}) · {formatInt(s.n)}{' '}
      {s.n === 1 ? 'escaneo' : 'escaneos'}
      {v && v.median !== null ? (
        <>
          {' '}
          · por auto {formatPidValue(v.median)} {unit} ({formatInt(v.n)} {v.n === 1 ? 'auto' : 'autos'})
        </>
      ) : null}
    </div>
  )
}

function rowTitle(r: PidRangeRow, unit: string): string {
  const m = r.metric
  const base = `promedio ${formatPidValue(m.avg)} ${unit} · mín ${formatPidValue(m.min)} · máx ${formatPidValue(m.max)} · desvío ${formatPidValue(m.stdDev)} · ${formatInt(m.sampleCount)} muestras`
  return r.suspect ? `${base} — lectura dudosa: ${r.suspect}` : base
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** Redondea el dominio a un paso "lindo" para que los ticks caigan en números redondos. */
function niceDomain(lo: number, hi: number, rows: ReadonlyArray<PidRangeRow>): [number, number] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    const all = rows.flatMap((r) => [r.metric.min, r.metric.max])
    if (all.length === 0) return [0, 1]
    lo = Math.min(...all)
    hi = Math.max(...all)
  }
  if (lo === hi) {
    lo -= 1
    hi += 1
  }
  const step = niceStep((hi - lo) / 4)
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step]
}

function niceStep(raw: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / exp
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp
}

function niceTicks(lo: number, hi: number): Array<number> {
  const step = niceStep((hi - lo) / 4)
  const out: Array<number> = []
  for (let t = lo; t <= hi + step / 2; t += step) out.push(Math.round(t * 1000) / 1000)
  return out
}
