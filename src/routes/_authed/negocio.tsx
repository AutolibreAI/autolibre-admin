import { Fragment } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import {
  BUSINESS_MONTH_WINDOWS,
  BUSINESS_MONTH_WINDOW_LABELS,
  businessSearchSchema,
  type BusinessMonthWindow,
} from '~/lib/business'
import { getBusinessMetrics } from '~/fn/business'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { ComingSoonPipeline } from '~/components/ComingSoonPipeline'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * `/negocio` — el P&L mensual. Fase 1: lectura pura (usuarios, proveedores,
 * pedidos declarado, tareas internas). Sin migración, sin una sola escritura.
 *
 * Es la primera pantalla del panel que NO reemplaza una consulta de DBeaver: el
 * P&L no se puede correr hoy ni a mano. Misma excepción que `/ai-costos`.
 *
 * Ítem de nav propio (no una pestaña de `/metricas`): decisión explícita del
 * plan. Los bloques de costos, ingresos y margen —con sus migraciones 011–013—
 * llegan en fases siguientes.
 *
 * ── Orientación de la tabla ─────────────────────────────────────────────────
 *
 * Los MESES son las columnas y cada métrica es una fila — traspuesto respecto
 * del listado clásico del panel. Es a propósito: un P&L se lee "cómo evolucionó
 * cada línea", y con dos meses (y creciendo) todas las líneas comparten el mismo
 * eje horizontal, así que se comparan de un vistazo una debajo de la otra. La
 * primera columna queda fija (`sticky`) al hacer scroll horizontal.
 */
export const Route = createFileRoute('/_authed/negocio')({
  /**
   * SSR MODE: 'data-only'. Mismo trade que `/metricas` y `/operacion`: detrás de
   * auth (ningún crawler la ve), markup de tablas pesado en relación a su dato,
   * y el loader corre igual en el servidor y se serializa (sin waterfall).
   */
  ssr: 'data-only',

  validateSearch: businessSearchSchema,
  loaderDeps: ({ search }) => search,

  loader: async ({ deps, abortController }) => ({
    metrics: await getBusinessMetrics({ data: deps, signal: abortController.signal }),
  }),

  head: () => ({ meta: [{ title: 'Negocio — AutoLibre' }] }),
  component: NegocioPage,
})

interface MetricRow {
  label: string
  /** Un valor ya formateado por mes, alineado por índice con el eje de meses. */
  cells: Array<string>
  /** La fila "resultado" del bloque (acumulado / activos / hechas) va en negrita. */
  strong?: boolean
}

interface MetricGroup {
  title: string
  note: string
  rows: Array<MetricRow>
}

