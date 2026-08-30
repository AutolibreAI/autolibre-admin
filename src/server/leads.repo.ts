import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import type { LeadListItem, LeadSearch, LeadSource, LeadStatus } from '~/lib/leads'

/**
 * Leads — el embudo usuario → taller.
 *
 * ── Qué reemplaza ───────────────────────────────────────────────────────────
 *
 * El `UPDATE leads SET status = …` a mano que el propio backend designó en
 * `lead-status.vo.ts`: *"el resto del recorrido lo mueve el equipo desde SQL"*.
 * No hay caso de uso en el backend que mueva un lead — `submit-lead` lo crea en
 * `new` y ahí termina. Sin esta pantalla el embudo entero es inalcanzable.
 *
 * La lectura arma su SQL acá; la ESCRITURA pasa por `ops.advance_lead`, porque
 * es la única forma de que el cambio y su fila de auditoría en `ops.action_log`
 * no puedan separarse.
 */

const toNum = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)

const toIso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value === null ? null : String(value)

interface LeadRow {
  id: string
  status: LeadStatus
  source: LeadSource
  partner_name: string
  partner_id: string
  user_name: string | null
  user_email: string | null
  vehicle_alias: string | null
  vehicle_plate: string | null
  lost_reason: string | null
  note: string | null
  created_at: Date
  contacted_at: Date | null
  won_at: Date | null
  hours_to_contact: string | null
  stale: boolean
}

/**
 * El listado.
 *
 * ── El orden pone los sin contactar arriba, y no es cosmético ───────────────
 *
 * Mismo criterio que el listado de partners, que pone los de cero rubros
 * primero: una lista ordenada sólo por fecha esconde lo urgente en el medio, y
 * eso es exactamente lo que hace que un modo de falla pase desapercibido. Acá
 * lo urgente es un lead sin contactar — plata que se está yendo.
 *
 * ── `hours_to_contact` cuenta contra `now()` cuando todavía no hubo contacto ─
 *
 * Así la columna dice "hace cuánto que este lead espera", que es la pregunta
 * que se acciona. Dejarla en NULL hasta que alguien conteste haría que
 * justamente los casos peores no tengan número.
 */
export async function listLeads(
  search: LeadSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<LeadListItem>> {
  void opts.signal // `pg` no acepta AbortSignal; queda documentado el hueco.

  const rows = await sql<LeadRow>(
    `SELECT l.id, l.status::text AS status, l.source::text AS source,
            p.name AS partner_name, p.id AS partner_id,
            u.name AS user_name, u.email AS user_email,
            nullif(btrim(coalesce(v.alias, '')), '') AS vehicle_alias,
            v.plate AS vehicle_plate,
            l.lost_reason, l.note, l.created_at, l.contacted_at, l.won_at,
            extract(epoch FROM (coalesce(l.contacted_at, now()) - l.created_at)) / 3600.0
              AS hours_to_contact,
            (l.status = 'new' AND l.created_at < now() - interval '48 hours') AS stale
       FROM leads l
       JOIN partners p ON p.id = l.partner_id
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN vehicles v ON v.id = l.vehicle_id
      WHERE ($1::lead_status IS NULL OR l.status = $1)
        AND ($2::boolean OR l.status IN ('new', 'contacted'))
        AND ($3::text IS NULL OR p.name ILIKE '%' || $3 || '%'
                              OR u.email ILIKE '%' || $3 || '%'
                              OR u.name  ILIKE '%' || $3 || '%')
      ORDER BY (l.status = 'new') DESC, l.created_at DESC
      LIMIT 200`,
    [search.status ?? null, search.closed === 'show', search.q ?? null],
  )

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    source: r.source,
    partnerName: r.partner_name,
    partnerId: r.partner_id,
    userName: r.user_name,
    userEmail: r.user_email,
    // El alias que le puso el dueño gana sobre la patente: es como el operador
    // lo va a nombrar por teléfono. La patente queda de respaldo.
    vehicleLabel: r.vehicle_alias ?? r.vehicle_plate ?? null,
    lostReason: r.lost_reason,
    note: r.note,
    createdAt: toIso(r.created_at) as string,
    contactedAt: toIso(r.contacted_at),
    wonAt: toIso(r.won_at),
    hoursToContact: toNum(r.hours_to_contact),
    stale: r.stale,
  }))
}

/**
 * Mover un lead por el embudo, vía `ops.advance_lead`.
 *
 * ── Por qué no es un UPDATE desde acá ───────────────────────────────────────
 *
 * Dos motivos, y el segundo es el que no se ve:
 *
 *  1. AUDITORÍA. El SP escribe `ops.action_log` en la misma unidad de trabajo.
 *     Un UPDATE acá más un INSERT de log serían dos sentencias separables, y el
 *     modo de falla es el peor: el cambio queda y el registro de quién lo hizo
 *     no.
 *
 *  2. `idx_leads_open_user_partner_vehicle_unique`. Es un índice UNIQUE PARCIAL
 *     sobre `(user_id, partner_id, coalesce(vehicle_id, '000…'))` donde
 *     `status IN ('new','contacted')`. REABRIR un lead cerrado puede chocarlo si
 *     mientras tanto se abrió otro para el mismo trío. El SP captura esa
 *     violación y la traduce a `LEAD_ALREADY_OPEN` con una explicación; sin eso,
 *     la pantalla mostraría el texto crudo de Postgres con el nombre del índice,
 *     que no le dice nada a quien está atendiendo el lead.
 *
 * Cerrar (→ won/lost) siempre se puede: saca la fila del índice parcial.
 */
export async function advanceLead(
  input: { leadId: string; status: string; lostReason?: string; note?: string },
  actorId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ id: string; status: LeadStatus }> {
  void opts.signal

  const row = await sqlOne<{ l: { id: string; status: LeadStatus } }>(
    'SELECT ops.advance_lead($1, $2, $3, $4, $5) AS l',
    [
      input.leadId,
      input.status,
      actorId,
      input.lostReason ?? null,
      input.note ?? null,
    ],
  )
  if (!row) throw new Error(`NOT_FOUND:${input.leadId}`)
  return { id: row.l.id, status: row.l.status }
}
