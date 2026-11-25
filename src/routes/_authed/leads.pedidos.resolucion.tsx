import { useRef, useState, type ReactNode } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowLeft, Download, Users } from 'lucide-react'
import {
  QUOTE_REQUEST_CHANNELS,
  QUOTE_REQUEST_OUTCOMES,
  QUOTE_REQUEST_USER_OUTCOMES,
  quoteChannelLabel,
  quoteCloseReasonLabel,
  quoteOutcomeLabel,
  quotePublicCode,
  quoteUserOutcomeLabel,
  formatPlainDay,
  readableQuoteRequestError,
} from '~/lib/quote-requests'
import {
  QUOTE_RESOLUTION_EXPORT_LIMIT,
  QUOTE_RESOLUTION_LIST_LIMIT,
  QUOTE_RESOLUTION_SERVICES_SOURCE_LABELS,
  buenosAiresDateTime,
  quoteResolutionCsv,
  quoteResolutionSearchSchema,
  type QuoteResolutionPartnerOption,
  type QuoteResolutionRow,
  type QuoteResolutionSearch,
  type QuoteResolutionSortKey,
} from '~/lib/quote-resolution'
import { userOutcomeReporterLabel } from '~/lib/quote-user-flow'
import { exportQuoteResolutionFn, listQuoteResolutionFn } from '~/fn/quote-resolution'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup, RangeFilter } from '~/components/Filters'
import { SortHeader } from '~/components/SortHeader'
import { QuoteRequestsUnavailable } from '~/components/QuoteRequestsUnavailable'
import { QuoteStatusBadge } from '~/components/QuoteRequestCells'
import { Button } from '~/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * «Resolución de pedidos» — una fila por pedido (app, web y WhatsApp; con
 * cuenta y sin ella) con cómo terminó. → `~/lib/quote-resolution`,
 * `.claude/rules/quote-proposals.md`
 *
 * ── Qué reemplaza ───────────────────────────────────────────────────────────
 *
 * La planilla de «¿cómo terminó cada pedido?» que se armaba a mano abriendo
 * ficha por ficha: el resultado que dio la persona, el que registró el equipo
 * al cerrar, el taller elegido y la nota. Ningún `select` lo daba junto.
 *
 * ── Dos resultados, dos columnas ───────────────────────────────────────────
 *
 * «Según el cliente» (`user_outcome`) y «según el equipo» (`outcome`) van
 * SEPARADOS a propósito (decisión del 2026-11-25). No se unifican acá.
 *
 * ── Sólo lectura ───────────────────────────────────────────────────────────
 *
 * Elegir la propuesta y declarar si fue se hace desde la ficha (el link de cada
 * fila). Esta pantalla no escribe nada.
 */
export const Route = createFileRoute('/_authed/leads/pedidos/resolucion')({
  /**
   * SSR completo (heredado). Pantalla de CONTENIDO —una tabla de lectura que
   * se abre para revisar y exportar—, mismo criterio que `/leads/pedidos`.
   */
  validateSearch: quoteResolutionSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps, abortController }) =>
    listQuoteResolutionFn({ data: deps, signal: abortController.signal }),
  head: () => ({ meta: [{ title: 'Pedidos · Resolución — AutoLibre' }] }),
  component: ResolutionPage,
})

const SEARCH_KEYS = { sort: 'resSort', dir: 'resDir' }

