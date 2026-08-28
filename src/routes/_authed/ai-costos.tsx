import { Await, createFileRoute } from '@tanstack/react-router'
import {
  AlertTriangle,
  CircleDollarSign,
  Cpu,
  ExternalLink,
  EyeOff,
  Hash,
} from 'lucide-react'
import {
  SURFACE_LABELS,
  TRACKED_SURFACES,
  USAGE_WINDOWS,
  WINDOW_LABELS,
  aiUsageSearchSchema,
  formatTokens,
  formatUsd,
} from '~/lib/ai-usage'
import {
  getAiModelPrices,
  getAiSurfaceCoverage,
  getAiUsageByModel,
  getAiUsageByUser,
  getAiUsageDaily,
  getAiUsageSummary,
} from '~/fn/ai-usage'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { PanelSkeleton } from '~/components/Fallbacks'
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
  ModelPrice,
  SurfaceCoverage,
  UsageByModel,
  UsageByUser,
  UsageDay,
  UsageSummary,
} from '~/lib/ai-usage'

export const Route = createFileRoute('/_authed/ai-costos')({
  validateSearch: aiUsageSearchSchema,
  loaderDeps: ({ search }) => search,

  /**
   * SSR FULL + STREAMING.
   *
   * `true` y no `'data-only'`: es una pantalla de lectura pura sin interacción
   * más allá de los filtros, así que el HTML servido ya es útil antes de que
   * hidrate.
   *
   * Qué se espera y qué se transmite después NO es un reparto por gusto:
   *
   *  - Totales, serie diaria y desglose por modelo se ESPERAN. Son el contenido
   *    de la página; sin ellos no hay nada que mirar.
   *
   *  - Cobertura, top de usuarios y tarifas se transmiten como promesa. Las tres
   *    son caras por motivos distintos — cobertura hace un count dinámico por
   *    tabla del registry, y el top de usuarios une el consumo con `users` — y
   *    ninguna es la respuesta a "cuánto gastamos", que es la pregunta con la
   *    que alguien entra acá.
   */
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal

    const coveragePromise = getAiSurfaceCoverage({ signal })
    const byUserPromise = getAiUsageByUser({ data: deps, signal })
    const pricesPromise = getAiModelPrices({ signal })

    const [summary, daily, byModel] = await Promise.all([
      getAiUsageSummary({ data: deps, signal }),
      getAiUsageDaily({ data: deps, signal }),
      getAiUsageByModel({ data: deps, signal }),
    ])

    return { summary, daily, byModel, coveragePromise, byUserPromise, pricesPromise }
  },

  head: () => ({ meta: [{ title: 'Costos de IA — AutoLibre' }] }),
  component: AiCostsPage,
})

