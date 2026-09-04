import { createFileRoute } from '@tanstack/react-router'
import { Info, ScanLine, TriangleAlert } from 'lucide-react'
import {
  MIN_VEHICLES_FOR_CONFIDENCE,
  fuelTypeLabel,
  isBroken,
  isConfident,
  scannerSearchSchema,
  scannerTypeLabel,
  transmissionLabel,
  variantLabel,
} from '~/lib/scanners'
import { getScannerCompatibility } from '~/fn/scanners'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Input } from '~/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatDate, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type {
  CompatibilityCell,
  CompatibilityMatrix,
  CompatibilityRow,
  CompatibilityTotals,
  ScannerVariant,
} from '~/lib/scanners'

export const Route = createFileRoute('/_authed/escaneres')({
  /**
   * SSR completo (el default de `start.ts`), y acá el motivo es distinto al de
   * las otras pantallas de listado.
   *
   * No es de entrada: se llega desde el menú. Es de CONSULTA — se abre para
   * contestarle a un cliente "¿qué escáner le sirve a un Vento?" mientras la
   * conversación está pasando. Una tabla que aparece cien milisegundos después
   * de un shell vacío obliga a esperar justo en el momento en que alguien está
   * del otro lado.
   *
   * Y el payload es chico y todo texto: no hay componente pesado que justifique
   * `data-only`. La matriz completa son las variantes por los modelos con
   * sesiones, no los 84 catálogos.
   */
  validateSearch: scannerSearchSchema,
  loaderDeps: ({ search }) => search,

  loader: ({ deps, abortController }) =>
    getScannerCompatibility({ data: deps, signal: abortController.signal }),

  head: () => ({ meta: [{ title: 'Escáneres — AutoLibre' }] }),
  component: ScannerCompatibility,
})

/**
 * La matriz de compatibilidad escáner ↔ vehículo.
 *
 * Filas: versiones concretas del catálogo, con motor, caja y año. Columnas:
 * variantes de escáner. En la intersección, conexiones que sirvieron sobre
 * conexiones intentadas.
 *
 * ── Las TRES cosas que una celda puede decir, y son distintas ───────────────
 *
 *  1. **Vacía** → nunca se probó. No dice nada sobre compatibilidad.
 *  2. **`0 de N`** → se probó N veces y no funcionó ninguna. Esto SÍ es una
 *     afirmación sobre el escáner, y va en rojo.
 *  3. **`K de N`** → funcionó. Verde sólo si además fueron suficientes autos
 *     distintos como para que la muestra signifique algo.
 *
 * La primera versión de esta pantalla sólo tenía (1) y (3), porque contaba toda
 * sesión `completed` como éxito. Eso metía las 6 sesiones que engancharon y no
 * trajeron un solo dato adentro de la columna de éxitos — o sea que
 * **recomendaba en base a fallas**. El corte está en `lib/scanners.ts`.
 */
function ScannerCompatibility() {
  const matrix = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <>
      <PageHeader
        title="Escáneres"
        subtitle="Con qué versiones de auto funcionó cada escáner, y con cuáles no."
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <EvidenceNotice totals={matrix.totals} />

      <VariantLegend variants={matrix.variants} />

      <div className="mt-5 max-w-sm">
        <label
          htmlFor="q"
          className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground"
        >
          Filtrar por vehículo
        </label>
        <Input
          id="q"
          type="search"
          defaultValue={search.q ?? ''}
          placeholder="Marca, modelo, versión o año"
          /**
           * `replace: true` para que escribir en el buscador no llene el
           * historial con una entrada por tecla. Mismo criterio que Usuarios y
           * Catálogo.
           *
           * El filtro toca FILAS, nunca columnas: dos escáneres se comparan
           * mirándolos juntos sobre la misma fila, así que esconder una columna
           * rompería lo único que esta pantalla hace.
           */
          onChange={(event) => {
            const value = event.target.value.trim()
            navigate({ search: { q: value === '' ? undefined : value }, replace: true })
          }}
        />
      </div>

      <Matrix matrix={matrix} filtered={Boolean(search.q)} />
    </>
  )
}

// ── Lo que la tabla puede y no puede afirmar ─────────────────────────────────

/**
 * El encuadre, arriba de la tabla y no debajo.
 *
 * Su trabajo es que nadie lea una celda vacía como "no funciona". Dice la
 * muestra completa —exitosas, sin datos, fallidas— y explica de dónde sale el
 * "sin datos", porque es una deducción nuestra y no un estado que el backend
 * escriba.
 *
 * `failed` se muestra INCLUSO en cero, que es la excepción declarada a la regla
 * de Inicio ("una fila en cero no se muestra"), por el mismo motivo por el que
 * las tarjetas de cola de Operación aparecen en cero: acá el cero no dice "todo
 * bien", dice "el backend todavía no escribe este estado". Esconderlo haría
 * creer que la columna ya está cubierta.
 */