function ResolutionPage() {
  const result = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const header = (subtitle: string, actions?: ReactNode) => (
    <>
      <Link
        to="/leads/pedidos"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Pedidos
      </Link>
      <PageHeader
        title="Resolución de pedidos"
        subtitle={subtitle}
        actions={
          <>
            {actions}
            <SsrTag>ssr: full</SsrTag>
          </>
        }
      />
    </>
  )

  if (!('rows' in result)) {
    return (
      <>
        {header('Cómo terminó cada pedido.')}
        <QuoteRequestsUnavailable availability={result.availability} />
      </>
    )
  }

  const { rows, truncated, partnerOptions, proposalsAvailable, userFlowAvailable } = result

  const setSearch = (next: Partial<QuoteResolutionSearch>) =>
    navigate({ search: { ...search, ...next }, replace: true, resetScroll: false })

  return (
    <>
      {header(
        truncated
          ? `Se muestran los primeros ${formatInt(QUOTE_RESOLUTION_LIST_LIMIT)} pedidos con este filtro: acotalo, o bajá el CSV, que trae todos.`
          : `${formatInt(rows.length)} ${rows.length === 1 ? 'pedido' : 'pedidos'} con este filtro.`,
        <ExportButton search={search} />,
      )}

      <p className="mb-4 max-w-prose text-sm leading-relaxed text-muted-foreground">
        Una fila por pedido, de todos los canales. «Según el cliente» es lo que dijo la persona (en la app o al
        equipo); «según el equipo» es lo que se registró al cerrar el pedido. Para cargar qué eligió o si fue al
        taller, entrá a la ficha. Fechas en hora de Buenos Aires.
      </p>

      {!proposalsAvailable || !userFlowAvailable ? (
        <p className="mb-4 rounded-md border border-status-yellow/30 bg-status-yellow-bg px-3 py-2 text-xs leading-relaxed text-status-yellow">
          {!proposalsAvailable
            ? 'Esta base no tiene las propuestas del backend (0120–0122): sin cantidad de propuestas ni taller elegido. '
            : ''}
          {!userFlowAvailable
            ? 'Esta base no tiene la migración 0169 del backend: sin fecha del trabajo ni quién informó el resultado.'
            : ''}
        </p>
      ) : null}

      <Filters
        search={search}
        setSearch={setSearch}
        partnerOptions={partnerOptions}
        proposalsAvailable={proposalsAvailable}
      />

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Ningún pedido con estos filtros.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <Sort label="Pedido" sortKey="createdAt" search={search} firstClick="desc" />
                <Sort label="Canal" sortKey="channel" search={search} />
                <Sort label="Contacto" sortKey="contact" search={search} />
                <TableHead>Rubro / servicio</TableHead>
                <Sort label="Propuestas" sortKey="proposals" search={search} align="right" firstClick="desc" />
                <Sort label="Resultado según el cliente" sortKey="userOutcome" search={search} />
                <Sort label="Resultado según el equipo" sortKey="outcome" search={search} />
                <Sort label="Taller elegido" sortKey="partner" search={search} />
                <Sort label="Fecha del trabajo" sortKey="performedOn" search={search} firstClick="desc" />
                <TableHead>Quién informó</TableHead>
                <Sort label="Estado" sortKey="status" search={search} />
                <TableHead>Nota</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <ResolutionRow key={r.id} row={r} />
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
  sortKey: QuoteResolutionSortKey
  search: QuoteResolutionSearch
  align?: 'right'
  firstClick?: 'asc' | 'desc'
}) {
  return (
    <SortHeader
      label={label}
      sortKey={sortKey}
      active={search.resSort === sortKey}
      dir={search.resDir}
      to="/leads/pedidos/resolucion"
      align={align}
      firstClick={firstClick}
      searchKeys={SEARCH_KEYS}
    />
  )
}

// ── Filtros ─────────────────────────────────────────────────────────────────

