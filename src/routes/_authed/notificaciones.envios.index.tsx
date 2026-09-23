import { Link, createFileRoute } from '@tanstack/react-router'
import { campaignSearchSchema, type CampaignListItem } from '~/lib/campaigns'
import {
  NOTIFICATION_STATE_LABELS,
  NOTIFICATION_STATE_TONE,
  type NotificationStateTone,
} from '~/lib/notifications'
import { listNotificationCampaigns } from '~/fn/notifications'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { BroadcastComposer } from '~/components/BroadcastComposer'
import { SortHeader } from '~/components/SortHeader'
import { Badge } from '~/components/ui/badge'
import { SearchInput } from '~/components/SearchInput'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatDateTime, formatInt } from '~/lib/format'
import { cn } from '~/lib/utils'

/**
 * `/notificaciones/envios` — los envíos ad-hoc, uno por fila.
 *
 * Qué reemplaza: **nada, y ahí está el punto.** Hasta ahora el resultado de un
 * envío se veía UNA vez, en el compositor, y se perdía al recargar; para
 * recuperarlo había que acordarse del `broadcastId` y filtrar el historial por
 * él. Un `group by source_id` sobre `notifications` que nadie corría.
 *
 * SSR heredado (`true`), mismo criterio que el historial: se llega acá desde el
 * resultado de un envío o desde un link pegado en un chat, y en los dos casos es
 * el primer pintado.
 */
export const Route = createFileRoute('/_authed/notificaciones/envios/')({
  validateSearch: campaignSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps, abortController }) =>
    listNotificationCampaigns({ data: deps, signal: abortController.signal }),
  head: () => ({ meta: [{ title: 'Envíos — AutoLibre' }] }),
  component: CampaignsList,
})

const TONE_CLASS: Record<NotificationStateTone, string> = {
  ok: 'bg-status-green-bg text-status-green border-status-green/20',
  warn: 'bg-status-yellow-bg text-status-yellow border-status-yellow/20',
  bad: 'bg-status-red-bg text-status-red border-status-red/20',
  neutral: 'bg-secondary text-muted-foreground border-border',
}

function CampaignsList() {
  const campaigns = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const setSearch = (next: Partial<typeof search>) =>
    navigate({ search: { ...search, ...next }, replace: true })

  return (
    <>
      <PageHeader
        title="Envíos"
        subtitle={`${formatInt(campaigns.length)} ${search.q ? 'con esta búsqueda' : 'en total'}`}
        actions={
          <>
            <BroadcastComposer />
            <SsrTag>ssr: full</SsrTag>
          </>
        }
      />

      <div className="mb-4">
        <SearchInput
          id="campaign-q"
          label="Buscar"
          placeholder="Título o texto del mensaje"
          value={search.q}
          onSearch={(q) => setSearch({ q })}
          className="w-full sm:w-72"
        />
      </div>

      {campaigns.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-6 py-16 text-center">
          <p className="text-sm font-medium">Todavía no hay envíos</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
            Un envío aparece acá apenas el backend crea sus notificaciones. Acá sólo salen los
            ad-hoc: los avisos automáticos (vencimientos, multas, diagnósticos) los genera una
            regla y viven en el historial.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <SortHeader
                  label="Envío"
                  sortKey="title"
                  to="/notificaciones/envios"
                  searchKeys={SEARCH_KEYS}
                  active={search.campaignSort === 'title'}
                  dir={search.campaignDir}
                />
                <SortHeader
                  label="Destinatarios"
                  sortKey="recipients"
                  to="/notificaciones/envios"
                  searchKeys={SEARCH_KEYS}
                  align="right"
                  firstClick="desc"
                  active={search.campaignSort === 'recipients'}
                  dir={search.campaignDir}
                />
                <SortHeader
                  label="Leídas"
                  sortKey="read"
                  to="/notificaciones/envios"
                  searchKeys={SEARCH_KEYS}
                  align="right"
                  firstClick="desc"
                  active={search.campaignSort === 'read'}
                  dir={search.campaignDir}
                />
                <TableHead>Estados</TableHead>
                <SortHeader
                  label="Programado (UTC)"
                  sortKey="sentAt"
                  to="/notificaciones/envios"
                  searchKeys={SEARCH_KEYS}
                  firstClick="desc"
                  active={search.campaignSort === 'sentAt'}
                  dir={search.campaignDir}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaigns.map((c) => (
                <CampaignRow key={c.broadcastId} campaign={c} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {campaigns.length === 200 ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Cortado en 200 envíos. Afiná la búsqueda — el listado no pagina, mismo criterio que el
          resto del panel.
        </p>
      ) : null}
    </>
  )
}

/**
 * Las claves de orden de ESTA ruta. Calificadas por dominio porque
 * `/notificaciones` ya usa `sort`/`dir` con otro enum.
 * → `.claude/rules/notifications.md`
 */
const SEARCH_KEYS = { sort: 'campaignSort', dir: 'campaignDir' }

function CampaignRow({ campaign: c }: { campaign: CampaignListItem }) {
  // El % se calcula sobre destinatarios, no sobre entregadas: "de los que
  // eligieron, cuántos la abrieron" es la pregunta del envío. Con el
  // denominador en entregadas, un envío que no le llegó a nadie mostraría 0/0.
  const readPct = c.recipients > 0 ? Math.round((c.read / c.recipients) * 100) : 0

  return (
    <TableRow>
      <TableCell className="max-w-[340px]">
        <Link
          to="/notificaciones/envios/$broadcastId"
          params={{ broadcastId: c.broadcastId }}
          className="rounded text-sm font-medium outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="line-clamp-1">{c.title}</span>
        </Link>
        <div className="line-clamp-1 text-xs text-muted-foreground" title={c.body}>
          {c.body}
        </div>
      </TableCell>

      <TableCell className="text-right text-sm tabular-nums">{formatInt(c.recipients)}</TableCell>

      <TableCell className="text-right text-sm tabular-nums">
        <span className={cn(c.read === 0 && 'text-muted-foreground/60')}>{formatInt(c.read)}</span>
        <div className="text-xs text-muted-foreground">{readPct}%</div>
      </TableCell>

      <TableCell>
        <div className="flex flex-wrap gap-1">
          {c.states.map((s) => (
            <Badge
              key={s.state}
              variant="outline"
              className={cn('font-normal tabular-nums', TONE_CLASS[NOTIFICATION_STATE_TONE[s.state]])}
            >
              {formatInt(s.count)} {NOTIFICATION_STATE_LABELS[s.state].toLowerCase()}
            </Badge>
          ))}
        </div>
      </TableCell>

      <TableCell className="text-xs tabular-nums text-muted-foreground">
        <div>{formatDateTime(c.scheduledAt)}</div>
        <div className={cn(!c.sentAt && 'text-muted-foreground/40')}>
          {c.sentAt ? `salió ${formatDateTime(c.sentAt)}` : 'sin enviar'}
        </div>
      </TableCell>
    </TableRow>
  )
}
