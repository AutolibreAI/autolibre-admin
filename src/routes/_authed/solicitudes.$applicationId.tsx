import { useCallback, useState, type FormEvent, type ReactNode } from 'react'
import { Link, createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { AlertTriangle, ArrowLeft, CheckCircle2 } from 'lucide-react'
import {
  MANUAL_STATUSES,
  STATUS_LABELS,
  type ManualStatus,
} from '~/lib/partners'
import {
  approvePartnerApplication,
  getPartnerApplication,
  getServiceCatalog,
  unstickPartnerApplication,
  updatePartnerApplicationStatus,
} from '~/fn/partners'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { ApplicationLogo } from '~/components/ApplicationLogo'
import { ApplicationEditor, type ApplicationDraft } from '~/components/ApplicationEditor'
import { ApplicationStatusBadge } from '~/components/ApplicationStatusBadge'
import { ResolvedServicesSummary } from '~/components/ResolvedServicesSummary'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { formatDate } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { ApplicationDetail } from '~/lib/partners'
import { PartnerWelcomeCard } from '~/components/PartnerWelcomeCard'
import { readableApprovalError, type ApprovalResult } from '~/lib/partner-approval'

export const Route = createFileRoute('/_authed/solicitudes/$applicationId')({
  loader: async ({ params, abortController }) => {
    const signal = abortController.signal
    const [app, catalog] = await Promise.all([
      getPartnerApplication({ data: params, signal }).catch((cause: unknown) => {
        if (cause instanceof Error && cause.message.startsWith('NOT_FOUND:')) return null
        throw cause
      }),
      getServiceCatalog({ signal }),
    ])

    if (!app) throw notFound()
    return { app, catalog }
  },

  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData ? `${loaderData.app.businessName} — Solicitudes` : 'Solicitud' },
    ],
  }),

  component: ApplicationDetailPage,
})

