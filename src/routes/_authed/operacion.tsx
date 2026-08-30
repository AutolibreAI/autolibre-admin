import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { AlertCircle, Clock, Plus, Trash2 } from 'lucide-react'
import {
  OPS_WINDOWS,
  OPS_WINDOW_LABELS,
  QUEUE_LABELS,
  QUEUE_TABLES,
  opsSearchSchema,
  type CatalogGap,
  type ExcludedDomain,
  type FailureReason,
  type OpsWindow,
  type QueueHealth,
} from '~/lib/ops'
import {
  deleteExcludedDomain,
  getCatalogGaps,
  getExcludedDomains,
  getFailureReasons,
  getQueueHealth,
  saveExcludedDomain,
} from '~/fn/ops'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
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

/**
 * Operación — las colas del sistema y sus fallas.
 *
 * Qué reemplaza: los cuatro `select status, count(*) … group by 1` que hoy hay
 * que correr uno por uno en DBeaver para saber si algo se colgó, más el
 * `select failure_reason, …` que es lo segundo que uno escribe cuando el
 * primero da rojo.
 *
 * Lo que esta pantalla NO hace, a propósito: reintentar, reencolar ni cancelar
 * nada. Muestra el problema y dice en qué tabla está. Mover estado del dominio
 * es del backend con su TDD; un UPDATE lanzado desde el panel es exactamente el
 * problema que este repo existe para matar.
 */
export const Route = createFileRoute('/_authed/operacion')({
  /**
   * SSR MODE: 'data-only'.
   *
   * El loader corre igual en el servidor durante el pedido del documento y su
   * resultado se serializa en el HTML — no hay waterfall ni flash de carga
   * después de hidratar. Lo que se saltea es RENDERIZAR este componente en el
   * servidor.
   *
   * Por qué el trade cierra acá:
   *  - Está detrás de auth, así que ningún crawler la ve. El markup
   *    server-rendered no compra nada de SEO ni de preview de link.
   *  - Quien llega ya está adentro de un shell hidratado, así que el markup
   *    pre-renderizado casi no mueve el primer pintado.
   *  - Es markup pesado en relación a su dato: cuatro tarjetas, tres tablas y
   *    un formulario sobre unas pocas decenas de filas. Renderizarlo en el
   *    servidor gasta CPU y bytes en nodos que se reconcilian de inmediato.
   *
   * El inverso vale para /solicitudes y /partners, que son contenido y suelen
   * ser el primer pintado de una sesión: esas se quedan en SSR completo.
   */
  ssr: 'data-only',

  validateSearch: opsSearchSchema,
  loaderDeps: ({ search }) => search,

  /**
   * Cuatro consultas, un solo `Promise.all`.
   *
   * No se transmite nada acá — a diferencia de Inicio, ninguna de las cuatro es
   * notoriamente más cara que las otras, y con `ssr: 'data-only'` no hay markup
   * progresivo que ganar. Un `Await` sería una frontera de Suspense sin nada
   * del otro lado.
   */
  loader: async ({ deps, abortController }) => {
    const signal = abortController.signal
    const [queues, failures, gaps, domains] = await Promise.all([
      getQueueHealth({ signal }),
      getFailureReasons({ data: deps, signal }),
      getCatalogGaps({ data: deps, signal }),
      getExcludedDomains({ signal }),
    ])
    return { queues, failures, gaps, domains }
  },

  head: () => ({ meta: [{ title: 'Operación — AutoLibre' }] }),
  component: Operacion,
})

function Operacion() {
  const { queues, failures, gaps, domains } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <>
      <PageHeader
        title="Operación"
        subtitle="Colas asincrónicas, fallas y huecos de catálogo."
        actions={<SsrTag>ssr: data-only</SsrTag>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Ventana
        </span>
        {OPS_WINDOWS.map((w) => (
          <WindowChip
            key={w}
            active={search.window === w}
            onClick={() => navigate({ search: { window: w }, replace: true })}
          >
            {OPS_WINDOW_LABELS[w]}
          </WindowChip>
        ))}
      </div>

      <QueueGrid queues={queues} />

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Motivos de falla</CardTitle>
          </CardHeader>
          <CardContent>
            <FailureTable rows={failures} window={search.window} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Patentes que el catálogo no resolvió</CardTitle>
          </CardHeader>
          <CardContent>
            <GapTable rows={gaps} window={search.window} />
          </CardContent>
        </Card>
      </div>

      <DomainsCard domains={domains} />
    </>
  )
}

function WindowChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-md border px-2.5 py-1 text-xs transition-colors',
        active
          ? 'border-transparent bg-primary text-primary-foreground'
          : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

// ── Colas ────────────────────────────────────────────────────────────────────

/**
 * Las cuatro tarjetas siempre están, incluso en cero.
 *
 * Es la decisión inversa a la lista de "qué hay que arreglar" de Inicio, y a
 * propósito: allá una fila en cero es ruido porque la lista es de pendientes.
 * Acá la ausencia de una cola no se puede distinguir de "esa cola está sana" si
 * la tarjeta desaparece — y "no hay notificaciones registradas" es un dato
 * distinto de "todas salieron bien".
 */
function QueueGrid({ queues }: { queues: Array<QueueHealth> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {queues.map((q) => {
        const broken = q.failed > 0 || q.stuck > 0 || q.retrying > 0
        return (
          <div
            key={q.key}
            className={cn(
              'rounded-lg border p-4',
              q.stuck > 0 || q.retrying > 0
                ? 'border-destructive/30 bg-status-red-bg'
                : q.failed > 0
                  ? 'border-status-yellow/30 bg-status-yellow-bg'
                  : 'border-border bg-card',
            )}
          >
            <div className="flex items-center gap-2 text-muted-foreground">
              {broken ? (
                <AlertCircle className="size-4 shrink-0" aria-hidden />
              ) : (
                <Clock className="size-4 shrink-0" aria-hidden />
              )}
              <span className="text-xs font-medium uppercase tracking-wider">
                {QUEUE_LABELS[q.key]}
              </span>
            </div>

            <div className="mt-2 font-heading text-2xl font-bold tracking-tight">
              {formatInt(q.total)}
            </div>

            <dl className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              <div className="flex justify-between gap-2">
                <dt>Completadas</dt>
                <dd className="tabular-nums">{formatInt(q.ok)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Fallidas</dt>
                <dd className={cn('tabular-nums', q.failed > 0 && 'font-medium text-foreground')}>
                  {formatInt(q.failed)}
                </dd>
              </div>
              {/*
                `stuck` cuenta lo que ARRANCÓ y NUNCA se intentó. Un `failed`
                avisa; un colgado no avisa nunca — se queda ahí, y sin esta
                pantalla se descubre cuando un usuario reclama.
              */}
              <div className="flex justify-between gap-2">
                <dt>Sin intentar (+{q.stuckAfterMinutes} min)</dt>
                <dd className={cn('tabular-nums', q.stuck > 0 && 'font-medium text-destructive')}>
                  {formatInt(q.stuck)}
                </dd>
              </div>
              {/*
                Fila condicional, no una fila en cero: hoy sólo `notifications`
                tiene reintento automático, y mostrar "Reintentando: 0" en las
                otras tres sugeriría que ahí también hay uno.
              */}
              {q.retrying > 0 ? (
                <div className="flex justify-between gap-2">
                  <dt title="El backend la reintenta cada minuto y no hay tope de intentos.">
                    Reintento sin tope
                  </dt>
                  <dd className="tabular-nums font-medium text-destructive">
                    {formatInt(q.retrying)}
                  </dd>
                </div>
              ) : null}
            </dl>

            <p className="mt-2 truncate border-t border-border pt-2 font-mono text-[10px] text-muted-foreground">
              {QUEUE_TABLES[q.key]}
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {q.lastEventAt ? `Último: ${formatDate(q.lastEventAt)}` : 'Sin eventos registrados'}
            </p>
          </div>
        )
      })}
    </div>
  )
}

// ── Fallas ───────────────────────────────────────────────────────────────────

function FailureTable({
  rows,
  window,
}: {
  rows: Array<FailureReason>
  window: OpsWindow
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Ninguna falla registrada en la ventana ({OPS_WINDOW_LABELS[window].toLowerCase()}).
      </p>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Motivo</TableHead>
          <TableHead>Cola</TableHead>
          <TableHead className="text-right">Veces</TableHead>
          <TableHead className="text-right">Última</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={`${r.queue}:${r.reason}`}>
            {/*
              El motivo es texto del proveedor y puede ser largo. Se trunca con
              `title` para el detalle completo: una celda de 400 caracteres
              rompe la tabla y esconde las tres columnas que siguen.
            */}
            <TableCell className="max-w-[18rem] truncate" title={r.reason}>
              {r.reason}
            </TableCell>
            <TableCell className="text-muted-foreground">{QUEUE_LABELS[r.queue]}</TableCell>
            <TableCell className="text-right tabular-nums">{formatInt(r.count)}</TableCell>
            <TableCell className="text-right text-muted-foreground">
              {r.lastAt ? formatDate(r.lastAt) : '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

// ── Huecos de catálogo ───────────────────────────────────────────────────────

function GapTable({ rows, window }: { rows: Array<CatalogGap>; window: OpsWindow }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Ninguna búsqueda sin resultado en la ventana ({OPS_WINDOW_LABELS[window].toLowerCase()}).
      </p>
    )
  }

  return (
    <>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        Cada fila es un auto que alguien quiso cargar y el catálogo no supo resolver. Es una lista
        de trabajo, no una métrica.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Patente</TableHead>
            <TableHead>Provincia</TableHead>
            <TableHead className="text-right">Intentos</TableHead>
            <TableHead className="text-right">Último</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((g) => (
            <TableRow key={`${g.plate}:${g.state ?? ''}`}>
              <TableCell className="font-mono uppercase">{g.plate}</TableCell>
              <TableCell className="text-muted-foreground">{g.state ?? '—'}</TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(g.times)}</TableCell>
              <TableCell className="text-right text-muted-foreground">
                {formatDate(g.lastAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  )
}

// ── Dominios excluidos: la única escritura de la pantalla ────────────────────

/**
 * La acción ejecutable del panel.
 *
 * Se puede porque `ops` es NUESTRO schema y porque esto no decide nada del
 * negocio: no cambia lo que la app hace, cambia a quién cuentan las métricas de
 * este panel. Mover estado del dominio (aprobar, pausar, reintentar) sigue
 * siendo del backend.
 *
 * `router.invalidate()` en vez de estado local: el número de usuarios ocultos
 * lo calcula Postgres, así que después de escribir hay que volver a preguntar.
 * Mantener una copia en el cliente sería inventar un dato que la base ya sabe.
 */
function DomainsCard({ domains }: { domains: Array<ExcludedDomain> }) {
  const router = useRouter()
  const [domain, setDomain] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      await router.invalidate()
    } catch (cause) {
      // El mensaje del zod del server function es el útil ("Escribí solo el
      // dominio…"). Mostrarlo crudo es mejor que un "algo salió mal" genérico.
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mt-5">
      <CardHeader>
        <CardTitle className="text-base">Dominios internos excluidos de las métricas</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
          Un email cuyo dominio esté en esta lista no cuenta como usuario real, ni acá ni en{' '}
          <Link to="/ai-costos" className="text-brand hover:underline">
            Costos de IA
          </Link>
          . Es el mismo criterio en las dos pantallas, a propósito. Un dominio que oculta 0 usuarios
          está mal escrito.
        </p>

        {domains.length > 0 ? (
          <Table className="mb-4">
            <TableHeader>
              <TableRow>
                <TableHead>Dominio</TableHead>
                <TableHead>Nota</TableHead>
                <TableHead className="text-right">Oculta</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {domains.map((d) => (
                <TableRow key={d.domain}>
                  <TableCell className="font-mono">{d.domain}</TableCell>
                  <TableCell className="max-w-[24rem] truncate text-muted-foreground" title={d.note ?? ''}>
                    {d.note ?? '—'}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular-nums',
                      d.users === 0 && 'text-status-yellow',
                    )}
                  >
                    {formatInt(d.users)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Quitar ${d.domain}`}
                      onClick={() => run(() => deleteExcludedDomain({ data: { domain: d.domain } }))}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="mb-4 text-sm text-muted-foreground">
            No hay dominios excluidos: todas las cuentas cuentan como reales.
          </p>
        )}

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!domain.trim()) return
            void run(async () => {
              await saveExcludedDomain({ data: { domain, note: note.trim() || undefined } })
              setDomain('')
              setNote('')
            })
          }}
        >
          <div className="space-y-1.5">
            <label
              htmlFor="domain"
              className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              Dominio
            </label>
            <Input
              id="domain"
              value={domain}
              onChange={(e) => setDomain(e.currentTarget.value)}
              placeholder="ejemplo.com"
              className="w-56 font-mono"
              autoComplete="off"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="note"
              className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              Nota
            </label>
            <Input
              id="note"
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
              placeholder="Por qué se excluye"
              className="w-72"
              autoComplete="off"
            />
          </div>

          <Button type="submit" size="sm" disabled={busy || !domain.trim()} className="gap-1.5">
            <Plus className="size-3.5" aria-hidden />
            {busy ? 'Guardando…' : 'Excluir'}
          </Button>
        </form>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
