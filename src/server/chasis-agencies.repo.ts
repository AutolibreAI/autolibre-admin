import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import {
  AGENCY_LIST_LIMIT,
  AGENCY_STATUSES,
  CLOSED_AGENCY_STATUSES,
  toSpAgencyInteraction,
  toSpAgencyPatch,
} from '~/lib/chasis-agencies'
import type {
  AddAgencyInteractionInput,
  AgencyInteraction,
  AgencyObjection,
  AgencyOfferedModel,
  AgencyPatch,
  AgencySearch,
  AgencyStatus,
  AgencySummary,
  ChasisAgency,
  CreateAgencyInput,
  DataInterest,
  IntegrationMode,
} from '~/lib/chasis-agencies'
import type { InteractionChannel, Reaction } from '~/lib/partner-prospects'

/**
 * API Chasis — `ops.chasis_agency` y sus charlas (migración 031).
 *
 * Las escrituras son SÓLO llamadas a los SP de la 031 (auditoría en
 * `ops.action_log`, teléfono normalizado, Carbufy). Si aparece un
 * `INSERT/UPDATE ops.chasis_agency` suelto acá, está mal. El SQL de las
 * escrituras está copiado LITERAL en la integración de `031_ops_api_chasis.test.sql`.
 */

const toInt = (v: unknown): number => Number(v ?? 0)
const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''))

const TODAY_BA = `(now() at time zone 'America/Argentina/Buenos_Aires')::date`
const CLOSED_SQL = `(${CLOSED_AGENCY_STATUSES.map((s) => `'${s}'`).join(', ')})`

/** ¿Está la 031? Mismo guard por `to_regclass` que el resto de `ops`. */
export async function chasisAgenciesAvailable(): Promise<boolean> {
  const row = await sqlOne<{ ok: boolean }>(`select to_regclass('ops.chasis_agency') is not null as ok`)
  return row?.ok === true
}

interface AgencyRow {
  id: string
  name: string
  contact_name: string | null
  phone: string | null
  phone_digits: string | null
  locality: string | null
  talked_to_decider: boolean | null
  uses_carbufy: boolean | null
  use_case: string | null
  data_interests: Array<string> | null
  data_interests_other: string | null
  monthly_volume: number | null
  current_solution: string | null
  current_provider: string | null
  integration_mode: string | null
  other_interest: string | null
  has_workshop: boolean | null
  status: string
  discard_reason: string | null
  referral_loaded: boolean
  owner_id: string | null
  next_step: string | null
  last_contact_on: string | null
  next_follow_up_on: string | null
  follow_up_in_days: number | null
  notes: string | null
  prospect_id: string | null
  prospect_name: string | null
  interaction_count: number
  created_at: Date | string
  updated_at: Date | string
}

/** Fechas como TEXTO (`to_char`): un `date` por `Date` corre el día (`ai-costs.md`). */
const SELECT_FROM = `
  select a.id, a.name, a.contact_name, a.phone, a.phone_digits, a.locality, a.talked_to_decider,
         a.uses_carbufy, a.use_case, a.data_interests, a.data_interests_other, a.monthly_volume,
         a.current_solution, a.current_provider, a.integration_mode, a.other_interest, a.has_workshop,
         a.status, a.discard_reason, a.referral_loaded, a.owner_id, a.next_step,
         to_char(a.last_contact_on, 'YYYY-MM-DD') as last_contact_on,
         to_char(a.next_follow_up_on, 'YYYY-MM-DD') as next_follow_up_on,
         (a.next_follow_up_on - ${TODAY_BA})::int as follow_up_in_days,
         a.notes, a.prospect_id, pp.name as prospect_name,
         (select count(*)::int from ops.chasis_agency_interaction i where i.agency_id = a.id) as interaction_count,
         a.created_at, a.updated_at
    from ops.chasis_agency a
    left join ops.partner_prospect pp on pp.id = a.prospect_id`

