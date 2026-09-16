import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowLeft, Check, Minus } from 'lucide-react'
import {
  CAMPAIGN_OUTCOMES,
  type CampaignDetail,
  type CampaignOutcomeKey,
  type CampaignRecipientRow,
} from '~/lib/campaigns'
import {
  NOTIFICATION_STATE_LABELS,
  NOTIFICATION_STATE_TONE,
  type NotificationStateTone,
} from '~/lib/notifications'
import { getNotificationCampaign } from '~/fn/notifications'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Badge } from '~/components/ui/badge'
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `/notificaciones/envios/:broadcastId` — un envío: a quién le llegó, en qué
 * estado quedó cada fila, y qué hizo cada persona después.
 *
 * ── El uuid se chequea ACÁ, antes de llamar al server function ──────────────
 *
 * `getNotificationCampaign` valida con `z.uuid()` y un valor que no lo sea le
 * hace tirar una excepción — que en una ruta con un parámetro de URL es un 500
 * disfrazado de bug. Un id mal tipeado es un 404 de pantalla, así que el path
 * param se filtra antes y el componente muestra "no existe".
 *
 * SSR heredado (`true`): se llega desde el resultado de un envío o desde un link
 * pegado en un chat.
 */
export const Route = createFileRoute('/_authed/notificaciones/envios/$broadcastId')({
  loader: async ({ params, abortController }): Promise<CampaignDetail | null> =>
    UUID_RE.test(params.broadcastId)
      ? getNotificationCampaign({
          data: { broadcastId: params.broadcastId },
          signal: abortController.signal,
        })
      : null,
  head: () => ({ meta: [{ title: 'Envío — AutoLibre' }] }),
  component: CampaignDetailScreen,
})

const TONE_CLASS: Record<NotificationStateTone, string> = {
  ok: 'bg-status-green-bg text-status-green border-status-green/20',
  warn: 'bg-status-yellow-bg text-status-yellow border-status-yellow/20',
  bad: 'bg-status-red-bg text-status-red border-status-red/20',
  neutral: 'bg-secondary text-muted-foreground border-border',
}

const OUTCOME_LABEL = (key: CampaignOutcomeKey): string =>
  CAMPAIGN_OUTCOMES.find((o) => o.key === key)?.label ?? key

