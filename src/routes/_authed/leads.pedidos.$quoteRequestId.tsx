import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { ArrowLeft, Globe, MessageCircle, Smartphone } from 'lucide-react'
import {
  formatMinutes,
  parseInternalNotes,
  quoteCancellationReasonLabel,
  quoteChannelLabel,
  quoteCloseReasonLabel,
  quoteMapLocation,
  quoteOutcomeLabel,
  quotePublicCode,
  quoteRequestDetailSearchSchema,
  quoteRequestIdSchema,
  quoteUserOutcomeLabel,
  type QuoteRequestDetail,
} from '~/lib/quote-requests'
import { getQuoteRequestFn } from '~/fn/quote-requests'
import { listQuoteResponsesFn } from '~/fn/quote-responses'
import { listQuoteMessageTemplatesFn } from '~/fn/quote-message-templates'
import { proposalToMessageEntry } from '~/lib/quote-templates'
import { getQuoteVehicleProfileFn } from '~/fn/quote-vehicle-profile'
import {
  getServiceCatalog,
  listPartnerCandidatesFn,
  listPartnerOptionsFn,
  listPartnerZonesFn,
} from '~/fn/partners'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { PartnerCandidates } from '~/components/PartnerCandidates'
import { QuoteRequestPhotos } from '~/components/QuoteRequestPhotos'
import { listQuoteRequestPhotosFn } from '~/fn/quote-photos'
import { QuoteProposals } from '~/components/QuoteProposals'
import { listQuoteProposalsFn } from '~/fn/quote-proposals'
import { QuoteRequestActions, QuoteRequestNoteComposer } from '~/components/QuoteRequestActions'
import { QuoteRequestEditor } from '~/components/QuoteRequestEditor'
import { QuoteRequestsUnavailable } from '~/components/QuoteRequestsUnavailable'
import { QuoteStatusBadge, QuoteVehicleWarnings, QuoteWhatsAppLink } from '~/components/QuoteRequestCells'
import { QuoteTemplates } from '~/components/QuoteTemplates'
import { QuoteVehicleProfileCard } from '~/components/QuoteVehicleProfileCard'
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
 * Y escribe: las transiciones del operador y la nota interna, vía los SPs de
 * `ops` de la 011 (`QuoteRequestActions`). Sólo en la rama con la tabla
 * disponible — sin ella la pantalla corta antes y no hay botones.
 *
 * `<QuoteTemplates detail={d}/>` es texto para copiar y pegar al contactar,
 * completado con los datos DE ESTE pedido — no vive en el listado porque no
 * tiene sentido sin un pedido puntual al que referirse. → `~/lib/quote-templates`.
 *
 * `<QuoteRequestEditor/>` (migración 018) edita contacto, patente, vehículo
 * escrito, descripción, monto y zona tipeada: el pedido casi nunca llega
 * completo, y la persona suelta los datos de a poco.
 *
 * Desde `.claude/plans/partners-derivacion.md` (Fase 2) también monta
 * `<PartnerCandidates/>`: dado el rubro del pedido (clasificado vía
 * `ops.set_quote_request_rubro`, migración 013), qué partners activos lo
 * cubren, ordenados por cercanía a la coordenada del pedido.
 */