function mapRow(r: AgencyRow): ChasisAgency {
  return {
    id: r.id,
    name: r.name,
    contactName: r.contact_name,
    phone: r.phone,
    phoneDigits: r.phone_digits,
    locality: r.locality,
    talkedToDecider: r.talked_to_decider,
    usesCarbufy: r.uses_carbufy,
    useCase: r.use_case,
    dataInterests: (r.data_interests ?? []) as Array<DataInterest>,
    dataInterestsOther: r.data_interests_other,
    monthlyVolume: r.monthly_volume === null ? null : Number(r.monthly_volume),
    currentSolution: r.current_solution,
    currentProvider: r.current_provider,
    integrationMode: r.integration_mode as IntegrationMode | null,
    otherInterest: r.other_interest,
    hasWorkshop: r.has_workshop,
    status: r.status as AgencyStatus,
    discardReason: r.discard_reason,
    referralLoaded: r.referral_loaded === true,
    ownerId: r.owner_id,
    nextStep: r.next_step,
    lastContactOn: r.last_contact_on,
    nextFollowUpOn: r.next_follow_up_on,
    followUpInDays: r.follow_up_in_days === null ? null : Number(r.follow_up_in_days),
    notes: r.notes,
    prospectId: r.prospect_id,
    prospectName: r.prospect_name,
    interactionCount: toInt(r.interaction_count),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  }
}

/** El WHERE de los filtros. `withStatus: false` es el de los contadores (son el desglose por estado). */
function filterWhere(search: Partial<AgencySearch>, params: Array<unknown>, opts: { withStatus: boolean }): string {
  const clauses: Array<string> = []
  if (search.q) {
    params.push(`%${search.q}%`)
    const like = `$${params.length}`
    const digits = search.q.replace(/[^0-9]/g, '')
    let phoneClause = ''
    if (digits.length >= 4) {
      params.push(`%${digits}%`)
      phoneClause = ` or a.phone_digits like $${params.length}`
    }
    clauses.push(`(a.name ilike ${like} or a.contact_name ilike ${like} or a.locality ilike ${like}${phoneClause})`)
  }
  if (opts.withStatus && search.agencyStatus) {
    params.push(search.agencyStatus)
    clauses.push(`a.status = $${params.length}`)
  }
  if (search.agencyZones && search.agencyZones.length > 0) {
    params.push(search.agencyZones)
    clauses.push(`btrim(a.locality) = any($${params.length}::text[])`)
  }
  if (search.agencyOwner === 'none') clauses.push(`a.owner_id is null`)
  else if (search.agencyOwner) {
    params.push(search.agencyOwner)
    clauses.push(`a.owner_id = $${params.length}`)
  }
  return clauses.length > 0 ? `where ${clauses.join(' and ')}` : ''
}

export async function listAgencies(search: AgencySearch): Promise<{ rows: Array<ChasisAgency>; matched: number }> {
  const params: Array<unknown> = []
  const where = filterWhere(search, params, { withStatus: true })
  params.push(AGENCY_LIST_LIMIT)
  const rows = await sql<AgencyRow & { matched: number }>(
    `select s.*, count(*) over () as matched from (${SELECT_FROM} ${where}) s
      order by (s.status in ${CLOSED_SQL}), s.next_follow_up_on asc nulls last, s.name
      limit $${params.length}`,
    params,
  )
  return { rows: rows.map(mapRow), matched: rows.length > 0 ? toInt(rows[0]?.matched) : 0 }
}

/** Agencias abiertas con seguimiento vencido o de hoy: la sección de agencias de "Hoy". */
export async function listDueAgencies(): Promise<Array<ChasisAgency>> {
  const rows = await sql<AgencyRow>(
    `${SELECT_FROM}
      where a.next_follow_up_on <= ${TODAY_BA} and a.status not in ${CLOSED_SQL}
      order by a.next_follow_up_on asc, a.name`,
  )
  return rows.map(mapRow)
}

export async function findAgency(id: string): Promise<ChasisAgency | null> {
  const row = await sqlOne<AgencyRow>(`${SELECT_FROM} where a.id = $1`, [id])
  return row ? mapRow(row) : null
}

