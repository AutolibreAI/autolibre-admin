import { Link, createFileRoute } from '@tanstack/react-router'
import {
  QUOTE_REQUEST_CHANNELS,
  QUOTE_REQUEST_OUTCOMES,
  QUOTE_REQUEST_STATUSES,
  QUOTE_UNCONTACTED_AFTER_HOURS,
  formatMinutes,
  quoteCancellationReasonLabel,
  quoteChannelLabel,
  quoteCloseReasonLabel,
  quoteOutcomeLabel,
  quotePublicCode,
  quoteRequestSearchSchema,
  quoteStatusLabel,
  quoteUserOutcomeLabel,
  type QuoteRequestListItem,
  type QuoteRequestSearch,
  type QuoteRequestStatusSummary,
  type QuoteSortKey,
} from '~/lib/quote-requests'
import { listQuoteRequestsFn } from '~/fn/quote-requests'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { SortHeader } from '~/components/SortHeader'
import { QuoteRequestsUnavailable } from '~/components/QuoteRequestsUnavailable'
import { QuoteStatusBadge, QuoteVehicleWarnings, QuoteWhatsAppLink } from '~/components/QuoteRequestCells'
import { Input } from '~/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { formatArs, formatDateTime, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * Pedidos de presupuesto — la cola de `QuoteRequest`s.
 *
 * ── Qué reemplaza ───────────────────────────────────────────────────────────
 *
 * `listar-pedidos-de-presupuesto-abiertos.sql` del backend, que el operador
 * corre en DBeaver (`… where status <> 'closed' order by created_at`). El
 * default de esta pantalla es exactamente ese corte y ese orden; los cerrados
 * —que el script no muestra y nadie mira— están a un chip.
 *
 * ── Vocabulario ─────────────────────────────────────────────────────────────
 *
 * `QuoteRequest` es un aggregate de `quotes/`, NO un `Lead`. Vive bajo `/leads`
 * como línea de captación, igual que Seguros y Multas. → `.claude/rules/leads.md`
 *
 * ── Es `leads.pedidos.index.tsx` y no `leads.pedidos.tsx` ──────────────────
 *
 * Con un `leads.pedidos.tsx` con componente, el detalle
 * (`leads.pedidos.$quoteRequestId.tsx`) quedaría ANIDADO adentro y renderizaría
 * en un `<Outlet/>` que esta tabla no tiene: la URL cambiaría y la pantalla no.
 * Mismo patrón que `chats.index.tsx` + `chats.$conversationId.tsx`.
 */
export const Route = createFileRoute('/_authed/leads/pedidos/')({
  /**
   * SSR completo (heredado). Pantalla de CONTENIDO —la cola de trabajo del
   * operador, con contacto y descripción— que puede ser el primer pintado de la
   * sesión en que alguien se sienta a llamar gente. Mismo criterio que
   * `/leads/talleres`, `/leads/seguros` y `/leads/multas`.
   */
  validateSearch: quoteRequestSearchSchema,
  loaderDeps: ({ search }) => search,

  /**
   * Una sola RPC: el handler chequea que la tabla exista y recién ahí corre
   * listado + resumen en paralelo. En una base sin el flujo desplegado vuelve
   * `{ availability }` sin tocar `quote_requests`.
   */
  loader: async ({ deps, abortController }) =>
    listQuoteRequestsFn({ data: deps, signal: abortController.signal }),

  head: () => ({ meta: [{ title: 'Leads · Pedidos — AutoLibre' }] }),
  component: Pedidos,
})

