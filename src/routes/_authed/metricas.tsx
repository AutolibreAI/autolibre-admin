import { createFileRoute } from '@tanstack/react-router'
import {
  GROWTH_UNITS,
  GROWTH_UNIT_LABELS,
  VEHICLE_DIST_SCOPES,
  VEHICLE_DIST_SCOPE_LABELS,
  growthSearchSchema,
  vehicleDistSearchSchema,
  type GrowthSearch,
  type UsageAdoption,
  type VehicleDistScope,
} from '~/lib/ops'
import { getAdoptionSeries, getOpsPulse, getUsageAdoption, getVehicleDistribution } from '~/fn/ops'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { PulseRow } from '~/components/PulseCards'
import { Chip, FilterGroup } from '~/components/Filters'
import { GrowthChart } from '~/components/GrowthChart'
import { SortHeader } from '~/components/SortHeader'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatInt } from '~/lib/format'

/**
 * `/metricas` mergea dos schemas de search: la unidad temporal de los gráficos
 * y el orden/scope de la tabla de distribución. Son ejes independientes y cada
 * uno tiene su server function; el schema combinado sólo vive acá para que
 * `validateSearch` cubra las dos. Las cards del pulso y la tabla de adopción no
 * toman search params.
 */
const metricasSearchSchema = growthSearchSchema.extend(vehicleDistSearchSchema.shape)

export const Route = createFileRoute('/_authed/metricas')({
  /**
   * SSR MODE: 'data-only'. Mismo trade que `/operacion`:
   *  - Detrás de auth: ningún crawler la ve, el markup server-rendered no compra
   *    SEO ni preview de link.
   *  - El componente es un SVG que se dibuja en el cliente igual — renderizarlo
   *    en el servidor gasta bytes en nodos que se reconcilian de inmediato.
   *  - El loader corre en el servidor durante el pedido del documento y su
   *    resultado se serializa: no hay waterfall ni flash de carga.
   */
  ssr: 'data-only',

  validateSearch: metricasSearchSchema,
  loaderDeps: ({ search }) => search,

  /**
   * Cuatro llamadas en paralelo contra el pool: el pulso del negocio (las 4
   * cards, compartidas con Inicio), la tabla de adopción por función, la serie
   * de crecimiento y la distribución de autos por usuario. Cada `data` se valida
   * por su propio schema del lado del server function, así que pasarles la
   * búsqueda entera es inocuo (las claves de más se descartan).
   */
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal
    const [pulse, usage, series, distribution] = await Promise.all([
      getOpsPulse({ signal }),
      getUsageAdoption({ signal }),
      getAdoptionSeries({ data: deps, signal }),
      getVehicleDistribution({ data: deps, signal }),
    ])
    return { pulse, usage, series, distribution }
  },

  head: () => ({ meta: [{ title: 'Métricas — AutoLibre' }] }),
  component: MetricasPage,
})

/**
 * Métricas — el estado y la evolución del producto en números.
 *
 * Tres bloques, de arriba abajo:
 *  1. Las 4 cards del pulso (idénticas a Inicio): usuarios, vehículos, partners,
 *     leads. Comparten `PulseRow` — si se ven distintas, una está mal.
 *  2. Adopción por función: qué % de los usuarios reales usó cada cosa. Reemplaza
 *     una docena de `count(distinct user_id)` sueltos que nadie corre.
 *  3. Crecimiento: altas de `users`/`vehicles` por período + la distribución de
 *     autos por usuario. Es lo que Inicio no muestra: la curva, no el snapshot.
 *
 * Los números excluyen las cuentas internas / E2E, igual que "Usuarios reales"
 * en Inicio.
 */