function ApplicationDetailPage() {
  const { app, catalog } = Route.useLoaderData()
  const [draft, setDraftState] = useState<ApplicationDraft | null>(null)
  const setDraft = useCallback((next: ApplicationDraft) => setDraftState(next), [])
  /**
   * El resultado de la última aprobación vive ACÁ y no en `ApprovePanel`: al
   * aprobar, `router.invalidate()` trae el partner y `ApprovePanel` se
   * desmonta — el resultado (dueño, ubicación) se perdería con él.
   */
  const [approval, setApproval] = useState<{ result: ApprovalResult; zone: string } | null>(null)

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
        title={app.businessName}
        subtitle={`Recibida el ${formatDate(app.createdAt)}`}
        actions={
          <>
            <ApplicationStatusBadge status={app.status} />
            <SsrTag>ssr: full</SsrTag>
          </>
        }
      />

      <StuckWarning app={app} />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0">
          <ApplicationLogo key={app.logoUrl} url={app.logoUrl} name={app.businessName} />
          <ApplicationEditor app={app} catalog={catalog} onDraftChange={setDraft} />
        </div>

        <div className="space-y-4">
          {approval ? (
            <ApprovalResultCard
              app={app}
              result={approval.result}
              zone={approval.zone}
              onResult={(result, zone) => setApproval({ result, zone })}
            />
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {app.partner ? 'Rubros cargados' : 'Al aprobar'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResolvedServicesSummary
                resolved={app.resolved}
                declaredCount={app.declaredServices.length}
                serviceOther={app.serviceOther}
                howFound={app.howFound}
                howFoundOther={app.howFoundOther}
              />
            </CardContent>
          </Card>

          <PartnerWelcomeCard
            // Al aprobar, `invalidate()` trae el partner y su slug: el cuadro se
            // vuelve a completar en vez de quedarse con el aviso de antes.
            key={`${app.partner?.id ?? 'sin-partner'}:${app.partner?.status ?? ''}:${app.partner?.publicSlug ?? ''}`}
            businessName={app.businessName}
            partner={app.partner}
          />

          {app.partner ? (
            <PublishedPanel app={app} />
          ) : (
            <>
              <ApprovePanel
                app={app}
                draft={draft}
                onApproved={(result, zone) => setApproval({ result, zone })}
              />
              <StatusPanel app={app} />
            </>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * Consulta 5 del runbook, como acción en contexto.
 *
 * Una solicitud en `verbal_agreement` sin partner está TRABADA:
 * `approve_partner_application()` lleva `AND status <> 'verbal_agreement'` como
 * lock optimista, así que la rechaza para siempre con "inexistente o ya
 * aprobada" — y sin partner. Pasa cuando alguien pone ese estado a mano.
 */
function StuckWarning({ app }: { app: ApplicationDetail }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const stuck = app.status === 'verbal_agreement' && !app.partner

  if (!stuck) return null

  async function onUnstick() {
    setBusy(true)
    try {
      await unstickPartnerApplication({ data: { applicationId: app.id } })
      await router.invalidate()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Alert className="mb-4 border-status-red/25 bg-status-red-bg">
      <AlertTriangle className="size-4 text-status-red" />
      <AlertTitle className="text-status-red">Solicitud trabada</AlertTitle>
      <AlertDescription className="text-muted-foreground">
        <p>
          Está en <strong>acuerdo verbal</strong> pero no tiene partner. El backend la
          rechaza en este estado (409). Devolvela a <strong>en conversación</strong> y volvé
          a aprobarla.
        </p>
        <Button size="sm" variant="outline" className="mt-3" disabled={busy} onClick={onUnstick}>
          {busy ? 'Destrabando…' : 'Destrabar'}
        </Button>
      </AlertDescription>
    </Alert>
  )
}

function PublishedPanel({ app }: { app: ApplicationDetail }) {
  const invisible = app.partner!.serviceCount === 0

  return (
    <Card className={cn(invisible && 'border-status-red/25')}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CheckCircle2 className="size-4 text-status-green" aria-hidden />
          Publicado
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Field label="Partner" value={app.partner!.name} />
        <Field label="Zona de cobertura" value={app.partner!.coverageZone} />
        <SubmittedByField app={app} />
        <Field
          label="Rubros cargados"
          value={
            invisible ? (
              <span className="text-status-red">0 — invisible en la app</span>
            ) : (
              String(app.partner!.serviceCount)
            )
          }
        />
        {app.reviewedAt ? <Field label="Aprobada" value={formatDate(app.reviewedAt)} /> : null}

        {invisible ? (
          <Alert className="border-status-red/25 bg-status-red-bg">
            <AlertTriangle className="size-4 text-status-red" />
            <AlertDescription className="text-xs leading-relaxed text-muted-foreground">
              El partner existe y se lista sin filtro, pero no aparece bajo ningún chip.
              Hay que cargarle los rubros a mano — es la consulta 8 del runbook.
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  )
}

/**
 * «Registrado por»: `submitted_by_user_id` (0149). Sin la columna en la base,
 * o con una solicitud anónima, lo dice en vez de esconderse: decide si el
 * taller va a tener dueño al aprobar o va a necesitar un código de reclamo.
 */
function SubmittedByField({ app }: { app: ApplicationDetail }) {
  return (
    <Field
      label="Registrado por"
      value={
        app.submittedBy ? (
          (app.submittedBy.email ?? <span className="text-muted-foreground">cuenta sin email</span>)
        ) : (
          <span className="text-muted-foreground">nadie logueado (anónima o anterior)</span>
        )
      }
    />
  )
}

/**
 * Aprobar: desde el 2026-11-05 lo hace el backend
 * (`POST /admin/partner-applications/:id/approval`), que crea el partner, carga
 * los rubros, copia la ubicación y asigna el dueño. Lo tipeado sin guardar se
 * guarda ANTES, en una llamada aparte (`approveApplication` en el repo).
 */
function ApprovePanel({
  app,
  draft,
  onApproved,
}: {
  app: ApplicationDetail
  draft: ApplicationDraft | null
  onApproved: (result: ApprovalResult, zone: string) => void
}) {
  const router = useRouter()
  const [coverageZone, setCoverageZone] = useState(app.suggestedCoverageZone ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmedInvisible, setConfirmedInvisible] = useState(false)

  // Con cambios sin guardar, lo que se va a aprobar es lo que está en pantalla:
  // la cuenta de rubros sale de lo tildado, no de lo guardado. Las etiquetas
  // "sin reconocer" no cuentan — el INSERT de la aprobación tampoco las matchea.
  const pending = draft?.dirty ? draft : null
  const servicesToLoad = pending ? pending.serviceCount : app.resolved.totalServices
  const wouldBeInvisible = servicesToLoad === 0
  const blocked = wouldBeInvisible && !confirmedInvisible

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const zone = coverageZone.trim()
    try {
      const result = await approvePartnerApplication({
        data: {
          applicationId: app.id,
          coverageZone: zone,
          ...(pending ? { edits: pending.edits } : {}),
        },
      })
      onApproved(result, zone)
      await router.invalidate()
    } catch (cause) {
      setError(readableApprovalError(cause, { savedEdits: pending !== null }))
      // El paso 0 pudo haber guardado aunque el backend fallara: releer.
      if (pending) await router.invalidate()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Aprobar y publicar</CardTitle>
      </CardHeader>
      <CardContent>
        {wouldBeInvisible ? (
          <Alert className="mb-4 border-status-red/25 bg-status-red-bg">
            <AlertTriangle className="size-4 text-status-red" />
            <AlertTitle className="text-status-red">Quedaría invisible</AlertTitle>
            <AlertDescription className="text-xs leading-relaxed text-muted-foreground">
              <p>
                Nada de lo declarado matchea un servicio o familia activos, así que no se le cargaría
                ningún rubro. El partner se publicaría igual y se listaría sin filtro, pero
                no saldría bajo ningún chip de la app.
              </p>
              <label className="mt-3 flex items-start gap-2 text-foreground">
                <input
                  type="checkbox"
                  checked={confirmedInvisible}
                  onChange={(e) => setConfirmedInvisible(e.currentTarget.checked)}
                  className="mt-0.5"
                />
                <span>Entiendo, y le cargo los rubros a mano después.</span>
              </label>
            </AlertDescription>
          </Alert>
        ) : null}

        {pending ? (
          <p className="mb-3 rounded-md border border-status-yellow/30 bg-status-yellow-bg p-2.5 text-xs leading-relaxed text-muted-foreground">
            Tenés cambios sin guardar en el formulario. Se guardan justo antes de aprobar y el
            partner se crea con esos datos. Si la aprobación falla, los cambios quedan guardados.
          </p>
        ) : null}

        <div className="mb-3 space-y-1">
          <SubmittedByField app={app} />
          <p className="text-xs text-muted-foreground">
            {app.submittedBy
              ? 'Al aprobar, esa cuenta queda como dueña del taller.'
              : 'Sin cuenta que la haya registrado: después de aprobar, emitile un código de reclamo desde la ficha del partner.'}
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <label
              htmlFor="coverageZone"
              className="block text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              Zona de cobertura
            </label>
            <Input
              id="coverageZone"
              value={coverageZone}
              onChange={(e) => setCoverageZone(e.currentTarget.value)}
              placeholder="CABA y GBA Norte"
              required
              minLength={1}
              maxLength={200}
            />
            {/* Es texto libre y es lo que el usuario ve en la ficha. */}
            <p className="text-xs text-muted-foreground">
              La ve el usuario en la ficha. Escribila como la leería una persona, no como un
              código.
            </p>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            className="w-full"
            disabled={busy || blocked || coverageZone.trim().length === 0}
          >
            {busy
              ? 'Aprobando…'
              : wouldBeInvisible
                ? pending
                  ? 'Guardar cambios y aprobar igual'
                  : 'Aprobar igual'
                : pending
                  ? `Guardar cambios y aprobar (${servicesToLoad} rubros)`
                  : `Aprobar y cargar ${servicesToLoad} rubros`}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

/**
 * Lo que devolvió el backend al aprobar. «Rubros» decide "invisible" con
 * `totalServices` (conteo por SQL después de la llamada), NUNCA con
 * `servicesLoaded`: ése cuenta lo insertado por ESTA llamada y es 0 en
 * cualquier re-aprobación aunque el partner tenga rubros.
 */
function ApprovalResultCard({
  app,
  result,
  zone,
  onResult,
}: {
  app: ApplicationDetail
  result: ApprovalResult
  zone: string
  onResult: (result: ApprovalResult, zone: string) => void
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const invisible = result.totalServices === 0

  // Re-aprobar es idempotente: mismo partner, repara rubros y dueño. La zona la
  // ignora el backend en ese caso, pero el DTO la exige.
  async function onRetry() {
    setBusy(true)
    setError(null)
    const retryZone = app.partner?.coverageZone.trim() || zone
    try {
      const next = await approvePartnerApplication({
        data: { applicationId: app.id, coverageZone: retryZone },
      })
      onResult(next, retryZone)
      await router.invalidate()
    } catch (cause) {
      setError(readableApprovalError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className={cn(invisible && 'border-status-red/25')}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CheckCircle2 className="size-4 text-status-green" aria-hidden />
          {result.alreadyApproved ? 'Ya estaba aprobada — se reparó' : 'Aprobada y publicada'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {result.alreadyApproved ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            La solicitud ya tenía partner. El backend devolvió el mismo y completó lo que faltara
            (rubros y dueño); la zona de cobertura no se cambió.
          </p>
        ) : null}

        <Field
          label="Rubros"
          value={
            invisible ? (
              <span className="text-status-red">0 — invisible en la app</span>
            ) : (
              `${result.totalServices} en total · ${result.servicesLoaded} cargados ahora`
            )
          }
        />
        {invisible ? (
          <Alert className="border-status-red/25 bg-status-red-bg">
            <AlertTriangle className="size-4 text-status-red" />
            <AlertDescription className="text-xs leading-relaxed text-muted-foreground">
              El partner se lista sin filtro pero no sale bajo ningún chip. Cargale los rubros a
              mano desde la ficha.
            </AlertDescription>
          </Alert>
        ) : null}

        <Field
          label="Ubicación"
          value={
            result.locationCopied ? (
              'Copiada de la solicitud'
            ) : (
              <span className="text-muted-foreground">
                No se copió (la solicitud no traía coordenadas válidas, o el partner ya tenía):
                si falta, cargala desde la ficha.
              </span>
            )
          }
        />

        <Field label="Dueño" value={<OwnerOutcome result={result} />} />

        {result.ownerGrant === 'failed' ? (
          <div className="space-y-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={onRetry}>
              {busy ? 'Aprobando…' : 'Volver a aprobar'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Es seguro: no duplica el partner, sólo completa lo que faltó.
            </p>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <Link
          to="/partners/$partnerId"
          params={{ partnerId: result.partnerId }}
          className="inline-block text-sm underline underline-offset-2"
        >
          Ir a la ficha del partner
        </Link>
      </CardContent>
    </Card>
  )
}

function OwnerOutcome({ result }: { result: ApprovalResult }) {
  const who = result.ownerEmail ?? (result.ownerUserId ? 'una cuenta sin email' : null)

  switch (result.ownerGrant) {
    case 'granted':
      return <span>{who ?? 'La cuenta que la registró'} quedó como dueño.</span>
    case 'already_granted':
      return <span>{who ?? 'Esa cuenta'} ya era dueño.</span>
    case 'owner_taken':
      return (
        <span className="block rounded-md border border-status-yellow/30 bg-status-yellow-bg p-2 text-xs leading-relaxed">
          El taller ya tenía otro dueño{who ? ` (${who})` : ''}: no se le asignó a quien registró
          la solicitud. Revisalo en «Miembros» de la ficha.
        </span>
      )
    case 'no_submitter':
      return (
        <span>
          Nadie la registró logueado: emitile un código de reclamo desde{' '}
          <Link
            to="/partners/$partnerId"
            params={{ partnerId: result.partnerId }}
            className="underline underline-offset-2"
          >
            la ficha del partner
          </Link>{' '}
          («Miembros»).{who ? ` Hoy el dueño es ${who}.` : ''}
        </span>
      )
    case 'failed':
      return (
        <span className="text-status-red">
          No se pudo asignar el dueño. La aprobación sí quedó hecha.
        </span>
      )
    default:
      // Un valor nuevo del backend: crudo, nunca escondido.
      return (
        <span>
          Resultado del backend: <code>{result.ownerGrant}</code>
          {who ? ` · ${who}` : ''}
        </span>
      )
  }
}

/**
 * Editor del embudo.
 *
 * `verbal_agreement` NO está en la lista, y no es un olvido: es el único camino
 * hacia ese estado que rompe la invariante. Se llega ahí aprobando, nunca a
 * mano. Ver `MANUAL_STATUSES` en `~/lib/partners`.
 */
function StatusPanel({ app }: { app: ApplicationDetail }) {
  const router = useRouter()
  const [busy, setBusy] = useState<ManualStatus | null>(null)

  async function onSet(status: ManualStatus) {
    setBusy(status)
    try {
      await updatePartnerApplicationStatus({ data: { applicationId: app.id, status } })
      await router.invalidate()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Estado del embudo</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-1.5">
          {MANUAL_STATUSES.map((s) => (
            <Button
              key={s}
              type="button"
              size="sm"
              variant={app.status === s ? 'default' : 'outline'}
              disabled={busy !== null}
              onClick={() => onSet(s)}
            >
              {busy === s ? '…' : STATUS_LABELS[s]}
            </Button>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          <strong>Acuerdo verbal</strong> no está acá a propósito: la función de aprobación
          lo usa como lock, así que ponerlo a mano deja la solicitud trabada. Se llega ahí
          aprobando.
        </p>
      </CardContent>
    </Card>
  )
}

function Field({
  label,
  value,
  className,
}: {
  label: string
  value: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm break-words">{value}</div>
    </div>
  )
}
