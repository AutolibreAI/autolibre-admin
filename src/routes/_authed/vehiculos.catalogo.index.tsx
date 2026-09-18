import { Link, createFileRoute } from '@tanstack/react-router'
import {
  VEHICLE_TYPES,
  VEHICLE_TYPE_LABELS,
  fleetSearchSchema,
  vehicleTypeLabel,
  type FleetMetricRow,
  type FleetSummary,
} from '~/lib/vehicles'
import { fleetMetricsFn, fleetSummaryFn } from '~/fn/vehicles'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { SortHeader } from '~/components/SortHeader'
import { Input } from '~/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatArs, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * El catálogo de vehículos, con su flota.
 *
 * ── Unificada el 2026-09-17 ──────────────────────────────────────────────────
 *
 * Hasta acá había dos pestañas: el listado del catálogo (`listCatalogs`, el
 * universo de los 210 modelos, sus manuales y sus variantes) y "Flota"
 * (`fleetMetrics`, sólo los 180 modelos con ≥1 auto). Eran la misma consulta
 * con dos universos distintos, y el universo que cada una escondía era
 * justo el dato que la otra necesitaba — ver
 * `.claude/plans/vehiculos-catalogo-flota.md`.
 *
 * `fleetMetrics` es la que sobrevive: su `join lateral … on true` ya devuelve
 * una fila por modelo aunque no tenga autos, así que sacarle el `where
 * vehicle_count > 0` alcanzó para traer el superconjunto sin reescribir nada.
 *
 * ── Qué consulta reemplaza ───────────────────────────────────────────────────
 *
 * Las dos que reemplazaban las pantallas viejas, juntas: el `INSERT` a mano
 * que hacía falta apenas apareciera el primer manual (imposible, porque
 * `file_id` referencia una fila de `files` que sólo se crea subiendo el
 * archivo), y la consulta que nadie corría sobre "¿cuáles son los modelos más
 * comunes de la flota, y cómo se comporta cada uno?".
 *
 * ── Los 30 modelos sin auto no son un resto histórico ───────────────────────
 *
 * `vehicles` apunta al SPEC, no al catálogo (`vehicle-manuals.md`, trampa 3):
 * un modelo sin ninguna variante cargada no puede tener autos, ni hoy ni
 * nunca, hasta que alguien le cree el spec. Es un pendiente operativo real —
 * el usuario eligió ese modelo por patente y no hay a qué colgarle el auto —
 * y es un fenómeno VIVO: uno de cada siete modelos que se crea sale inerte.
 * Por eso el universo de la tabla es el superconjunto (210), no sólo los que
 * ya tienen flota.
 */
export const Route = createFileRoute('/_authed/vehiculos/catalogo/')({
  /**
   * SSR completo (el default de `start.ts`).
   *
   * Es una pantalla de ENTRADA: se llega buscando un modelo por nombre para
   * cargarle el manual o revisar su flota, así que suele ser el primer
   * pintado de la sesión. `data-only` acá te deja mirando el shell vacío
   * mientras baja el bundle, que es el peor momento para hacerlo.
   */
  validateSearch: fleetSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal
    const [rows, summary] = await Promise.all([
      fleetMetricsFn({ data: deps, signal }),
      fleetSummaryFn({ signal }),
    ])
    return { rows, summary }
  },
  head: () => ({ meta: [{ title: 'Vehículos · Catálogo — AutoLibre' }] }),
  component: CatalogList,
})