function MetricasPage() {
  const { pulse, usage, series, distribution } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setUnit = (unit: GrowthSearch['unit']) =>
    navigate({ search: (prev) => ({ ...prev, unit }), replace: true })

  const setScope = (fleetScope: VehicleDistScope) =>
    navigate({ search: (prev) => ({ ...prev, fleetScope }), replace: true })

  return (
    <>
      <PageHeader
        title="Métricas"
        subtitle="El estado del negocio, qué funciones usa la gente y cómo crece."
        actions={<SsrTag>ssr: data-only</SsrTag>}
      />

      <PulseRow pulse={pulse} />

      <AdoptionTable data={usage} />

      <section className="mt-8">
        <h2 className="mb-3 font-heading text-base font-semibold">Crecimiento</h2>

        <div className="mb-5">
          <FilterGroup label="Unidad de tiempo">
            {GROWTH_UNITS.map((u) => (
              <Chip key={u} active={search.unit === u} onClick={() => setUnit(u)}>
                {GROWTH_UNIT_LABELS[u]}
              </Chip>
            ))}
          </FilterGroup>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <GrowthChart points={series.users} unit={series.unit} label="Usuarios" />
          <GrowthChart points={series.vehicles} unit={series.unit} label="Vehículos" />
        </div>

        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Las barras son las altas de cada período; la línea es el acumulado. El
          total de vehículos cuenta los registros históricos (activos + archivados),
          así que no coincide con "Vehículos activos" de arriba. Se excluyen las
          cuentas internas de test.
        </p>
      </section>

      <section className="mt-8">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h2 className="font-heading text-base font-semibold">Vehículos por usuario</h2>
          <FilterGroup label="Contar">
            {VEHICLE_DIST_SCOPES.map((s) => (
              <Chip key={s} active={distribution.scope === s} onClick={() => setScope(s)}>
                {VEHICLE_DIST_SCOPE_LABELS[s]}
              </Chip>
            ))}
          </FilterGroup>
        </div>

        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Cuántos usuarios reales tienen 0, 1, 2… autos.{' '}
          {formatInt(distribution.totalUsers)} usuarios ·{' '}
          {formatInt(distribution.totalFleet)} autos en total. «Autos en el
          segmento» es cantidad × usuarios; «% de la flota» es qué porción del
          padrón concentra ese segmento.
        </p>

        {distribution.buckets.length === 0 ? (
          <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
            Todavía no hay usuarios reales para contar.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortHeader
                    label="Vehículos"
                    sortKey="vehicles"
                    active={search.sort === 'vehicles'}
                    dir={search.dir}
                    to="/metricas"
                    align="right"
                    firstClick="asc"
                  />
                  <SortHeader
                    label="Usuarios"
                    sortKey="users"
                    active={search.sort === 'users'}
                    dir={search.dir}
                    to="/metricas"
                    align="right"
                    firstClick="desc"
                  />
                  <SortHeader
                    label="% de usuarios"
                    sortKey="pctUsers"
                    active={search.sort === 'pctUsers'}
                    dir={search.dir}
                    to="/metricas"
                    align="right"
                    firstClick="desc"
                  />
                  <SortHeader
                    label="Autos en el segmento"
                    sortKey="segmentVehicles"
                    active={search.sort === 'segmentVehicles'}
                    dir={search.dir}
                    to="/metricas"
                    align="right"
                    firstClick="desc"
                  />
                  <SortHeader
                    label="% de la flota"
                    sortKey="pctFleet"
                    active={search.sort === 'pctFleet'}
                    dir={search.dir}
                    to="/metricas"
                    align="right"
                    firstClick="desc"
                  />
                </TableRow>
              </TableHeader>
              <TableBody>
                {distribution.buckets.map((b) => (
                  <TableRow key={b.vehicles}>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatInt(b.vehicles)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatInt(b.users)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {b.pctUsers.toFixed(1)}%
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatInt(b.segmentVehicles)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {b.pctFleet.toFixed(1)}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              {/*
                El pie cuadra la tabla: usuarios suma el total, los dos % dan 100,
                y «autos en el segmento» suma el padrón. Si una columna no cierra,
                el filtro o el cálculo está mal — mismo criterio que la columna
                `users` de la tabla de dominios excluidos.
              */}
              <TableFooter>
                <TableRow>
                  <TableCell className="text-right text-muted-foreground">Total</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatInt(distribution.totalUsers)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    100,0%
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatInt(distribution.totalFleet)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {distribution.totalFleet === 0 ? '0,0%' : '100,0%'}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        )}
      </section>
    </>
  )
}

/**
 * Adopción por función — con qué interactúa la gente y con qué no.
 *
 * Orden FIJO por % descendente: la tabla contesta "de un vistazo, ¿qué usan y
 * qué no?", y para eso alcanza con verla ordenada. Sin `SortHeader` a propósito
 * — no hay search param, así que no hay colisión de nombres que esquivar
 * (`.claude/rules/notifications.md`) y `ssr: 'data-only'` se mantiene.
 *
 * La barra por fila es el mismo patrón que `Distribution` en `dashboard.tsx`:
 * CSS puro sobre el token de marca, sin librería de charts (que traería su
 * propia paleta y sus sombras — lo que el design system prohíbe).
 */
function AdoptionTable({ data }: { data: UsageAdoption }) {
  const rows = [...data.features].sort((a, b) => b.pct - a.pct)

  return (
    <section className="mt-8">
      <h2 className="mb-1 font-heading text-base font-semibold">Adopción por función</h2>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        Sobre {formatInt(data.totalUsers)} usuarios reales (cuentas internas de
        test excluidas). Cada fila cuenta a los usuarios que usaron esa función al
        menos una vez, sin ventana temporal.
      </p>

      {data.totalUsers === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Todavía no hay usuarios reales para medir.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Función</TableHead>
                <TableHead className="w-[9rem]" />
                <TableHead className="text-right">Usuarios</TableHead>
                <TableHead className="text-right">%</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell className="text-sm">{row.label}</TableCell>
                  <TableCell>
                    <span className="block h-2.5 overflow-hidden rounded-full bg-secondary">
                      <span
                        className="block h-full rounded-full bg-brand"
                        style={{ width: `${row.pct}%` }}
                      />
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(row.users)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {row.pct.toFixed(1)}%
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}
