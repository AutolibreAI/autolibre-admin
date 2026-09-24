import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  VEHICLE_REGION_LABELS,
  type LocationBreakdownRow,
  type VehicleLocationBreakdown,
  type VehicleRegion,
} from '~/lib/vehicle-location'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * "Dónde están radicados" — el bloque de `/metricas`.
 *
 * Jerarquía FIJA, no ordenable (mismo criterio que la tabla de adopción: no
 * hay search param nuevo que pueda colisionar):
 *
 *   AMBA (subtotal) → CABA, Conurbano (desplegable a partidos)
 *   Resto de Buenos Aires (desplegable a partidos)
 *   Interior (subtotal) → cada provincia
 *   Sin clasificar (ámbar) · Sin dato
 *
 * Dos porcentajes: sobre el total (cuadra con el pie) y sobre los que tienen
 * dato — "¿qué parte de lo que sabemos es AMBA?" no debería bajar porque haya
 * autos sin consultar. `sin_dato` no tiene el segundo.
 *
 * → `.claude/rules/vehicle-location.md`
 */
export function VehicleLocationSection({ data }: { data: VehicleLocationBreakdown }) {
  const sum = (rows: Array<LocationBreakdownRow>) => ({
    vehicles: rows.reduce((n, r) => n + r.vehicles, 0),
    uniquePlates: rows.reduce((n, r) => n + r.uniquePlates, 0),
  })
  const of = (region: VehicleRegion) => data.rows.filter((r) => r.region === region)

  const caba = sum(of('caba'))
  const ambaPba = of('amba_pba')
  const restoPba = of('resto_pba')
  const interior = of('interior')
  const unclassified = sum(of('sin_clasificar'))
  const noData = sum(of('sin_dato'))
  const amba = sum([...of('caba'), ...ambaPba])
  const withData = data.totalVehicles - noData.vehicles

  // Provincias del interior, una fila cada una, de mayor a menor.
  const provinces = [...groupBy(interior, (r) => r.provinceLabel ?? '?')]
    .map(([label, rows]) => ({ label, ...sum(rows) }))
    .sort((a, b) => b.vehicles - a.vehicles || a.label.localeCompare(b.label, 'es'))

  const pct = (n: number, d: number) => (d === 0 ? null : (n / d) * 100)

  return (
    <section className="mt-8">
      <h2 className="mb-1 font-heading text-base font-semibold">Dónde están radicados</h2>
      <p className="mb-3 max-w-3xl text-xs leading-relaxed text-muted-foreground">
        {formatInt(data.totalVehicles)} autos activos de usuarios reales ·{' '}
        {formatInt(data.totalUniquePlates)} patentes únicas. Es el domicilio del
        TITULAR según el registro, no dónde vive o usa el auto nuestro usuario —
        si el auto se vendió o está a nombre de otro, no es él.
        {data.sourceDateMin && data.sourceDateMax ? (
          <>
            {' '}El dato del registro va del {formatDate(data.sourceDateMin)} al{' '}
            {formatDate(data.sourceDateMax)}.
          </>
        ) : null}{' '}
        AMBA = CABA + los 40 municipios de la Región Metropolitana.
      </p>

      {data.totalVehicles === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Todavía no hay autos activos de usuarios reales.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Radicación</TableHead>
                <TableHead className="w-[9rem]" />
                <TableHead className="text-right">Vehículos</TableHead>
                <TableHead className="text-right">Patentes únicas</TableHead>
                <TableHead className="text-right">% del total</TableHead>
                <TableHead className="text-right">% con dato</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <Row label="AMBA" level={0} strong {...amba} total={data.totalVehicles} withData={withData} pct={pct} />
              <Row label="CABA" level={1} {...caba} total={data.totalVehicles} withData={withData} pct={pct} />
              <ExpandableRow
                label="Conurbano (40 municipios)"
                level={1}
                rows={ambaPba}
                total={data.totalVehicles}
                withData={withData}
                pct={pct}
              />
              <ExpandableRow
                label={VEHICLE_REGION_LABELS.resto_pba}
                level={0}
                strong
                rows={restoPba}
                total={data.totalVehicles}
                withData={withData}
                pct={pct}
              />
              <Row label="Interior" level={0} strong {...sum(interior)} total={data.totalVehicles} withData={withData} pct={pct} />
              {provinces.map((p) => (
                <Row key={p.label} level={1} {...p} total={data.totalVehicles} withData={withData} pct={pct} />
              ))}
              {unclassified.vehicles > 0 ? (
                <Row
                  label={VEHICLE_REGION_LABELS.sin_clasificar}
                  level={0}
                  tone="warn"
                  {...unclassified}
                  total={data.totalVehicles}
                  withData={withData}
                  pct={pct}
                />
              ) : null}
              <Row
                label={`${VEHICLE_REGION_LABELS.sin_dato} (sin consulta por patente)`}
                level={0}
                muted
                {...noData}
                total={data.totalVehicles}
                withData={null}
                pct={pct}
              />
            </TableBody>
            {/*
              El pie cuadra: la suma de las filas hoja (CABA, cada partido, cada
              provincia, sin clasificar, sin dato) tiene que dar el total. Si no
              cierra, el clasificador dejó una región sin fila.
            */}
            <TableFooter>
              <TableRow>
                <TableCell className="text-muted-foreground" colSpan={2}>
                  Total
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatInt(data.totalVehicles)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInt(data.totalUniquePlates)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">100,0%</TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}

      {data.gaps.length > 0 ? (
        <div className="mt-3 rounded-lg border border-status-yellow/40 bg-status-yellow-bg p-4">
          <h3 className="text-sm font-semibold text-status-yellow">Localidades sin clasificar</h3>
          <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground">
            Hay dato del registro y el clasificador no las supo ubicar: una
            localidad de Buenos Aires que el dataset de Georef no tiene (o que
            existe en partidos de regiones distintas), o una provincia que no se
            reconoce. Se arreglan con un alias en{' '}
            <code className="font-mono">src/server/vehicle-location.ts</code>.
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {data.gaps.map((g) => (
              <li
                key={`${g.province}|${g.city}`}
                className="rounded-md border border-status-yellow/30 bg-card px-2 py-1 text-xs"
              >
                {g.city ?? '(sin localidad)'}
                <span className="text-muted-foreground"> · {g.province ?? '?'} · </span>
                <span className="tabular-nums">{formatInt(g.vehicles)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

type PctFn = (n: number, d: number) => number | null

interface RowProps {
  label: string
  level: 0 | 1 | 2
  vehicles: number
  uniquePlates: number
  total: number
  /** `null` ⇒ la columna "% con dato" no aplica a esta fila (`sin dato`). */
  withData: number | null
  pct: PctFn
  strong?: boolean
  muted?: boolean
  tone?: 'warn'
  toggle?: { open: boolean; onClick: () => void }
}

function Row({ label, level, vehicles, uniquePlates, total, withData, pct, strong, muted, tone, toggle }: RowProps) {
  const pTotal = pct(vehicles, total)
  const pData = withData === null ? null : pct(vehicles, withData)
  return (
    <TableRow className={cn(level === 2 && 'bg-canvas/60')}>
      <TableCell
        className={cn(
          'text-sm',
          level === 1 && 'pl-8',
          level === 2 && 'pl-14 text-xs',
          strong && 'font-medium',
          muted && 'text-muted-foreground',
          tone === 'warn' && 'text-status-yellow',
        )}
      >
        {toggle ? (
          <button
            type="button"
            onClick={toggle.onClick}
            aria-expanded={toggle.open}
            className="-ml-1 inline-flex items-center gap-1 rounded outline-none hover:text-brand focus-visible:ring-2 focus-visible:ring-ring"
          >
            {toggle.open ? (
              <ChevronDown className="size-3.5" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden />
            )}
            {label}
          </button>
        ) : (
          label
        )}
      </TableCell>
      <TableCell>
        {level < 2 ? (
          <span className="block h-2.5 overflow-hidden rounded-full bg-secondary">
            <span
              className={cn('block h-full rounded-full', muted ? 'bg-muted-foreground/40' : 'bg-brand')}
              style={{ width: `${pTotal ?? 0}%` }}
            />
          </span>
        ) : null}
      </TableCell>
      <TableCell className={cn('text-right tabular-nums', strong && 'font-medium')}>{formatInt(vehicles)}</TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">{formatInt(uniquePlates)}</TableCell>
      <TableCell className={cn('text-right tabular-nums', strong && 'font-medium')}>
        {pTotal === null ? '—' : `${pTotal.toFixed(1)}%`}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {pData === null ? '—' : `${pData.toFixed(1)}%`}
      </TableCell>
    </TableRow>
  )
}

/** Una fila de región que se despliega a sus partidos, de mayor a menor. */
function ExpandableRow({
  label,
  level,
  rows,
  strong,
  ...rest
}: {
  label: string
  level: 0 | 1
  rows: Array<LocationBreakdownRow>
  strong?: boolean
  total: number
  withData: number | null
  pct: PctFn
}) {
  const [open, setOpen] = useState(false)
  const partidos = [...groupBy(rows, (r) => r.partido ?? '')]
    .map(([partido, rs]) => ({
      // `partido` vacío = la localidad existe en DOS partidos de la misma
      // región (`DEL VISO`: José C. Paz y Pilar) — la región es segura, el
      // partido no.
      label: partido || '(localidad en más de un partido)',
      vehicles: rs.reduce((n, r) => n + r.vehicles, 0),
      uniquePlates: rs.reduce((n, r) => n + r.uniquePlates, 0),
    }))
    .sort((a, b) => b.vehicles - a.vehicles || a.label.localeCompare(b.label, 'es'))

  return (
    <>
      <Row
        label={label}
        level={level}
        strong={strong}
        vehicles={partidos.reduce((n, p) => n + p.vehicles, 0)}
        uniquePlates={partidos.reduce((n, p) => n + p.uniquePlates, 0)}
        toggle={partidos.length ? { open, onClick: () => setOpen((o) => !o) } : undefined}
        {...rest}
      />
      {open
        ? partidos.map((p) => <Row key={p.label} level={2} {...p} {...rest} />)
        : null}
    </>
  )
}

function groupBy<T>(items: Array<T>, key: (t: T) => string): Map<string, Array<T>> {
  const m = new Map<string, Array<T>>()
  for (const it of items) {
    const k = key(it)
    const list = m.get(k)
    if (list) list.push(it)
    else m.set(k, [it])
  }
  return m
}