function CatalogList() {
  const { rows, summary } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true })

  // Los conteos de los chips se calculan sobre lo YA CARGADO (post-filtro),
  // igual que hacía el listado viejo con "Sin manual (N)": son un resumen de
  // la vista actual, no del universo entero.
  const withVehiclesCount = rows.filter((r) => r.vehicleCount > 0).length
  const withoutVehiclesCount = rows.filter((r) => r.vehicleCount === 0).length
  const withoutManualCount = rows.filter((r) => r.manualCount === 0).length
  const withoutSpecsCount = rows.filter((r) => r.specCount === 0).length

  return (
    <>
      <PageHeader
        title="Catálogo"
        subtitle="Los modelos del catálogo, con su flota y sus manuales."
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <SummaryTiles summary={summary} shown={rows.length} />

      <div className="mb-5 mt-5 space-y-4">
        <Input
          value={search.q ?? ''}
          onChange={(e) => {
            // El valor se lee sincrónicamente, ANTES de entrar al updater. Es
            // la regla del repo: `e.currentTarget` es null durante el render.
            const value = e.currentTarget.value
            setSearch({ q: value || undefined })
          }}
          placeholder="Buscar por marca, modelo o versión…"
          className="max-w-sm"
          autoComplete="off"
        />

        <div className="flex flex-wrap gap-5">
          <FilterGroup label="Tipo">
            <Chip active={!search.vehicleType} onClick={() => setSearch({ vehicleType: undefined })}>
              Todos
            </Chip>
            {VEHICLE_TYPES.map((t) => (
              <Chip
                key={t}
                active={search.vehicleType === t}
                onClick={() => setSearch({ vehicleType: search.vehicleType === t ? undefined : t })}
              >
                {VEHICLE_TYPE_LABELS[t]}
              </Chip>
            ))}
          </FilterGroup>

          <FilterGroup label="Autos">
            <Chip
              active={!search.onlyWithVehicles && !search.onlyWithoutVehicles}
              onClick={() => setSearch({ onlyWithVehicles: false, onlyWithoutVehicles: false })}
            >
              Todos
            </Chip>
            <Chip
              active={search.onlyWithVehicles}
              onClick={() => setSearch({ onlyWithVehicles: true, onlyWithoutVehicles: false })}
            >
              Con autos ({formatInt(withVehiclesCount)})
            </Chip>
            {/*
              `warn`: "sin autos" acota a modelos INERTES — el usuario los
              eligió por patente y no hay a qué colgarles el auto todavía.
              No es un estado neutro, como sí lo era el mismo cero en el
              listado viejo del catálogo.
            */}
            <Chip
              active={search.onlyWithoutVehicles}
              tone="warn"
              onClick={() => setSearch({ onlyWithVehicles: false, onlyWithoutVehicles: true })}
            >
              Sin autos ({formatInt(withoutVehiclesCount)})
            </Chip>
          </FilterGroup>

          <FilterGroup label="Pendientes">
            <Chip
              active={search.onlyWithoutManual}
              tone="warn"
              onClick={() => setSearch({ onlyWithoutManual: !search.onlyWithoutManual })}
            >
              Sin manual ({formatInt(withoutManualCount)})
            </Chip>
            {/*
              Hoy selecciona el MISMO conjunto que "Sin autos": todo modelo sin
              variante de powertrain tampoco puede tener un auto (`vehicles`
              apunta al spec, no al catálogo). Se deja como chip aparte porque
              son dos preguntas distintas — "nadie lo tiene" vs "no se le
              puede colgar un auto" — que dejan de coincidir el día que se
              cree un spec sin que nadie cargue el auto todavía.
            */}
            <Chip
              active={search.onlyWithoutSpecs}
              tone="warn"
              onClick={() => setSearch({ onlyWithoutSpecs: !search.onlyWithoutSpecs })}
            >
              Sin variantes ({formatInt(withoutSpecsCount)})
            </Chip>
          </FilterGroup>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Ningún modelo con estos filtros.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table className="min-w-[1200px]">
            <TableHeader>
              <TableRow>
                <SortHeader label="Modelo" sortKey="model" active={search.sort === 'model'} dir={search.dir} to="/vehiculos/catalogo" firstClick="asc" />
                <SortHeader label="Tipo" sortKey="type" active={search.sort === 'type'} dir={search.dir} to="/vehiculos/catalogo" firstClick="asc" />
                <SortHeader label="Vehículos" sortKey="vehicles" active={search.sort === 'vehicles'} dir={search.dir} to="/vehiculos/catalogo" align="right" firstClick="desc" />
                <SortHeader label="Usuarios" sortKey="users" active={search.sort === 'users'} dir={search.dir} to="/vehiculos/catalogo" align="right" firstClick="desc" />
                <SortHeader label="Km prom." sortKey="avgKm" active={search.sort === 'avgKm'} dir={search.dir} to="/vehiculos/catalogo" align="right" firstClick="desc" />
                <TableHead className="text-right">Con VTV</TableHead>
                <TableHead className="text-right">Con seguro</TableHead>
                <SortHeader label="Con multas" sortKey="withFines" active={search.sort === 'withFines'} dir={search.dir} to="/vehiculos/catalogo" align="right" firstClick="desc" />
                <SortHeader label="Deuda multas" sortKey="fineDebt" active={search.sort === 'fineDebt'} dir={search.dir} to="/vehiculos/catalogo" align="right" firstClick="desc" />
                <SortHeader label="Escaneados" sortKey="scanned" active={search.sort === 'scanned'} dir={search.dir} to="/vehiculos/catalogo" align="right" firstClick="desc" />
                <SortHeader label="Manuales" sortKey="manuals" active={search.sort === 'manuals'} dir={search.dir} to="/vehiculos/catalogo" align="right" firstClick="desc" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <Row key={r.catalogId} r={r} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/*
        El corte se dice en pantalla, no se esconde. Un listado que calla que
        cortó en 500 es un listado que miente por omisión — el operador busca
        un modelo, no lo ve, y concluye que no existe.
      */}
      {rows.length === 500 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Se muestran los primeros 500. Afiná la búsqueda para ver el resto.
        </p>
      ) : null}
    </>
  )
}

