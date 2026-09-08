import { createFileRoute } from '@tanstack/react-router'
import {
  GROWTH_UNITS,
  GROWTH_UNIT_LABELS,
  VEHICLE_DIST_SCOPES,
  VEHICLE_DIST_SCOPE_LABELS,
  growthSearchSchema,
  vehicleDistSearchSchema,
  type GrowthSearch,
  type VehicleDistScope,
} from '~/lib/ops'
import { getAdoptionSeries, getVehicleDistribution } from '~/fn/ops'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { GrowthChart } from '~/components/GrowthChart'
import { SortHeader } from '~/components/SortHeader'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatInt } from '~/lib/format'

/**
 * `/graficos` mergea dos schemas de search: la unidad temporal de los gráficos
 * y el orden/scope de la tabla de distribución. Son ejes independientes y cada
 * uno tiene su server function; el schema combinado sólo vive acá para que
 * `validateSearch` cubra las dos.
 */
const graficosSearchSchema = growthSearchSchema.extend(vehicleDistSearchSchema.shape)

export const Route = createFileRoute('/_authed/graficos')({
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

  validateSearch: graficosSearchSchema,
  loaderDeps: ({ search }) => search,

  /**
   * Dos llamadas en paralelo contra el pool: la serie de crecimiento y la
   * distribución de autos por usuario. Cada `data` se valida por su propio
   * schema del lado del server function, así que pasarles la búsqueda entera es
   * inocuo (las claves de más se descartan).
   */
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal
    const [series, distribution] = await Promise.all([
      getAdoptionSeries({ data: deps, signal }),
      getVehicleDistribution({ data: deps, signal }),
    ])
    return { series, distribution }
  },

  head: () => ({ meta: [{ title: 'Gráficos — AutoLibre' }] }),
  component: GraficosPage,
})

/**
 * Gráficos — el crecimiento del producto en el tiempo, más la distribución de
 * autos por usuario.
 *
 * Qué reemplaza:
 *  - Las curvas: nada previo. `/dashboard` da el pulso (totales y últimos 30
 *    días) pero no la evolución período a período.
 *  - La tabla: el `select vc, count(*) from (… group by user)` que contesta
 *    "cuántos usuarios tienen 1 auto, cuántos 2, …" y que hoy nadie corre.
 *
 * Los números excluyen las cuentas internas / E2E (`@autolibre.app`), igual que
 * "Usuarios reales" en Inicio.
 */
function GraficosPage() {
  const { series, distribution } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setUnit = (unit: GrowthSearch['unit']) =>
    navigate({ search: (prev) => ({ ...prev, unit }), replace: true })

  const setScope = (fleetScope: VehicleDistScope) =>
    navigate({ search: (prev) => ({ ...prev, fleetScope }), replace: true })

  return (
    <>
      <PageHeader
        title="Gráficos"
        subtitle="El crecimiento de usuarios y vehículos en el tiempo."
        actions={<SsrTag>ssr: data-only</SsrTag>}
      />

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
        así que no coincide con "Vehículos activos" de Inicio. Se excluyen las
        cuentas internas de test.
      </p>

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
                    to="/graficos"
                    align="right"
                    firstClick="asc"
                  />
                  <SortHeader
                    label="Usuarios"
                    sortKey="users"
                    active={search.sort === 'users'}
                    dir={search.dir}
                    to="/graficos"
                    align="right"
                    firstClick="desc"
                  />
                  <SortHeader
                    label="% de usuarios"
                    sortKey="pctUsers"
                    active={search.sort === 'pctUsers'}
                    dir={search.dir}
                    to="/graficos"
                    align="right"
                    firstClick="desc"
                  />
                  <SortHeader
                    label="Autos en el segmento"
                    sortKey="segmentVehicles"
                    active={search.sort === 'segmentVehicles'}
                    dir={search.dir}
                    to="/graficos"
                    align="right"
                    firstClick="desc"
                  />
                  <SortHeader
                    label="% de la flota"
                    sortKey="pctFleet"
                    active={search.sort === 'pctFleet'}
                    dir={search.dir}
                    to="/graficos"
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
