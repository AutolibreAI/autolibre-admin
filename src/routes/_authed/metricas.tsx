import { Link, createFileRoute } from '@tanstack/react-router'
import {
  CANT_MEASURE_YET,
  GROWTH_UNITS,
  GROWTH_UNIT_LABELS,
  PROPOSAL_STATUS_LABELS,
  VEHICLE_DIST_SCOPES,
  VEHICLE_DIST_SCOPE_LABELS,
  growthSearchSchema,
  vehicleDistSearchSchema,
  type GrowthSearch,
  type OnboardingSeries,
  type ProposalStats,
  type ScanRecurrence,
  type UnsolvedTasks,
  type UsageAdoption,
  type VehicleDebtAdoption,
  type VehicleDistScope,
} from '~/lib/ops'
import type { QuoteRequestSeries } from '~/lib/quote-requests'
import {
  getAdoptionSeries,
  getAssistantProposalStats,
  getOnboardingSeries,
  getOpsPulse,
  getScanRecurrence,
  getUnsolvedTasks,
  getUsageAdoption,
  getVehicleDebtAdoption,
  getVehicleDistribution,
} from '~/fn/ops'
import { getQuoteRequestSeriesFn } from '~/fn/quote-requests'
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
import { cn } from '~/lib/utils'

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
   * Diez llamadas en paralelo contra el pool: el pulso del negocio (las 4
   * cards, compartidas con Inicio), los cinco bloques con datos de la sección
   * `Preguntas` (adopción por función, deuda de patente y multas por vehículo,
   * recurrencia de escaneo, propuestas del chat, tareas sin solución), la serie
   * de crecimiento, la de onboarding (altas con vehículo), la distribución de
   * autos por usuario y la serie de Pedidos. Cada `data` se valida por su
   * propio schema del lado del server function, así que pasarles la búsqueda
   * entera es inocuo (las claves de más se descartan).
   */
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal
    const [
      pulse,
      usage,
      debts,
      recurrence,
      proposals,
      unsolved,
      series,
      onboarding,
      distribution,
      quoteSeries,
    ] = await Promise.all([
      getOpsPulse({ signal }),
      getUsageAdoption({ signal }),
      getVehicleDebtAdoption({ signal }),
      getScanRecurrence({ signal }),
      getAssistantProposalStats({ signal }),
      getUnsolvedTasks({ signal }),
      getAdoptionSeries({ data: deps, signal }),
      getOnboardingSeries({ data: deps, signal }),
      getVehicleDistribution({ data: deps, signal }),
      getQuoteRequestSeriesFn({ data: deps, signal }),
    ])
    return {
      pulse,
      usage,
      debts,
      recurrence,
      proposals,
      unsolved,
      series,
      onboarding,
      distribution,
      quoteSeries,
    }
  },

  head: () => ({ meta: [{ title: 'Métricas — AutoLibre' }] }),
  component: MetricasPage,
})

/**
 * Métricas — el estado y la evolución del producto en números.
 *
 * De arriba abajo:
 *  1. Las 4 cards del pulso (idénticas a Inicio): usuarios, vehículos, partners,
 *     leads. Comparten `PulseRow` — si se ven distintas, una está mal.
 *  2. `Preguntas`: los bloques que contestan (o dicen por qué no se puede
 *     contestar) preguntas de producto. Adopción por función, deuda de patente
 *     y multas por vehículo (grano distinto: es el auto, no el usuario, y el %
 *     es sobre los consultados), recurrencia de escaneo, qué produce el chat,
 *     tareas sin solución, y un bloque ámbar con lo que todavía no se puede
 *     medir.
 *  3. Crecimiento: altas de `users`/`vehicles` por período + la distribución de
 *     autos por usuario. Es lo que Inicio no muestra: la curva, no el snapshot.
 *
 * Los números excluyen las cuentas internas / E2E, igual que "Usuarios reales"
 * en Inicio.
 */
