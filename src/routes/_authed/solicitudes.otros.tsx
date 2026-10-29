import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { ArrowLeft, Check, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  editPartnerServicesFn,
  getPartnerApplication,
  getPartnerServicesView,
  getServiceCatalog,
  listPartnerApplications,
} from '~/fn/partners'
import { ApplicationStatusBadge } from '~/components/ApplicationStatusBadge'
import { Chip, FilterGroup } from '~/components/Filters'
import { MockBanner } from '~/components/MockBanner'
import { MultiSelect } from '~/components/MultiSelect'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Textarea } from '~/components/ui/textarea'
import {
  fetchServiceOtherReviewsMock,
  markServiceOtherReviewedMock,
  unmarkServiceOtherReviewedMock,
} from '~/mocks/service-other-review'
import { formatDate, formatDateTime } from '~/lib/format'
import { serviceOtherReviewSearchSchema } from '~/lib/service-other-review'
import type { ServiceFamily } from '~/lib/catalog'
import type { ApplicationStatus } from '~/lib/partners'
import type { ServiceOtherReview, ServiceOtherRow } from '~/lib/service-other-review'

/**
 * Revisión de los rubros "Otro" que declaran los proveedores al anotarse.
 *
 * Reemplaza el `select business_name, service_other from partner_applications
 * where service_other <> ''` que nadie corría: el "Otro" sólo se veía abriendo
 * cada solicitud. Al lado de cada texto van los servicios que el partner tiene
 * HOY, y se le pueden asignar servicios del catálogo con el mismo
 * `editPartnerServicesFn` (auditado, transaccional) que usa su ficha.
 *
 * Lo que NO puede todavía, y lo dice: crear un servicio nuevo en el catálogo
 * (no hay endpoint) y guardar "revisado" (no hay columna; `~/mocks`).
 *
 * SSR completo: son una docena de solicitudes. El loader lee la cola, se queda
 * con las que declararon "otros" (`declaredOther`, que también se prende por
 * "cómo nos conoció"), y pide el detalle de cada una para el texto y el partner.
 */
export const Route = createFileRoute('/_authed/solicitudes/otros')({
  validateSearch: serviceOtherReviewSearchSchema,
  loader: async ({ abortController }) => {
    const signal = abortController.signal
    const [applications, catalog] = await Promise.all([
      listPartnerApplications({ data: { published: 'show' }, signal }),
      getServiceCatalog({ signal }),
    ])
    const details = await Promise.all(
      applications
        .filter((a) => a.declaredOther)
        .map((a) => getPartnerApplication({ data: { applicationId: a.id }, signal })),
    )
    const rows: Array<ServiceOtherRow> = await Promise.all(
      details
        .filter((d) => (d.serviceOther ?? '').trim() !== '')
        .map(async (d) => {
          const view = d.partner
            ? await getPartnerServicesView({ data: { partnerId: d.partner.id }, signal })
            : null
          return {
            applicationId: d.id,
            businessName: d.businessName,
            status: d.status,
            // El repo tipa `createdAt` como string pero `pg` lo entrega como
            // `Date` (las solicitudes no lo pasan por `toISOString`). Se
            // normaliza acá: el tipo mentía y `localeCompare` reventaba.
            createdAt: new Date(d.createdAt).toISOString(),
            serviceOther: (d.serviceOther ?? '').trim(),
            partner:
              d.partner && view
                ? { id: d.partner.id, name: d.partner.name, assignedServiceIds: view.assignedServiceIds }
                : null,
          }
        }),
    )
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return { rows, catalog }
  },
  head: () => ({ meta: [{ title: 'Solicitudes · Rubros «Otro» — AutoLibre' }] }),
  component: ServiceOtherReviewPage,
})

function ServiceOtherReviewPage() {
  const { rows, catalog } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const [reviews, setReviews] = useState<Map<string, ServiceOtherReview>>(new Map())
  useEffect(() => {
    void fetchServiceOtherReviewsMock().then(setReviews)
  }, [])

  const pending = rows.filter((r) => !reviews.has(r.applicationId))
  const visible = search.serviceOtherReview === 'pending' ? pending : rows

  const serviceName = useMemo(() => {
    const m = new Map<string, string>()
    for (const f of catalog) for (const s of f.services) m.set(s.id, `${s.name} (${f.name})`)
    return m
  }, [catalog])

  return (
    <>
      <Link
        to="/solicitudes"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Solicitudes
      </Link>

      <PageHeader
        title="Rubros «Otro» declarados"
        subtitle={`${rows.length} solicitudes con texto en «Otro» · ${pending.length} sin revisar`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <MockBanner
        items={[
          'La marca «Revisado» y su nota son de ejemplo: no se guardan y se pierden al recargar. Falta la columna en la base.',
          'Asignar servicios SÍ es real: guarda en el partner, igual que el editor de su ficha.',
          'Crear un servicio nuevo en el catálogo no se puede todavía desde el panel.',
        ]}
      />

      <div className="mb-4">
        <FilterGroup label="Revisión">
          <Chip
            active={search.serviceOtherReview === 'pending'}
            onClick={() => navigate({ search: { serviceOtherReview: 'pending' }, replace: true })}
          >
            Sin revisar ({pending.length})
          </Chip>
          <Chip
            active={search.serviceOtherReview === 'all'}
            onClick={() => navigate({ search: { serviceOtherReview: 'all' }, replace: true })}
          >
            Todas ({rows.length})
          </Chip>
        </FilterGroup>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-lg border border-border bg-card py-16 text-center text-sm text-muted-foreground">
          {rows.length === 0 ? 'Ninguna solicitud declaró algo en «Otro».' : 'No queda nada sin revisar.'}
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((row) => (
            <ReviewCard
              key={row.applicationId}
              row={row}
              catalog={catalog}
              serviceName={serviceName}
              review={reviews.get(row.applicationId) ?? null}
              onReviewed={(r) => setReviews((prev) => new Map(prev).set(row.applicationId, r))}
              onUnreviewed={() =>
                setReviews((prev) => {
                  const next = new Map(prev)
                  next.delete(row.applicationId)
                  return next
                })
              }
            />
          ))}
        </div>
      )}
    </>
  )
}

