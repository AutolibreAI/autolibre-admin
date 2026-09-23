import { Link, createFileRoute } from '@tanstack/react-router'
import { BellPlus } from 'lucide-react'
import {
  FEEDBACK_WINDOWS,
  FEEDBACK_WINDOW_LABELS,
  feedbackSearchSchema,
  type FeedbackListItem,
  type FeedbackSearch,
} from '~/lib/feedback'
import { listAppFeedback, listFeedbackAppVersions, listFeedbackPlatforms } from '~/fn/feedback'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Chip, FilterGroup } from '~/components/Filters'
import { SearchInput } from '~/components/SearchInput'
import { SortHeader } from '~/components/SortHeader'
import { BroadcastComposer } from '~/components/BroadcastComposer'
import { Button } from '~/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatDate, formatInt } from '~/lib/format'

/**
 * Feedback (`/feedback`).
 *
 * Reemplaza el `select * from feedback order by submitted_at desc` + el join
 * a `users` que hoy nadie corre. → `.claude/rules/feedback.md`.
 */
export const Route = createFileRoute('/_authed/feedback')({
  /**
   * SSR completo, mismo criterio que `/chats`: tabla chica (5 filas al
   * 2026-09-23), sin nada que streamear.
   */
  validateSearch: feedbackSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps, abortController }) => {
    const [rows, platforms, appVersions] = await Promise.all([
      listAppFeedback({ data: deps, signal: abortController.signal }),
      listFeedbackPlatforms(),
      listFeedbackAppVersions(),
    ])
    return { rows, platforms, appVersions }
  },
  head: () => ({ meta: [{ title: 'Feedback — AutoLibre' }] }),
  component: FeedbackList,
})

function FeedbackList() {
  const { rows, platforms, appVersions } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<FeedbackSearch>) =>
    navigate({ search: { ...search, ...next }, replace: true })

  const filtered =
    Boolean(search.q) ||
    Boolean(search.feedbackPlatform) ||
    Boolean(search.feedbackAppVersion) ||
    Boolean(search.userId) ||
    search.feedbackWindow !== 'all'

  return (
    <>
      <PageHeader
        title="Feedback"
        subtitle={`${formatInt(rows.length)} ${filtered ? 'con este filtro' : 'mensajes recibidos'}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <div className="mb-4 flex flex-wrap items-end gap-5">
        <SearchInput
          label="Buscar"
          placeholder="Mensaje, email o nombre"
          value={search.q}
          onSearch={(q) => setSearch({ q })}
        />

        {platforms.length > 1 ? (
          <FilterGroup
            label="Plataforma"
            onClear={search.feedbackPlatform ? () => setSearch({ feedbackPlatform: undefined }) : undefined}
          >
            {platforms.map((p) => (
              <Chip
                key={p}
                active={search.feedbackPlatform === p}
                onClick={() =>
                  setSearch({ feedbackPlatform: search.feedbackPlatform === p ? undefined : p })
                }
              >
                {p}
              </Chip>
            ))}
          </FilterGroup>
        ) : null}

        {appVersions.length > 1 ? (
          <FilterGroup
            label="Versión"
            onClear={search.feedbackAppVersion ? () => setSearch({ feedbackAppVersion: undefined }) : undefined}
          >
            {appVersions.map((v) => (
              <Chip
                key={v}
                active={search.feedbackAppVersion === v}
                onClick={() =>
                  setSearch({ feedbackAppVersion: search.feedbackAppVersion === v ? undefined : v })
                }
              >
                {v}
              </Chip>
            ))}
          </FilterGroup>
        ) : null}

        <FilterGroup label="Ventana">
          {FEEDBACK_WINDOWS.map((w) => (
            <Chip
              key={w}
              active={search.feedbackWindow === w}
              onClick={() => setSearch({ feedbackWindow: w })}
            >
              {FEEDBACK_WINDOW_LABELS[w]}
            </Chip>
          ))}
        </FilterGroup>

        {search.userId ? (
          <FilterGroup label="Usuario" onClear={() => setSearch({ userId: undefined })}>
            <Chip active onClick={() => setSearch({ userId: undefined })}>
              filtrado por uno
            </Chip>
          </FilterGroup>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-6 py-16 text-center">
          <p className="text-sm font-medium">Ningún feedback con este filtro</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <SortHeader label="Fecha" sortKey="submittedAt" active={search.sort === 'submittedAt'} dir={search.dir} to="/feedback" firstClick="desc" />
                <SortHeader label="Usuario" sortKey="user" active={search.sort === 'user'} dir={search.dir} to="/feedback" />
                <SortHeader label="Mensaje" sortKey="messageLength" active={search.sort === 'messageLength'} dir={search.dir} to="/feedback" firstClick="desc" />
                <SortHeader label="Plataforma" sortKey="platform" active={search.sort === 'platform'} dir={search.dir} to="/feedback" />
                <SortHeader label="Versión" sortKey="appVersion" active={search.sort === 'appVersion'} dir={search.dir} to="/feedback" />
                <TableHead>Dispositivo</TableHead>
                <TableHead className="text-right">Responder</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((f) => (
                <FeedbackRow key={f.id} feedback={f} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  )
}

function FeedbackRow({ feedback: f }: { feedback: FeedbackListItem }) {
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-sm tabular-nums text-muted-foreground">
        {formatDate(f.submittedAt)}
      </TableCell>

      <TableCell className="min-w-[180px]">
        <Link
          to="/usuarios/$userId"
          params={{ userId: f.userId }}
          className="rounded text-sm font-medium outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {f.userName ?? f.userEmail}
        </Link>
        {f.userName ? <div className="text-xs text-muted-foreground">{f.userEmail}</div> : null}
        <div className="mt-0.5 text-xs text-muted-foreground/70">
          {formatInt(f.vehicleCount)} {f.vehicleCount === 1 ? 'auto' : 'autos'}
          {' · '}
          {f.lastActivityAt ? `activo el ${formatDate(f.lastActivityAt)}` : 'sin actividad registrada'}
          {f.feedbackCount > 1 ? ` · ${formatInt(f.feedbackCount)} feedbacks` : ''}
        </div>
      </TableCell>

      <TableCell className="max-w-[420px] text-sm">
        <p className="whitespace-pre-wrap break-words">{f.message}</p>
      </TableCell>

      <TableCell className="text-sm text-muted-foreground">
        {f.platform ?? <span className="text-muted-foreground/50">—</span>}
      </TableCell>

      <TableCell className="text-sm text-muted-foreground">
        {f.appVersion ?? <span className="text-muted-foreground/50">—</span>}
      </TableCell>

      <TableCell className="text-xs text-muted-foreground">
        {f.deviceModel ?? '—'}
        {f.osVersion ? ` · ${f.osVersion}` : ''}
      </TableCell>

      <TableCell className="text-right">
        <BroadcastComposer
          presetRecipient={{
            id: f.userId,
            email: f.userEmail,
            name: f.userName,
            pushTokens: f.pushTokenCount,
          }}
          trigger={
            <Button size="sm" variant="outline" className="gap-1.5">
              <BellPlus className="size-3.5" aria-hidden />
              Responder
            </Button>
          }
        />
      </TableCell>
    </TableRow>
  )
}