export const Route = createFileRoute('/_authed/leads/pedidos/$quoteRequestId')({
  /**
   * `quoteRubros` es el ÚNICO search param de esta ruta: qué rubros se están
   * MIRANDO en el panel de candidatos. Cambiarlo no clasifica el pedido —
   * eso es la escritura explícita de `<PartnerCandidates/>` — pero sí hace
   * que el `loader` vuelva a pedir los candidatos de esos rubros.
   */
  validateSearch: quoteRequestDetailSearchSchema,
  loaderDeps: ({ search }) => ({ quoteRubros: search.quoteRubros }),

  /**
   * SSR completo (heredado). Es una ficha de CONTENIDO que se abre desde un
   * link pegado en un chat de equipo ("mirá AL-1042") y tiene que llegar
   * pintada. Mismo criterio que `/chats/:id` y `/usuarios/:id`.
   *
   * Un cambio de `quoteRubros` re-corre este loader desde el CLIENTE (la
   * navegación de TanStack Router pega los server functions por RPC), no
   * dispara un nuevo SSR completo — es lo que hace viable tener los rubros en
   * la URL sin pagar un round trip de servidor por cada cambio.
   */
  loader: async ({ params, deps, abortController }) => {
    // `parse` acá además del validator del server function: un id que no es
    // uuid es un 404 de la PANTALLA, no un 500 de validación.
    if (!quoteRequestIdSchema.safeParse(params).success) throw notFound()

    const signal = abortController.signal
    const result = await getQuoteRequestFn({ data: params, signal }).catch((cause: unknown) => {
      if (cause instanceof Error && cause.message.startsWith('NOT_FOUND:')) return null
      throw cause
    })
    if (!result) throw notFound()
    if (!('detail' in result))
      return {
        result,
        catalog: [],
        zones: [],
        candidates: [],
        effectiveCategorySlugs: [],
        responses: { available: false as const },
        partnerOptions: [],
        templates: [],
        vehicleProfile: null,
        photos: { available: false as const },
        proposals: { available: false as const },
      }

    // Los presupuestos viejos de `ops` ya no tienen tarjeta (2026-10-27): se
    // siguen leyendo sólo para PRECARGAR propuestas en los pedidos que los
    // tenían. Sin la 015 vuelven `{ available: false }` y la precarga no aparece.
    // Los presupuestos, el directorio y las plantillas van en el MISMO
    // `Promise.all` que el catálogo: son independientes entre sí y esperar
    // uno detrás de otro sólo sumaría round trips a una ficha que ya hace
    // varios. El perfil del vehículo sólo se pide si el pedido tiene uno
    // vinculado — el caso más común (`web`/`whatsapp` sin cuenta) no tiene
    // nada que pedir acá.
    // Las propuestas en la app tienen su PROPIO guard (0120–0122 del backend):
    // en una base sin ellas vuelven `{ available: false }`, nunca un 500.
    const [catalog, zones, responses, partnerOptions, templates, vehicleProfile, photos, proposals] = await Promise.all([
      getServiceCatalog({ signal }),
      listPartnerZonesFn({ signal }),
      listQuoteResponsesFn({ data: params, signal }),
      listPartnerOptionsFn({ signal }),
      listQuoteMessageTemplatesFn({ signal }),
      result.detail.vehicleId
        ? getQuoteVehicleProfileFn({ data: { vehicleId: result.detail.vehicleId }, signal })
        : Promise.resolve(null),
      listQuoteRequestPhotosFn({ data: { quoteRequestId: params.quoteRequestId }, signal }),
      listQuoteProposalsFn({ data: params, signal }),
    ])

    // Precedencia (`.claude/rules/leads.md` / el plan §5, trampa 6): el search
    // param gana; si no está, el default son los rubros guardados.
    const effectiveCategorySlugs = deps.quoteRubros.length > 0 ? deps.quoteRubros : result.detail.rubroCategorySlugs

    const candidates =
      effectiveCategorySlugs.length > 0
        ? await listPartnerCandidatesFn({
            data: {
              categorySlugs: effectiveCategorySlugs,
              // GPS, o la dirección tipeada geocodificada (021): el mismo punto que el mapa.
              lat: quoteMapLocation(result.detail)?.lat ?? null,
              lng: quoteMapLocation(result.detail)?.lng ?? null,
            },
            signal,
          })
        : []

    return {
      result,
      catalog,
      zones,
      candidates,
      effectiveCategorySlugs,
      responses,
      partnerOptions,
      templates,
      vehicleProfile,
      photos,
      proposals,
    }
  },

  head: ({ loaderData }) => ({
    meta: [
      {
        title:
          loaderData && 'detail' in loaderData.result
            ? `${quotePublicCode(loaderData.result.detail.publicNumber)} — Pedidos`
            : 'Pedido — Pedidos',
      },
    ],
  }),

  component: QuoteRequestScreen,
})

