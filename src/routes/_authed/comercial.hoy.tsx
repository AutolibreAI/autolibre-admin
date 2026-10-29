import { createFileRoute, useRouter } from '@tanstack/react-router'
import { listTodayFollowUpsFn } from '~/fn/partner-prospects'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { ProspectCard, ProspectSummaryTiles } from '~/components/ProspectCards'
import { ProspectComposer } from '~/components/ProspectComposer'
import { ProspectImporter } from '~/components/ProspectImporter'
import { ProspectsUnavailable } from '~/components/ProspectsUnavailable'
import { formatInt } from '~/lib/format'

/**
 * Hoy (`/comercial/hoy`) — los seguimientos vencidos y los del día, de
 * contactos que siguen abiertos, del más viejo al de hoy.
 *
 * Reemplaza el "¿a quién tenía que llamar?" que hoy se contesta recorriendo
 * el tablero de Ruta 2 a ojo, fila por fila, mirando la fecha.
 *
 * SSR completo: "vencido hace N días" lo calcula Postgres contra hoy en Buenos
 * Aires (`followUpInDays`), así que el servidor y el navegador pintan lo mismo.
 */
export const Route = createFileRoute('/_authed/comercial/hoy')({
  loader: () => listTodayFollowUpsFn(),
  head: () => ({ meta: [{ title: 'Hoy · Seguimiento comercial — AutoLibre' }] }),
  component: TodayView,
})

function TodayView() {
  const data = Route.useLoaderData()
  const { user } = Route.useRouteContext()
  const router = useRouter()

  if (!data.available) return <ProspectsUnavailable />

  const overdue = data.rows.filter((r) => (r.followUpInDays ?? 0) < 0).length
  const today = data.rows.length - overdue

  return (
    <>
      <PageHeader
        title="Seguimientos de hoy"
        subtitle={
          data.rows.length === 0
            ? 'No hay seguimientos vencidos ni para hoy.'
            : `${formatInt(overdue)} vencidos · ${formatInt(today)} para hoy`
        }
        actions={
          <>
            <SsrTag>ssr: full</SsrTag>
            <ProspectImporter facets={data.facets} currentUserId={user.id} />
            <ProspectComposer facets={data.facets} currentUserId={user.id} />
          </>
        }
      />

      <ProspectSummaryTiles summary={data.summary} />

      {data.rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          Nada pendiente para hoy. Los próximos seguimientos están en la pestaña Contactos.
        </p>
      ) : (
        <div className="space-y-3">
          {data.rows.map((p) => (
            <ProspectCard
              key={p.id}
              prospect={p}
              facets={data.facets}
              onListChanged={() => void router.invalidate()}
            />
          ))}
        </div>
      )}
    </>
  )
}
