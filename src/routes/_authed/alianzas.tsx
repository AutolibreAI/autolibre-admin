import { createFileRoute } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'
import { getAllianceDashboardsFn } from '~/fn/alliance-dashboards'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'

/**
 * Alianzas (`/alianzas`) — los tableros de control de cada alianza en un solo
 * lugar. Hoy son ACCESOS: ninguna alianza expone API ni export.
 * → `~/lib/alliance-dashboards`
 *
 * `ssr: 'data-only'`: el link de un tablero sin login no tiene por qué quedar en
 * el HTML del servidor; viaja como dato del loader (que ya es sólo para admins).
 */
export const Route = createFileRoute('/_authed/alianzas')({
  ssr: 'data-only',
  loader: () => getAllianceDashboardsFn(),
  head: () => ({ meta: [{ title: 'Alianzas — AutoLibre' }] }),
  component: AlliancesPage,
})

function AlliancesPage() {
  const dashboards = Route.useLoaderData()
  return (
    <>
      <PageHeader
        title="Tableros de alianzas"
        subtitle="Cómo va cada alianza (los «tableros de partners» del pedido). Por ahora son accesos: ninguna expone API ni export."
        actions={<SsrTag>ssr: data-only</SsrTag>}
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {dashboards.map((d) => (
          <Card key={d.key} className="shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{d.name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="text-muted-foreground">{d.what}</p>
              <p className="text-xs text-muted-foreground">{d.access}</p>
              {d.url ? (
                <Button asChild size="sm" variant="outline" className="shadow-none">
                  <a href={d.url} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer">
                    Abrir tablero <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                </Button>
              ) : d.missingEnv ? (
                <p className="text-xs text-status-yellow">
                  Falta configurar <code>{d.missingEnv}</code> en las variables del servidor (Vercel).
                </p>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  )
}
