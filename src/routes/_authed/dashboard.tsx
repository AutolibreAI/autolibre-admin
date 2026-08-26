import { Await, createFileRoute } from '@tanstack/react-router'
import { getCategoryCounts, getSummary } from '~/fn/records'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { PanelSkeleton } from '~/components/Fallbacks'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import type { CategoryCount, Summary } from '~/lib/types'

export const Route = createFileRoute('/_authed/dashboard')({
  head: () => ({ meta: [{ title: 'Inicio — AutoLibre' }] }),

  /**
   * STREAMING SSR.
   *
   * The loader awaits only what the page cannot render without. The slower call
   * is returned as an *un-awaited promise*: Start serializes it into the
   * streamed document, so the shell and the summary flush immediately and the
   * remaining panel arrives in a later chunk that hydrates itself in place.
   *
   * The key property is that both queries start on the server, in parallel.
   * There is no client-side waterfall and no second round trip.
   */
  loader: async ({ abortController }) => {
    const signal = abortController.signal

    // Start the slow one first so it overlaps with the awaited call.
    const categoriesPromise = getCategoryCounts({ signal })
    const summary = await getSummary({ signal })

    return { summary, categoriesPromise }
  },

  component: Dashboard,
})

function Dashboard() {
  const { summary, categoriesPromise } = Route.useLoaderData()

  return (
    <>
      <PageHeader
        title="Inicio"
        subtitle="Resumen general."
        actions={<SsrTag>ssr: full + streaming</SsrTag>}
      />

      <SummaryRow summary={summary} />

      <Card className="mt-5">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Por categoría</CardTitle>
          <SsrTag>streamed</SsrTag>
        </CardHeader>
        <CardContent>
          {/*
            Everything above is in the first flush. `Await` suspends only this
            subtree: the fallback is server-rendered, then replaced when the
            promise settles and its chunk lands.
          */}
          <Await
            promise={categoriesPromise}
            fallback={<PanelSkeleton rows={3} label="Cargando categorías" />}
          >
            {(rows) => <CategoryTable rows={rows} />}
          </Await>
        </CardContent>
      </Card>
    </>
  )
}

function SummaryRow({ summary }: { summary: Summary }) {
  const { byStatus } = summary
  return (
    <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
      <Stat label="Total" value={summary.total} />
      <Stat label="Activos" value={byStatus.active} />
      <Stat label="Pendientes" value={byStatus.pending} />
      <Stat label="Archivados" value={byStatus.archived} />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="mt-1.5 font-heading text-2xl font-bold tracking-tight">{value}</div>
      </CardContent>
    </Card>
  )
}

function CategoryTable({ rows }: { rows: Array<CategoryCount> }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Sin datos.</p>

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Categoría</TableHead>
          <TableHead className="text-right">Cantidad</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.category}>
            <TableCell>{row.category}</TableCell>
            <TableCell className="text-right">{row.count}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
