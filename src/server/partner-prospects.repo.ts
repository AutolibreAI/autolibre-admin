import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { CLOSED_PROSPECT_STATUSES, PROSPECT_LIST_LIMIT, originSlug, toSpPatch } from '~/lib/partner-prospects'
import type {
  CreateProspectInput,
  ImportResult,
  PartnerMatch,
  PartnerProspect,
  PhoneMatches,
  ProspectOrigin,
  ProspectOwner,
  ProspectPlan,
  ProspectSearch,
  ProspectStatus,
  ProspectSummary,
} from '~/lib/partner-prospects'

/**
 * Seguimiento comercial — `ops.partner_prospect` (migración 024).
 *
 * ── Las escrituras son SÓLO llamadas a los SP de `ops` ─────────────────────
 *
 * La tabla es nuestra y un `INSERT` directo "funcionaría", pero se saltearía
 * `ops.action_log` (la única respuesta a "¿quién cambió esto?") y la
 * normalización del teléfono de la que depende la detección de duplicados. Si
 * aparece un `INSERT/UPDATE ops.partner_prospect` suelto acá, está mal.
 *
 * El SQL de las escrituras está copiado LITERAL en el bloque de integración de
 * `migrations/024_ops_seguimiento_comercial.test.sql`. Si se toca uno, se toca
 * el otro.
 */

const toInt = (v: unknown): number => Number(v ?? 0)
const toIso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : String(v ?? '')

/** "Hoy" es el de Buenos Aires: un seguimiento "para el jueves" vence el jueves de acá. */
const TODAY_BA = `(now() at time zone 'America/Argentina/Buenos_Aires')::date`

const CLOSED_SQL = `(${CLOSED_PROSPECT_STATUSES.map((s) => `'${s}'`).join(', ')})`

// ── Disponibilidad ─────────────────────────────────────────────────────────

/**
 * ¿Está aplicada la 024 en esta base? `to_regclass` y no un try/catch: un
 * catch que se traga errores de SQL termina tragándose los reales. Mismo guard
 * que `quoteResponsesAvailable()`.
 */
export async function partnerProspectsAvailable(): Promise<boolean> {
  const row = await sqlOne<{ ok: boolean }>(
    `select to_regclass('ops.partner_prospect') is not null as ok`,
  )
  return row?.ok === true
}

// ── Lectura ────────────────────────────────────────────────────────────────

interface ProspectRow {
  id: string
  name: string
  phone: string | null
  phone_digits: string | null
  locality: string | null
  short_note: string | null
  category_slugs: Array<string> | null
  origin_slug: string
  status: string
  owner_id: string | null
  talked_to: string | null
  plan: string
  last_contact_on: string | null
  next_follow_up_on: string | null
  follow_up_in_days: number | null
  notes: string | null
  partner_id: string | null
  partner_name: string | null
  partner_status: string | null
  created_at: Date | string
  updated_at: Date | string
}

/**
 * Las fechas salen como TEXTO (`to_char`): un `date` que pasa por `Date` en
 * `pg` queda a medianoche local del proceso y corre el día (`ai-costs.md`).
 *
 * El join a `partners` es `LEFT`: `partner_id` es nullable y sin FK
 * (guardrail 6). Un proveedor borrado deja el contacto con el id y sin nombre.
 */
const SELECT_FROM = `
  select p.id, p.name, p.phone, p.phone_digits, p.locality, p.short_note, p.category_slugs,
         p.origin_slug, p.status, p.owner_id, p.talked_to, p.plan,
         to_char(p.last_contact_on, 'YYYY-MM-DD') as last_contact_on,
         to_char(p.next_follow_up_on, 'YYYY-MM-DD') as next_follow_up_on,
         (p.next_follow_up_on - ${TODAY_BA})::int as follow_up_in_days,
         p.notes, p.partner_id, pa.name as partner_name, pa.status::text as partner_status,
         p.created_at, p.updated_at
    from ops.partner_prospect p
    left join partners pa on pa.id = p.partner_id`