function AiCostsPage() {
  const { summary, daily, byModel, coveragePromise, byUserPromise, pricesPromise } =
    Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setFilter = (patch: Partial<typeof search>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })

  return (
    <>
      <PageHeader
        title="Costos de IA"
        subtitle={
          summary.events === 0
            ? 'Sin consumo medido en este período'
            : `${formatInt(summary.events)} llamadas · ${summary.models} modelo(s)`
        }
        actions={<SsrTag>ssr: full + streaming</SsrTag>}
      />

      {/* ── Filtros ─────────────────────────────────────────────────────── */}
      <div className="mb-5 flex flex-wrap items-end gap-5">
        <FilterGroup label="Período">
          {USAGE_WINDOWS.map((w) => (
            <Chip key={w} active={search.window === w} onClick={() => setFilter({ window: w })}>
              {WINDOW_LABELS[w]}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="Superficie">
          <Chip active={!search.surface} onClick={() => setFilter({ surface: undefined })}>
            Todas
          </Chip>
          {TRACKED_SURFACES.map((s) => (
            <Chip key={s} active={search.surface === s} onClick={() => setFilter({ surface: s })}>
              {SURFACE_LABELS[s]}
            </Chip>
          ))}
        </FilterGroup>
      </div>

      <SummaryTiles summary={summary} />

      {/*
        Nota discreta, NO un cartel de alerta: excluir cuentas internas es el
        comportamiento correcto, no un problema. Pero tiene que estar escrito
        en pantalla igual — un panel que filtra en silencio es un panel que
        miente prolijamente, y el día que alguien compare este total contra la
        factura del proveedor va a necesitar saber qué se sacó.
      */}
      {summary.internalEvents > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Se excluyeron <strong>{formatInt(summary.internalEvents)}</strong> llamadas de cuentas
          internas. Los dominios excluidos viven en{' '}
          <code className="font-mono">ops.excluded_email_domains</code>.
        </p>
      ) : null}

      {/*
        El aviso de eventos sin precio va ANTES de cualquier tabla de plata.
        Si apareciera al pie, el operador ya leyó el total y se lo llevó como
        cierto. Un total incompleto sin su asterisco arriba es peor que no
        mostrarlo.
      */}
      {summary.unpricedEvents > 0 ? (
        <Notice tone="warning" icon={AlertTriangle} title="Hay consumo sin precio cargado">
          {formatInt(summary.unpricedEvents)} de {formatInt(summary.events)} llamadas usaron un
          modelo sin tarifa vigente en <code className="font-mono">ops.ai_model_pricing</code>. El
          gasto de arriba <strong>no las incluye</strong>: cargá la tarifa con su{' '}
          <code className="font-mono">valid_from</code> correcto y el histórico se recalcula solo.
        </Notice>
      ) : null}

      {daily.length > 0 ? <DailyChart days={daily} /> : null}

      <Section title="Por modelo" hint="Qué contratamos y cuánto salió cada uno.">
        <ByModelTable rows={byModel} />
      </Section>

      <Section
        title="Cobertura"
        hint="De qué superficies del producto NO tenemos medición. Se calcula contra el schema, no contra una lista."
      >
        <Await
          promise={coveragePromise}
          fallback={<PanelSkeleton rows={3} label="Cargando cobertura" />}
        >
          {(rows) => <CoverageTable rows={rows} />}
        </Await>
      </Section>

      <Section title="Quién consume" hint="Top 20 por gasto en el período.">
        <Await
          promise={byUserPromise}
          fallback={<PanelSkeleton rows={3} label="Cargando consumo por usuario" />}
        >
          {(rows) => <ByUserTable rows={rows} />}
        </Await>
      </Section>

      <Section
        title="Tarifas"
        hint="Con qué números se calculó todo lo de arriba. Cada fila vale para su ventana de vigencia."
      >
        <Await
          promise={pricesPromise}
          fallback={<PanelSkeleton rows={3} label="Cargando tarifas" />}
        >
          {(rows) => <PricesTable rows={rows} />}
        </Await>
      </Section>
    </>
  )
}

// ── Totales ──────────────────────────────────────────────────────────────────

function SummaryTiles({ summary }: { summary: UsageSummary }) {
  const tiles = [
    {
      key: 'usd',
      icon: CircleDollarSign,
      value: formatUsd(summary.totalUsd),
      label: 'Gasto estimado',
      hint:
        summary.unpricedEvents > 0
          ? `Sobre ${formatInt(summary.pricedEvents)} de ${formatInt(summary.events)} llamadas`
          : 'Tokens × tarifa vigente al momento de cada llamada',
      accent: summary.unpricedEvents > 0,
    },
    {
      key: 'events',
      icon: Hash,
      value: formatInt(summary.events),
      label: 'Llamadas',
      hint:
        summary.firstEvent && summary.lastEvent
          ? `${formatDate(summary.firstEvent)} → ${formatDate(summary.lastEvent)}`
          : 'Sin eventos en el período',
      accent: false,
    },
    {
      key: 'tokens',
      icon: Cpu,
      value: formatTokens(summary.inputTokens + summary.outputTokens),
      label: 'Tokens',
      hint: `${formatInt(summary.inputTokens)} entrada · ${formatInt(summary.outputTokens)} salida`,
      accent: false,
    },
    {
      key: 'users',
      icon: EyeOff,
      value: formatInt(summary.users),
      label: 'Usuarios',
      hint: 'Distintos, con al menos una llamada medida',
      accent: false,
    },
  ] as const

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map(({ key, icon: Icon, value, label, hint, accent }) => (
        <div
          key={key}
          className={cn(
            'rounded-lg border p-4',
            accent ? 'border-status-yellow/30 bg-status-yellow-bg' : 'border-border bg-card',
          )}
        >
          <div className="flex items-center gap-2 text-muted-foreground">
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
          </div>
          <div className="mt-2 font-heading text-2xl font-bold tracking-tight">{value}</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>
        </div>
      ))}
    </div>
  )
}

// ── Serie diaria ─────────────────────────────────────────────────────────────

/**
 * Barras en CSS puro, sin librería de charts.
 *
 * No es minimalismo: meter una dependencia de gráficos por un chart de una sola
 * serie traería su propia paleta y sus propias sombras, que es exactamente lo
 * que el design system prohíbe (superficies separadas por BORDES, `Shadows` es
 * cero en los tres niveles). Un `div` con `height` sale del token de marca y no
 * discute con nadie.
 *
 * La escala es por TOKENS y no por costo: el costo puede ser NULL para un día
 * entero sin precio cargado, y una barra que desaparece por eso haría parecer
 * que ese día no hubo consumo — cuando lo que falta es la tarifa, no el uso.
 */
