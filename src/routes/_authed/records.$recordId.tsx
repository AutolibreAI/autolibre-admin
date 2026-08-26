import type { ReactNode } from 'react'
import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { getRecord } from '~/fn/records'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { StatusBadge } from '~/components/StatusBadge'
import { Card, CardContent } from '~/components/ui/card'
import { formatDate } from '~/lib/format'

export const Route = createFileRoute('/_authed/records/$recordId')({
  /**
   * Full SSR: this route has a single required record and the document's
   * `<title>` depends on it, so blocking on the load is the right call. When
   * secondary panels are added here (history, related items, audit log), return
   * them as un-awaited promises and stream them — see the dashboard loader.
   */
  loader: async ({ params, abortController }) => {
    const record = await getRecord({
      data: params,
      signal: abortController.signal,
    }).catch((cause: unknown) => {
      if (cause instanceof Error && cause.message.startsWith('NOT_FOUND:')) return null
      throw cause
    })

    if (!record) throw notFound()
    return record
  },

  // Route data feeding `head()` is only possible because the document itself is
  // server-rendered per request.
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData ? `${loaderData.name} — AutoLibre` : 'Registro — AutoLibre' }],
  }),

  component: RecordDetail,
})

function RecordDetail() {
  const record = Route.useLoaderData()

  return (
    <>
      <Link
        to="/records"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Registros
      </Link>

      <PageHeader title={record.name} subtitle={record.id} actions={<SsrTag>ssr: full</SsrTag>} />

      <div className="grid gap-3.5 sm:grid-cols-3">
        <Fact label="Categoría" value={record.category} />
        <Fact label="Estado" value={<StatusBadge status={record.status} />} />
        <Fact label="Actualizado" value={formatDate(record.updatedAt)} />
      </div>
    </>
  )
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="mt-1.5 text-base font-medium">{value}</div>
      </CardContent>
    </Card>
  )
}