export async function listAgencyLocalities(): Promise<Array<string>> {
  const rows = await sql<{ locality: string }>(
    `select distinct btrim(locality) as locality from ops.chasis_agency
      where nullif(btrim(locality), '') is not null order by 1`,
  )
  return rows.map((r) => r.locality)
}

/**
 * El resumen. Las objeciones cuentan agencias DISTINTAS (el número grande) y
 * charlas, igual que el Resumen de Contactos. "Consultas/mes del pipeline" es
 * la suma de `monthly_volume` de las agencias abiertas, con cuántas lo tienen
 * cargado al lado (una suma sin el `n` se lee como completa).
 */
export async function agencySummary(search: Partial<AgencySearch>): Promise<AgencySummary> {
  const params: Array<unknown> = []
  const where = filterWhere(search, params, { withStatus: false })
  const statusCols = AGENCY_STATUSES.map(
    (s) => `count(*) filter (where a.status = '${s}')::int as "st_${s}"`,
  ).join(',\n            ')
  const inFilter = `i.agency_id in (select a.id from ops.chasis_agency a ${where})`

  const [counts, objections, others] = await Promise.all([
    sqlOne<Record<string, unknown>>(
      `select count(*)::int as total,
              ${statusCols},
              count(*) filter (where a.referral_loaded)::int as referrals_loaded,
              count(*) filter (where a.status = 'client' and not a.referral_loaded)::int as clients_without_referral,
              coalesce(sum(a.monthly_volume) filter (where a.status not in ${CLOSED_SQL}), 0)::bigint::text as pipeline_volume,
              count(a.monthly_volume) filter (where a.status not in ${CLOSED_SQL})::int as pipeline_volume_n,
              coalesce(sum(a.monthly_volume) filter (where a.status = 'client'), 0)::bigint::text as client_volume
         from ops.chasis_agency a
         ${where}`,
      params,
    ),
    sql<{ objection: string | null; agencies: number; interactions: number; total: number }>(
      `select i.objection,
              count(distinct i.agency_id)::int as agencies,
              count(*)::int as interactions,
              (sum(count(*)) over ())::int as total
         from ops.chasis_agency_interaction i
        where ${inFilter}
        group by i.objection`,
      params,
    ),
    sql<{ text: string; count: number }>(
      `select min(btrim(i.objection_other)) as text, count(*)::int as count
         from ops.chasis_agency_interaction i
        where ${inFilter} and i.objection = 'other' and i.objection_other is not null
        group by lower(btrim(i.objection_other))
        order by count(*) desc, 1
        limit 10`,
      params,
    ),
  ])

  return {
    total: toInt(counts?.total),
    byStatus: Object.fromEntries(AGENCY_STATUSES.map((s) => [s, toInt(counts?.[`st_${s}`])])) as Record<
      AgencyStatus,
      number
    >,
    referralsLoaded: toInt(counts?.referrals_loaded),
    clientsWithoutReferral: toInt(counts?.clients_without_referral),
    pipelineVolume: toInt(counts?.pipeline_volume),
    pipelineVolumeN: toInt(counts?.pipeline_volume_n),
    clientVolume: toInt(counts?.client_volume),
    interactions: objections.length > 0 ? toInt(objections[0]?.total) : 0,
    objections: objections
      .filter((o) => o.objection !== null)
      .map((o) => ({
        objection: o.objection as AgencyObjection,
        agencies: toInt(o.agencies),
        interactions: toInt(o.interactions),
      }))
      .sort((a, b) => b.agencies - a.agencies || b.interactions - a.interactions),
    otherObjections: others.map((o) => ({ text: o.text, count: toInt(o.count) })),
  }
}

interface InteractionRow {
  id: string
  occurred_at: Date | string
  channel: string
  answered: boolean | null
  talked_to_decider: boolean | null
  offered_model: string | null
  offered_amount: string | null
  reaction: string | null
  questions_answers: string | null
  objection: string | null
  objection_other: string | null
  pitch_notes: string | null
  status_after: string
  discard_reason: string | null
  next_step: string
  next_follow_up_on: string | null
  actor_name: string | null
}

