import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { listNotificationCampaigns } from '~/fn/notifications'
import { MockBanner } from '~/components/MockBanner'
import { PageHeader, SsrTag } from '~/components/PageHeader'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { fetchNotificationEffectMock } from '~/mocks/notification-effect'
import { formatDateTime, formatInt } from '~/lib/format'
import {
  EFFECT_ACTIONS,
  EFFECT_ACTION_LABELS,
  EFFECT_WINDOWS,
  lift,
  rate,
  windowClosed,
} from '~/lib/notification-effect'
import { cn } from '~/lib/utils'
import type { CampaignListItem } from '~/lib/campaigns'
import type { EffectAction, NotificationEffect } from '~/lib/notification-effect'

/**
 * Efecto de cada envío: conversión a 24 h / 72 h / 7 días a una acción
 * objetivo, contra la misma audiencia en el período anterior.
 *
 * Los envíos (fecha, mensaje, alcanzados) son REALES, de
 * `listNotificationCampaigns`. La conversión es de ejemplo
 * (`~/mocks/notification-effect`): no hay registro de envíos con audiencia
 * congelada ni consulta por ventana. Las celdas de ejemplo van en cursiva.
 *
 * `ssr: 'data-only'`: si una ventana ya cerró depende del reloj del
 * navegador; renderizarlo en el servidor daría un mismatch de hidratación.
 */
export const Route = createFileRoute('/_authed/notificaciones/envios/efecto')({
  ssr: 'data-only',
  loader: ({ abortController }) => listNotificationCampaigns({ data: {}, signal: abortController.signal }),
  head: () => ({ meta: [{ title: 'Envíos · Efecto — AutoLibre' }] }),
  component: EffectPage,
})

const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1).replace('.', ',')} %`)

function EffectPage() {
  const campaigns = Route.useLoaderData()
  const sent = campaigns.filter((c) => c.sentAt !== null)

  return (
    <>
      <Link
        to="/notificaciones/envios"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Envíos
      </Link>

      <PageHeader
        title="Efecto de cada envío"
        subtitle={`${formatInt(sent.length)} envíos ya salidos · canal push`}
        actions={<SsrTag>ssr: data-only</SsrTag>}
      />

      <MockBanner
        items={[
          'Fecha, mensaje y alcanzados son reales. La conversión y la base de comparación son de ejemplo (en cursiva).',
          'Falta en el backend: el registro de cada envío con la audiencia congelada y la acción objetivo, y la consulta de conversión por ventana.',
        ]}
      />

      {sent.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-6 py-16 text-center text-sm text-muted-foreground">
          Todavía no salió ningún envío.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table className="min-w-[1080px]">
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Canal</TableHead>
                <TableHead>Mensaje</TableHead>
                <TableHead>Acción objetivo</TableHead>
                <TableHead className="text-right">Alcanzados</TableHead>
                <TableHead className="text-right">Sin hacerla antes</TableHead>
                {EFFECT_WINDOWS.map((w) => (
                  <TableHead key={w.key} className="text-right">
                    {w.label}
                  </TableHead>
                ))}
                <TableHead className="text-right">Base 7 días antes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sent.map((c) => (
                <EffectRow key={c.broadcastId} campaign={c} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="mt-3 max-w-3xl space-y-1 text-xs text-muted-foreground">
        <p>
          Conversión = de los alcanzados que no habían hecho la acción antes del envío, qué % la hizo dentro de
          la ventana. Entre paréntesis, la diferencia en puntos contra la base: la misma audiencia, en una
          ventana del mismo largo justo antes del envío.
        </p>
        <p>
          Sólo cuentan usuarios que ya existían al enviar: las altas posteriores no entran. Es correlación, no
          causa. Una ventana que todavía no cerró dice «en curso».
        </p>
      </div>
    </>
  )
}

function EffectRow({ campaign: c }: { campaign: CampaignListItem }) {
  const [action, setAction] = useState<EffectAction>('vehicle')
  const [effect, setEffect] = useState<NotificationEffect | null>(null)
  const now = useMemo(() => new Date(), [])

  useEffect(() => {
    let cancelled = false
    setEffect(null)
    void fetchNotificationEffectMock(c.broadcastId, action, c.recipients).then((e) => {
      if (!cancelled) setEffect(e)
    })
    return () => {
      cancelled = true
    }
  }, [c.broadcastId, c.recipients, action])

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-sm">
        <Link
          to="/notificaciones/envios/$broadcastId"
          params={{ broadcastId: c.broadcastId }}
          className="hover:underline"
        >
          {formatDateTime(c.sentAt ?? c.scheduledAt)}
        </Link>
      </TableCell>
      <TableCell className="text-sm">Push</TableCell>
      <TableCell className="max-w-xs">
        <p className="truncate text-sm font-medium" title={c.title}>
          {c.title}
        </p>
        <p className="line-clamp-2 text-xs text-muted-foreground" title={c.body}>
          {c.body}
        </p>
      </TableCell>
      <TableCell>
        <Select value={action} onValueChange={(v) => setAction(v as EffectAction)}>
          <SelectTrigger className="h-8 w-44" aria-label="Acción objetivo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EFFECT_ACTIONS.map((a) => (
              <SelectItem key={a} value={a}>
                {EFFECT_ACTION_LABELS[a]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(c.recipients)}</TableCell>
      <TableCell className="text-right tabular-nums italic">
        {effect ? formatInt(effect.eligible) : '…'}
      </TableCell>
      {EFFECT_WINDOWS.map((w) => {
        const closed = windowClosed(c.sentAt ?? c.scheduledAt, w.hours, now)
        const l = effect ? lift(effect, w.key) : null
        return (
          <TableCell key={w.key} className="text-right tabular-nums italic">
            {!effect ? (
              '…'
            ) : !closed ? (
              <span className="not-italic text-muted-foreground">en curso</span>
            ) : (
              <>
                {pct(rate(effect.converted[w.key], effect.eligible))}
                {l !== null ? (
                  <span className={cn('ml-1 text-xs', l < 0 && 'text-status-red')}>
                    ({l >= 0 ? '+' : ''}
                    {l.toFixed(1).replace('.', ',')})
                  </span>
                ) : null}
              </>
            )}
          </TableCell>
        )
      })}
      <TableCell className="text-right tabular-nums italic">
        {effect ? pct(rate(effect.baselineConverted.d7, effect.baselineEligible)) : '…'}
      </TableCell>
    </TableRow>
  )
}
