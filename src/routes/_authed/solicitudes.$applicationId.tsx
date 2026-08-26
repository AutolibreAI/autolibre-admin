import { useState, type FormEvent, type ReactNode } from 'react'
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
  unstickPartnerApplication,
  updatePartnerApplicationStatus,
} from '~/fn/partners'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { ApplicationStatusBadge } from '~/components/ApplicationStatusBadge'
import { ResolvedServicesSummary } from '~/components/ResolvedServicesSummary'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { formatDate } from '~/lib/format'
import { cn } from '~/lib/utils'
import type { ApplicationDetail } from '~/lib/partners'

export const Route = createFileRoute('/_authed/solicitudes/$applicationId')({
  loader: async ({ params, abortController }) => {
    const app = await getPartnerApplication({
      data: params,
      signal: abortController.signal,
    }).catch((cause: unknown) => {
      if (cause instanceof Error && cause.message.startsWith('NOT_FOUND:')) return null
      throw cause
    })

    if (!app) throw notFound()
    return app
  },

  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData ? `${loaderData.businessName} — Solicitudes` : 'Solicitud' },
    ],
  }),

  component: ApplicationDetailPage,
})

function ApplicationDetailPage() {
  const app = Route.useLoaderData()

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
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Contacto</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Field label="Email" value={app.email} />
              <Field label="WhatsApp" value={app.whatsapp} />
              <Field label="Dirección" value={app.address} className="sm:col-span-2" />
              <Field label="Cómo nos encontró" value={app.howFound ?? '—'} />
              <Field label="Canal de contacto" value={app.contactChannel ?? '—'} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Lo que declaró</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field
                label="Especializado en marca"
                value={app.brandSpecialized ? 'Sí' : 'No'}
              />
              <ChipList label="Marcas" items={app.declaredBrands} />
              <ChipList label="Combustibles" items={app.declaredFuelTypes} />
              <ChipList label="Tipos de vehículo" items={app.vehicleTypes} />
              {app.serviceOther ? (
                <Field label="Otros servicios (texto libre)" value={app.serviceOther} />
              ) : null}
            </CardContent>
          </Card>

          {app.internalNotes || app.reviewNote || app.nextStep ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Notas</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {app.nextStep ? <Field label="Próximo paso" value={app.nextStep} /> : null}
                {app.followUpDate ? (
                  <Field label="Fecha de seguimiento" value={formatDate(app.followUpDate)} />
                ) : null}
                {app.internalNotes ? (
                  <Field label="Notas internas" value={app.internalNotes} />
                ) : null}
                {app.reviewNote ? <Field label="Nota de revisión" value={app.reviewNote} /> : null}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
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
              />
            </CardContent>
          </Card>

          {app.partner ? (
            <PublishedPanel app={app} />
          ) : (
            <>
              <ApprovePanel app={app} />
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
          Está en <strong>acuerdo verbal</strong> pero no tiene partner. La función de
          aprobación la va a rechazar para siempre en este estado. Devolvela a{' '}
          <strong>en conversación</strong> y volvé a aprobarla.
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
 * Consultas 2 + 3 del runbook, en un solo acto.
 *
 * En DBeaver son dos pasos y el segundo es "el que se olvida". Acá van en una
 * transacción (`approveApplication` en el repo), así que o pasan los dos o no
 * pasa ninguno.
 */
function ApprovePanel({ app }: { app: ApplicationDetail }) {
  const router = useRouter()
  const [coverageZone, setCoverageZone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmedInvisible, setConfirmedInvisible] = useState(false)

  const wouldBeInvisible = app.resolved.totalServices === 0
  const blocked = wouldBeInvisible && !confirmedInvisible

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await approvePartnerApplication({
        data: { applicationId: app.id, coverageZone: coverageZone.trim() },
      })
      await router.invalidate()
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.includes('inexistente o ya aprobada')
          ? 'La función rechazó la solicitud: no existe o ya fue aprobada. Si está en acuerdo verbal sin partner, destrabala primero.'
          : 'No pudimos aprobar la solicitud. No se creó nada — la operación es transaccional.',
      )
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
                Nada de lo declarado matchea una familia activa, así que no se le cargaría
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
              minLength={3}
              maxLength={120}
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
            disabled={busy || blocked || coverageZone.trim().length < 3}
          >
            {busy
              ? 'Aprobando…'
              : wouldBeInvisible
                ? 'Aprobar igual'
                : `Aprobar y cargar ${app.resolved.totalServices} rubros`}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
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

function ChipList({ label, items }: { label: string; items: Array<string> }) {
  return (
    <div>
      <div className="mb-1.5 text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {items.length === 0 ? (
        <span className="text-sm text-muted-foreground">—</span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <span
              key={item}
              className="rounded-md border border-border bg-secondary px-2 py-0.5 text-xs"
            >
              {item}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