function DailyChart({ days }: { days: Array<UsageDay> }) {
  const max = Math.max(...days.map((d) => d.inputTokens + d.outputTokens), 1)

  return (
    <div className="mt-5 rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Consumo por día</h2>
        <span className="text-xs text-muted-foreground">escala: tokens</span>
      </div>

      <div className="flex h-28 items-end gap-1" role="list">
        {days.map((d) => {
          const tokens = d.inputTokens + d.outputTokens
          return (
            <div
              key={d.day}
              role="listitem"
              className="group flex min-w-0 flex-1 flex-col justify-end"
              title={`${formatDate(d.day)} — ${formatInt(tokens)} tokens · ${formatInt(d.events)} llamadas · ${formatUsd(d.totalUsd)}`}
            >
              <div
                className={cn(
                  'w-full rounded-sm transition-opacity group-hover:opacity-70',
                  d.unpricedEvents > 0 ? 'bg-status-yellow' : 'bg-brand',
                )}
                style={{ height: `${Math.max((tokens / max) * 100, 2)}%` }}
              />
            </div>
          )
        })}
      </div>

      <div className="mt-2 flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>{formatDate(days[0]!.day)}</span>
        <span>{formatDate(days[days.length - 1]!.day)}</span>
      </div>
    </div>
  )
}

// ── Tablas ───────────────────────────────────────────────────────────────────

function ByModelTable({ rows }: { rows: Array<UsageByModel> }) {
  if (rows.length === 0) return <Empty>No hay consumo medido en este período.</Empty>

  return (
    <TableShell>
      <TableHeader>
        <TableRow>
          <TableHead>Modelo</TableHead>
          <TableHead className="text-right">Llamadas</TableHead>
          <TableHead className="text-right">Entrada</TableHead>
          <TableHead className="text-right">Salida</TableHead>
          <TableHead className="text-right">Tarifa (US$/Mtok)</TableHead>
          <TableHead className="text-right">Gasto</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.model}>
            <TableCell>
              <span className="font-mono text-xs">{r.model}</span>
              <div className="text-xs text-muted-foreground">
                {r.provider ?? 'proveedor sin identificar'}
                {r.unpriced ? (
                  <span className="ml-1.5 text-status-yellow">· sin tarifa vigente</span>
                ) : null}
              </div>
            </TableCell>
            <TableCell className="text-right">{formatInt(r.events)}</TableCell>
            <TableCell className="text-right" title={formatInt(r.inputTokens)}>
              {formatTokens(r.inputTokens)}
            </TableCell>
            <TableCell className="text-right" title={formatInt(r.outputTokens)}>
              {formatTokens(r.outputTokens)}
            </TableCell>
            <TableCell className="text-right text-xs text-muted-foreground">
              {r.inputUsdPerMtok === null
                ? '—'
                : `${r.inputUsdPerMtok} / ${r.outputUsdPerMtok}`}
            </TableCell>
            <TableCell
              className={cn('text-right font-medium', r.totalUsd === null && 'text-status-yellow')}
            >
              {formatUsd(r.totalUsd)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableShell>
  )
}

/**
 * El informe de agujeros.
 *
 * Es la tabla que justifica que las demás sean creíbles: dice explícitamente de
 * qué NO hay datos. Sin ella el panel muestra dos superficies y calla que hay
 * otras dos gastando sin medir, lo que produce un total prolijo y falso.
 */
