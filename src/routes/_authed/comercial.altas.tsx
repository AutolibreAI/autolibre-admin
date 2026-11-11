import { useRef, useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight, Link2 } from 'lucide-react'
import {
  REGISTERED_PROSPECT_STATUSES,
  monthLabel,
  prospectMonthSearchSchema,
  readableProspectError,
  shiftMonth,
} from '~/lib/partner-prospects'
import { STATUS_LABELS as APPLICATION_STATUS_LABELS } from '~/lib/partners'
import { getMonthlyRegistrationsFn, updateProspectFn } from '~/fn/partner-prospects'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { FrontBadge, ProspectStatusBadge, VerifiedBadge } from '~/components/ProspectFields'
import { ProspectsUnavailable } from '~/components/ProspectsUnavailable'
import { Button } from '~/components/ui/button'
import { formatDate, formatInt } from '~/lib/format'
import type { PartnerProspect, ProspectFacets, RegistrationCandidate } from '~/lib/partner-prospects'

/**
 * Altas (`/comercial/altas`) — los proveedores que se dieron de alta en el
 * marketplace en un mes, por quién los consiguió: la lista para liquidar a fin
 * de mes. Lee la fecha de alta GUARDADA al vincular (030), no la recalcula.
 *
 * Abajo, las posibles altas sin vincular: contactos sin proveedor cuyo
 * teléfono coincide con uno del marketplace o con una solicitud. Vincular es
 * un click de una persona, nunca automático (una cadena comparte teléfono
 * entre sucursales). → `.claude/rules/partner-prospects.md`
 *
 * SSR completo: sin un mes en la URL, el servidor usa el actual de Buenos
 * Aires y lo devuelve; las fechas son días (`YYYY-MM-DD`) armados en SQL.
 */
export const Route = createFileRoute('/_authed/comercial/altas')({
  validateSearch: prospectMonthSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getMonthlyRegistrationsFn({ data: deps }),
  head: () => ({ meta: [{ title: 'Altas · Seguimiento comercial — AutoLibre' }] }),
  component: RegistrationsView,
})

const day = (d: string) => formatDate(`${d}T12:00:00Z`)

