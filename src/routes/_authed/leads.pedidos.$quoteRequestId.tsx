import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import {
  formatMinutes,
  parseInternalNotes,
  quoteCancellationReasonLabel,
  quoteChannelLabel,
  quoteCloseReasonLabel,
  quoteOutcomeLabel,
  quotePublicCode,
  quoteRequestIdSchema,
  quoteUserOutcomeLabel,
  type QuoteRequestDetail,
} from '~/lib/quote-requests'
import { getQuoteRequestFn } from '~/fn/quote-requests'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { QuoteRequestsUnavailable } from '~/components/QuoteRequestsUnavailable'
import { QuoteVehicleWarnings } from '~/components/QuoteRequestCells'
import { QuoteStatusControl } from '~/components/QuoteStatusControl'
import { QuoteTemplates } from '~/components/QuoteTemplates'
import { Card, CardContent } from '~/components/ui/card'
import { formatArs, formatDateTime, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { ReactNode } from 'react'

/**
 * Un pedido de presupuesto, entero.
 *
 * Reemplaza el `select * from quote_requests where id = '…'` que el operador
 * corre en DBeaver para ver un pedido antes de llamar — con lo que ese select no
 * contesta solo: en qué orden pasaron las cosas, las notas como hilo, y si el
 * vehículo que se vinculó es de verdad de esa persona.
 *
 * `<QuoteTemplates detail={d}/>` es texto para copiar y pegar al contactar,
 * completado con los datos DE ESTE pedido — no vive en el listado porque no
 * tiene sentido sin un pedido puntual al que referirse. → `~/lib/quote-templates`.
 *
 * `<QuoteStatusControl/>` en el campo "Estado" cambia `status` vía
 * `ops.advance_quote_request` (migración 011) — mismo componente que usa la
 * fila del listado. → `.claude/rules/leads.md`.
 */
export const Route = createFileRoute('/_authed/leads/pedidos/$quoteRequestId')({
  /**
   * SSR completo (heredado). Es una ficha de CONTENIDO que se abre desde un
   * link pegado en un chat de equipo ("mirá AL-1042") y tiene que llegar
   * pintada. Mismo criterio que `/chats/:id` y `/usuarios/:id`.
   */
  loader: async ({ params, abortController }) => {
    // `parse` acá además del validator del server function: un id que no es
    // uuid es un 404 de la PANTALLA, no un 500 de validación.
    if (!quoteRequestIdSchema.safeParse(params).success) throw notFound()

    const result = await getQuoteRequestFn({ data: params, signal: abortController.signal }).catch(
      (cause: unknown) => {
        if (cause instanceof Error && cause.message.startsWith('NOT_FOUND:')) return null
        throw cause
      },
    )
    if (!result) throw notFound()
    return result
  },

  head: ({ loaderData }) => ({
    meta: [
      {
        title:
          loaderData && 'detail' in loaderData
            ? `${quotePublicCode(loaderData.detail.publicNumber)} — Pedidos`
            : 'Pedido — Pedidos',
      },
    ],
  }),

  component: QuoteRequestScreen,
})

function QuoteRequestScreen() {
  const result = Route.useLoaderData()

  const back = (
    <Link
      to="/leads/pedidos"
      className="mb-3 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <ArrowLeft className="size-3.5" aria-hidden />
      Pedidos de presupuesto
    </Link>
  )

  if (!('detail' in result)) {
    return (
      <>
        {back}
        <PageHeader title="Pedido de presupuesto" actions={<SsrTag>ssr: full</SsrTag>} />
        <QuoteRequestsUnavailable availability={result.availability} />
      </>
    )
  }

  const d = result.detail

  return (
    <>
      {back}

      <PageHeader
        title={`${quotePublicCode(d.publicNumber)} · Pedido de presupuesto`}
        subtitle={`Por ${quoteChannelLabel(d.channel)}${d.enteredManually ? ' · cargado a mano' : ''} · recibido ${formatDateTime(d.createdAt)} UTC · actualizado ${formatDateTime(d.updatedAt)} UTC`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <p className="mb-5 max-w-prose text-sm leading-relaxed text-muted-foreground">
        El estado se cambia desde la tarjeta de abajo. Agregar una nota interna se sigue haciendo con el
        script SQL de <code className="font-mono">autolibre-backend-hex/scripts/sql/</code>.
      </p>

      <QuoteTemplates detail={d} />

      <Card className="mb-4">
        <CardContent className="pt-6">
          <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Estado">
              <QuoteStatusControl
                quoteRequestId={d.id}
                status={d.status}
                proposalsCount={d.proposalsCount}
              />
              {d.uncontacted ? (
                <div className="mt-1 text-xs font-medium text-status-yellow">
                  sin contactar hace {formatInt(d.ageHours)} h (lectura del reloj)
                </div>
              ) : null}
            </Field>
            <Field label="Propuestas devueltas">
              <span className="text-sm tabular-nums">
                {d.proposalsCount === null ? '—' : formatInt(d.proposalsCount)}
              </span>
            </Field>
            {/*
              Dos resultados y no uno: el del operador (le preguntó) y el que
              declaró la persona desde la app. `null` del operador es "todavía no
              se preguntó", que NO es "No respondió".
            */}
            <Field label="Resultado (operador)">
              <span className="text-sm">
                {d.outcome ? (
                  quoteOutcomeLabel(d.outcome)
                ) : (
                  <span className="text-muted-foreground">Todavía no se preguntó</span>
                )}
              </span>
            </Field>
            <Field label="Resultado (usuario)">
              <span className="text-sm">
                {d.userOutcome ? (
                  quoteUserOutcomeLabel(d.userOutcome)
                ) : (
                  <span className="text-muted-foreground">No declaró</span>
                )}
              </span>
            </Field>
          </div>
        </CardContent>
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardContent className="space-y-4 pt-6">
            <SectionTitle>Contacto</SectionTitle>
            <Field label="Nombre">
              <span className="text-sm">{d.contactName ?? <span className="text-muted-foreground">sin nombre</span>}</span>
            </Field>
            <Field label="Teléfono">
              <span className="font-mono text-sm tabular-nums">{d.contactPhone}</span>
            </Field>
            <Field label="Email">
              <span className="text-sm">{d.contactEmail ?? <span className="text-muted-foreground">—</span>}</span>
            </Field>
            <Field label="Cuenta de AutoLibre">
              {d.userId ? (
                <Link to="/usuarios/$userId" params={{ userId: d.userId }} className="text-sm text-brand hover:underline">
                  {d.userEmail ?? d.userId}
                </Link>
              ) : (
                <span className="text-sm text-muted-foreground">
                  Anónimo — {d.channel === 'app' ? 'entró por el endpoint público' : `los pedidos por ${quoteChannelLabel(d.channel)} no tienen cuenta`}
                </span>
              )}
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 pt-6">
            <SectionTitle>Vehículo</SectionTitle>
            <Field label="Patente que escribió la persona">
              <span className="font-mono font-semibold tracking-wider">{d.plate}</span>
            </Field>
            <Field label="Vehículo vinculado por el operador">
              {d.vehicleId ? (
                <div className="text-sm">
                  <span className="font-mono font-semibold tracking-wider">{d.vehiclePlate ?? '—'}</span>
                  {d.vehicleArchived ? (
                    <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">archivado</span>
                  ) : null}
                  <div className="text-xs text-muted-foreground">{d.catalogLabel ?? 'sin modelo de catálogo'}</div>
                  <QuoteVehicleWarnings row={d} />
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">Ninguno todavía</span>
              )}
            </Field>
            {d.vehicleId ? (
              <Field label="Dueño del vehículo">
                {d.vehicleOwnerId ? (
                  <Link
                    to="/usuarios/$userId"
                    params={{ userId: d.vehicleOwnerId }}
                    className={cn('text-sm hover:underline', d.vehicleOwnerMismatch ? 'text-status-yellow' : 'text-brand')}
                  >
                    {d.vehicleOwnerEmail ?? d.vehicleOwnerId}
                  </Link>
                ) : (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </Field>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 pt-6">
            <SectionTitle>Pedido</SectionTitle>
            <Field label="Descripción">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{d.description}</p>
            </Field>
            <Field label="Monto declarado">
              {d.declaredAmount === null ? (
                <span className="text-sm text-muted-foreground">No declaró</span>
              ) : (
                <>
                  <span className="text-sm tabular-nums">{formatArs(d.declaredAmount)}</span>
                  <div className="text-xs text-muted-foreground">
                    Lo que dice que le cotizaron en otro lado. No hay columna de moneda: se asume ARS.
                  </div>
                </>
              )}
            </Field>
          </CardContent>
        </Card>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="pt-6">
            <SectionTitle>Recorrido</SectionTitle>
            <p className="mb-3 mt-1 text-xs text-muted-foreground">Horas en UTC.</p>
            <Timeline detail={d} />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <SectionTitle>Notas internas</SectionTitle>
            <p className="mb-3 mt-1 text-xs text-muted-foreground">
              Las escribe el operador; la persona nunca las ve. El sello es hora de Buenos Aires, tal cual lo
              escribió el script.
            </p>
            <NotesThread raw={d.internalNotes} />
          </CardContent>
        </Card>
      </div>

      {/*
        `<details>` nativo: el payload crudo es para depurar, no para leer todos
        los días. Cerrado por default y sin JS.
      */}
      <details className="rounded-lg border border-border bg-card">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <code className="font-mono">raw_submission</code>
          <span className="ml-2 text-xs font-normal text-muted-foreground">lo que llegó, sin normalizar</span>
        </summary>
        <div className="overflow-x-auto border-t border-border">
          <pre className="p-4 font-mono text-xs leading-relaxed">{d.rawSubmissionJson}</pre>
        </div>
      </details>
    </>
  )
}

interface TimelineEvent {
  at: string
  label: string
  body?: ReactNode
}

/**
 * Ordenado por el TIMESTAMP, no por el orden de las columnas: `user_outcome_at`
 * puede caer antes que `answered_at`, y una cancelación del usuario cierra sin
 * haber pasado por `answered`. Un paso sin fecha no aparece — no se inventa
 * cuándo pasó.
 */
function Timeline({ detail: d }: { detail: QuoteRequestDetail }) {
  const events: Array<TimelineEvent> = [
    { at: d.createdAt, label: 'Pedido recibido', body: `por ${quoteChannelLabel(d.channel)}` },
  ]

  if (d.contactedAt) {
    events.push({ at: d.contactedAt, label: 'Contactado', body: `a ${formatMinutes(d.minutesToContact)} de recibido` })
  }
  if (d.answeredAt) {
    events.push({
      at: d.answeredAt,
      label: 'Respondido',
      body: `${d.proposalsCount === null ? 'sin cantidad de propuestas cargada' : `${formatInt(d.proposalsCount)} ${d.proposalsCount === 1 ? 'propuesta' : 'propuestas'}`} · a ${formatMinutes(d.minutesToAnswer)} de recibido`,
    })
  }
  if (d.userOutcomeAt) {
    events.push({
      at: d.userOutcomeAt,
      label: 'La persona declaró el resultado',
      body: d.userOutcome ? quoteUserOutcomeLabel(d.userOutcome) : undefined,
    })
  }
  if (d.closedAt) {
    const byUser = d.closeReasonCode === 'cancelled_by_user'
    events.push({
      at: d.closedAt,
      label: byUser ? 'Cancelado por la persona' : 'Cerrado',
      body: (
        <div className="space-y-1">
          {d.closeReasonCode && !byUser ? <div>Motivo: {quoteCloseReasonLabel(d.closeReasonCode)}</div> : null}
          {byUser && d.cancellationReason ? (
            <div>Motivo: {quoteCancellationReasonLabel(d.cancellationReason)}</div>
          ) : null}
          {byUser && d.cancellationComment ? (
            <blockquote className="border-l-2 border-border pl-2 italic">
              “{d.cancellationComment}” <span className="not-italic text-muted-foreground/70">— la persona</span>
            </blockquote>
          ) : null}
          {d.closedReason ? <div>Nota del operador: {d.closedReason}</div> : null}
          {d.outcome ? <div>Resultado (operador): {quoteOutcomeLabel(d.outcome)}</div> : null}
          {d.outcomeNote ? <div>Nota del resultado: {d.outcomeNote}</div> : null}
        </div>
      ),
    })
  }

  events.sort((a, b) => a.at.localeCompare(b.at))

  return (
    <ol className="space-y-3 border-l border-border pl-4">
      {events.map((e) => (
        <li key={`${e.label}-${e.at}`} className="relative">
          <span
            className="absolute -left-[1.3rem] top-1.5 size-2 rounded-full border border-border bg-card"
            aria-hidden
          />
          <div className="text-sm font-medium">{e.label}</div>
          <div className="text-xs tabular-nums text-muted-foreground">{formatDateTime(e.at)}</div>
          {e.body ? <div className="mt-0.5 text-sm text-muted-foreground">{e.body}</div> : null}
        </li>
      ))}
    </ol>
  )
}

function NotesThread({ raw }: { raw: string | null }) {
  const notes = parseInternalNotes(raw)
  if (notes.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin notas.</p>
  }
  return (
    <ol className="space-y-2">
      {notes.map((n, i) => (
        <li key={i} className="rounded-md border border-border bg-secondary px-3 py-2">
          {n.stamp ? (
            <div className="text-[11px] tabular-nums text-muted-foreground">{n.stamp} (Buenos Aires)</div>
          ) : (
            <div className="text-[11px] text-muted-foreground/70">sin fecha — escrita a mano</div>
          )}
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{n.text}</p>
        </li>
      ))}
    </ol>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="font-heading text-base font-semibold">{children}</h2>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  )
}