function CampaignDetailScreen() {
  const detail = Route.useLoaderData()
  const { broadcastId } = Route.useParams()

  if (!detail) {
    return (
      <>
        <PageHeader title="Envío" subtitle="No encontrado" actions={<SsrTag>ssr: full</SsrTag>} />
        <div className="rounded-lg border border-border bg-card px-6 py-16 text-center">
          <p className="text-sm font-medium">Ese envío no existe</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
            Ninguna notificación tiene <span className="font-mono text-xs">{broadcastId}</span> como
            origen. Un envío sólo aparece si el backend llegó a crear sus filas.
          </p>
          <Link
            to="/notificaciones/envios"
            className="mt-4 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Volver a los envíos
          </Link>
        </div>
      </>
    )
  }

  const { campaign, outcomes, recipients } = detail

  return (
    <>
      <PageHeader
        title={campaign.title}
        subtitle={`${formatInt(campaign.recipients)} destinatario${campaign.recipients === 1 ? '' : 's'} · ${formatInt(campaign.read)} leída${campaign.read === 1 ? '' : 's'}`}
        actions={<SsrTag>ssr: full</SsrTag>}
      />

      <Link
        to="/notificaciones/envios"
        className="mb-4 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Envíos
      </Link>

      <section className="mb-6 rounded-lg border border-border bg-card p-4">
        <p className="text-sm leading-relaxed">{campaign.body}</p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {campaign.states.map((s) => (
            <Badge
              key={s.state}
              variant="outline"
              className={cn(
                'font-normal tabular-nums',
                TONE_CLASS[NOTIFICATION_STATE_TONE[s.state]],
              )}
            >
              {formatInt(s.count)} {NOTIFICATION_STATE_LABELS[s.state].toLowerCase()}
            </Badge>
          ))}
        </div>

        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <div>
            <dt className="inline">Programado: </dt>
            <dd className="inline tabular-nums text-foreground">
              {formatDateTime(campaign.scheduledAt)} (UTC)
            </dd>
          </div>
          <div>
            <dt className="inline">Primer envío: </dt>
            <dd className="inline tabular-nums text-foreground">
              {campaign.sentAt ? `${formatDateTime(campaign.sentAt)} (UTC)` : 'todavía ninguno'}
            </dd>
          </div>
          <div>
            <dt className="inline">Id del envío: </dt>
            <dd className="inline font-mono text-foreground">{campaign.broadcastId}</dd>
          </div>
        </dl>

        <Link
          to="/notificaciones"
          search={{
            notificationBroadcastId: campaign.broadcastId,
            sort: 'scheduledAt',
            dir: 'desc',
          }}
          className="mt-3 inline-block rounded text-xs font-medium underline decoration-dotted outline-none hover:text-brand focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Ver estas filas en el historial
        </Link>
      </section>

      <section className="mb-6">
        <h2 className="mb-1 font-heading text-base font-semibold">Qué pasó después</h2>
        <p className="mb-3 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          De los que recibieron el envío y <span className="text-foreground">todavía no</span> habían
          hecho cada cosa, cuántos la hicieron después. Se compara contra el momento de SU
          notificación, no contra el del lote.{' '}
          <span className="text-foreground">Es correlación, no causa</span>: no hay grupo de control
          y las seis acciones también pasan solas.
        </p>

        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Acción</TableHead>
                <TableHead className="text-right">No la habían hecho</TableHead>
                <TableHead className="text-right">La hicieron después</TableHead>
                <TableHead>Qué mide</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {outcomes.map((o) => {
                const def = CAMPAIGN_OUTCOMES.find((x) => x.key === o.key)
                const pct =
                  o.pendingBefore > 0 ? Math.round((o.converted / o.pendingBefore) * 100) : null
                return (
                  <TableRow key={o.key}>
                    <TableCell className="text-sm font-medium">{OUTCOME_LABEL(o.key)}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                      {formatInt(o.pendingBefore)}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      <span className={cn(o.converted === 0 && 'text-muted-foreground/60')}>
                        {formatInt(o.converted)}
                      </span>
                      {/* Sin nadie a quien le faltara hacerlo, el % no existe —
                          no es 0%. Mismo criterio que `toNum` con el null. */}
                      <span className="ml-1 text-xs text-muted-foreground">
                        {pct === null ? '—' : `${pct}%`}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[320px] text-xs leading-relaxed text-muted-foreground">
                      {def?.hint}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>

        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-status-yellow">
          Lo que esta pantalla NO puede decir: <strong>cuánto tardaron en leerla</strong> —
          `notifications` guarda que la abrió, pero no cuándo (no hay `read_at`) — ni{' '}
          <strong>con qué condición se eligió la audiencia</strong>, que no se guarda en ninguna
          tabla. Las dos necesitan un cambio de schema, y ninguna se estima con un número plausible.
        </p>
      </section>

      <section>
        <h2 className="mb-3 font-heading text-base font-semibold">
          Destinatarios ({formatInt(recipients.length)})
        </h2>
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Usuario</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Enviada (UTC)</TableHead>
                <TableHead>Qué hizo después</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recipients.map((r) => (
                <RecipientRow key={r.notificationId} recipient={r} />
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </>
  )
}

function RecipientRow({ recipient: r }: { recipient: CampaignRecipientRow }) {
  const did = r.outcomes.filter((o) => o.didAfter && !o.hadBefore)
  const already = r.outcomes.filter((o) => o.hadBefore)

  return (
    <TableRow>
      <TableCell>
        <Link
          to="/usuarios/$userId"
          params={{ userId: r.userId }}
          className="rounded text-sm font-medium outline-none hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {r.name ?? r.email}
        </Link>
        {r.name ? <div className="text-xs text-muted-foreground">{r.email}</div> : null}
      </TableCell>

      <TableCell>
        <Badge
          variant="outline"
          className={cn('font-normal', TONE_CLASS[NOTIFICATION_STATE_TONE[r.state]])}
        >
          {NOTIFICATION_STATE_LABELS[r.state]}
        </Badge>
      </TableCell>

      <TableCell className="text-xs tabular-nums text-muted-foreground">
        {r.sentAt ? formatDateTime(r.sentAt) : <span className="text-muted-foreground/40">sin enviar</span>}
      </TableCell>

      <TableCell className="max-w-[360px]">
        {did.length === 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground/60">
            <Minus className="size-3" aria-hidden />
            nada nuevo
          </span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {did.map((o) => (
              <span
                key={o.key}
                className="inline-flex items-center gap-1 rounded-md border border-status-green/20 bg-status-green-bg px-1.5 py-0.5 text-xs text-status-green"
              >
                <Check className="size-3" aria-hidden />
                {OUTCOME_LABEL(o.key)}
              </span>
            ))}
          </div>
        )}
        {/* Lo que ya tenía va apagado y al pie: es el contexto que hace legible
            la columna de al lado (quien ya tenía auto no podía "cargar uno"),
            no un resultado del envío. */}
        {already.length > 0 ? (
          <div className="mt-1 text-xs text-muted-foreground/60">
            ya tenía: {already.map((o) => OUTCOME_LABEL(o.key).toLowerCase()).join(', ')}
          </div>
        ) : null}
      </TableCell>
    </TableRow>
  )
}