function RegistrationsView() {
  const data = Route.useLoaderData()
  if (!data.available) return <ProspectsUnavailable missing={data.missing} />

  const groups = groupByOwner(data.rows, data.facets)

  return (
    <>
      <PageHeader
        title={`Altas de ${monthLabel(data.month)}`}
        subtitle={`${formatInt(data.rows.length)} ${data.rows.length === 1 ? 'proveedor dado de alta' : 'proveedores dados de alta'}, por quién lo consiguió`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <nav aria-label="Mes" className="mb-6 flex items-center gap-2">
        <Button asChild size="sm" variant="outline" className="h-9 gap-1 shadow-none">
          <Link to="/comercial/altas" search={{ prospectMonth: shiftMonth(data.month, -1) }}>
            <ChevronLeft className="size-4" aria-hidden /> {monthLabel(shiftMonth(data.month, -1))}
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline" className="h-9 gap-1 shadow-none">
          <Link to="/comercial/altas" search={{ prospectMonth: shiftMonth(data.month, 1) }}>
            {monthLabel(shiftMonth(data.month, 1))} <ChevronRight className="size-4" aria-hidden />
          </Link>
        </Button>
        <Button asChild size="sm" variant="ghost" className="h-9">
          <Link to="/comercial/altas" search={{}}>
            Este mes
          </Link>
        </Button>
      </nav>

      {groups.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-4 py-5 text-sm text-muted-foreground">
          Ninguna alta en {monthLabel(data.month)}. Una alta cuenta cuando el contacto queda vinculado a su proveedor
          del marketplace.
        </p>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {groups.map((g) => (
              <div key={g.ownerId ?? 'none'} className="rounded-lg border border-border bg-card px-4 py-3">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{g.ownerName}</p>
                <p className="mt-1 font-heading text-2xl font-semibold tabular-nums">{formatInt(g.rows.length)}</p>
                <p className="text-xs text-muted-foreground">{formatInt(g.verified)} verificados</p>
              </div>
            ))}
          </div>

          {groups.map((g) => (
            <section key={g.ownerId ?? 'none'} aria-label={`Altas de ${g.ownerName}`}>
              <h2 className="mb-2 font-heading text-sm font-semibold">
                {g.ownerName} ({formatInt(g.rows.length)})
              </h2>
              <ul className="space-y-2">
                {g.rows.map((p) => (
                  <RegistrationRow key={p.id} prospect={p} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <section aria-labelledby="al-candidates" className="mt-10">
        <h2 id="al-candidates" className="mb-1 font-heading text-sm font-semibold">
          Posibles altas sin vincular ({formatInt(data.candidates.length)})
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Contactos sin proveedor cuyo teléfono coincide con uno del marketplace o con una solicitud. Revisá que sea el
          mismo antes de vincular: una cadena puede compartir teléfono entre sucursales.
        </p>
        {data.candidates.length === 0 ? (
          <p className="rounded-lg border border-border bg-card px-4 py-5 text-sm text-muted-foreground">
            No hay coincidencias por teléfono pendientes.
          </p>
        ) : (
          <ul className="space-y-2">
            {data.candidates.map((c) => (
              <CandidateRow key={c.prospect.id} candidate={c} facets={data.facets} />
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

interface OwnerGroup {
  ownerId: string | null
  ownerName: string
  rows: Array<PartnerProspect>
  verified: number
}

function groupByOwner(rows: ReadonlyArray<PartnerProspect>, facets: ProspectFacets): Array<OwnerGroup> {
  const map = new Map<string, OwnerGroup>()
  for (const p of rows) {
    const key = p.ownerId ?? 'none'
    let g = map.get(key)
    if (!g) {
      g = {
        ownerId: p.ownerId,
        ownerName: p.ownerId ? (facets.owners.find((o) => o.id === p.ownerId)?.name ?? 'usuario borrado') : 'Sin asignar',
        rows: [],
        verified: 0,
      }
      map.set(key, g)
    }
    g.rows.push(p)
    if (p.verified) g.verified += 1
  }
  return [...map.values()].sort((a, b) => b.rows.length - a.rows.length || a.ownerName.localeCompare(b.ownerName))
}

function RegistrationRow({ prospect: p }: { prospect: PartnerProspect }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 text-sm">
          {p.partnerId ? (
            <Link
              to="/partners/$partnerId"
              params={{ partnerId: p.partnerId }}
              className="font-semibold underline-offset-2 hover:underline"
            >
              {p.partnerName ?? 'proveedor borrado'}
            </Link>
          ) : null}
          <span className="text-muted-foreground">
            contacto{' '}
            <Link
              to="/comercial/contactos/$prospectId"
              params={{ prospectId: p.id }}
              className="underline-offset-2 hover:underline"
            >
              {p.name}
            </Link>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {p.front ? <FrontBadge front={p.front} quoteCode={p.frontQuoteCode} /> : null}
          {p.verified ? <VerifiedBadge /> : null}
          <ProspectStatusBadge status={p.status} />
        </div>
      </div>
      <span className="text-sm tabular-nums">{p.partnerRegisteredOn ? `alta ${day(p.partnerRegisteredOn)}` : ''}</span>
    </li>
  )
}

/**
 * Una coincidencia por teléfono. "Vincular" hace lo mismo que el vinculador de
 * la tarjeta (`partnerId` por `updateProspectFn`: el SP de la 030 fija la fecha
 * de alta) y, si el contacto todavía no estaba registrado, lo pasa a
 * Registrado en el mismo parche.
 */
function CandidateRow({ candidate: c, facets }: { candidate: RegistrationCandidate; facets: ProspectFacets }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const p = c.prospect
  const willRegister = !REGISTERED_PROSPECT_STATUSES.includes(p.status)
  const owner = p.ownerId ? (facets.owners.find((o) => o.id === p.ownerId)?.name ?? null) : null

  async function link(partnerId: string) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(partnerId)
    setError(null)
    try {
      await updateProspectFn({
        data: { id: p.id, patch: willRegister ? { partnerId, status: 'registered' } : { partnerId } },
      })
      await router.invalidate()
    } catch (cause) {
      setError(readableProspectError(cause))
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  return (
    <li className="space-y-2 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link
          to="/comercial/contactos/$prospectId"
          params={{ prospectId: p.id }}
          className="font-semibold underline-offset-2 hover:underline"
        >
          {p.name}
        </Link>
        <ProspectStatusBadge status={p.status} />
        <span className="text-muted-foreground">
          {[p.phone, p.locality, owner ? `conseguido por ${owner}` : null].filter(Boolean).join(' · ')}
        </span>
      </div>

      {c.partners.length > 0 ? (
        <ul className="space-y-1.5">
          {c.partners.map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
            >
              <span className="min-w-0">
                <Link2 className="mr-1 inline size-3.5 text-muted-foreground" aria-hidden />
                <Link to="/partners/$partnerId" params={{ partnerId: m.id }} className="underline-offset-2 hover:underline">
                  {m.name}
                </Link>
                <span className="text-muted-foreground">
                  {' '}
                  · en el marketplace desde {day(m.createdOn)}
                  {m.status !== 'active' ? ` · ${m.status}` : ''}
                </span>
              </span>
              <Button
                size="sm"
                className="h-9"
                disabled={busy !== null}
                onClick={() => void link(m.id)}
              >
                {busy === m.id ? 'Vinculando…' : willRegister ? 'Vincular y pasar a Registrado' : 'Vincular'}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {c.applications.length > 0 ? (
        <ul className="space-y-1.5">
          {c.applications.map((a) => (
            <li key={a.id} className="rounded-md border border-dashed border-border px-3 py-2 text-sm">
              Mandó una solicitud que todavía no es proveedor:{' '}
              <Link
                to="/solicitudes/$applicationId"
                params={{ applicationId: a.id }}
                className="underline underline-offset-2"
              >
                {a.businessName}
              </Link>
              <span className="text-muted-foreground">
                {' '}
                · {APPLICATION_STATUS_LABELS[a.status as keyof typeof APPLICATION_STATUS_LABELS] ?? a.status} · desde{' '}
                {day(a.createdOn)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <p className="text-sm text-status-red" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  )
}
