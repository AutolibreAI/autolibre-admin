import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { ArrowLeft, Car, User } from 'lucide-react'
import {
  ACTIVITY_KIND_LABELS,
  isActivityDetailKind,
  type ActivityEventDetail,
} from '~/lib/activity-feed'
import { getAppActivityEvent } from '~/fn/activity-feed'
import { OutcomeBadge } from '~/components/ActivityCells'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { formatDate, formatDateTime } from '~/lib/format'

export const Route = createFileRoute('/_authed/actividad/$activityKind/$activityId')({
  loader: async ({ params, abortController }) => {
    /**
     * El tipo se valida ACÁ y no en el componente: `/actividad/chat/<uuid>` no
     * existe a propósito —un chat lo abre `/chats/:id`, que muestra la
     * conversación entera— y tiene que dar 404, no una ficha a medias. El enum
     * de `getAppActivityEvent` lo revalida del lado del servidor.
     */
    if (!isActivityDetailKind(params.activityKind)) throw notFound()

    const event = await getAppActivityEvent({
      data: { activityKind: params.activityKind, activityId: params.activityId },
      signal: abortController.signal,
    }).catch((cause: unknown) => {
      if (cause instanceof Error && cause.message.startsWith('NOT_FOUND:')) return null
      throw cause
    })

    if (!event) throw notFound()
    return event
  },

  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `${ACTIVITY_KIND_LABELS[loaderData.kind]} — Actividad`
          : 'Actividad',
      },
    ],
  }),

  component: ActivityEventScreen,
})

/**
 * La ficha de un evento que NO tiene pantalla dueña en el panel.
 *
 * Los que sí la tienen (chat, escaneo, documentos, pedido, alta de usuario)
 * nunca llegan acá: el listado los manda directo a esa pantalla, que muestra
 * mucho más que esto. Repetirlas acá sería una pantalla que no reemplaza
 * ninguna consulta — la premisa que el `CLAUDE.md` pone como condición para que
 * una pantalla exista.
 *
 * Lo que esta ficha SÍ reemplaza es el `select * from <tabla> where id = '…'`
 * que hoy es la única forma de ver qué tiene esa fila, más los dos joins
 * (usuario, vehículo) que hacen falta para entenderla.
 */
function ActivityEventScreen() {
  const e = Route.useLoaderData()

  return (
    <>
      <Link
        to="/actividad"
        className="mb-3 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Actividad
      </Link>

      <PageHeader
        title={ACTIVITY_KIND_LABELS[e.kind]}
        subtitle={`${e.userName ?? e.userEmail ?? 'sin usuario'} · ${formatDateTime(e.occurredAt)} UTC`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <FieldsCard event={e} />

        <div className="space-y-4">
          <UserCard event={e} />
          {e.vehicleId ? <VehicleCard event={e} /> : null}
        </div>
      </div>
    </>
  )
}

function FieldsCard({ event: e }: { event: ActivityEventDetail }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
        <CardTitle className="text-base">Qué quedó registrado</CardTitle>
        {e.outcome ? <OutcomeBadge code={e.outcome} /> : null}
      </CardHeader>
      <CardContent>
        {e.fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            La fila existe y no tiene ningún campo cargado además de su fecha.
          </p>
        ) : (
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {e.fields.map((f) => (
              <div key={f.label} className="min-w-0">
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {f.label}
                </dt>
                <dd className="mt-0.5 break-words text-sm">{renderValue(f)}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * El SQL declara QUÉ es el valor (`kind`) y el formato humano se pone acá, con
 * los formateadores de `~/lib/format` — los mismos de todo el panel, con la zona
 * pineada en UTC. Un `to_char` con el formato final adentro de la consulta daría
 * una fecha que se ve distinta al resto en cuanto alguien toque uno de los dos
 * lados.
 */
function renderValue(field: ActivityEventDetail['fields'][number]) {
  if (field.value === null) return <span className="text-muted-foreground/50">—</span>
  if (field.kind === 'date') return formatDate(field.value)
  if (field.kind === 'datetime') return `${formatDateTime(field.value)} UTC`
  return field.value
}

function UserCard({ event: e }: { event: ActivityEventDetail }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <User className="size-4 text-muted-foreground" aria-hidden />
          Quién
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {e.userId ? (
          <>
            <Link
              to="/usuarios/$userId"
              params={{ userId: e.userId }}
              className="block rounded text-sm font-medium outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {e.userName ?? e.userEmail}
            </Link>
            {e.userName && e.userEmail ? (
              <p className="break-all text-xs text-muted-foreground">{e.userEmail}</p>
            ) : null}
            {e.userRole && e.userRole !== 'user' ? (
              <p className="text-xs text-muted-foreground">rol: {e.userRole}</p>
            ) : null}
            <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
              La ficha del usuario tiene el censo entero de lo que tiene cargado.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Sin usuario asociado.</p>
        )}
      </CardContent>
    </Card>
  )
}

function VehicleCard({ event: e }: { event: ActivityEventDetail }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Car className="size-4 text-muted-foreground" aria-hidden />
          Sobre qué auto
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <p className="font-mono text-sm font-medium tracking-wide">
          {e.vehiclePlate ?? <span className="font-sans text-muted-foreground/50">sin patente</span>}
        </p>
        <p className="text-sm text-muted-foreground">
          {e.vehicleLabel ?? 'sin modelo de catálogo'}
        </p>
        {e.vehicleArchived ? <p className="text-xs text-status-yellow">archivado</p> : null}
        {/*
          No hay link: el panel todavía no tiene ficha de vehículo. `/vehiculos/listado`
          es el padrón entero, y mandar ahí con la patente en `q` sería un link que
          promete una ficha y entrega un filtro.
        */}
      </CardContent>
    </Card>
  )
}