function ReviewCard({
  row,
  catalog,
  serviceName,
  review,
  onReviewed,
  onUnreviewed,
}: {
  row: ServiceOtherRow
  catalog: Array<ServiceFamily>
  serviceName: Map<string, string>
  review: ServiceOtherReview | null
  onReviewed: (r: ServiceOtherReview) => void
  onUnreviewed: () => void
}) {
  const router = useRouter()
  const assigned = row.partner?.assignedServiceIds ?? []
  const [selected, setSelected] = useState<Array<string>>(assigned)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [note, setNote] = useState('')

  // Si el loader se relee (después de guardar), la selección vuelve a lo guardado.
  const assignedKey = assigned.join(',')
  useEffect(() => {
    setSelected(assigned)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignedKey])

  const options = useMemo(
    () =>
      catalog.flatMap((f) => f.services.map((s) => ({ value: s.id, label: `${s.name} (${f.name})` }))),
    [catalog],
  )

  const add = selected.filter((id) => !assigned.includes(id))
  const remove = assigned.filter((id) => !selected.includes(id))
  const dirty = add.length > 0 || remove.length > 0

  async function save() {
    if (!row.partner || !dirty) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await editPartnerServicesFn({ data: { partnerId: row.partner.id, add, remove } })
      setSaved(true)
      await router.invalidate()
    } catch {
      setError('No pudimos guardar los servicios. No se aplicó nada: la operación es transaccional.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <CardTitle className="text-base">
            <Link
              to="/solicitudes/$applicationId"
              params={{ applicationId: row.applicationId }}
              className="hover:underline"
            >
              {row.businessName}
            </Link>
          </CardTitle>
          <p className="text-xs text-muted-foreground">Se anotó el {formatDate(row.createdAt)}</p>
        </div>
        <ApplicationStatusBadge status={row.status as ApplicationStatus} />
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Declaró en «Otro»</p>
          <blockquote className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap">
            {row.serviceOther}
          </blockquote>

          {review ? (
            <div className="rounded-md border border-status-green/30 bg-status-green-bg px-3 py-2 text-sm text-status-green">
              <p className="font-medium">
                Revisado el {formatDateTime(review.reviewedAt)} · {review.reviewedBy}
              </p>
              {review.note ? <p className="mt-0.5">{review.note}</p> : null}
              <button
                type="button"
                onClick={() => void unmarkServiceOtherReviewedMock(row.applicationId).then(onUnreviewed)}
                className="mt-1 inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
              >
                <RotateCcw className="size-3" aria-hidden /> Volver a «sin revisar»
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Nota (opcional): qué se decidió, o qué servicio falta crear"
                rows={2}
                maxLength={500}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => void markServiceOtherReviewedMock(row.applicationId, note.trim()).then(onReviewed)}
              >
                <Check aria-hidden /> Marcar revisado
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Servicios asignados hoy
          </p>
          {row.partner ? (
            <>
              {assigned.length === 0 ? (
                <p className="text-sm text-status-yellow">
                  Ninguno: el partner no aparece bajo ningún rubro en la app.
                </p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {assigned.map((id) => (
                    <li key={id} className="rounded-md border border-border px-2 py-0.5 text-xs">
                      {serviceName.get(id) ?? id}
                    </li>
                  ))}
                </ul>
              )}
              <MultiSelect
                label={`Servicios de ${row.partner.name}`}
                options={options}
                selected={selected}
                onChange={setSelected}
                placeholder="Elegir servicios del catálogo"
                searchPlaceholder="Buscar servicio"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
                  {busy ? 'Guardando…' : 'Guardar servicios'}
                </Button>
                {dirty ? (
                  <span className="text-xs text-muted-foreground">
                    {add.length > 0 ? `+${add.length}` : ''}
                    {add.length > 0 && remove.length > 0 ? ' · ' : ''}
                    {remove.length > 0 ? `−${remove.length}` : ''}
                  </span>
                ) : null}
                {saved && !dirty ? <span className="text-xs text-status-green">Guardado.</span> : null}
              </div>
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
              <Link
                to="/partners/$partnerId"
                params={{ partnerId: row.partner.id }}
                className="inline-block text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                Abrir la ficha de {row.partner.name}
              </Link>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              La solicitud todavía no se aprobó: no hay partner al que asignarle servicios. Se resuelve al
              aprobarla, desde la solicitud.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
