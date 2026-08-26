import { createFileRoute } from '@tanstack/react-router'
import { getCategoryCounts } from '~/fn/records'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Card, CardContent } from '~/components/ui/card'
import type { CategoryCount } from '~/lib/types'

export const Route = createFileRoute('/_authed/analytics')({
  /**
   * SSR MODE: 'data-only'.
   *
   * The loader still runs on the server during the document request and its
   * result is serialized into the streamed HTML — no client fetch waterfall, no
   * loading flash after hydration. What is skipped is server-*rendering this
   * route's component*.
   *
   * Why that trade fits this route:
   *  - It is behind auth, so no crawler sees it. Server-rendered markup buys
   *    nothing for SEO or link previews.
   *  - Whoever reaches it is already inside a hydrated shell, so pre-rendered
   *    markup barely moves first paint.
   *  - Visualisations are markup-heavy relative to their data. Rendering them
   *    server-side spends CPU and response bytes on nodes that are immediately
   *    reconciled away.
   *
   * The inverse holds for /records: content-heavy, often the first paint of a
   * session, so it stays on full SSR. This choice is per route — the document,
   * the shell and the `_authed` chrome around this outlet are all still
   * server-rendered.
   */
  ssr: 'data-only',

  loader: ({ abortController }) => getCategoryCounts({ signal: abortController.signal }),

  head: () => ({ meta: [{ title: 'Analítica — AutoLibre' }] }),
  component: Analytics,
})

function Analytics() {
  const rows = Route.useLoaderData()

  return (
    <>
      <PageHeader
        title="Analítica"
        subtitle="Distribución de registros por categoría."
        actions={<SsrTag>ssr: data-only</SsrTag>}
      />

      <Card>
        <CardContent className="pt-6">
          <BarList rows={rows} />
        </CardContent>
      </Card>
    </>
  )
}

function BarList({ rows }: { rows: Array<CategoryCount> }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Sin datos.</p>

  const max = Math.max(...rows.map((r) => r.count))

  return (
    <ul className="space-y-2.5">
      {rows.map((row) => (
        <li key={row.category} className="grid grid-cols-[9rem_1fr_3rem] items-center gap-3">
          <span className="truncate text-sm">{row.category}</span>
          <span className="h-2.5 overflow-hidden rounded-full bg-secondary">
            <span
              className="block h-full rounded-full bg-brand"
              style={{ width: `${(row.count / max) * 100}%` }}
            />
          </span>
          <span className="text-right text-sm">{row.count}</span>
        </li>
      ))}
    </ul>
  )
}
