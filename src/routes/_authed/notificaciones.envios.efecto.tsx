import { Link, createFileRoute } from '@tanstack/react-router'
import { getSendTargetMock, setSendTargetMock } from '~/mocks/notification-targets'
import { ArrowLeft } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { getNotificationEffect, listNotificationCampaigns } from '~/fn/notifications'
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
import { formatDateTime, formatInt } from '~/lib/format'
import {
  EFFECT_ACTIONS,
  EFFECT_ACTION_LABELS,
  EFFECT_WINDOWS,
  audienceLooksSelectedByAction,
  effectChannelLabel,
  lift,
  rate,
  windowClosed,
} from '~/lib/notification-effect'
import { cn } from '~/lib/utils'
import type { CampaignListItem } from '~/lib/campaigns'
import type { EffectAction, NotificationEffect } from '~/lib/notification-effect'

/**
 * Efecto de cada envío: conversión a 24 h / 72 h / 7 días a una acción
 * objetivo, contra la misma audiencia en la ventana del mismo largo previa al
 * envío.
 *
 * Desde el 2026-11-03 todo es REAL: los envíos salen de
 * `listNotificationCampaigns` y la conversión de `getNotificationEffect`
 * (`notificationEffect` en `~/server/campaigns.repo`), una consulta por fila y
 * por acción, al montarse la fila o cambiar la acción. Lo único que no se puede
 * es GUARDAR la acción objetivo de cada envío (`targetAction`, pedido al
 * backend). Desde el 06/11/26 el lugar principal de carga es el formulario del
 * envío («Objetivo»); acá se lee de ahí (`~/mocks/notification-targets`, en
 * memoria) y se puede corregir. Sin objetivo cargado, se deduce del texto.
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
const pts = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1).replace('.', ',')}`

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
        subtitle={`${formatInt(sent.length)} envíos ya salidos`}
        actions={<SsrTag>ssr: data-only</SsrTag>}
      />

      <MockBanner
        items={[
          'Todos los números son reales. Lo único que falta en el backend es GUARDAR la acción objetivo de cada envío: se carga en el formulario del envío («Objetivo») o acá por fila, y se pierde al recargar.',
        ]}
      />

      {sent.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-6 py-16 text-center text-sm text-muted-foreground">
          Todavía no salió ningún envío.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table className="min-w-[1160px]">
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
          Conversión = de los alcanzados que ya tenían cuenta y no habían hecho la acción antes del envío,
          cuántos la hicieron dentro de la ventana (cantidad y %). Entre paréntesis, la diferencia en puntos
          contra la base: la misma audiencia, en una ventana del mismo largo que termina en el envío.
        </p>
        <p>
          Sólo cuentan usuarios que ya existían al enviar: las altas posteriores no entran. «Cargar documento»
          es seguro, VTV, cédula o licencia con archivo; «Crear pedido» no cuenta los cerrados como duplicado o
          prueba. Es correlación, no causa. Una ventana que todavía no cerró dice «en curso».
        </p>
        <p>
          <span className="text-status-yellow">⚠ Base sesgada</span>: si casi nadie de la audiencia había hecho
          la acción antes (95 % o más), seguramente se eligió por eso, y en la ventana previa nadie pudo hacerla.
          La base da cerca de 0 por construcción y la diferencia exagera el efecto: mirá el % solo.
        </p>
      </div>
    </>
  )
}

function EffectRow({ campaign: c }: { campaign: CampaignListItem }) {
  const [saved] = useState(() => getSendTargetMock(c.broadcastId))
  const [action, setActionState] = useState<EffectAction>(() => saved ?? guessAction(c))
  const [fromSend, setFromSend] = useState(saved !== null)
  const setAction = (next: EffectAction) => {
    setActionState(next)
    setSendTargetMock(c.broadcastId, next)
    setFromSend(true)
  }
  const [effect, setEffect] = useState<NotificationEffect | null>(null)
  const [error, setError] = useState(false)
  const now = useMemo(() => new Date(), [])

  useEffect(() => {
    let cancelled = false
    setEffect(null)
    setError(false)
    getNotificationEffect({ data: { broadcastId: c.broadcastId, action } })
      .then((e) => {
        if (!cancelled) setEffect(e)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [c.broadcastId, action])

  const biased = effect ? audienceLooksSelectedByAction(effect) : false
  const pending = error ? '×' : '…'

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
      <TableCell className="text-sm">{effect ? effectChannelLabel(effect.channels) : '…'}</TableCell>
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
        <p className="mt-1 text-xs italic text-muted-foreground">
          {fromSend ? 'Objetivo cargado (de ejemplo, en memoria)' : 'Deducido del texto'}
        </p>
        {error ? <p className="mt-1 text-xs text-destructive">No pudimos calcularlo.</p> : null}
        {effect && !effect.available ? (
          <p className="mt-1 text-xs text-muted-foreground">Esta base no tiene pedidos.</p>
        ) : null}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(c.recipients)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {effect ? (
          <>
            {formatInt(effect.eligible)}
            {effect.existed < effect.reached ? (
              <span className="block text-xs text-muted-foreground">
                {formatInt(effect.reached - effect.existed)} sin cuenta al enviar
              </span>
            ) : null}
          </>
        ) : (
          pending
        )}
      </TableCell>
      {EFFECT_WINDOWS.map((w) => {
        const closed = windowClosed(c.sentAt ?? c.scheduledAt, w.hours, now)
        const l = effect ? lift(effect, w.key) : null
        return (
          <TableCell key={w.key} className="text-right tabular-nums">
            {!effect ? (
              pending
            ) : !closed ? (
              <span className="text-muted-foreground">en curso</span>
            ) : (
              <>
                {formatInt(effect.converted[w.key])} · {pct(rate(effect.converted[w.key], effect.eligible))}
                {l !== null ? (
                  <span className={cn('ml-1 text-xs', l < 0 && 'text-status-red', biased && 'text-status-yellow')}>
                    ({pts(l)})
                  </span>
                ) : null}
              </>
            )}
          </TableCell>
        )
      })}
      <TableCell className="text-right tabular-nums">
        {effect ? (
          <>
            {pct(rate(effect.baseline.d7.converted, effect.baseline.d7.eligible))}
            <span className="block text-xs text-muted-foreground">
              {formatInt(effect.baseline.d7.converted)} de {formatInt(effect.baseline.d7.eligible)}
            </span>
            {biased ? <span className="block text-xs text-status-yellow">⚠ base sesgada</span> : null}
          </>
        ) : (
          pending
        )}
      </TableCell>
    </TableRow>
  )
}

/**
 * Acción inicial por palabras del título: sólo elige qué se muestra primero,
 * nunca cambia un número, y la persona la cambia en el selector. Sin match,
 * «Cargar vehículo» como antes.
 */
function guessAction(c: CampaignListItem): EffectAction {
  const t = `${c.title} ${c.body}`.toLowerCase()
  if (/veh[ií]culo|auto\b/.test(t)) return 'vehicle'
  if (/seguro|vtv|c[eé]dula|licencia|documento|p[oó]liza/.test(t)) return 'document'
  if (/pedido|presupuesto|propuesta|necesit/.test(t)) return 'quote_request'
  return 'vehicle'
}