function mapRow(r: ProspectRow): PartnerProspect {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    phoneDigits: r.phone_digits,
    locality: r.locality,
    shortNote: r.short_note,
    categorySlugs: r.category_slugs ?? [],
    originSlug: r.origin_slug,
    status: r.status as ProspectStatus,
    ownerId: r.owner_id,
    talkedTo: r.talked_to,
    plan: r.plan as ProspectPlan,
    lastContactOn: r.last_contact_on,
    nextFollowUpOn: r.next_follow_up_on,
    followUpInDays: r.follow_up_in_days === null ? null : Number(r.follow_up_in_days),
    notes: r.notes,
    partnerId: r.partner_id,
    partnerName: r.partner_name,
    partnerStatus: r.partner_status,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  }
}

/**
 * El WHERE de los filtros. `withStatus: false` arma el de los contadores, que
 * siguen a todo MENOS al estado (son el desglose por estado).
 */
function filterWhere(
  search: ProspectSearch,
  params: Array<unknown>,
  opts: { withStatus: boolean },
): string {
  const clauses: Array<string> = []
  if (search.q) {
    params.push(`%${search.q}%`)
    const like = `$${params.length}`
    const digits = search.q.replace(/[^0-9]/g, '')
    let phoneClause = ''
    if (digits.length >= 4) {
      params.push(`%${digits}%`)
      phoneClause = ` or p.phone_digits like $${params.length}`
    }
    clauses.push(
      `(p.name ilike ${like} or p.locality ilike ${like} or p.talked_to ilike ${like}` +
        ` or p.short_note ilike ${like}${phoneClause})`,
    )
  }
  if (opts.withStatus && search.prospectStatus) {
    params.push(search.prospectStatus)
    clauses.push(`p.status = $${params.length}`)
  }
  if (search.prospectOrigin) {
    params.push(search.prospectOrigin)
    clauses.push(`p.origin_slug = $${params.length}`)
  }
  if (search.prospectRubro) {
    params.push(search.prospectRubro)
    clauses.push(`$${params.length} = any(p.category_slugs)`)
  }
  if (search.prospectOwner === 'none') {
    clauses.push(`p.owner_id is null`)
  } else if (search.prospectOwner) {
    params.push(search.prospectOwner)
    clauses.push(`p.owner_id = $${params.length}`)
  }
  return clauses.length > 0 ? `where ${clauses.join(' and ')}` : ''
}

/**
 * El listado. Corta en `PROSPECT_LIST_LIMIT` y devuelve el total real al lado
 * (`count(*) over ()`, en la MISMA consulta: con una segunda serían dos
 * snapshots). Abiertos primero, por próximo seguimiento; los cerrados al final.
 */
export async function listProspects(
  search: ProspectSearch,
): Promise<{ rows: Array<PartnerProspect>; matched: number }> {
  const params: Array<unknown> = []
  const where = filterWhere(search, params, { withStatus: true })
  params.push(PROSPECT_LIST_LIMIT)
  const rows = await sql<ProspectRow & { matched: number }>(
    `select s.*, count(*) over () as matched from (${SELECT_FROM} ${where}) s
      order by (s.status in ${CLOSED_SQL}), s.next_follow_up_on asc nulls last, s.name
      limit $${params.length}`,
    params,
  )
  return { rows: rows.map(mapRow), matched: rows.length > 0 ? toInt(rows[0]?.matched) : 0 }
}

/** La vista "Hoy": seguimientos vencidos y de hoy, de contactos abiertos, por fecha. */
export async function listTodayFollowUps(): Promise<Array<PartnerProspect>> {
  const rows = await sql<ProspectRow>(
    `${SELECT_FROM}
      where p.next_follow_up_on <= ${TODAY_BA}
        and p.status not in ${CLOSED_SQL}
      order by p.next_follow_up_on asc, p.name`,
  )
  return rows.map(mapRow)
}