function NegocioPage() {
  const { metrics } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setWindow = (businessMonths: BusinessMonthWindow) =>
    navigate({ search: (prev) => ({ ...prev, businessMonths }), replace: true })

  // Los tres bloques comparten el MISMO eje de meses (mismo `MONTHS_CTE` en el
  // repo), así que `users.rows` sirve de lista canónica de columnas.
  const months = metrics.users.rows.map((r) => ({ month: r.month, partial: r.partial }))

  const net = (n: number) => (n > 0 ? `+${formatInt(n)}` : formatInt(n))
  const ratio = (n: number | null) => (n === null ? '—' : n.toFixed(1))

  const groups: Array<MetricGroup> = [
    {
      title: 'Usuarios',
      note: `Altas por created_at, cuentas internas excluidas. Churn = ${metrics.users.churnAfterDays} días corridos sin ninguna señal (piso en el alta) y sin ningún vehículo creado a fin de mes — da 0 y va a dar 0 hasta fines de octubre. ${formatInt(metrics.users.neverActivated)} usuarios se registraron y no hicieron nada (ni un auto): caen como baja a los ${metrics.users.churnAfterDays} días.`,
      rows: [
        { label: 'Altas', cells: metrics.users.rows.map((r) => formatInt(r.altas)) },
        { label: 'Bajas por churn', cells: metrics.users.rows.map((r) => formatInt(r.bajas)) },
        { label: 'Crecimiento neto', cells: metrics.users.rows.map((r) => net(r.crecimientoNeto)) },
        { label: 'Altas / bajas', cells: metrics.users.rows.map((r) => ratio(r.ratioAltasBajas)) },
        { label: 'Acumulados', cells: metrics.users.rows.map((r) => formatInt(r.acumulados)) },
        {
          label: 'Activos fin de mes',
          cells: metrics.users.rows.map((r) => formatInt(r.activosFinDeMes)),
          strong: true,
        },
      ],
    },
    {
      title: 'Proveedores',
      note: 'Altas y acumulado por created_at (columna inmutable → serie estable). Sin churn: no hay histórico de estado y no se inventa uno. partners.status es el estado ACTUAL.',
      rows: [
        { label: 'Altas', cells: metrics.providers.rows.map((r) => formatInt(r.altas)) },
        {
          label: 'Del legacy sheet',
          cells: metrics.providers.rows.map((r) => formatInt(r.altasFromSheet)),
        },
        {
          label: 'Acumulados',
          cells: metrics.providers.rows.map((r) => formatInt(r.acumulados)),
          strong: true,
        },
      ],
    },
    {
      title: 'Tareas internas del usuario',
      note: 'Recordatorios de mantenimiento (maintenance_occurrences), generadas y hechas — las dos por created_at. Métrica de uso del producto, no de negocio: no entra al margen.',
      rows: [
        { label: 'Generadas', cells: metrics.internalTasks.rows.map((r) => formatInt(r.generated)) },
        {
          label: 'Hechas',
          cells: metrics.internalTasks.rows.map((r) => formatInt(r.done)),
          strong: true,
        },
      ],
    },
  ]

  const colCount = months.length + 1

  return (
    <>
      <PageHeader
        title="Negocio"
        subtitle="Cuánta plata entra, cuánta sale y qué queda — mes a mes."
        actions={<SsrTag>ssr: data-only</SsrTag>}
      />

      <div className="mb-6">
        <FilterGroup label="Meses">
          {BUSINESS_MONTH_WINDOWS.map((w) => (
            <Chip key={w} active={search.businessMonths === w} onClick={() => setWindow(w)}>
              {BUSINESS_MONTH_WINDOW_LABELS[w]}
            </Chip>
          ))}
        </FilterGroup>
      </div>

      <p className="mb-6 max-w-prose rounded-lg border border-border bg-card p-4 text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Fase 1 — lectura pura.</span>{' '}
        Esta entrega cubre usuarios, proveedores, pedidos (declarado) y tareas
        internas. Los costos variables, los ingresos y el margen bruto llegan con
        sus migraciones en fases siguientes. Una fila que no se puede medir se
        declara como agujero, nunca se estima en silencio.
      </p>

      {metrics.providers.nonActiveCount > 0 ? (
        <p className="mb-6 max-w-prose rounded-md border border-status-yellow/40 bg-status-yellow-bg p-3 text-xs leading-relaxed text-status-yellow">
          {formatInt(metrics.providers.nonActiveCount)} partner(s) con estado
          distinto de <code>active</code>. La serie de acumulado de Proveedores
          dejó de ser exacta: para una serie histórica real hace falta una tabla
          de snapshots mensuales. Ese es el momento de agregarla, no antes.
        </p>
      ) : null}

      {months.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Todavía no hay meses con datos para mostrar.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-20 bg-card">Métrica</TableHead>
                {months.map((m) => (
                  <TableHead key={m.month} className="whitespace-nowrap text-right tabular-nums">
                    {m.month}
                    {m.partial ? (
                      <span className="ml-1.5 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
                        parcial
                      </span>
                    ) : null}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => (
                <Fragment key={g.title}>
                  <TableRow className="border-t-2 border-border bg-secondary/50 hover:bg-secondary/50">
                    <TableCell colSpan={colCount} className="py-2 align-top">
                      <span className="font-heading text-sm font-semibold text-foreground">
                        {g.title}
                      </span>
                      <span className="ml-2 text-xs font-normal leading-relaxed text-muted-foreground">
                        {g.note}
                      </span>
                    </TableCell>
                  </TableRow>
                  {g.rows.map((row) => (
                    <TableRow key={row.label}>
                      <TableCell
                        className={cn(
                          'sticky left-0 z-10 bg-card text-sm text-muted-foreground',
                          row.strong && 'font-medium text-foreground',
                        )}
                      >
                        {row.label}
                      </TableCell>
                      {months.map((m, i) => (
                        <TableCell
                          key={m.month}
                          className={cn(
                            'text-right tabular-nums',
                            row.strong && 'font-medium text-foreground',
                          )}
                        >
                          {row.cells[i]}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <section className="mt-10">
        <h2 className="mb-3 font-heading text-base font-semibold">Pedidos</h2>
        <ComingSoonPipeline
          what="Un pedido es una solicitud de cotización que abre un usuario para que varios talleres manden sus ofertas (1 a N, con ofertas de vuelta). No es un Lead, que es el usuario yendo hacia UN taller (1 a 1)."
          blocker="No existe: no hay tabla, no hay flujo, no hay una sola fila. Es un aggregate nuevo del backend (candidatos: QuoteRequest / QuoteOffer, a confirmar), con su TDD — un pedido es DOMINIO, no operación del panel, así que no se modela en el schema ops. Mínimo que la métrica necesita: fecha de creación, estado, usuario y vehículo, una fila por oferta con su partner, y si genera ingreso el monto y la fecha del cobro."
        />
      </section>
    </>
  )
}