export async function listAgencyInteractions(agencyId: string): Promise<Array<AgencyInteraction>> {
  const rows = await sql<InteractionRow>(
    `select i.id, i.occurred_at, i.channel, i.answered, i.talked_to_decider, i.offered_model,
            i.offered_amount, i.reaction, i.questions_answers, i.objection, i.objection_other,
            i.pitch_notes, i.status_after, i.discard_reason, i.next_step,
            to_char(i.next_follow_up_on, 'YYYY-MM-DD') as next_follow_up_on,
            coalesce(nullif(btrim(u.name), ''), u.email) as actor_name
       from ops.chasis_agency_interaction i
       left join users u on u.id = i.actor_id
      where i.agency_id = $1
      order by i.occurred_at desc, i.created_at desc`,
    [agencyId],
  )
  return rows.map((r) => ({
    id: r.id,
    occurredAt: toIso(r.occurred_at),
    channel: r.channel as InteractionChannel,
    answered: r.answered,
    talkedToDecider: r.talked_to_decider,
    offeredModel: r.offered_model as AgencyOfferedModel | null,
    offeredAmount: r.offered_amount,
    reaction: r.reaction as Reaction | null,
    questionsAnswers: r.questions_answers,
    objection: r.objection as AgencyObjection | null,
    objectionOther: r.objection_other,
    pitchNotes: r.pitch_notes,
    statusAfter: r.status_after as AgencyStatus,
    discardReason: r.discard_reason,
    nextStep: r.next_step,
    nextFollowUpOn: r.next_follow_up_on,
    actorName: r.actor_name,
  }))
}

// ── Escrituras: los SP de la 031 ───────────────────────────────────────────

async function reread(id: string | undefined): Promise<ChasisAgency> {
  const agency = id ? await findAgency(id) : null
  if (!agency) throw new Error('AGENCY_WRITE_FAILED')
  return agency
}

export async function createAgency(input: CreateAgencyInput, actorId: string): Promise<ChasisAgency> {
  const row = await sqlOne<{ r: { id: string } | null }>(
    `SELECT ops.create_chasis_agency(p_actor_id => $1, p_data => $2::jsonb) AS r`,
    [actorId, JSON.stringify(toSpAgencyPatch(input))],
  )
  return reread(row?.r?.id)
}

export async function updateAgency(id: string, patch: AgencyPatch, actorId: string): Promise<ChasisAgency> {
  const row = await sqlOne<{ r: { id: string } | null }>(
    `SELECT ops.update_chasis_agency(p_id => $1, p_actor_id => $2, p_patch => $3::jsonb) AS r`,
    [id, actorId, JSON.stringify(toSpAgencyPatch(patch))],
  )
  return reread(row?.r?.id)
}

export async function addAgencyInteraction(input: AddAgencyInteractionInput, actorId: string): Promise<ChasisAgency> {
  await sqlOne<{ r: unknown }>(
    `SELECT ops.add_chasis_agency_interaction(p_agency_id => $1, p_actor_id => $2, p_data => $3::jsonb) AS r`,
    [input.agencyId, actorId, JSON.stringify(toSpAgencyInteraction(input))],
  )
  return reread(input.agencyId)
}

/**
 * "Crear contacto de proveedor": crea el contacto (o linkea al que ya tiene
 * ese teléfono, sin duplicar). `created = false` = ya existía.
 */
export async function createProspectFromAgency(
  agencyId: string,
  actorId: string,
): Promise<{ prospectId: string; created: boolean }> {
  const row = await sqlOne<{ r: { prospect_id: string; created: boolean } | null }>(
    `SELECT ops.create_prospect_from_chasis_agency(p_agency_id => $1, p_actor_id => $2) AS r`,
    [agencyId, actorId],
  )
  if (!row?.r) throw new Error('AGENCY_WRITE_FAILED')
  return { prospectId: row.r.prospect_id, created: row.r.created === true }
}
