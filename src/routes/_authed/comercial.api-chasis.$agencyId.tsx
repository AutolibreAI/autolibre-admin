import { Link, createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { ArrowLeft, MessageCircle } from 'lucide-react'
import { prospectWhatsAppUrl } from '~/lib/partner-prospects'
import { getAgencyDetailFn } from '~/fn/chasis-agencies'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { FollowUpTag, SaveIndicator } from '~/components/ProspectCards'
import {
  AgencyFichaEditor,
  AgencyInteractionComposer,
  AgencyInteractionHistory,
  AgencyProspectLink,
  AgencyStatusSelect,
  ReferralWarning,
  useAgencyAutosave,
} from '~/components/ChasisAgencies'
import { ProspectsUnavailable } from '~/components/ProspectsUnavailable'
import { Button } from '~/components/ui/button'
import { formatInt } from '~/lib/format'
import type { AgencyFacets, AgencyInteraction, ChasisAgency } from '~/lib/chasis-agencies'

/**
 * La ficha de una agencia (`/comercial/api-chasis/:id`): estado, todo lo que
 * se sabe, el check del referido en Chasis, "Crear contacto de proveedor" si
 * tiene taller propio, y el historial COMPLETO de charlas (031, append-only).
 *
 * SSR completo: las fechas del historial salen con el formateador fijo de
 * Buenos Aires y los días al seguimiento los calcula Postgres.
 */
export const Route = createFileRoute('/_authed/comercial/api-chasis/$agencyId')({
  loader: async ({ params }) => {
    const data = await getAgencyDetailFn({ data: { id: params.agencyId } })
    if (data === null) throw notFound()
    return data
  },
  head: () => ({ meta: [{ title: 'Agencia · API Chasis — AutoLibre' }] }),
  component: AgencyDetailView,
  notFoundComponent: () => (
    <p className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
      Esa agencia no existe.{' '}
      <Link to="/comercial/api-chasis" className="underline underline-offset-2">
        Volver a API Chasis
      </Link>
    </p>
  ),
})

function AgencyDetailView() {
  const data = Route.useLoaderData()
  if (!data.available) return <ProspectsUnavailable missing={data.missing} />
  return <AgencyDetail key={data.agency.id} initial={data.agency} interactions={data.interactions} facets={data.facets} />
}

function AgencyDetail({
  initial,
  interactions,
  facets,
}: {
  initial: ChasisAgency
  interactions: ReadonlyArray<AgencyInteraction>
  facets: AgencyFacets
}) {
  const router = useRouter()
  const { agency: a, state, save, accept } = useAgencyAutosave(initial, (patch) => {
    if (patch.status !== undefined || patch.usesCarbufy !== undefined || patch.hasWorkshop !== undefined)
      void router.invalidate()
  })
  const waUrl = prospectWhatsAppUrl(a.phoneDigits)

  return (
    <>
      <Link
        to="/comercial/api-chasis"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> API Chasis
      </Link>

      <PageHeader
        title={a.name}
        subtitle={[a.contactName, a.locality, a.phone].filter(Boolean).join(' · ') || 'sin contacto, zona ni teléfono'}
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
            <AgencyInteractionComposer agency={a} onSaved={accept} />
          </>
        }
      />

      <section className="mb-6 space-y-3 rounded-lg border border-border bg-card p-4" aria-label="Estado">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <p className="text-sm">
              {a.status === 'discarded' && a.discardReason ? (
                <>
                  <span className="text-muted-foreground">Descartada: </span>
                  {a.discardReason}
                </>
              ) : (
                <>
                  <span className="text-muted-foreground">Próximo paso: </span>
                  {a.nextStep ?? 'sin definir'}
                </>
              )}
            </p>
            <FollowUpTag days={a.followUpInDays} date={a.nextFollowUpOn} />
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <AgencyStatusSelect agency={a} onSave={save} />
            <SaveIndicator state={state} />
          </div>
        </div>
        <ReferralWarning agency={a} />
        <AgencyProspectLink agency={a} />
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section aria-labelledby="ad-ficha">
          <h2 id="ad-ficha" className="mb-2 font-heading text-sm font-semibold">
            Ficha
          </h2>
          <div className="rounded-lg border border-border bg-card p-4">
            <AgencyFichaEditor agency={a} facets={facets} save={save} />
          </div>
        </section>

        <section aria-labelledby="ad-history">
          <h2 id="ad-history" className="mb-2 font-heading text-sm font-semibold">
            Historial de charlas{interactions.length > 0 ? ` (${formatInt(interactions.length)})` : ''}
          </h2>
          <AgencyInteractionHistory interactions={interactions} />
        </section>
      </div>
    </>
  )
}
