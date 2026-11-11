import { Link, createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { ArrowLeft, MessageCircle } from 'lucide-react'
import { REGISTERED_PROSPECT_STATUSES, prospectWhatsAppUrl } from '~/lib/partner-prospects'
import { getProspectDetailFn } from '~/fn/partner-prospects'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import {
  FichaEditor,
  FollowUpTag,
  PartnerLinkSection,
  ProviderInfoEditor,
  SaveIndicator,
  StatusSelect,
  VerificationEditor,
  useProspectAutosave,
} from '~/components/ProspectCards'
import { FrontBadge, VerifiedBadge } from '~/components/ProspectFields'
import { InteractionComposer, InteractionHistory } from '~/components/ProspectInteractions'
import { ProspectsUnavailable } from '~/components/ProspectsUnavailable'
import { Button } from '~/components/ui/button'
import { formatInt } from '~/lib/format'
import type { PartnerProspect, ProspectFacets, ProspectInteraction } from '~/lib/partner-prospects'

/**
 * La ficha de un contacto (`/comercial/contactos/:id`): lo que se sabe del
 * proveedor, la verificación, el vínculo con el marketplace y el historial
 * COMPLETO de charlas (030), de la más nueva a la más vieja.
 *
 * Reemplaza lo que hoy se hace con la tarjeta y la nota: cada llamado,
 * WhatsApp o visita queda como un registro propio, sin pisar el anterior.
 *
 * SSR completo: las fechas del historial salen con el formateador fijo de
 * Buenos Aires y "vencido hace N días" lo calcula Postgres.
 */
export const Route = createFileRoute('/_authed/comercial/contactos/$prospectId')({
  loader: async ({ params }) => {
    const data = await getProspectDetailFn({ data: { id: params.prospectId } })
    if (data === null) throw notFound()
    return data
  },
  head: () => ({ meta: [{ title: 'Contacto · Seguimiento comercial — AutoLibre' }] }),
  component: ProspectDetailView,
  notFoundComponent: () => (
    <p className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
      Ese contacto no existe.{' '}
      <Link to="/comercial/contactos" className="underline underline-offset-2">
        Volver a Contactos
      </Link>
    </p>
  ),
})

function ProspectDetailView() {
  const data = Route.useLoaderData()
  if (!data.available) return <ProspectsUnavailable missing={data.missing} />
  // `key`: al pasar de un contacto a otro, el autoguardado arranca de cero.
  return (
    <ProspectDetail
      key={data.prospect.id}
      initial={data.prospect}
      interactions={data.interactions}
      facets={data.facets}
    />
  )
}

function ProspectDetail({
  initial,
  interactions,
  facets,
}: {
  initial: PartnerProspect
  interactions: ReadonlyArray<ProspectInteraction>
  facets: ProspectFacets
}) {
  const router = useRouter()
  const { prospect: p, state, save, accept } = useProspectAutosave(initial, (patch) => {
    if (patch.status !== undefined || patch.partnerId !== undefined) void router.invalidate()
  })
  const waUrl = prospectWhatsAppUrl(p.phoneDigits)
  const owner = facets.owners.find((o) => o.id === p.ownerId)?.name ?? 'sin asignar'

  return (
    <>
      <Link
        to="/comercial/contactos"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Contactos
      </Link>

      <PageHeader
        title={p.name}
        subtitle={[p.locality, p.phone].filter(Boolean).join(' · ') || 'sin localidad ni teléfono'}
        actions={
          <>
            <SsrTag>ssr: full</SsrTag>
            {waUrl ? (
              <Button asChild size="sm" variant="outline" className="h-9 gap-1.5 shadow-none">
                <a href={waUrl} target="_blank" rel="noreferrer">
                  <MessageCircle className="size-4" aria-hidden /> WhatsApp
                </a>
              </Button>
            ) : null}
            <InteractionComposer prospect={p} onSaved={accept} />
          </>
        }
      />

      <section className="mb-6 rounded-lg border border-border bg-card p-4" aria-label="Estado">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {p.front ? <FrontBadge front={p.front} quoteCode={p.frontQuoteCode} /> : null}
              {p.verified ? <VerifiedBadge /> : null}
              <span className="text-xs text-muted-foreground">Conseguido por {owner}</span>
            </div>
            <p className="text-sm">
              {p.status === 'discarded' && p.discardReason ? (
                <>
                  <span className="text-muted-foreground">Descartado: </span>
                  {p.discardReason}
                </>
              ) : (
                <>
                  <span className="text-muted-foreground">Próximo paso: </span>
                  {p.nextStep ?? 'sin definir'}
                </>
              )}
            </p>
            <FollowUpTag days={p.followUpInDays} date={p.nextFollowUpOn} />
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <StatusSelect prospect={p} onSave={save} onRegistered={() => undefined} />
            <SaveIndicator state={state} />
          </div>
        </div>
        {p.partnerId !== null || REGISTERED_PROSPECT_STATUSES.includes(p.status) ? (
          <PartnerLinkSection prospect={p} autoSuggest={false} onLink={(partnerId) => save({ partnerId })} />
        ) : null}
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="space-y-6">
          <section aria-labelledby="pd-provider">
            <h2 id="pd-provider" className="mb-2 font-heading text-sm font-semibold">
              El proveedor
            </h2>
            <div className="rounded-lg border border-border bg-card p-4">
              <ProviderInfoEditor prospect={p} save={save} />
            </div>
          </section>

          <section aria-labelledby="pd-verify">
            <h2 id="pd-verify" className="mb-2 font-heading text-sm font-semibold">
              Verificación
            </h2>
            <div className="rounded-lg border border-border bg-card p-4">
              <VerificationEditor prospect={p} save={save} />
            </div>
          </section>

          <section aria-labelledby="pd-ficha">
            <h2 id="pd-ficha" className="mb-2 font-heading text-sm font-semibold">
              Ficha
            </h2>
            <FichaEditor prospect={p} facets={facets} save={save} />
          </section>
        </div>

        <section aria-labelledby="pd-history">
          <h2 id="pd-history" className="mb-2 font-heading text-sm font-semibold">
            Historial de charlas{interactions.length > 0 ? ` (${formatInt(interactions.length)})` : ''}
          </h2>
          <InteractionHistory interactions={interactions} />
        </section>
      </div>
    </>
  )
}
