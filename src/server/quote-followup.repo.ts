import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { INTERNAL_PREDICATE } from './ops.repo'
import { vehicleTextSource } from './quote-requests.repo'
import { availablePieces } from './quote-resolution.repo'
import { FOLLOWUP_SINCE, type FollowupOrder } from '~/lib/quote-followup'

/**
 * Seguimiento de pedidos — lectura (el SQL del prototipo, con los guards del
 * panel) y el envío guardado en `ops.quote_followup_send` (041).
 * → `~/lib/quote-followup`
 */

const BA = 'America/Argentina/Buenos_Aires'

let seen = false
export async function followupSendsAvailable(): Promise<boolean> {
  if (seen) return true
  const row = await sqlOne<{ ok: boolean }>(`select to_regclass('ops.quote_followup_send') is not null as ok`)
  seen = row?.ok === true
  return seen
}

interface Row {
  id: string
  n: number | string
  fecha: string
  status: string
  outcome: string | null
  cierre: string | null
  answered_at: Date | string | null
  nombre: string | null
  tel: string | null
  plate: string | null
  auto: string | null
  servicios: string | null
  descr: string | null
  proposals: Array<{ id: string; partner_id: string | null; name: string }> | null
  elegido: string | null
  sent_at: Date | string | null
  sent_by: string | null
}

const iso = (v: Date | string | null) => (v === null ? null : v instanceof Date ? v.toISOString() : String(v))

export async function listFollowupOrders(): Promise<{ rows: Array<FollowupOrder>; sendsAvailable: boolean }> {
  const [pieces, textSource, sends, extra] = await Promise.all([
    availablePieces(),
    vehicleTextSource(),
    followupSendsAvailable(),
    sqlOne<{ catalog_id: boolean }>(
      `select exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = 'quote_requests'
                         and column_name = 'vehicle_catalog_id') as catalog_id`,
    ),
  ])
  const vehicleText = textSource === 'column' ? `nullif(btrim(qr.vehicle_description), '')` : `null::text`
  const catalog2 = extra?.catalog_id
    ? `(select nullif(btrim(concat_ws(' ', c2.brand, c2.model, c2.year::text)), '') from vehicle_catalogs c2 where c2.id = qr.vehicle_catalog_id)`
    : `null::text`
  const services = pieces.ai
    ? `(select string_agg(s.name, ' + ' order by qs.score desc nulls last)
          from quote_request_services qs join services s on s.id = qs.service_id
         where qs.quote_request_id = qr.id)`
    : `null::text`
  const proposals = pieces.proposals
    ? `(select json_agg(json_build_object('id', p.id, 'partner_id', p.partner_id, 'name', coalesce(pa.name, p.provider_name, '—'))
                        order by p.position nulls last)
          from quote_request_proposals p left join partners pa on pa.id = p.partner_id
         where p.quote_request_id = qr.id and p.withdrawn_at is null)`
    : `null::json`
  const elegido = pieces.proposals
    ? `(select coalesce(pa.name, p.provider_name) from quote_request_proposals p
          left join partners pa on pa.id = p.partner_id where p.id = qr.selected_proposal_id)`
    : `null::text`
  const sendCols = sends
    ? `fs.sent_at, coalesce(nullif(btrim(su.name), ''), su.email) as sent_by`
    : `null::timestamptz as sent_at, null::text as sent_by`
  const sendJoins = sends
    ? `left join ops.quote_followup_send fs on fs.quote_request_id = qr.id
       left join users su on su.id = fs.sent_by`
    : ''
  // `user_outcome = 'pending'` existe en el enum desde la 0122; se compara como texto.
  const rows = await sql<Row>(
    `select qr.id, qr.public_number as n,
            to_char(qr.created_at at time zone '${BA}', 'YYYY-MM-DD') as fecha,
            qr.status::text as status, qr.outcome::text as outcome,
            qr.close_reason_code::text as cierre, qr.answered_at,
            coalesce(nullif(btrim(qr.contact_name), ''), u.name) as nombre,
            coalesce(nullif(btrim(qr.contact_phone), ''), u.phone) as tel,
            qr.plate,
            coalesce(nullif(btrim(concat_ws(' ', vc.brand, vc.model, vc.year::text)), ''), ${catalog2}, ${vehicleText}) as auto,
            ${services} as servicios,
            left(qr.description, 300) as descr,
            ${proposals} as proposals,
            ${elegido} as elegido,
            ${sendCols}
       from quote_requests qr
       left join users u on u.id = qr.user_id
       left join vehicles v on v.id = qr.vehicle_id
       left join vehicle_catalog_specs vs on vs.id = v.vehicle_catalog_spec_id
       left join vehicle_catalogs vc on vc.id = vs.vehicle_catalog_id
       ${sendJoins}
      where qr.created_at >= $1::date
        and coalesce(qr.close_reason_code::text, '') not in ('duplicate', 'resolved', 'cancelled_by_user')
        and coalesce(qr.cancellation_reason::text, '') <> 'created_by_mistake'
        and coalesce(u.role::text, 'user') <> 'admin'
        and not (qr.user_id is not null and ${INTERNAL_PREDICATE})
        and (qr.outcome is null or qr.outcome::text = 'no_response')
        and (qr.user_outcome is null or qr.user_outcome::text = 'pending')
        and coalesce(qr.internal_notes, '') not ilike '%pedido de prueba%'
      order by qr.created_at desc
      limit 2000`,
    [FOLLOWUP_SINCE],
  )
  return {
    sendsAvailable: sends,
    rows: rows.map((r) => ({
      id: r.id,
      n: Number(r.n),
      fecha: r.fecha,
      status: r.status,
      outcome: r.outcome,
      cierre: r.cierre,
      answeredAt: iso(r.answered_at),
      nombre: r.nombre,
      tel: r.tel,
      plate: r.plate,
      auto: r.auto,
      servicios: r.servicios,
      descr: r.descr,
      proposals: (r.proposals ?? []).map((p) => ({ id: p.id, partnerId: p.partner_id, name: p.name })),
      elegido: r.elegido,
      sentAt: iso(r.sent_at),
      sentByName: r.sent_by,
    })),
  }
}

export async function setFollowupSent(ids: ReadonlyArray<string>, sent: boolean, actorId: string): Promise<number> {
  if (!(await followupSendsAvailable())) throw new Error('FOLLOWUP_UNAVAILABLE')
  const row = await sqlOne<{ n: number }>(
    `select ops.set_quote_followup_sent(p_quote_request_ids => $1::uuid[], p_sent => $2, p_actor_id => $3) as n`,
    [ids, sent, actorId],
  )
  return Number(row?.n ?? 0)
}
