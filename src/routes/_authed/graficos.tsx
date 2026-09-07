import { createFileRoute } from '@tanstack/react-router'
import {
  GROWTH_UNITS,
  GROWTH_UNIT_LABELS,
  growthSearchSchema,
  type GrowthSearch,
} from '~/lib/ops'
import { getAdoptionSeries } from '~/fn/ops'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { GrowthChart } from '~/components/GrowthChart'

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

  validateSearch: growthSearchSchema,
  loaderDeps: ({ search }) => search,

  /**
   * Una sola llamada: `getAdoptionSeries` ya trae las dos series (usuarios y
   * vehículos) en paralelo contra el pool. Separarlas serían dos round trips y
   * dos `now()` distintos para dos ejes que se leen juntos.
   */
  loader: ({ deps, abortController }) =>
    getAdoptionSeries({ data: deps, signal: abortController.signal }),

  head: () => ({ meta: [{ title: 'Gráficos — AutoLibre' }] }),
  component: GraficosPage,
})

/**
 * Gráficos — el crecimiento del producto en el tiempo.
 *
 * Qué reemplaza: nada previo. `/dashboard` da el pulso (totales y últimos 30
 * días) pero no una curva. Acá se ve cómo entran usuarios y vehículos período a
 * período, con la unidad temporal a elección.
 *
 * Los números excluyen las cuentas internas / E2E (`@autolibre.app`), igual que
 * "Usuarios reales" en Inicio — para vehículos también, cosa que `adoptionPulse`
 * no hace: acá el gráfico es crecimiento real, un auto de una cuenta de test no
 * cuenta.
 */
function GraficosPage() {
  const series = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setUnit = (unit: GrowthSearch['unit']) =>
    navigate({ search: (prev) => ({ ...prev, unit }), replace: true })

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
    </>
  )
}