export async function findProspect(id: string): Promise<PartnerProspect | null> {
  const row = await sqlOne<ProspectRow>(`${SELECT_FROM} where p.id = $1`, [id])
  return row ? mapRow(row) : null
}

export async function prospectSummary(search: ProspectSearch = {}): Promise<ProspectSummary> {
  const params: Array<unknown> = []
  const where = filterWhere(search, params, { withStatus: false })
  const row = await sqlOne<Record<string, unknown>>(
    `select count(*)::int as total,
            count(*) filter (where p.status <> 'pending')::int as contacted,
            count(*) filter (where p.status = 'interested')::int as interested,
            count(*) filter (where p.status = 'registered')::int as registered,
            count(*) filter (where p.status = 'not_interested')::int as not_interested,
            count(*) filter (where p.next_follow_up_on <= ${TODAY_BA}
                               and p.status not in ${CLOSED_SQL})::int as due_today
       from ops.partner_prospect p
       ${where}`,
    params,
  )
  return {
    total: toInt(row?.total),
    contacted: toInt(row?.contacted),
    interested: toInt(row?.interested),
    registered: toInt(row?.registered),
    notInterested: toInt(row?.not_interested),
    dueToday: toInt(row?.due_today),
  }
}

export async function listProspectOrigins(): Promise<Array<ProspectOrigin>> {
  return sql<ProspectOrigin>(
    `select slug, label from ops.partner_prospect_origin order by position, label`,
  )
}

/**
 * Los comerciales elegibles: los admins con cuenta de Clerk (los únicos que
 * pueden entrar al panel) más quien ya figure como comercial de algún contacto
 * aunque haya dejado de ser admin — si no, su nombre desaparecería de la
 * tarjeta. Sin el corte por `clerk`, DEV traería 876 admins `native`
 * heredados (`CLAUDE.md`).
 */
export async function listProspectOwners(): Promise<Array<ProspectOwner>> {
  return sql<ProspectOwner>(
    `select u.id, coalesce(nullif(btrim(u.name), ''), u.email) as name, u.email
       from users u
      where (u.role = 'admin' and u.auth_provider = 'clerk')
         or u.id in (select owner_id from ops.partner_prospect where owner_id is not null)
      order by 2`,
  )
}

/**
 * Lo que ya existe con alguno de estos teléfonos: contactos (duplicado real,
 * el índice único lo rechazaría) y proveedores del marketplace (ya está
 * registrado: no hace falta salir a buscarlo). El teléfono del proveedor se
 * normaliza con la MISMA función que el del contacto.
 */
export async function findPhoneMatches(phones: ReadonlyArray<string>): Promise<PhoneMatches> {
  if (phones.length === 0) return { prospects: [], partners: [] }
  const [prospects, partners] = await Promise.all([
    sql<{ id: string; name: string; phoneDigits: string }>(
      `select id, name, phone_digits as "phoneDigits"
         from ops.partner_prospect where phone_digits = any($1::text[])`,
      [phones],
    ),
    sql<{ id: string; name: string; phoneDigits: string }>(
      `select id, name, ops.normalize_ar_phone(whatsapp) as "phoneDigits"
         from partners where ops.normalize_ar_phone(whatsapp) = any($1::text[])`,
      [phones],
    ),
  ])
  return { prospects, partners }
}

interface PartnerMatchRow {
  id: string
  name: string
  whatsapp: string | null
  coverage_zone: string | null
  status: string
}

const mapPartner = (r: PartnerMatchRow): PartnerMatch => ({
  id: r.id,
  name: r.name,
  whatsapp: r.whatsapp,
  coverageZone: r.coverage_zone,
  status: r.status,
})

