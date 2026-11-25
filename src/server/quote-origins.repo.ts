import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { notDuplicatePredicate, quoteRequestsAvailability } from './quote-requests.repo'
import type { QuoteOriginWeekly } from '~/lib/quote-origins'

/**
 * Pedidos por origen, por semana (lunes, hora de Buenos Aires) — el reporte de
 * la tarjeta «Trazabilidad: registrar de dónde viene cada pedido».
 *
 * El origen sólo existe para lo cargado A MANO (`ops.quote_request_origin`,
 * 036). Lo que entró solo por app, web o WhatsApp no tiene origen declarado:
 * va por su canal, aparte, para no inventar de dónde vino. Un pedido cargado a
 * mano antes de la 036 sale «a mano, sin origen». Sin duplicados ni pruebas.
 */
export async function quoteOriginWeekly(weeks: number): Promise<QuoteOriginWeekly> {
  const avail = await quoteRequestsAvailability({})
  if (!avail.available) return { available: false, originAvailable: false, rows: [] }
  const t = await sqlOne<{ ok: boolean }>(`select to_regclass('ops.quote_request_origin') is not null as ok`)
  const originAvailable = t?.ok === true
  const origin = originAvailable
    ? `(select o.origin from ops.quote_request_origin o where o.quote_request_id = qr.id)`
    : `null::text`
  const rows = await sql<{ week: string; source: string; n: number }>(
    `select to_char(date_trunc('week', qr.created_at at time zone 'America/Argentina/Buenos_Aires'), 'YYYY-MM-DD') as week,
            case
              when (qr.raw_submission->>'source') = 'admin_manual_entry'
                then coalesce('origen:' || ${origin}, 'manual_sin_origen')
              else 'canal:' || qr.channel::text
            end as source,
            count(*)::int as n
       from quote_requests qr
      where ${notDuplicatePredicate('qr.')}
        and qr.created_at >= date_trunc('week', now() at time zone 'America/Argentina/Buenos_Aires') at time zone 'America/Argentina/Buenos_Aires'
                             - make_interval(weeks => $1::int - 1)
      group by 1, 2
      order by 1`,
    [weeks],
  )
  return { available: true, originAvailable, rows: rows.map((r) => ({ week: r.week, source: r.source, count: Number(r.n) })) }
}