function CoverageTable({ rows }: { rows: Array<SurfaceCoverage> }) {
  return (
    <TableShell>
      <TableHeader>
        <TableRow>
          <TableHead>Superficie</TableHead>
          <TableHead>Origen</TableHead>
          <TableHead className="text-right">Filas</TableHead>
          <TableHead className="text-right">Medidas</TableHead>
          <TableHead>Estado</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.surface}>
            <TableCell>
              <div className="font-medium">{r.label}</div>
              {r.note ? (
                <p className="mt-0.5 max-w-md text-xs leading-relaxed text-muted-foreground">
                  {r.note}
                </p>
              ) : null}
            </TableCell>
            <TableCell>
              <span className="font-mono text-xs text-muted-foreground">{r.sourceTable}</span>
            </TableCell>
            <TableCell className="text-right text-muted-foreground">
              {r.totalRows === null ? '—' : formatInt(r.totalRows)}
            </TableCell>
            <TableCell className="text-right">{formatInt(r.measuredEvents)}</TableCell>
            <TableCell>
              {r.tracked ? (
                <Pill tone="ok">Medida</Pill>
              ) : r.hasTokenColumns ? (
                /*
                  El backend agregó las columnas pero el registry todavía no la
                  marca. Es accionable desde ESTE repo: una migración que ponga
                  `tracked = true` y sume la superficie a `ops.v_ai_usage`.
                */
                <Pill tone="warn">Instrumentada, sin leer</Pill>
              ) : (
                <Pill tone="bad">Sin instrumentar</Pill>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableShell>
  )
}

function ByUserTable({ rows }: { rows: Array<UsageByUser> }) {
  if (rows.length === 0) return <Empty>Nadie consumió IA en este período.</Empty>

  return (
    <TableShell>
      <TableHeader>
        <TableRow>
          <TableHead>Usuario</TableHead>
          <TableHead className="text-right">Llamadas</TableHead>
          <TableHead className="text-right">Tokens</TableHead>
          <TableHead className="text-right">Gasto</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.userId ?? 'sin-usuario'}>
            <TableCell>
              {/*
                Un usuario borrado en `public` deja la fila viva con su uuid y
                sin nombre — el LEFT JOIN de `ops.ai_usage_by_user` está hecho
                para eso. El gasto no desaparece porque el usuario ya no esté.
              */}
              <div className="font-medium">{r.name ?? 'Usuario dado de baja'}</div>
              <div className="font-mono text-xs text-muted-foreground">
                {r.email ?? r.userId ?? '—'}
              </div>
            </TableCell>
            <TableCell className="text-right">{formatInt(r.events)}</TableCell>
            <TableCell
              className="text-right"
              title={formatInt(r.inputTokens + r.outputTokens)}
            >
              {formatTokens(r.inputTokens + r.outputTokens)}
            </TableCell>
            <TableCell className="text-right font-medium">{formatUsd(r.totalUsd)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableShell>
  )
}

function PricesTable({ rows }: { rows: Array<ModelPrice> }) {
  if (rows.length === 0) {
    return <Empty>No hay tarifas cargadas: todo el gasto va a figurar sin precio.</Empty>
  }

  return (
    <TableShell>
      <TableHeader>
        <TableRow>
          <TableHead>Modelo</TableHead>
          <TableHead className="text-right">Entrada US$/Mtok</TableHead>
          <TableHead className="text-right">Salida US$/Mtok</TableHead>
          <TableHead>Vigencia</TableHead>
          <TableHead>Fuente · verificada</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id} className={cn(!r.current && 'text-muted-foreground')}>
            <TableCell>
              <span className="font-mono text-xs">{r.model}</span>
              <div className="text-xs text-muted-foreground">{r.provider}</div>
            </TableCell>
            <TableCell className="text-right">{r.inputUsdPerMtok}</TableCell>
            <TableCell className="text-right">{r.outputUsdPerMtok}</TableCell>
            <TableCell className="text-xs">
              {formatDate(r.validFrom)} → {r.validTo ? formatDate(r.validTo) : 'vigente'}
            </TableCell>
            <TableCell className="text-xs">
              {/*
                El link es el punto de toda esta columna: permite confirmar la
                tarifa sin salir del panel. `rel="noreferrer"` va porque
                `target="_blank"` sin eso le entrega `window.opener` al destino.
              */}
              {r.sourceUrl ? (
                <a
                  href={r.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-brand hover:underline"
                >
                  {r.source ?? r.sourceUrl}
                  <ExternalLink className="size-3 shrink-0" aria-hidden />
                </a>
              ) : (
                <span className="text-muted-foreground">{r.source ?? 'sin fuente'}</span>
              )}
              {/*
                La fecha es lo que hace útil al link: sin ella no se sabe si el
                número se chequeó ayer o hace dos años. Una tarifa vieja no
                avisa — sigue calculando, prolija y equivocada.
              */}
              <div className="text-muted-foreground">
                {r.verifiedAt ? `verificada ${formatDate(r.verifiedAt)}` : 'sin verificar'}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableShell>
  )
}

// ── Piezas chicas ────────────────────────────────────────────────────────────

function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-7">
      <div className="mb-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}

function TableShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <Table>{children}</Table>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card py-12 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function Notice({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: 'warning'
  icon: typeof AlertTriangle
  title: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'mt-4 rounded-lg border p-3.5',
        tone === 'warning' && 'border-status-yellow/30 bg-status-yellow-bg',
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-status-yellow" aria-hidden />
        <span className="text-sm font-medium">{title}</span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{children}</p>
    </div>
  )
}

function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'bad'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs',
        tone === 'ok' && 'border-status-green/25 bg-status-green-bg text-status-green',
        tone === 'warn' && 'border-status-yellow/30 bg-status-yellow-bg text-status-yellow',
        tone === 'bad' && 'border-status-red/25 bg-status-red-bg text-status-red',
      )}
    >
      {children}
    </span>
  )
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'h-8 rounded-md border px-3 text-sm transition-colors',
        active
          ? 'border-brand bg-brand-soft text-brand'
          : 'border-border bg-card text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