function Pedidos() {
  const result = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  if (!('rows' in result)) {
    return (
      <>
        <PageHeader
          title="Pedidos de presupuesto"
          subtitle="La persona pide un presupuesto y el operador sale a buscar talleres."
          actions={<SsrTag>ssr: full</SsrTag>}
        />
        <QuoteRequestsUnavailable availability={result.availability} />
      </>
    )
  }

  const { rows, summary } = result

  // `resetScroll: false`: tocar un chip no tiene por qué mandarte al tope — mismo
  // arreglo que `partners.cobertura.tsx`.
  const setSearch = (next: Partial<QuoteRequestSearch>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  const filtered =
    Boolean(search.q) ||
    search.quoteStatus !== 'all' ||
    search.quoteChannel !== 'all' ||
    search.quoteOutcome !== 'all' ||
    search.quoteUncontacted

  return (
    <>
      <PageHeader
        title="Pedidos de presupuesto"
        subtitle={`${formatInt(rows.length)} ${filtered ? 'con este filtro' : 'pedidos'} · de ${formatInt(summary.total)} en total`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      {/*
        La lista no escribe, y se dice en pantalla: si el operador no lo lee
        acá, busca en la fila el botón de "marcar contactado" que vive en la ficha.
      */}
      <p className="mb-5 max-w-prose text-sm leading-relaxed text-muted-foreground">
        La lista es de solo lectura. Marcar contactado / respondido, cerrar y agregar notas internas se hace desde
        la ficha de cada pedido.
      </p>

      <SummaryTiles summary={summary} />

      <div className="mb-4 mt-5 flex flex-wrap items-end gap-5">
        <div className="space-y-1.5">
          <label
            htmlFor="q"
            className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            Buscar
          </label>
          <Input
            id="q"
            type="search"
            placeholder="AL-1001, patente, teléfono, email…"
            defaultValue={search.q ?? ''}
            className="w-64"
            onChange={(e) => {
              const value = e.currentTarget.value.trim()
              setSearch({ q: value === '' ? undefined : value })
            }}
          />
        </div>

        <FilterGroup label="Estado">
          <Chip active={search.quoteStatus === 'open'} onClick={() => setSearch({ quoteStatus: 'open' })}>
            Abiertos
          </Chip>
          <Chip active={search.quoteStatus === 'all'} onClick={() => setSearch({ quoteStatus: 'all' })}>
            Todos
          </Chip>
          {QUOTE_REQUEST_STATUSES.map((s) => (
            <Chip key={s} active={search.quoteStatus === s} onClick={() => setSearch({ quoteStatus: s })}>
              {quoteStatusLabel(s)}
            </Chip>
          ))}
          <Chip
            active={search.quoteStatus === 'cancelled_by_user'}
            onClick={() => setSearch({ quoteStatus: 'cancelled_by_user' })}
          >
            Cancelados por el usuario
          </Chip>
        </FilterGroup>

        <FilterGroup label="Canal">
          <Chip active={search.quoteChannel === 'all'} onClick={() => setSearch({ quoteChannel: 'all' })}>
            Todos
          </Chip>
          {QUOTE_REQUEST_CHANNELS.map((c) => (
            <Chip key={c} active={search.quoteChannel === c} onClick={() => setSearch({ quoteChannel: c })}>
              {quoteChannelLabel(c)}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="Resultado (operador)">
          <Chip active={search.quoteOutcome === 'all'} onClick={() => setSearch({ quoteOutcome: 'all' })}>
            Todos
          </Chip>
          {QUOTE_REQUEST_OUTCOMES.map((o) => (
            <Chip key={o} active={search.quoteOutcome === o} onClick={() => setSearch({ quoteOutcome: o })}>
              {quoteOutcomeLabel(o)}
            </Chip>
          ))}
          <Chip
            active={search.quoteOutcome === 'unasked'}
            onClick={() => setSearch({ quoteOutcome: 'unasked' })}
          >
            Sin preguntar
          </Chip>
        </FilterGroup>

        {/*
          `warn`: acota a filas problemáticas. Y el umbral va en la etiqueta
          porque es una deducción nuestra del reloj, no un estado del dominio.
        */}
        <FilterGroup label="Atención">
          <Chip
            tone="warn"
            active={search.quoteUncontacted}
            onClick={() => setSearch({ quoteUncontacted: !search.quoteUncontacted })}
          >
            Sin contactar &gt; {QUOTE_UNCONTACTED_AFTER_HOURS} h
          </Chip>
        </FilterGroup>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          {summary.total === 0
            ? 'Todavía no entró ningún pedido de presupuesto. Cuando alguien pida uno por la app, la web o WhatsApp, aparece acá.'
            : 'Ningún pedido con estos filtros.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <Sort label="Pedido" sortKey="createdAt" search={search} firstClick="asc" />
                <Sort label="Estado" sortKey="status" search={search} />
                <Sort label="Canal" sortKey="channel" search={search} />
                <Sort label="Contacto" sortKey="contact" search={search} />
                <Sort label="Cuenta" sortKey="account" search={search} />
                <Sort label="Vehículo" sortKey="plate" search={search} />
                <TableHead>Descripción</TableHead>
                <Sort label="Monto declarado" sortKey="declaredAmount" search={search} align="right" firstClick="desc" />
                <Sort label="Propuestas" sortKey="proposals" search={search} align="right" firstClick="desc" />
                <Sort label="A contacto" sortKey="toContact" search={search} align="right" firstClick="desc" />
                <Sort label="A respuesta" sortKey="toAnswer" search={search} align="right" firstClick="desc" />
                <TableHead>Resultado (operador)</TableHead>
                <TableHead>Resultado (usuario)</TableHead>
                <Sort label="Notas" sortKey="notes" search={search} align="right" firstClick="desc" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <QuoteRow key={r.id} row={r} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  )
}

function Sort({
  label,
  sortKey,
  search,
  align,
  firstClick = 'asc',
}: {
  label: string
  sortKey: QuoteSortKey
  search: QuoteRequestSearch
  align?: 'right'
  firstClick?: 'asc' | 'desc'
}) {
  return (
    <SortHeader
      label={label}
      sortKey={sortKey}
      active={search.sort === sortKey}
      dir={search.dir}
      to="/leads/pedidos"
      align={align}
      firstClick={firstClick}
    />
  )
}

/**
 * Los cuatro estados SIEMPRE, incluso en cero, y sin los filtros de abajo — es
 * el panorama, no el resultado del filtro. Mismo criterio que `/leads/seguros`.
 *
 * "Cerrados" lleva adentro cuántos cerró la PERSONA: `closed` mezcla "el
 * operador terminó el caso" con "el usuario se fue solo", y leídas juntas las
 * dos cosas dicen nada. "Sin contactar" es ámbar y no rojo: es nuestra lectura
 * del reloj, algo para mirar, no un fracaso.
 */
function SummaryTiles({ summary }: { summary: QuoteRequestStatusSummary }) {
  const tiles: ReadonlyArray<{ label: string; value: number; sub?: string; warn?: boolean }> = [
    { label: 'Recibidos', value: summary.byStatus.received },
    { label: 'Contactados', value: summary.byStatus.contacted },
    { label: 'Respondidos', value: summary.byStatus.answered },
    {
      label: 'Cerrados',
      value: summary.byStatus.closed,
      sub: `${formatInt(summary.cancelledByUser)} cancelados por el usuario`,
    },
    {
      label: `Sin contactar > ${QUOTE_UNCONTACTED_AFTER_HOURS} h`,
      value: summary.uncontacted,
      warn: summary.uncontacted > 0,
    },
  ]

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {tiles.map((t) => (
        <div
          key={t.label}
          className={cn(
            'rounded-lg border p-4',
            t.warn ? 'border-status-yellow/30 bg-status-yellow-bg' : 'border-border bg-card',
          )}
        >
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t.label}</div>
          <div className="mt-1 font-heading text-2xl font-bold tracking-tight tabular-nums">
            {formatInt(t.value)}
          </div>
          {t.sub ? <div className="mt-0.5 text-xs text-muted-foreground">{t.sub}</div> : null}
        </div>
      ))}
    </div>
  )
}

/** "hace 5 h" / "hace 3 d". Lectura del reloj de Postgres, no del navegador. */
function ageLabel(hours: number): string {
  return hours < 48 ? `hace ${formatInt(hours)} h` : `hace ${formatInt(Math.floor(hours / 24))} d`
}

function Muted({ children = '—' }: { children?: string }) {
  return <span className="text-muted-foreground/50">{children}</span>
}

function QuoteRow({ row }: { row: QuoteRequestListItem }) {
  const cancelledByUser = row.closeReasonCode === 'cancelled_by_user'

  return (
    <TableRow className={cn(row.status === 'closed' && 'opacity-70')}>
      <TableCell className="whitespace-nowrap">
        <Link
          to="/leads/pedidos/$quoteRequestId"
          params={{ quoteRequestId: row.id }}
          className="rounded font-mono font-semibold tracking-wide text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {quotePublicCode(row.publicNumber)}
        </Link>
        <div className="text-xs tabular-nums text-muted-foreground">{formatDateTime(row.createdAt)} UTC</div>
        <div className="text-xs text-muted-foreground">{ageLabel(row.ageHours)}</div>
      </TableCell>

      <TableCell>
        <QuoteStatusBadge status={row.status} />
        {row.closeReasonCode ? (
          <div className={cn('mt-1 text-xs', cancelledByUser ? 'text-foreground' : 'text-muted-foreground')}>
            {quoteCloseReasonLabel(row.closeReasonCode)}
            {cancelledByUser && row.cancellationReason
              ? ` · ${quoteCancellationReasonLabel(row.cancellationReason)}`
              : ''}
          </div>
        ) : null}
        {row.uncontacted ? (
          <div className="mt-1 text-xs font-medium text-status-yellow">sin contactar</div>
        ) : null}
      </TableCell>

      <TableCell className="whitespace-nowrap">{quoteChannelLabel(row.channel)}</TableCell>

      <TableCell>
        <div>{row.contactName ?? <Muted>sin nombre</Muted>}</div>
        <div className="font-mono text-xs tabular-nums text-muted-foreground">{row.contactPhone}</div>
        <QuoteWhatsAppLink phone={row.contactPhone} publicNumber={row.publicNumber} contactName={row.contactName} />
        {row.contactEmail ? <div className="truncate text-xs text-muted-foreground">{row.contactEmail}</div> : null}
      </TableCell>

      {/*
        La cuenta de AutoLibre, si hay. "anónimo" no es un error: web y WhatsApp
        no tienen cuenta, y un POST público con `channel = app` tampoco.
      */}
      <TableCell>
        {row.userId ? (
          <Link to="/usuarios/$userId" params={{ userId: row.userId }} className="text-brand hover:underline">
            {row.userEmail ?? row.userId}
          </Link>
        ) : (
          <Muted>anónimo</Muted>
        )}
      </TableCell>

      <TableCell>
        <span className="font-mono font-semibold tracking-wider">{row.plate}</span>
        {row.vehicleId ? (
          <>
            {row.catalogLabel ? <div className="text-xs text-muted-foreground">{row.catalogLabel}</div> : null}
            <QuoteVehicleWarnings row={row} />
          </>
        ) : (
          <div className="text-xs text-muted-foreground/70">sin vehículo vinculado</div>
        )}
      </TableCell>

      <TableCell className="max-w-[18rem]" title={row.description}>
        <p className="line-clamp-2 text-sm text-muted-foreground">{row.description}</p>
      </TableCell>

      {/*
        `formatArs` corta centavos: la columna es `numeric(12,2)` pero es lo que
        la persona DICE que le cotizaron, no un monto contable. Sin columna de
        moneda en la base: se asume ARS.
      */}
      <TableCell className="text-right tabular-nums">
        {row.declaredAmount === null ? <Muted /> : formatArs(row.declaredAmount)}
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {row.proposalsCount === null ? <Muted /> : formatInt(row.proposalsCount)}
      </TableCell>

      <TableCell className="whitespace-nowrap text-right tabular-nums">
        {row.minutesToContact === null ? <Muted /> : formatMinutes(row.minutesToContact)}
      </TableCell>

      <TableCell className="whitespace-nowrap text-right tabular-nums">
        {row.minutesToAnswer === null ? <Muted /> : formatMinutes(row.minutesToAnswer)}
      </TableCell>

      {/*
        Dos columnas y no una: el operador le pregunta a la persona (`outcome`) y
        la persona declara sola desde la app (`user_outcome`). Pueden no
        coincidir, y esa discrepancia es un dato. `null` en el del operador es
        "todavía no se preguntó" — NO es "No respondió".
      */}
      <TableCell className="whitespace-nowrap">
        {row.outcome ? quoteOutcomeLabel(row.outcome) : <Muted>sin preguntar</Muted>}
      </TableCell>

      <TableCell className="whitespace-nowrap">
        {row.userOutcome ? quoteUserOutcomeLabel(row.userOutcome) : <Muted />}
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {row.noteCount === 0 ? <Muted>0</Muted> : formatInt(row.noteCount)}
      </TableCell>
    </TableRow>
  )
}