function SummaryTiles({ summary, shown }: { summary: FleetSummary; shown: number }) {
  const tiles = [
    {
      label: 'Autos en la flota',
      value: formatInt(summary.totalVehicles),
      hint:
        summary.archivedVehicles > 0
          ? `${formatInt(summary.archivedVehicles)} archivados`
          : undefined,
    },
    {
      label: 'Modelos',
      value: formatInt(summary.totalModels),
      hint: `${formatInt(summary.modelsWithVehicles)} con autos`,
    },
    { label: 'Usuarios con auto', value: formatInt(summary.usersWithVehicle) },
    { label: 'Modelos en esta vista', value: formatInt(shown) },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t.label}
          </div>
          <div className="mt-1 font-heading text-2xl font-bold tracking-tight tabular-nums">
            {t.value}
          </div>
          {t.hint ? <div className="mt-0.5 text-xs text-muted-foreground">{t.hint}</div> : null}
        </div>
      ))}
    </div>
  )
}

function Row({ r }: { r: FleetMetricRow }) {
  return (
    <TableRow>
      <TableCell>
        <Link
          to="/vehiculos/catalogo/$catalogId"
          params={{ catalogId: r.catalogId }}
          className="font-medium text-foreground hover:text-brand hover:underline"
        >
          {r.brand} {r.model} {r.trim} <span className="tabular-nums">{r.year}</span>
        </Link>
        {r.archivedCount > 0 ? (
          <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {formatInt(r.archivedCount)} archivado{r.archivedCount === 1 ? '' : 's'}
          </span>
        ) : null}
        {/*
          Modelo sin ninguna variante de powertrain: no puede tener un auto,
          ni hoy ni nunca, hasta que alguien le cree el spec (`vehicles`
          apunta al spec, no al catálogo — `vehicle-manuals.md`, trampa 3).
        */}
        {r.specCount === 0 ? (
          <span className="ml-1.5 text-[10px] uppercase tracking-wider text-status-yellow">
            sin variantes
          </span>
        ) : null}
      </TableCell>

      <TableCell className="text-muted-foreground">{vehicleTypeLabel(r.vehicleType)}</TableCell>

      <TableCell className="text-right font-heading text-sm font-bold tabular-nums">
        {formatInt(r.vehicleCount)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {formatInt(r.userCount)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {r.avgOdometerKm === null ? '—' : formatInt(r.avgOdometerKm)}
      </TableCell>

      <TableCell className="text-right tabular-nums text-muted-foreground">
        {r.withVtv === 0 ? <span className="text-muted-foreground/50">0</span> : formatInt(r.withVtv)}
        <span className="text-muted-foreground/40"> / {formatInt(r.vehicleCount)}</span>
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {r.withInsurance === 0 ? (
          <span className="text-muted-foreground/50">0</span>
        ) : (
          formatInt(r.withInsurance)
        )}
        <span className="text-muted-foreground/40"> / {formatInt(r.vehicleCount)}</span>
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {r.withFines === 0 ? (
          <span className="text-muted-foreground/50">0</span>
        ) : (
          <span className="font-medium text-status-yellow">{formatInt(r.withFines)}</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        {r.fineDebtTotal === 0 ? (
          <span className="text-muted-foreground/50">{formatArs(0)}</span>
        ) : (
          <span className="font-medium text-status-yellow">{formatArs(r.fineDebtTotal)}</span>
        )}
      </TableCell>

      <TableCell className="text-right tabular-nums text-muted-foreground">
        {formatInt(r.scannedOk)}
      </TableCell>

      {/*
        El color depende de DOS columnas, no de una:
          - con manual   → verde, tenga o no autos
          - sin manual, con autos → ámbar: pendiente REAL (§4.d del plan)
          - sin manual, sin autos → gris: no urge, nadie lo tiene todavía
        Antes de la fusión el cero de "vehículos" era contexto (Catálogo) y el
        cero de "manuales" era pendiente (Flota) — dos reglas opuestas, cada
        una correcta sólo dentro de su universo. Juntando los universos, la
        regla que estaba implícita en el `where` pasa a la celda.
      */}
      <TableCell className="text-right tabular-nums">
        <span
          className={cn(
            r.manualCount > 0
              ? 'text-status-green'
              : r.vehicleCount > 0
                ? 'text-status-yellow'
                : 'text-muted-foreground/50',
          )}
        >
          {formatInt(r.manualCount)}
        </span>
      </TableCell>
    </TableRow>
  )
}