function EvidenceNotice({ totals }: { totals: CompatibilityTotals }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 space-y-2 text-sm">
          <p className="font-medium">
            {formatInt(totals.attempts)} intentos de conexión sobre {formatInt(totals.vehicles)}{' '}
            autos y {formatInt(totals.catalogs)} versiones.
          </p>

          <dl className="flex flex-wrap gap-x-6 gap-y-1">
            <Stat label="Sirvieron" value={totals.ok} tone="green" />
            <Stat label="Engancharon sin traer datos" value={totals.noData} tone="yellow" />
            <Stat label="Fallidas según el backend" value={totals.failed} tone="plain" />
            {totals.pending > 0 ? (
              <Stat label="Subiendo todavía" value={totals.pending} tone="plain" />
            ) : null}
          </dl>

          <p className="leading-relaxed text-muted-foreground">
            <strong>“Enganchó sin traer datos” lo deducimos nosotros</strong>, no lo dice el
            backend: son sesiones que quedaron marcadas como completas con cero lecturas y cero
            minutos de duración. El estado <code>failed</code> del dominio existe y hoy tiene{' '}
            {formatInt(totals.failed)} filas, así que sin esa deducción la tabla diría que nunca
            falló nada.
          </p>
          <p className="leading-relaxed text-muted-foreground">
            Una celda <strong>vacía</strong> significa que esa combinación nunca se probó — no que
            no funcione. Una celda en <strong>rojo</strong> sí lo afirma: se intentó y no salió
            ninguna.
            {totals.orphanSessions > 0
              ? ` ${formatInt(totals.orphanSessions)} sesiones sin modelo de catálogo, en la última fila.`
              : ''}
          </p>
        </div>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'green' | 'yellow' | 'plain'
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'font-heading text-base font-bold tabular-nums',
          tone === 'green' && 'text-status-green',
          tone === 'yellow' && 'text-status-yellow',
        )}
      >
        {formatInt(value)}
      </dd>
    </div>
  )
}

// ── Las columnas, explicadas antes de la tabla ───────────────────────────────

/**
 * Qué es cada columna, con su rendimiento total.
 *
 * Existe porque el encabezado de la tabla no puede contener esto sin volverse
 * ilegible, y porque el eje horizontal es la parte menos obvia: "ELM327 v2.1" y
 * "no identificado" son la MISMA pieza de hardware según el enum del backend,
 * que tiene un solo valor.
 */