function Filters({
  search,
  setSearch,
  partnerOptions,
  proposalsAvailable,
}: {
  search: QuoteResolutionSearch
  setSearch: (next: Partial<QuoteResolutionSearch>) => void
  partnerOptions: Array<QuoteResolutionPartnerOption>
  proposalsAvailable: boolean
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-5">
      <FilterGroup label="Canal">
        <Chip active={search.resChannel === 'all'} onClick={() => setSearch({ resChannel: 'all' })}>
          Todos
        </Chip>
        {QUOTE_REQUEST_CHANNELS.map((c) => (
          <Chip key={c} active={search.resChannel === c} onClick={() => setSearch({ resChannel: c })}>
            {quoteChannelLabel(c)}
          </Chip>
        ))}
      </FilterGroup>

      <FilterGroup label="Resultado según el cliente">
        <Chip active={search.resUserOutcome === 'all'} onClick={() => setSearch({ resUserOutcome: 'all' })}>
          Todos
        </Chip>
        {QUOTE_REQUEST_USER_OUTCOMES.map((o) => (
          <Chip key={o} active={search.resUserOutcome === o} onClick={() => setSearch({ resUserOutcome: o })}>
            {quoteUserOutcomeLabel(o)}
          </Chip>
        ))}
        <Chip
          active={search.resUserOutcome === 'undeclared'}
          onClick={() => setSearch({ resUserOutcome: 'undeclared' })}
        >
          No declaró
        </Chip>
      </FilterGroup>

      <FilterGroup label="Resultado según el equipo">
        <Chip active={search.resOutcome === 'all'} onClick={() => setSearch({ resOutcome: 'all' })}>
          Todos
        </Chip>
        {QUOTE_REQUEST_OUTCOMES.map((o) => (
          <Chip key={o} active={search.resOutcome === o} onClick={() => setSearch({ resOutcome: o })}>
            {quoteOutcomeLabel(o)}
          </Chip>
        ))}
        <Chip active={search.resOutcome === 'unasked'} onClick={() => setSearch({ resOutcome: 'unasked' })}>
          Sin registrar
        </Chip>
      </FilterGroup>

      {/* Sin propuestas en la base no hay taller elegido: el filtro no se ofrece y el servidor lo ignora. */}
      {proposalsAvailable ? (
        <div className="space-y-1.5">
          <span className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Taller elegido
          </span>
          <Select value={search.resPartner} onValueChange={(v) => setSearch({ resPartner: v })}>
            <SelectTrigger className="h-8 w-56" aria-label="Taller elegido">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="none">Sin taller elegido</SelectItem>
              <SelectItem value="external">Taller de afuera del directorio</SelectItem>
              {partnerOptions.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <RangeFilter
        label="Fecha del pedido"
        type="date"
        min={search.resFrom}
        max={search.resTo}
        onCommit={({ min, max }) => setSearch({ resFrom: min, resTo: max })}
      />

      <FilterGroup label="Atención">
        <Chip
          tone="warn"
          active={search.resIncompleteFlow}
          onClick={() => setSearch({ resIncompleteFlow: !search.resIncompleteFlow })}
        >
          Flujo incompleto (respondido, sin decir si fue)
        </Chip>
      </FilterGroup>

      <FilterGroup label="Descartados">
        <Chip
          active={search.resShowDuplicates}
          onClick={() => setSearch({ resShowDuplicates: !search.resShowDuplicates })}
        >
          Incluir duplicados / prueba
        </Chip>
      </FilterGroup>
    </div>
  )
}

// ── Export ──────────────────────────────────────────────────────────────────

/**
 * Baja lo filtrado ENTERO (no sólo lo de la pantalla), con un techo de
 * `QUOTE_RESOLUTION_EXPORT_LIMIT`. El CSV se arma en el navegador: el server
 * function devuelve filas, no un archivo.
 */
function ExportButton({ search }: { search: QuoteResolutionSearch }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const inFlight = useRef(false)

  async function download() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setMessage(null)
    try {
      const { rows, truncated } = await exportQuoteResolutionFn({ data: search })
      const csv = quoteResolutionCsv(rows, window.location.origin)
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `resolucion-pedidos-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      if (truncated)
        setMessage(`El CSV trae los primeros ${formatInt(QUOTE_RESOLUTION_EXPORT_LIMIT)}: acotá el filtro para el resto.`)
    } catch (cause) {
      setMessage(readableQuoteRequestError(cause))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void download()} className="gap-1.5">
        <Download className="size-3.5" aria-hidden />
        {busy ? 'Armando el CSV…' : 'Bajar CSV'}
      </Button>
      {message ? <span className="max-w-xs text-right text-xs text-muted-foreground">{message}</span> : null}
    </div>
  )
}

// ── Fila ────────────────────────────────────────────────────────────────────

function Muted({ children = '—' }: { children?: string }) {
  return <span className="text-muted-foreground/50">{children}</span>
}

function ResolutionRow({ row: r }: { row: QuoteResolutionRow }) {
  return (
    <TableRow className={cn(r.status === 'closed' && 'opacity-80')}>
      <TableCell className="whitespace-nowrap">
        <Link
          to="/leads/pedidos/$quoteRequestId"
          params={{ quoteRequestId: r.id }}
          className="rounded font-mono font-semibold tracking-wide text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {quotePublicCode(r.publicNumber)}
        </Link>
        <div className="text-xs tabular-nums text-muted-foreground">{buenosAiresDateTime(r.createdAt)}</div>
      </TableCell>

      <TableCell className="whitespace-nowrap">
        {quoteChannelLabel(r.channel)}
        <div className="text-xs text-muted-foreground">
          {r.hasAccount ? 'con cuenta' : 'sin cuenta'}
          {r.enteredManually ? ' · cargado a mano' : ''}
        </div>
      </TableCell>

      <TableCell className="max-w-[12rem]">
        {r.contactName ? <div className="truncate">{r.contactName}</div> : null}
        {r.contactPhone ? (
          <div className="truncate text-xs tabular-nums text-muted-foreground">{r.contactPhone}</div>
        ) : null}
        {!r.contactName && !r.contactPhone ? <Muted /> : null}
      </TableCell>

      <TableCell className="max-w-[14rem]">
        {r.services.length > 0 ? (
          <>
            <div className="line-clamp-2 text-sm">{r.services.join(', ')}</div>
            {r.servicesSource ? (
              <div className="text-xs text-muted-foreground">{QUOTE_RESOLUTION_SERVICES_SOURCE_LABELS[r.servicesSource]}</div>
            ) : null}
          </>
        ) : (
          <Muted>sin clasificar</Muted>
        )}
      </TableCell>

      <TableCell className="text-right tabular-nums">
        {r.activeProposals === null ? <Muted /> : formatInt(r.activeProposals)}
      </TableCell>

      <TableCell className="whitespace-nowrap">
        {r.userOutcome ? quoteUserOutcomeLabel(r.userOutcome) : <Muted>No declaró</Muted>}
      </TableCell>

      <TableCell className="whitespace-nowrap">
        {r.outcome ? quoteOutcomeLabel(r.outcome) : <Muted>Sin registrar</Muted>}
      </TableCell>

      <TableCell className="max-w-[12rem]">
        {r.selectedProviderName === null ? (
          <Muted />
        ) : r.selectedPartnerId ? (
          <Link
            to="/partners/$partnerId"
            params={{ partnerId: r.selectedPartnerId }}
            className="truncate text-brand hover:underline"
          >
            {r.selectedProviderName}
          </Link>
        ) : (
          <>
            <div className="truncate">{r.selectedProviderName}</div>
            <div className="text-xs text-muted-foreground">de afuera del directorio</div>
          </>
        )}
      </TableCell>

      <TableCell className="whitespace-nowrap tabular-nums">
        {r.performedOn ? formatPlainDay(r.performedOn) : <Muted />}
      </TableCell>

      <TableCell className="max-w-[12rem] text-xs">
        {r.reporter.kind === 'operator' ? (
          <span className="flex items-start gap-1 text-status-yellow">
            <Users className="mt-0.5 size-3 shrink-0" aria-hidden />
            {userOutcomeReporterLabel(r.reporter)}
          </span>
        ) : r.reporter.kind === 'none' ? (
          <Muted />
        ) : (
          <span className="text-muted-foreground">{userOutcomeReporterLabel(r.reporter)}</span>
        )}
      </TableCell>

      <TableCell className="whitespace-nowrap">
        <QuoteStatusBadge status={r.status} />
        {r.closeReasonCode ? (
          <div className="mt-1 text-xs text-muted-foreground">{quoteCloseReasonLabel(r.closeReasonCode)}</div>
        ) : null}
      </TableCell>

      <TableCell className="max-w-[16rem]">
        {r.outcomeNote ? <p className="line-clamp-3 whitespace-pre-wrap text-xs">{r.outcomeNote}</p> : <Muted />}
      </TableCell>
    </TableRow>
  )
}