function QuoteRequestScreen() {
  const {
    result,
    catalog,
    zones,
    candidates,
    effectiveCategorySlugs,
    responses,
    partnerOptions,
    templates,
    vehicleProfile,
    photos,
    proposals,
  } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setQuoteRubros = (slugs: Array<string>) =>
    navigate({ search: { ...search, quoteRubros: slugs }, replace: true, resetScroll: false })

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
  // Sólo para precargar propuestas desde lo que se cargó antes del 2026-10-27.
  const responseRows = responses.available ? responses.rows : []
  // Hubo al menos un envío por la app: desde ahí `proposals_count` lo lleva el
  // backend y la plantilla «Presupuestos» puede repetir lo que ya le llegó.
  const hasAppSends = proposals.available && proposals.hasAppSends
  const activeProposals = proposals.available ? proposals.active : []
  // El mensaje «Presupuestos» sale de las propuestas activas, las MISMAS que
  // se ven en la tarjeta de abajo (y en la app, si la persona tiene cuenta).
  const messageEntries = activeProposals.map(proposalToMessageEntry)

  return (
    <>
      {back}

      <PageHeader
        title={`${quotePublicCode(d.publicNumber)} · Pedido de presupuesto`}
        subtitle={`Por ${quoteChannelLabel(d.channel)}${d.enteredManually ? ' · cargado a mano' : ''} · recibido ${formatDateTime(d.createdAt)} UTC · actualizado ${formatDateTime(d.updatedAt)} UTC`}
        actions={
          <div className="flex items-center gap-2">
            {d.editAvailable ? (
              <QuoteRequestEditor key={d.id} detail={d} />
            ) : (
              <span className="text-xs text-muted-foreground">Editar: falta aplicar la migración 018</span>
            )}
            <SsrTag>ssr: full</SsrTag>
          </div>
        }
      />

      <ChannelBanner detail={d} />

      {/*
        Contacto, vehículo y pedido van ARRIBA de todo (pedido del 2026-10-27):
        es lo que se mira antes de llamar, y abajo están los presupuestos y los
        candidatos, que con varios talleres son una pantalla entera de scroll.
      */}
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardContent className="space-y-4 pt-6">
            <SectionTitle>Contacto</SectionTitle>
            <Field label="Nombre">
              <span className="text-sm">{d.contactName ?? <span className="text-muted-foreground">sin nombre</span>}</span>
            </Field>
            <Field label="Teléfono">
              <span className="font-mono text-sm tabular-nums">{d.contactPhone}</span>
              <QuoteWhatsAppLink
                phone={d.contactPhone}
                publicNumber={d.publicNumber}
                contactName={d.contactName}
                explainMissing
              />
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
            <Field label="Patente">
              {d.plate ? (
                <span className="font-mono font-semibold tracking-wider">{d.plate}</span>
              ) : (
                <span className="text-sm text-muted-foreground">No la dio todavía</span>
              )}
            </Field>
            {/*
              El vehículo ESCRITO (migración 018): lo que contó la persona
              cuando no hay un vehicle_id que vincular. Vive en ops, no en
              quote_requests.
            */}
            <Field label="Vehículo (según la persona)">
              {d.vehicleText ? (
                <span className="text-sm">{d.vehicleText}</span>
              ) : (
                <span className="text-sm text-muted-foreground">Sin cargar</span>
              )}
            </Field>
            <Field label="Vehículo vinculado por el operador">
              {d.vehicleId ? (
                <div className="text-sm">
                  <Link
                    to="/vehiculos/$vehicleId"
                    params={{ vehicleId: d.vehicleId }}
                    className="rounded outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background font-mono font-semibold tracking-wider text-brand"
                  >
                    {d.vehiclePlate ?? 'ver el vehículo'}
                  </Link>
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
            <Field label="Zona">
              {d.locationAddress ? (
                <>
                  <span className="text-sm">{d.locationAddress}</span>
                  <div className="text-xs text-muted-foreground">
                    {[d.locationLocality, d.locationProvince].filter(Boolean).join(', ') || 'sin localidad'}
                    {' · '}
                    {d.locationSource === 'device' ? 'GPS del teléfono' : 'tipeada'}
                  </div>
                </>
              ) : (
                <span className="text-sm text-muted-foreground">Sin cargar</span>
              )}
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

      {/*
        Visible siempre que el pedido tenga `vehicleId` — aunque el canal no
        sea `app` (el operador puede haber vinculado el auto a mano). Sólo
        lectura: no hay ningún botón acá.
      */}
      {d.vehicleId && vehicleProfile ? <QuoteVehicleProfileCard profile={vehicleProfile} /> : null}

      <QuoteTemplates detail={d} entries={messageEntries} templates={templates} hasAppSends={hasAppSends} />

      <Card className="mb-4">
        <CardContent className="pt-6">
          <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Estado">
              <QuoteStatusBadge status={d.status} />
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

      {/* Las fotos del problema: las de la app y las que llegan por WhatsApp. */}
      <QuoteRequestPhotos key={`photos-${d.id}`} quoteRequestId={d.id} data={photos} />

      {/*
        El ÚNICO lugar donde se carga lo que consiguió el operador, llegue el
        pedido por la app o por WhatsApp (2026-10-27: la tarjeta de
        Presupuestos de `ops` se sacó). Con cuenta, la persona lo ve en la app;
        siempre, arma el mensaje «Presupuestos» de arriba.
        → `.claude/rules/quote-proposals.md`
      */}
      <QuoteProposals
        key={`proposals-${d.id}`}
        quoteRequestId={d.id}
        data={proposals}
        responses={responseRows}
        partners={partnerOptions}
        hasUser={d.userId !== null}
        channel={d.channel}
        status={d.status}
      />

      {/*
        `key` por pedido: navegar de uno a otro no arrastra un formulario a medio llenar.
        Con prefijo, igual que los hermanos de arriba: dos hermanos con el MISMO key
        dejan nodos huérfanos en el DOM que sobreviven a la navegación.
      */}
      <QuoteRequestActions
        key={`actions-${d.id}`}
        quoteRequestId={d.id}
        status={d.status}
        closeReasonCode={d.closeReasonCode}
        loadedProposals={activeProposals.length}
      />

      <PartnerCandidates
        key={`candidates-${d.id}`}
        quoteRequestId={d.id}
        publicNumber={d.publicNumber}
        detail={d}
        templates={templates}
        pedidoHasLocation={quoteMapLocation(d) !== null}
        catalog={catalog}
        zones={zones}
        savedCategorySlugs={d.rubroCategorySlugs}
        selectedCategorySlugs={effectiveCategorySlugs}
        candidates={candidates}
        onChangeCategories={setQuoteRubros}
      />

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
              pone <code className="font-mono">ops.add_quote_request_internal_note</code>.
            </p>
            <NotesThread raw={d.internalNotes} />
            <QuoteRequestNoteComposer key={d.id} quoteRequestId={d.id} status={d.status} />
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

/**
 * Por dónde entró el pedido, bien grande y arriba de todo (pedido del
 * 2026-10-27): es lo que decide cómo le llegan las propuestas a la persona.
 *
 * Lo que decide NO es el canal solo sino si hay CUENTA: un pedido `app` por el
 * endpoint público no tiene `user_id`, y entonces las propuestas no le llegan
 * a ninguna app. Por eso la segunda línea mira `userId`, y el canal es el
 * título.
 */
function ChannelBanner({ detail: d }: { detail: QuoteRequestDetail }) {
  const Icon = d.channel === 'whatsapp' ? MessageCircle : d.channel === 'web' ? Globe : Smartphone
  const hasAccount = d.userId !== null
  return (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary" aria-hidden>
        <Icon className="size-5" />
      </span>
      <div className="min-w-0">
        <div className="font-heading text-lg font-semibold leading-tight">
          Entró por {quoteChannelLabel(d.channel)}
          {d.enteredManually ? (
            <span className="ml-2 align-middle text-xs font-normal text-muted-foreground">cargado a mano</span>
          ) : null}
        </div>
        <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
          {hasAccount ? (
            <>
              <span className="font-medium text-foreground">Tiene cuenta de AutoLibre:</span> las propuestas que
              cargues le llegan a la app con un aviso. El WhatsApp es opcional.
            </>
          ) : (
            <>
              <span className="font-medium text-foreground">Sin cuenta de AutoLibre:</span> las propuestas no le
              llegan a ninguna app. Mandáselas por WhatsApp con el mensaje «Presupuestos».
            </>
          )}
        </p>
      </div>
    </div>
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