function VariantLegend({ variants }: { variants: Array<ScannerVariant> }) {
  if (variants.length === 0) return null

  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {variants.map((variant) => {
        const broken = isBroken(variant)

        return (
          <div
            key={variant.key}
            className={cn(
              'rounded-lg border p-4',
              broken ? 'border-status-red/30 bg-status-red-bg' : 'border-border bg-card',
            )}
          >
            <div className="flex items-center gap-2 text-muted-foreground">
              <ScanLine className="size-4 shrink-0" aria-hidden />
              <span className="text-xs font-medium uppercase tracking-wider">
                {scannerTypeLabel(variant.scannerType)}
              </span>
            </div>
            <div className="mt-1.5 font-heading text-base font-bold tracking-tight">
              {variantLabel(variant)}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {formatInt(variant.ok)} de {formatInt(variant.attempts)} intentos sirvieron ·{' '}
              {formatInt(variant.okVehicles)} autos · {formatInt(variant.catalogs)} versiones
              {variant.protocols.length > 0 ? ` · OBD ${variant.protocols.join(', ')}` : ''}
            </p>
            {!variant.identified ? (
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                El dispositivo nunca dijo qué era. No sabemos qué escáner se usó — y no saberlo es,
                en sí mismo, el modo en que estos intentos fallaron.
              </p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

// ── La matriz ────────────────────────────────────────────────────────────────

function Matrix({ matrix, filtered }: { matrix: CompatibilityMatrix; filtered: boolean }) {
  const { variants, rows } = matrix

  if (rows.length === 0) {
    return (
      <p className="mt-6 rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        {filtered
          ? 'Ninguna versión con ese nombre registró intentos de conexión todavía.'
          : 'Todavía no hay ninguna sesión de escáner registrada.'}
      </p>
    )
  }

  return (
    <>
      {/*
        La tabla scrollea DENTRO de su contenedor y nunca hace scrollear al
        `<body>`: el eje horizontal crece con cada variante nueva de escáner, y
        una página que se mueve de costado rompe la lectura de la barra lateral.
      */}
      <div className="mt-5 overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-64">Vehículo</TableHead>
              {variants.map((variant) => (
                <TableHead key={variant.key} className="min-w-36 text-center">
                  <span className="block text-xs uppercase tracking-wider text-muted-foreground">
                    {scannerTypeLabel(variant.scannerType)}
                  </span>
                  <span className="block font-medium normal-case tracking-normal text-foreground">
                    {variantLabel(variant)}
                  </span>
                </TableHead>
              ))}
              <TableHead className="min-w-32 text-right">Total</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {rows.map((row) => (
              <MatrixRow key={row.catalogId ?? 'orphan'} row={row} variants={variants} />
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Cada celda dice cuántos intentos sirvieron sobre cuántos hubo. Verde: funcionó en al menos{' '}
        {MIN_VEHICLES_FOR_CONFIDENCE} autos distintos, que es el piso para recomendarlo — cuatro
        conexiones del mismo auto dicen que a esa persona le anduvo, no que la versión sea
        compatible. Rojo: se intentó y no funcionó nunca. Guión: nunca se probó.
      </p>
    </>
  )
}

function MatrixRow({ row, variants }: { row: CompatibilityRow; variants: Array<ScannerVariant> }) {
  const orphan = row.catalogId === null

  /**
   * El detalle del auto va en la fila y no en un tooltip: la pregunta que trae
   * a alguien a esta pantalla es si SU versión es compatible, y un Corolla 1.8
   * manual de 2013 no dice nada de un 2.0 automático de 2020. Combustible y
   * caja salen del spec, así que pueden ser varios por versión.
   */
  const spec = [
    ...row.fuels.map(fuelTypeLabel),
    ...row.transmissions.map(transmissionLabel),
  ].join(' · ')

  return (
    <TableRow>
      <TableCell className={cn('font-medium', orphan && 'text-muted-foreground')}>
        {row.label}
        {orphan ? (
          <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
            El auto no resuelve a ninguna versión del catálogo.
          </span>
        ) : spec ? (
          <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{spec}</span>
        ) : null}
      </TableCell>

      {variants.map((variant) => (
        <TableCell key={variant.key} className="text-center">
          <Cell cell={row.cells.find((c) => c.variantKey === variant.key)} />
        </TableCell>
      ))}

      <TableCell className="text-right tabular-nums">
        <span className="font-medium">
          {formatInt(row.ok)} / {formatInt(row.attempts)}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {formatInt(row.okVehicles)} {row.okVehicles === 1 ? 'auto' : 'autos'} con éxito
        </span>
      </TableCell>
    </TableRow>
  )
}

/**
 * Una intersección.
 *
 * El caso vacío es el que más cuidado lleva: un guión gris con `title` que dice
 * "sin datos" con todas las letras. La tentación era poner un cero — que se lee
 * idéntico a la celda roja de "0 de 4", y son cosas opuestas: una es ignorancia,
 * la otra es evidencia.
 */
function Cell({ cell }: { cell: CompatibilityCell | undefined }) {
  if (!cell) {
    return (
      <span className="text-muted-foreground" title="Sin datos: nunca se probó esta combinación">
        —
      </span>
    )
  }

  const confident = isConfident(cell)
  const broken = isBroken(cell)

  return (
    <span
      className={cn(
        'inline-flex min-w-20 flex-col items-center rounded-md border px-2.5 py-1.5',
        broken && 'border-status-red/40 bg-status-red-bg',
        confident && 'border-brand/40 bg-brand-soft',
        !broken && !confident && 'border-border bg-card',
      )}
      title={
        broken
          ? `Se intentó ${cell.attempts} ${cell.attempts === 1 ? 'vez' : 'veces'} y no funcionó ninguna`
          : cell.lastOk
            ? `Última conexión exitosa: ${formatDate(cell.lastOk)}`
            : 'Sin fecha de última conexión exitosa'
      }
    >
      <span className="flex items-center gap-1">
        {broken ? (
          <TriangleAlert className="size-3.5 shrink-0 text-status-red" aria-hidden />
        ) : null}
        <span
          className={cn(
            'font-heading text-base font-bold tabular-nums leading-none',
            broken && 'text-status-red',
            confident && 'text-brand',
          )}
        >
          {formatInt(cell.ok)}
          <span className="font-normal text-muted-foreground"> / {formatInt(cell.attempts)}</span>
        </span>
      </span>
      <span className="mt-1 text-[11px] leading-none text-muted-foreground">
        {cell.ok === 0
          ? 'no funcionó'
          : `${formatInt(cell.okVehicles)} ${cell.okVehicles === 1 ? 'auto' : 'autos'}`}
      </span>
    </span>
  )
}