/** Proveedores del marketplace con el mismo teléfono que el contacto. */
export async function suggestPartnersForProspect(id: string): Promise<Array<PartnerMatch>> {
  const rows = await sql<PartnerMatchRow>(
    `select pa.id, pa.name, pa.whatsapp, pa.coverage_zone, pa.status::text as status
       from ops.partner_prospect p
       join partners pa on ops.normalize_ar_phone(pa.whatsapp) = p.phone_digits
      where p.id = $1
      order by (pa.status = 'active') desc, pa.name`,
    [id],
  )
  return rows.map(mapPartner)
}

/** El buscador para vincular: por nombre, o por teléfono si se tipearon dígitos. */
export async function searchPartnersForLink(q: string): Promise<Array<PartnerMatch>> {
  const params: Array<unknown> = [`%${q}%`]
  const digits = q.replace(/[^0-9]/g, '')
  let phoneClause = ''
  if (digits.length >= 6) {
    params.push(`%${digits}%`)
    phoneClause = ` or regexp_replace(coalesce(pa.whatsapp, ''), '[^0-9]', '', 'g') like $2`
  }
  const rows = await sql<PartnerMatchRow>(
    `select pa.id, pa.name, pa.whatsapp, pa.coverage_zone, pa.status::text as status
       from partners pa
      where pa.name ilike $1${phoneClause}
      order by (pa.status = 'active') desc, pa.name
      limit 15`,
    params,
  )
  return rows.map(mapPartner)
}

// ── Escrituras: los SP de `ops` de la migración 024 ─────────────────────────

export async function createProspect(input: CreateProspectInput, actorId: string): Promise<PartnerProspect> {
  const row = await sqlOne<{ r: { id: string } | null }>(
    `SELECT ops.create_partner_prospect(p_actor_id => $1, p_data => $2::jsonb) AS r`,
    [actorId, JSON.stringify(toSpPatch(input))],
  )
  return reread(row?.r?.id)
}

/** Parche: sólo viajan las claves que cambiaron (autoguardado campo por campo). */
export async function updateProspect(
  id: string,
  patch: Parameters<typeof toSpPatch>[0],
  actorId: string,
): Promise<PartnerProspect> {
  const row = await sqlOne<{ r: { id: string } | null }>(
    `SELECT ops.update_partner_prospect(p_id => $1, p_actor_id => $2, p_patch => $3::jsonb) AS r`,
    [id, actorId, JSON.stringify(toSpPatch(patch))],
  )
  return reread(row?.r?.id)
}

export async function importProspects(
  rows: ReadonlyArray<CreateProspectInput>,
  actorId: string,
): Promise<ImportResult> {
  const row = await sqlOne<{
    r: { created: Array<string>; skipped: Array<{ index: number; existing_id: string }> } | null
  }>(
    `SELECT ops.import_partner_prospects(p_actor_id => $1, p_rows => $2::jsonb) AS r`,
    [actorId, JSON.stringify(rows.map((r) => toSpPatch(r)))],
  )
  if (!row?.r) throw new Error('PROSPECT_WRITE_FAILED')
  return {
    created: row.r.created.length,
    skipped: row.r.skipped.map((s) => ({ index: Number(s.index), existingId: s.existing_id })),
  }
}

export async function addProspectOrigin(label: string, actorId: string): Promise<ProspectOrigin> {
  const row = await sqlOne<{ r: ProspectOrigin | null }>(
    `SELECT ops.add_partner_prospect_origin(p_actor_id => $1, p_slug => $2, p_label => $3) AS r`,
    [actorId, originSlug(label), label],
  )
  if (!row?.r) throw new Error('PROSPECT_WRITE_FAILED')
  return { slug: row.r.slug, label: row.r.label }
}

/**
 * El SP devuelve la fila cruda de `ops`; se relee con el SELECT de la pantalla
 * para que la tarjeta reciba lo mismo que pinta (nombre del proveedor
 * vinculado, días al seguimiento contra hoy en Buenos Aires).
 */
async function reread(id: string | undefined): Promise<PartnerProspect> {
  const prospect = id ? await findProspect(id) : null
  if (!prospect) throw new Error('PROSPECT_WRITE_FAILED')
  return prospect
}
