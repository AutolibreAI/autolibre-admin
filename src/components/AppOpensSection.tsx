import { useEffect, useMemo, useState } from 'react'
import { Chip, FilterGroup } from '~/components/Filters'
import { GrowthChart } from '~/components/GrowthChart'
import { MockBanner } from '~/components/MockBanner'
import { fetchAppOpensMock } from '~/mocks/app-opens'
import { APP_OPEN_WINDOWS, retentionPct, stickiness, summarizeWindow } from '~/lib/app-opens'
import { formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { AppOpenWindow, AppOpensData } from '~/lib/app-opens'

const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1).replace('.', ',')} %`)

/**
 * "Aperturas" en `/metricas`: lo que el gráfico de usuarios activos NO mide.
 *
 * Contra mock (`~/mocks/app-opens`) hasta que la app emita `app_open` y exista
 * el endpoint agregado. Se carga en el navegador: `/metricas` es `data-only`, y
 * la ventana (7/30/90) es un estado de la vista, no una consulta distinta — el
 * día que sea real, la ventana sí viaja al endpoint.
 */
export function AppOpensSection() {
  const [data, setData] = useState<AppOpensData | null>(null)
  const [windowDays, setWindowDays] = useState<AppOpenWindow>(30)

  useEffect(() => {
    let cancelled = false
    void fetchAppOpensMock().then((d) => {
      if (!cancelled) setData(d)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const days = useMemo(() => (data ? data.days.slice(-windowDays) : []), [data, windowDays])
  const summary = summarizeWindow(days)

  return (
    <section className="mt-8">
      <h2 className="mb-3 font-heading text-base font-semibold">Aperturas de la app</h2>
      <MockBanner
        title="Toda esta sección es de ejemplo"
        items={[
          'La app todavía no informa cuándo se abre: no hay de dónde contar aperturas. Los números son inventados para ver cómo se va a leer.',
          'Hace falta el evento app_open en la app (usuario, plataforma, versión, si vino de una notificación) y un endpoint que lo agregue.',
        ]}
      />

      <div className="mb-4">
        <FilterGroup label="Ventana">
          {APP_OPEN_WINDOWS.map((w) => (
            <Chip key={w} active={windowDays === w} onClick={() => setWindowDays(w)}>
              {w} días
            </Chip>
          ))}
        </FilterGroup>
      </div>

      {data === null ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <>
          <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Tile label="DAU (último día)" value={summary.last ? formatInt(summary.last.dau) : '—'} />
            <Tile label="WAU" value={summary.last ? formatInt(summary.last.wau) : '—'} />
            <Tile label="MAU" value={summary.last ? formatInt(summary.last.mau) : '—'} />
            <Tile label="Stickiness promedio (DAU/MAU)" value={pct(summary.avgStickiness)} />
            <Tile label="Aperturas con valor" value={pct(summary.valuableShare)} />
          </dl>

          <div className="grid gap-4 lg:grid-cols-2">
            <GrowthChart
              buckets={days.map((d) => d.date)}
              unit="dia"
              label="Personas que abrieron la app, por día"
              summaryPrefix=""
              bars={[
                { values: days.map((d) => d.valuable), color: 'var(--color-brand)', label: 'abrieron e hicieron algo de valor' },
                { values: days.map((d) => d.dau - d.valuable), color: 'var(--color-brand-muted)', label: 'sólo abrieron' },
              ]}
              lines={[
                {
                  values: days.map(stickiness),
                  color: 'var(--color-action)',
                  label: 'stickiness (DAU/MAU)',
                  format: (v) => pct(v),
                },
              ]}
              lineMax={100}
            />
            <RetentionTable data={data} />
          </div>

          <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            DAU / WAU / MAU = personas reales distintas que abrieron la app en el día, en los últimos 7 y en
            los últimos 30 días. Stickiness = DAU / MAU. «Con valor» = abrió y ese mismo día escaneó, chateó
            con el asistente, pidió un presupuesto o cargó un documento. Retención D1/D7/D30 = de las altas de
            esa semana, qué % volvió a abrir la app 1, 7 y 30 días después.
          </p>
        </>
      )}
    </section>
  )
}

function RetentionTable({ data }: { data: AppOpensData }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold">Retención por cohorte (semana de alta)</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="pb-2 font-medium">Semana</th>
            <th className="pb-2 text-right font-medium">Altas</th>
            <th className="pb-2 text-right font-medium">D1</th>
            <th className="pb-2 text-right font-medium">D7</th>
            <th className="pb-2 text-right font-medium">D30</th>
          </tr>
        </thead>
        <tbody>
          {[...data.cohorts].reverse().map((c) => (
            <tr key={c.cohortWeek} className="border-t border-border">
              <td className="py-1.5">{formatDate(`${c.cohortWeek}T12:00:00Z`)}</td>
              <td className="py-1.5 text-right tabular-nums">{formatInt(c.size)}</td>
              {[c.d1, c.d7, c.d30].map((v, i) => (
                <td
                  key={i}
                  className={cn('py-1.5 text-right tabular-nums', v === null && 'text-muted-foreground')}
                >
                  {v === null ? 'todavía no' : pct(retentionPct(v, c.size))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-heading text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  )
}