function MetricasPage() {
  const {
    pulse,
    usage,
    debts,
    recurrence,
    proposals,
    unsolved,
    series,
    onboarding,
    distribution,
    quoteSeries,
  } = Route.useLoaderData()
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

      <section className="mt-8">
        <h2 className="font-heading text-base font-semibold">Preguntas</h2>
        <p className="mt-1 mb-2 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          Qué funciones usa la gente, cada cuánto vuelve, qué produce el chat y a
          qué tareas no le podemos ofrecer un taller. El último bloque —ámbar— es
          lo que todavía no se puede medir desde acá.
        </p>

        <AdoptionTable data={usage} />
        <VehicleDebtTable data={debts} />
        <ScanRecurrenceTable data={recurrence} />
        <ProposalStatsBlock data={proposals} />
        <UnsolvedTasksTable data={unsolved} />
        <CantMeasureYetBlock />
      </section>

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
          <GrowthChart
            buckets={series.users.map((p) => p.bucket)}
            unit={series.unit}
            label="Usuarios"
            bars={[{ values: series.users.map((p) => p.added), color: 'var(--color-brand)', label: `altas por ${series.unit}` }]}
          />
          <GrowthChart
            buckets={series.vehicles.map((p) => p.bucket)}
            unit={series.unit}
            label="Vehículos"
            bars={[{ values: series.vehicles.map((p) => p.added), color: 'var(--color-brand)', label: `altas por ${series.unit}` }]}
          />
        </div>

        <OnboardingChart data={onboarding} />

        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Las barras son las altas de cada período; la línea (default) es el
          acumulado. El total de vehículos cuenta los registros históricos
          (activos + archivados), así que no coincide con "Vehículos activos" de
          arriba. Se excluyen las cuentas internas de test. Los períodos agrupan
          en hora de Buenos Aires, no UTC — un alta de las 22 h local cae en su
          propio día, no en el siguiente.
        </p>
      </section>

      <QuoteRequestsSection data={quoteSeries} unit={series.unit} />

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
 * Bloque 1 — Adopción por función. Con qué interactúa la gente y con qué no.
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
    <section className="mt-6">
      <h3 className="mb-1 font-heading text-sm font-semibold">Adopción por función</h3>
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

/**
 * Bloque 1b — Deuda de patente y de multas, por VEHÍCULO (no por usuario).
 *
 * A diferencia de `AdoptionTable`, el % de cada fila NO es sobre el padrón —
 * es sobre los autos a los que SE LES LLEGÓ A CONSULTAR esa deuda
 * (`row.queried`). Uno nunca consultado no es "sin deuda", es "no sabemos", y
 * contarlo en el denominador diluiría el número con silencio. Con `queried`
 * en 0 se muestra "—" en vez de "0 (0,0%)", que se leería como "consultado y
 * sin deuda".
 */
function VehicleDebtTable({ data }: { data: VehicleDebtAdoption }) {
  return (
    <section className="mt-8">
      <h3 className="mb-1 font-heading text-sm font-semibold">
        Deuda de patente y de multas
      </h3>
      <p className="mb-3 max-w-3xl text-xs leading-relaxed text-muted-foreground">
        Grano = vehículo, no usuario. El % es sobre los autos a los que se les
        consultó esa deuda, no sobre el padrón entero.
      </p>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Deuda</TableHead>
              <TableHead className="text-right">Consultados</TableHead>
              <TableHead className="text-right">Con deuda</TableHead>
              <TableHead className="text-right">%</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell className="text-sm">{row.label}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatInt(row.queried)}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {row.queried === 0 ? '—' : formatInt(row.withDebt)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {row.queried === 0 ? '—' : `${row.pct.toFixed(1)}%`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

/**
 * Bloque 2 — Recurrencia de escaneo. Cuántos usuarios hicieron N escaneos y los
 * días entre el primero y el último.
 *
 * Grano = usuario, universo = TODAS las `driving_sessions` (un intento fallido
 * también es "quiere saber cómo está su auto"). Sin ventana temporal, igual que
 * la tabla de adopción. El cero se muestra: si no hay sesiones, se dice.
 */
function ScanRecurrenceTable({ data }: { data: ScanRecurrence }) {
  return (
    <section className="mt-8">
      <h3 className="mb-1 font-heading text-sm font-semibold">Recurrencia de escaneo</h3>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        {formatInt(data.totalUsers)} usuarios escanearon alguna vez ·{' '}
        {formatInt(data.totalSessions)} sesiones en total. «Días» es el lapso entre
        la primera y la última sesión de cada usuario del grupo — 0 si escaneó una
        vez o todo el mismo día. Cuenta todos los intentos, traigan datos o no.
      </p>

      {data.buckets.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Todavía no hay sesiones de escaneo.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">Escaneos</TableHead>
                <TableHead className="text-right">Usuarios</TableHead>
                <TableHead className="text-right">Días (mín · prom · máx)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.buckets.map((b) => (
                <TableRow key={b.scans}>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatInt(b.scans)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(b.users)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {b.scans === 1
                      ? '—'
                      : `${formatInt(b.spanDaysMin)} · ${b.spanDaysAvg.toFixed(1)} · ${formatInt(b.spanDaysMax)}`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="text-right text-muted-foreground">Total</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatInt(data.totalUsers)}
                </TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </section>
  )
}

/**
 * Bloque 3 — Qué produce el chat. `assistant_proposals` por estado, con cuántas
 * vienen de una conversación.
 *
 * El bloque dice EN VOZ ALTA que `assistant_proposal_type` tiene un solo valor
 * (`maintenance`): "pedidos" y "búsqueda de proveedores" desde el chat no es que
 * no se usen — no se pueden representar. Mostrar sólo el conteo dejaría creer
 * que las otras dos existen y dan cero.
 */
function ProposalStatsBlock({ data }: { data: ProposalStats }) {
  const onlyMaintenance = data.types.length === 1 && data.types[0] === 'maintenance'

  return (
    <section className="mt-8">
      <h3 className="mb-1 font-heading text-sm font-semibold">Qué produce el chat</h3>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        {formatInt(data.total)} propuesta{data.total === 1 ? '' : 's'} del asistente.{' '}
        {onlyMaintenance ? (
          <>
            Todas de tipo <code className="font-mono">maintenance</code> — es el único
            valor de <code className="font-mono">assistant_proposal_type</code>. Pedidos
            y búsqueda de proveedores desde el chat todavía no se pueden representar
            (ver el bloque de abajo).
          </>
        ) : (
          <>
            Tipos presentes: {data.types.map((t) => t || '(vacío)').join(', ')}.
          </>
        )}
      </p>

      {data.total === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          El asistente todavía no propuso nada.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Propuestas</TableHead>
                <TableHead className="text-right">Desde una conversación</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.byStatus.map((r) => (
                <TableRow key={r.status}>
                  <TableCell className="text-sm">{PROPOSAL_STATUS_LABELS[r.status]}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatInt(r.count)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatInt(r.fromConversation)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="text-muted-foreground">Total</TableCell>
                <TableCell className="text-right tabular-nums">{formatInt(data.total)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatInt(data.byStatus.reduce((n, r) => n + r.fromConversation, 0))}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </section>
  )
}

const UNSOLVED_KIND_LABEL: Record<UnsolvedTasks['rows'][number]['kind'], string> = {
  no_service: 'La app no lo clasificó',
  no_partner: 'Sin taller en la red',
  covered: 'Cubierto',
}

/**
 * Bloque 4 — Tareas sin solución. Una fila por rubro de una tarea creada a mano
 * (`plan_id IS NULL`), con tareas, usuarios y partners activos.
 *
 * Ordenada por partners ascendente (los huecos arriba), con `(sin rubro)`
 * primero SIEMPRE. `no_service` es un bug de la app; `no_partner` es un hueco
 * del marketplace — se muestran distinto y enlazan distinto.
 */
function UnsolvedTasksTable({ data }: { data: UnsolvedTasks }) {
  return (
    <section className="mt-8">
      <h3 className="mb-1 font-heading text-sm font-semibold">Tareas sin solución</h3>
      <p className="mb-3 max-w-3xl text-xs leading-relaxed text-muted-foreground">
        Tareas que el usuario creó a mano (no las autogeneró un plan). «La app no
        lo clasificó» es un bug de la app; «sin taller en la red» es un hueco del
        marketplace — van a equipos distintos. Un solo partner en un rubro es un
        punto único de falla.
      </p>

      {data.rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          No hay tareas creadas a mano sin plan.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Rubro</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Tareas</TableHead>
                <TableHead className="text-right">Usuarios</TableHead>
                <TableHead className="text-right">Partners activos</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((r) => (
                <TableRow key={r.serviceSlug ?? '(sin rubro)'}>
                  <TableCell className="text-sm">
                    {r.kind === 'no_service' ? (
                      <span className="text-muted-foreground italic">(sin rubro)</span>
                    ) : r.kind === 'no_partner' && r.categorySlug ? (
                      <Link
                        to="/partners/cobertura"
                        search={{ coverageRubros: [r.categorySlug] }}
                        className="font-medium text-brand hover:underline"
                      >
                        {r.serviceName ?? r.serviceSlug}
                      </Link>
                    ) : (
                      <span className="font-medium">{r.serviceName ?? r.serviceSlug}</span>
                    )}
                    {r.serviceSlug ? (
                      <code className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                        {r.serviceSlug}
                      </code>
                    ) : null}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-xs whitespace-nowrap',
                      r.kind === 'no_service' && 'text-status-violet',
                      r.kind === 'no_partner' && 'text-status-red',
                      r.kind === 'covered' && r.activePartners === 1 && 'text-status-yellow',
                      r.kind === 'covered' && r.activePartners > 1 && 'text-muted-foreground',
                    )}
                  >
                    {r.kind === 'covered' && r.activePartners === 1
                      ? 'Punto único de falla'
                      : UNSOLVED_KIND_LABEL[r.kind]}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatInt(r.tasks)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(r.users)}</TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular-nums',
                      r.activePartners === 0 ? 'text-status-red' : 'text-muted-foreground',
                    )}
                  >
                    {formatInt(r.activePartners)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="text-muted-foreground" colSpan={2}>
                  Total
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatInt(data.totalTasks)}
                </TableCell>
                <TableCell colSpan={2} />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </section>
  )
}

/**
 * Bloque 5 — Lo que todavía no se puede medir. Lista CERRADA (`CANT_MEASURE_YET`
 * en `~/lib/ops`), `tone="warn"` — mismo criterio que "DTCs sin título" en
 * `/escaneres/detecciones`: trabajo pendiente que se ve aunque no se pueda hacer
 * desde acá. Las cuatro son del backend.
 */
function CantMeasureYetBlock() {
  return (
    <section className="mt-8">
      <div className="rounded-lg border border-status-yellow/40 bg-status-yellow-bg p-4">
        <h3 className="text-sm font-semibold text-status-yellow">
          Lo que todavía no se puede medir
        </h3>
        <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground">
          Cuatro de las nueve preguntas necesitan que el backend escriba un dato
          que hoy no persiste. No se resuelven inventando un proxy — mismo criterio
          que la medición de tokens de IA y los clicks de WhatsApp a partners.
        </p>
        <ul className="mt-3 space-y-2.5">
          {CANT_MEASURE_YET.map((item) => (
            <li
              key={item.question}
              className="rounded-md border border-status-yellow/30 bg-card p-3 text-xs leading-relaxed"
            >
              <p className="font-medium">{item.question}</p>
              <p className="mt-0.5 text-muted-foreground">{item.why}</p>
              <p className="mt-0.5">
                <span className="text-muted-foreground">Hace falta: </span>
                {item.needs}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

/**
 * Onboarding — altas con vehículo cargado dentro de los primeros
 * `ONBOARDING_VEHICLE_WINDOW_MIN` minutos, contra las altas brutas del mismo
 * período. Barra apilada: "sin auto en el proceso" (resto) + "con auto en el
 * proceso" (subset); línea = % con vehículo, sobre una escala fija a 100.
 */
function OnboardingChart({ data }: { data: OnboardingSeries }) {
  const buckets = data.points.map((p) => p.bucket)
  return (
    <div className="mt-4">
      <GrowthChart
        buckets={buckets}
        unit={data.unit}
        label="Altas con vehículo en el mismo proceso"
        bars={[
          {
            values: data.points.map((p) => Math.max(p.signups - p.withVehicle, 0)),
            color: 'var(--color-brand-muted)',
            label: 'sin auto en el alta',
          },
          {
            values: data.points.map((p) => p.withVehicle),
            color: 'var(--color-brand)',
            label: 'con auto en el alta',
          },
        ]}
        lines={[
          {
            values: data.points.map((p) => p.pctWithVehicle),
            color: 'var(--color-action)',
            label: '% con vehículo',
            format: (v) => `${v.toFixed(1)}%`,
          },
        ]}
        lineMax={100}
      />
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        "Con auto en el alta" = el primer vehículo del usuario se cargó dentro de
        los primeros 10 minutos desde su registro (mediana real: 1,5 min). El
        denominador de cada barra es la misma serie de altas que el gráfico de
        Usuarios de arriba.
      </p>
    </div>
  )
}

/**
 * Pedidos — las cuatro series sobre el mismo universo (cohorte por creación,
 * sin duplicados): recibidos, propuestas por pedido, cuánto tardamos y red vs
 * afuera. Cuelga de `quoteSeries`, que ya resuelve los dos niveles de guard
 * (`available` / `responsesAvailable`) — acá sólo se lee el resultado.
 */
function QuoteRequestsSection({ data, unit }: { data: QuoteRequestSeries; unit: GrowthSearch['unit'] }) {
  if (!data.available) {
    return (
      <section className="mt-8">
        <h2 className="mb-3 font-heading text-base font-semibold">Pedidos</h2>
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          El flujo de pedidos de presupuesto todavía no está desplegado en esta
          base — no hay nada que graficar.
        </p>
      </section>
    )
  }

  const buckets = data.buckets.map((b) => b.bucket)

  return (
    <section className="mt-8">
      <h2 className="mb-1 font-heading text-base font-semibold">Pedidos</h2>
      <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted-foreground">
        Las cuatro series excluyen los duplicados (mismo corte que "Pedidos
        totales" de arriba) y agrupan por cuándo se CREÓ el pedido, no por
        cuándo se contestó — así "los pedidos de esta semana" es el mismo
        conjunto en las cuatro. Con volumen bajo, conviene leerlas en Semana: en
        vista diaria una mediana es casi siempre un solo pedido.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <GrowthChart
          buckets={buckets}
          unit={unit}
          label="Pedidos recibidos"
          bars={[{ values: data.buckets.map((b) => b.received), color: 'var(--color-brand)', label: `recibidos por ${unit}` }]}
        />

        {data.responsesAvailable ? (
          <GrowthChart
            buckets={buckets}
            unit={unit}
            label="Propuestas por pedido"
            bars={[{ values: data.buckets.map((b) => b.proposalsTotal), color: 'var(--color-brand)', label: `propuestas por ${unit}` }]}
            lines={[
              {
                values: data.buckets.map((b) => b.avgProposalsPerRequest),
                color: 'var(--color-action)',
                label: 'promedio por pedido',
                format: (v) => v.toFixed(2),
              },
            ]}
          />
        ) : (
          <MissingResponsesNote label="Propuestas por pedido" />
        )}

        <div>
          <GrowthChart
            buckets={buckets}
            unit={unit}
            label="Cuánto tardamos"
            bars={[
              {
                values: data.buckets.map((b) => b.pendingContact),
                color: 'var(--color-status-red)',
                label: 'sin contactar',
              },
              {
                values: data.buckets.map((b) => Math.max(b.pendingAnswer - b.pendingContact, 0)),
                color: 'var(--color-status-yellow)',
                label: 'contactados, sin responder',
              },
            ]}
            lines={[
              {
                values: data.buckets.map((b) => b.medianHoursToContact),
                color: 'var(--color-action)',
                label: 'mediana hasta contactado',
                format: (v) => `${v.toFixed(1)} h`,
              },
              {
                values: data.buckets.map((b) => b.medianHoursToAnswer),
                color: 'var(--color-brand)',
                label: 'mediana hasta respondido',
                format: (v) => `${v.toFixed(1)} h`,
              },
            ]}
          />
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            "Hasta respondido" mide hasta que el operador marca respondido
            (`answered_at`), no hasta que se manda el mensaje por WhatsApp — abrir
            el link no escribe nada. Los pendientes NO entran a la mediana; los
            cancelados por el usuario antes de responder no cuentan como
            pendientes.
          </p>
        </div>

        {data.responsesAvailable ? (
          <GrowthChart
            buckets={buckets}
            unit={unit}
            label="Propuestas: red vs. afuera"
            bars={[
              { values: data.buckets.map((b) => b.proposalsNetwork), color: 'var(--color-brand)', label: 'del directorio' },
              { values: data.buckets.map((b) => b.proposalsOutside), color: 'var(--color-status-violet)', label: 'de afuera' },
            ]}
            lines={[
              {
                values: data.buckets.map((b) => b.pctNetwork),
                color: 'var(--color-action)',
                label: '% del directorio',
                format: (v) => `${v.toFixed(1)}%`,
              },
            ]}
            lineMax={100}
          />
        ) : (
          <MissingResponsesNote label="Propuestas: red vs. afuera" />
        )}
      </div>
    </section>
  )
}

function MissingResponsesNote({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">{label}</h2>
      <p className="mt-3 text-sm text-muted-foreground">
        Falta aplicar la migración 015 (`ops.quote_request_response`) en esta
        base — sin ella no hay de dónde leer qué contestó cada taller.
      </p>
    </div>
  )
}
