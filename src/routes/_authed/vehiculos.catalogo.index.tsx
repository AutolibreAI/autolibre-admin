import { Link, createFileRoute } from '@tanstack/react-router'
import { BookOpen, BookX } from 'lucide-react'
import {
  VEHICLE_TYPE_LABELS,
  catalogSearchSchema,
  catalogTitle,
  type CatalogListItem,
} from '~/lib/manuals'
import { listVehicleCatalogs } from '~/fn/manuals'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { Badge } from '~/components/ui/badge'
import { Input } from '~/components/ui/input'
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

export const Route = createFileRoute('/_authed/vehiculos/catalogo/')({
  /**
   * SSR completo (el default de `start.ts`).
   *
   * Es una pantalla de ENTRADA: se llega buscando un modelo por nombre para
   * cargarle el manual, así que suele ser el primer pintado de la sesión.
   * `data-only` acá te deja mirando el shell vacío mientras baja el bundle,
   * que es el peor momento para hacerlo.
   */
  validateSearch: catalogSearchSchema,
  loaderDeps: ({ search }) => search,

  loader: ({ deps, abortController }) =>
    listVehicleCatalogs({ data: deps, signal: abortController.signal }),

  head: () => ({ meta: [{ title: 'Vehículos · Catálogo — AutoLibre' }] }),
  component: CatalogList,
})

/**
 * El catálogo de vehículos, y cuáles tienen manual.
 *
 * ── Qué consulta de DBeaver reemplaza ───────────────────────────────────────
 *
 * Ninguna, y eso es el punto. `vehicle_catalog_manuals` arrancó con CERO filas
 * contra ~80 catálogos: nadie corría esa consulta porque no había nada que
 * consultar. Lo que reemplaza es el `INSERT` a mano que iba a hacer falta
 * apenas apareciera el primer PDF — y ese `INSERT` era imposible de todos
 * modos, porque `file_id` referencia una fila de `files` que sólo se puede
 * crear subiendo el archivo a DigitalOcean Spaces.
 *
 * ── Las tres columnas de conteo no son adorno ───────────────────────────────
 *
 * `Manuales` es la acción. `Variantes` y `Vehículos` son el contexto que
 * decide a CUÁL le cargás el manual primero: un modelo que 12 usuarios tienen
 * en la app vale más que uno que nadie cargó todavía.
 */
function CatalogList() {
  const catalogs = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true })

  const withoutManual = catalogs.filter((c) => c.manualCount === 0).length
  const filtered = Boolean(search.q) || search.onlyWithoutManual

  return (
    <>
      <PageHeader
        title="Catálogo"
        subtitle={`${formatInt(catalogs.length)} ${filtered ? 'con este filtro' : 'modelos'}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <div className="mb-5 space-y-4">
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

        <FilterGroup label="Manual">
          <Chip
            active={!search.onlyWithoutManual}
            onClick={() => setSearch({ onlyWithoutManual: false })}
          >
            Todos
          </Chip>
          {/*
            `warn` y no `brand`: acota a filas PROBLEMÁTICAS. Pintarlo de verde
            diría "seleccionado y todo bien", que es lo contrario.
          */}
          <Chip
            active={search.onlyWithoutManual}
            tone="warn"
            onClick={() => setSearch({ onlyWithoutManual: true })}
          >
            Sin manual ({formatInt(withoutManual)})
          </Chip>
        </FilterGroup>
      </div>

      {catalogs.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Ningún modelo con estos filtros.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Modelo</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead className="text-right">Manuales</TableHead>
                <TableHead className="text-right">Variantes</TableHead>
                <TableHead className="text-right">Vehículos</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {catalogs.map((c) => (
                <CatalogRow key={c.id} catalog={c} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/*
        El corte se dice en pantalla, no se esconde. Un listado que calla que
        cortó en 500 es un listado que miente por omisión — el operador busca un
        modelo, no lo ve, y concluye que no existe.
      */}
      {catalogs.length === 500 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Se muestran los primeros 500. Afiná la búsqueda para ver el resto.
        </p>
      ) : null}
    </>
  )
}

function CatalogRow({ catalog }: { catalog: CatalogListItem }) {
  const hasManual = catalog.manualCount > 0

  return (
    <TableRow>
      <TableCell>
        <Link
          to="/vehiculos/catalogo/$catalogId"
          params={{ catalogId: catalog.id }}
          className="font-medium text-foreground hover:text-brand hover:underline"
        >
          {catalogTitle(catalog)}
        </Link>
      </TableCell>

      <TableCell>
        <Badge variant="outline">{VEHICLE_TYPE_LABELS[catalog.vehicleType]}</Badge>
      </TableCell>

      <TableCell className="text-right">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 text-sm',
            hasManual ? 'text-status-green' : 'text-status-yellow',
          )}
        >
          {hasManual ? (
            <BookOpen className="size-3.5" aria-hidden />
          ) : (
            <BookX className="size-3.5" aria-hidden />
          )}
          {formatInt(catalog.manualCount)}
        </span>
      </TableCell>

      <TableCell className="text-right text-sm text-muted-foreground">
        {formatInt(catalog.specCount)}
      </TableCell>

      {/*
        Los vehículos SÍ se resaltan en cero, al revés que en Inicio: acá el
        cero no es un pendiente, es contexto — dice que ese modelo todavía no lo
        tiene nadie, o sea que su manual puede esperar.
      */}
      <TableCell className="text-right text-sm text-muted-foreground">
        {formatInt(catalog.vehicleCount)}
      </TableCell>
    </TableRow>
  )
}
