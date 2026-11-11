import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import {
  CLOSED_PROSPECT_STATUSES,
  PROSPECT_LIST_LIMIT,
  PROSPECT_STATUSES,
  REGISTERED_PROSPECT_STATUSES,
  originSlug,
  toSpInteraction,
  toSpPatch,
} from '~/lib/partner-prospects'
import type {
  AddInteractionInput,
  ComercialSummary,
  CreateProspectInput,
  ImportResult,
  InteractionChannel,
  Objection,
  OfferedModel,
  PartnerMatch,
  PartnerProspect,
  PhoneMatches,
  PreferredChannel,
  ProspectFront,
  ProspectInteraction,
  ProspectOrigin,
  ProspectOwner,
  ProspectPlan,
  ProspectSearch,
  ProspectStatus,
  ProspectSummarySearch,
  RegistrationCandidate,
  ProspectSummary,
  Reaction,
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
const REGISTERED_SQL = `(${REGISTERED_PROSPECT_STATUSES.map((s) => `'${s}'`).join(', ')})`

/** Los 4 checks de la 030. Una sola expresión para el SELECT, el filtro y el contador. */
const VERIFIED_SQL = `(p.verify_test_response and p.verify_identity and p.verify_payment and p.verify_reputation)`

// ── Disponibilidad ─────────────────────────────────────────────────────────

/**
 * ¿Está aplicada la 024 en esta base? `to_regclass` y no un try/catch: un
 * catch que se traga errores de SQL termina tragándose los reales. Mismo guard
 * que `quoteResponsesAvailable()`.
 *
 * Lo usan también Partners › Propuestas y Sellos, que sólo leen columnas de la
 * 024: siguen andando sin la 030.
 */
export async function partnerProspectsAvailable(): Promise<boolean> {
  const row = await sqlOne<{ ok: boolean }>(
    `select to_regclass('ops.partner_prospect') is not null as ok`,
  )
  return row?.ok === true
}

/**
 * Lo que necesita la pestaña Comercial: la 024 Y la 030. Sin la 030 los
 * estados de la base son los viejos (`pending`, `thinking`…) y la pantalla los
 * leería como desconocidos; en vez de mezclar dos embudos, dice qué falta.
 * `quotes` = existe `public.quote_requests` (del backend), para el `AL-n` del
 * frente "Por pedido".
 */
export async function comercialAvailability(): Promise<{
  has024: boolean
  has030: boolean
  quotes: boolean
  applications: boolean
}> {
  const row = await sqlOne<{ has024: boolean; has030: boolean; quotes: boolean; applications: boolean }>(
    `select to_regclass('ops.partner_prospect') is not null as has024,
            to_regclass('ops.partner_prospect_interaction') is not null as has030,
            to_regclass('public.quote_requests') is not null as quotes,
            to_regclass('public.partner_applications') is not null as applications`,
  )
  return {
    has024: row?.has024 === true,
    has030: row?.has030 === true,
    quotes: row?.quotes === true,
    applications: row?.applications === true,
  }
}

// ── Lectura ────────────────────────────────────────────────────────────────

/**
 * El último contacto comercial de cada PROVEEDOR del directorio: el máximo
 * `last_contact_on` de los contactos de Comercial vinculados a él
 * (`partner_id`). Un proveedor sin contacto vinculado no está en el mapa.
 * Sólo la fecha: ni la nota ni el teléfono del contacto viajan.
 */
export async function listPartnerLastContacts(): Promise<Array<{ partnerId: string; lastContactOn: string }>> {
  if (!(await partnerProspectsAvailable())) return []
  return (
    await sql<{ partner_id: string; last_contact_on: string }>(
      `select partner_id, to_char(max(last_contact_on), 'YYYY-MM-DD') as last_contact_on
         from ops.partner_prospect
        where partner_id is not null and last_contact_on is not null
        group by partner_id`,
    )
  ).map((r) => ({ partnerId: r.partner_id, lastContactOn: r.last_contact_on }))
}


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
  front: string | null
  front_quote_request_id: string | null
  front_quote_number: number | null
  knew_autolibre: boolean | null
  client_acquisition: string | null
  preferred_channel: string | null
  has_capacity: boolean | null
  management_system: string | null
  network: string | null
  verify_test_response: boolean
  verify_identity: boolean
  verify_payment: boolean
  verify_reputation: boolean
  verified: boolean
  discard_reason: string | null
  next_step: string | null
  partner_registered_on: string | null
  interaction_count: number
}

/**
 * Las fechas salen como TEXTO (`to_char`): un `date` que pasa por `Date` en
 * `pg` queda a medianoche local del proceso y corre el día (`ai-costs.md`).
 *
 * El join a `partners` es `LEFT`: `partner_id` es nullable y sin FK
 * (guardrail 6). Un proveedor borrado deja el contacto con el id y sin nombre.
 * Lo mismo el pedido del frente: `quote_requests` es del backend, y si la
 * tabla no existe en esta base el número sale `null` (`quotes = false`).
 *
 * `interaction_count` es subconsulta escalar, no JOIN: un JOIN multiplicaría
 * la fila por cada charla.
 */
function selectFrom(quotes: boolean): string {
  return `
  select p.id, p.name, p.phone, p.phone_digits, p.locality, p.short_note, p.category_slugs,
         p.origin_slug, p.status, p.owner_id, p.talked_to, p.plan,
         to_char(p.last_contact_on, 'YYYY-MM-DD') as last_contact_on,
         to_char(p.next_follow_up_on, 'YYYY-MM-DD') as next_follow_up_on,
         (p.next_follow_up_on - ${TODAY_BA})::int as follow_up_in_days,
         p.notes, p.partner_id, pa.name as partner_name, pa.status::text as partner_status,
         p.created_at, p.updated_at,
         p.front, p.front_quote_request_id,
         ${quotes ? '(select qr.public_number from quote_requests qr where qr.id = p.front_quote_request_id)' : 'null::int'}
           as front_quote_number,
         p.knew_autolibre, p.client_acquisition, p.preferred_channel, p.has_capacity,
         p.management_system, p.network,
         p.verify_test_response, p.verify_identity, p.verify_payment, p.verify_reputation,
         ${VERIFIED_SQL} as verified,
         p.discard_reason, p.next_step,
         to_char(p.partner_registered_on, 'YYYY-MM-DD') as partner_registered_on,
         (select count(*)::int from ops.partner_prospect_interaction i where i.prospect_id = p.id)
           as interaction_count
    from ops.partner_prospect p
    left join partners pa on pa.id = p.partner_id`
}

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
    front: r.front as ProspectFront | null,
    frontQuoteRequestId: r.front_quote_request_id,
    frontQuoteCode: r.front_quote_number === null ? null : `AL-${Number(r.front_quote_number)}`,
    knewAutolibre: r.knew_autolibre,
    clientAcquisition: r.client_acquisition,
    preferredChannel: r.preferred_channel as PreferredChannel | null,
    hasCapacity: r.has_capacity,
    managementSystem: r.management_system,
    network: r.network,
    verifyTestResponse: r.verify_test_response === true,
    verifyIdentity: r.verify_identity === true,
    verifyPayment: r.verify_payment === true,
    verifyReputation: r.verify_reputation === true,
    verified: r.verified === true,
    discardReason: r.discard_reason,
    nextStep: r.next_step,
    partnerRegisteredOn: r.partner_registered_on,
    interactionCount: toInt(r.interaction_count),
  }
}

/**
 * El WHERE de los filtros. `withStatus: false` arma el de los contadores, que
 * siguen a todo MENOS al estado (son el desglose por estado).
 */
function filterWhere(
  search: Partial<ProspectSearch>,
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
  if (search.prospectFront === 'none') {
    clauses.push(`p.front is null`)
  } else if (search.prospectFront) {
    params.push(search.prospectFront)
    clauses.push(`p.front = $${params.length}`)
  }
  // Zona = la localidad cargada, por igualdad: es texto libre y las opciones
  // salen de la misma columna (`listProspectLocalities`). Vacío = todas.
  if (search.prospectZones && search.prospectZones.length > 0) {
    params.push(search.prospectZones)
    clauses.push(`btrim(p.locality) = any($${params.length}::text[])`)
  }
  if (search.prospectVerified) clauses.push(VERIFIED_SQL)
  return clauses.length > 0 ? `where ${clauses.join(' and ')}` : ''
}

/**
 * El listado. Corta en `PROSPECT_LIST_LIMIT` y devuelve el total real al lado
 * (`count(*) over ()`, en la MISMA consulta: con una segunda serían dos
 * snapshots). Abiertos primero, por próximo seguimiento; los cerrados al final.
 */
export async function listProspects(
  search: ProspectSearch,
  quotes: boolean,
): Promise<{ rows: Array<PartnerProspect>; matched: number }> {
  const params: Array<unknown> = []
  const where = filterWhere(search, params, { withStatus: true })
  params.push(PROSPECT_LIST_LIMIT)
  const rows = await sql<ProspectRow & { matched: number }>(
    `select s.*, count(*) over () as matched from (${selectFrom(quotes)} ${where}) s
      order by (s.status in ${CLOSED_SQL}), s.next_follow_up_on asc nulls last, s.name
      limit $${params.length}`,
    params,
  )
  return { rows: rows.map(mapRow), matched: rows.length > 0 ? toInt(rows[0]?.matched) : 0 }
}

/** La vista "Hoy": seguimientos vencidos y de hoy, de contactos abiertos, por fecha. */
/**
 * La vista "Hoy": seguimientos vencidos y de hoy, de contactos abiertos, por
 * fecha. Con `search`, además los filtros de Contactos (lo usa el Resumen); el
 * estado no, porque "abierto" ya es el corte.
 */
export async function listTodayFollowUps(
  quotes: boolean,
  search: Partial<ProspectSearch> = {},
): Promise<Array<PartnerProspect>> {
  const params: Array<unknown> = []
  const where = filterWhere(search, params, { withStatus: false })
  const rows = await sql<ProspectRow>(
    `${selectFrom(quotes)}
      where p.next_follow_up_on <= ${TODAY_BA}
        and p.status not in ${CLOSED_SQL}
        ${where.replace(/^where /, 'and ')}
      order by p.next_follow_up_on asc, p.name`,
    params,
  )
  return rows.map(mapRow)
}

export async function findProspect(id: string, quotes: boolean): Promise<PartnerProspect | null> {
  const row = await sqlOne<ProspectRow>(`${selectFrom(quotes)} where p.id = $1`, [id])
  return row ? mapRow(row) : null
}

export async function prospectSummary(search: Partial<ProspectSearch> = {}): Promise<ProspectSummary> {
  const params: Array<unknown> = []
  const where = filterWhere(search, params, { withStatus: false })
  const row = await sqlOne<Record<string, unknown>>(
    `select count(*)::int as total,
            count(*) filter (where p.status <> 'to_contact')::int as contacted,
            count(*) filter (where p.status = 'interested')::int as interested,
            count(*) filter (where p.status in ${REGISTERED_SQL})::int as registered,
            count(*) filter (where p.status = 'discarded')::int as discarded,
            count(*) filter (where ${VERIFIED_SQL})::int as verified,
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
    discarded: toInt(row?.discarded),
    verified: toInt(row?.verified),
    dueToday: toInt(row?.due_today),
  }
}

// ── Resumen (etapa 2) ──────────────────────────────────────────────────────

/** El día de una charla en Buenos Aires: el rango del Resumen es de días de acá. */
const INTERACTION_DAY_BA = `(i.occurred_at at time zone 'America/Argentina/Buenos_Aires')::date`

/** El primer día del mes actual en Buenos Aires, y el del siguiente. */
const MONTH_START_BA = `date_trunc('month', ${TODAY_BA})::date`
const NEXT_MONTH_START_BA = `(date_trunc('month', ${TODAY_BA}) + interval '1 month')::date`

/**
 * El Resumen. Cuatro consultas, cada una con su pregunta (y su propio
 * snapshot, como los bloques de `/metricas`): los conteos de contactos, las
 * objeciones, los textos de "Otra" y los trabajos/mes. Todas parten del MISMO
 * `filterWhere` de Contactos (sin el estado: los conteos SON el desglose por
 * estado). El rango de fechas acota las charlas y las altas, nunca el estado
 * actual.
 */
export async function comercialSummary(search: ProspectSummarySearch): Promise<ComercialSummary> {
  const prospectParams: Array<unknown> = []
  const prospectWhere = filterWhere(search, prospectParams, { withStatus: false })

  // ── 1. Contactos: estado actual, verificados, altas ──
  const countParams = [...prospectParams]
  let altasPeriodSql = 'null::int'
  if (search.prospectFrom || search.prospectTo) {
    const conds: Array<string> = ['p.partner_registered_on is not null']
    if (search.prospectFrom) {
      countParams.push(search.prospectFrom)
      conds.push(`p.partner_registered_on >= $${countParams.length}::date`)
    }
    if (search.prospectTo) {
      countParams.push(search.prospectTo)
      conds.push(`p.partner_registered_on <= $${countParams.length}::date`)
    }
    altasPeriodSql = `count(*) filter (where ${conds.join(' and ')})::int`
  }
  // Los estados salen de la constante cerrada, nunca del payload: es seguro interpolarlos.
  const statusCols = PROSPECT_STATUSES.map(
    (s) => `count(*) filter (where p.status = '${s}')::int as "st_${s}"`,
  ).join(',\n              ')

  // ── 2–4. Las charlas de esos contactos, dentro del rango ──
  const interactionWhere = (params: Array<unknown>): string => {
    const conds = [`i.prospect_id in (select p.id from ops.partner_prospect p ${prospectWhere})`]
    if (search.prospectFrom) {
      params.push(search.prospectFrom)
      conds.push(`${INTERACTION_DAY_BA} >= $${params.length}::date`)
    }
    if (search.prospectTo) {
      params.push(search.prospectTo)
      conds.push(`${INTERACTION_DAY_BA} <= $${params.length}::date`)
    }
    return `where ${conds.join(' and ')}`
  }
  const objParams = [...prospectParams]
  const objWhere = interactionWhere(objParams)
  const otherParams = [...prospectParams]
  const otherWhere = interactionWhere(otherParams)
  const jobsParams = [...prospectParams]
  const jobsWhere = interactionWhere(jobsParams)

  const [counts, objections, others, jobs] = await Promise.all([
    sqlOne<Record<string, unknown>>(
      `select count(*)::int as total,
              ${statusCols},
              count(*) filter (where ${VERIFIED_SQL})::int as verified,
              count(*) filter (where p.partner_registered_on >= ${MONTH_START_BA}
                                 and p.partner_registered_on < ${NEXT_MONTH_START_BA})::int as altas_month,
              ${altasPeriodSql} as altas_period,
              to_char(${TODAY_BA}, 'YYYY-MM') as month
         from ops.partner_prospect p
         ${prospectWhere}`,
      countParams,
    ),
    // Una fila por objeción (incluida "ninguna", NULL): el total de charlas
    // sale de la misma consulta con una ventana, para que cuadre con las filas.
    sql<{ objection: string | null; prospects: number; interactions: number; total: number }>(
      `select i.objection,
              count(distinct i.prospect_id)::int as prospects,
              count(*)::int as interactions,
              (sum(count(*)) over ())::int as total
         from ops.partner_prospect_interaction i
         ${objWhere}
        group by i.objection`,
      objParams,
    ),
    sql<{ text: string; count: number }>(
      `select min(btrim(i.objection_other)) as text, count(*)::int as count
         from ops.partner_prospect_interaction i
         ${otherWhere} and i.objection = 'other' and i.objection_other is not null
        group by lower(btrim(i.objection_other))
        order by count(*) desc, 1
        limit 10`,
      otherParams,
    ),
    // El ÚLTIMO valor de cada contacto dentro del rango, y recién después el
    // promedio entre contactos: quien habló cinco veces no pesa cinco veces.
    sqlOne<{ avg: string | null; median: string | null; n: number }>(
      `select round(avg(jobs), 1)::text as avg,
              round((percentile_cont(0.5) within group (order by jobs))::numeric, 1)::text as median,
              count(*)::int as n
         from (select distinct on (i.prospect_id) i.jobs_per_month_to_pay as jobs
                 from ops.partner_prospect_interaction i
                 ${jobsWhere} and i.jobs_per_month_to_pay is not null
                order by i.prospect_id, i.occurred_at desc, i.created_at desc) last_per_prospect`,
      jobsParams,
    ),
  ])

  const byStatus = Object.fromEntries(
    PROSPECT_STATUSES.map((s) => [s, toInt(counts?.[`st_${s}`])]),
  ) as Record<ProspectStatus, number>
  const altasPeriod = counts?.altas_period

  return {
    total: toInt(counts?.total),
    byStatus,
    verified: toInt(counts?.verified),
    month: String(counts?.month ?? ''),
    altasMonth: toInt(counts?.altas_month),
    altasPeriod: altasPeriod === null || altasPeriod === undefined ? null : toInt(altasPeriod),
    interactions: objections.length > 0 ? toInt(objections[0]?.total) : 0,
    objections: objections
      .filter((o) => o.objection !== null)
      .map((o) => ({
        objection: o.objection as Objection,
        prospects: toInt(o.prospects),
        interactions: toInt(o.interactions),
      }))
      .sort((a, b) => b.prospects - a.prospects || b.interactions - a.interactions),
    otherObjections: others.map((o) => ({ text: o.text, count: toInt(o.count) })),
    jobs: {
      avg: jobs?.avg === null || jobs?.avg === undefined ? null : Number(jobs.avg),
      median: jobs?.median === null || jobs?.median === undefined ? null : Number(jobs.median),
      n: toInt(jobs?.n),
    },
  }
}

// ── Altas del mes (etapa 2) ────────────────────────────────────────────────

/** El mes actual en Buenos Aires (`YYYY-MM`). */
export async function currentMonthBA(): Promise<string> {
  const row = await sqlOne<{ month: string }>(`select to_char(${TODAY_BA}, 'YYYY-MM') as month`)
  return row?.month ?? ''
}

/**
 * Las altas de un mes: los contactos con `partner_registered_on` dentro de él,
 * por "Conseguido por" y fecha. Es la lista con la que se liquida: lee la fecha
 * GUARDADA (030), no la recalcula.
 */
export async function listMonthlyRegistrations(month: string, quotes: boolean): Promise<Array<PartnerProspect>> {
  const rows = await sql<ProspectRow>(
    `${selectFrom(quotes)}
      where p.partner_registered_on >= to_date($1, 'YYYY-MM')
        and p.partner_registered_on < (to_date($1, 'YYYY-MM') + interval '1 month')::date
      order by p.owner_id nulls last, p.partner_registered_on, p.name`,
    [month],
  )
  return rows.map(mapRow)
}

/**
 * Posibles altas sin vincular: contactos sin proveedor cuyo teléfono (la misma
 * normalización que los duplicados) coincide con un proveedor del marketplace,
 * o con una solicitud que todavía no tiene proveedor. Sólo sugiere: vincular
 * es un click de una persona.
 *
 * `applications = false` si la base no tiene `partner_applications` (es del
 * backend): ese lado sale vacío en vez de romper la consulta.
 */
export async function listUnlinkedRegistrationCandidates(
  applications: boolean,
): Promise<Array<RegistrationCandidate>> {
  const appsSql = applications
    ? `coalesce((select jsonb_agg(jsonb_build_object(
                   'id', a.id, 'businessName', a.business_name, 'status', a.status::text,
                   'createdOn', to_char((a.created_at at time zone 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD'))
                   order by a.created_at desc)
                 from partner_applications a
                where ops.normalize_ar_phone(a.whatsapp) = c.phone_digits
                  and not exists (select 1 from partners px where px.application_id = a.id)), '[]'::jsonb)`
    : `'[]'::jsonb`
  const rows = await sql<{
    id: string
    name: string
    phone: string | null
    locality: string | null
    status: string
    owner_id: string | null
    partners: RegistrationCandidate['partners']
    applications: RegistrationCandidate['applications']
  }>(
    `select * from (
       select c.id, c.name, c.phone, c.locality, c.status, c.owner_id,
              coalesce((select jsonb_agg(jsonb_build_object(
                          'id', pa.id, 'name', pa.name, 'status', pa.status::text,
                          'createdOn', to_char((pa.created_at at time zone 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD'))
                          order by (pa.status = 'active') desc, pa.name)
                        from partners pa
                       where ops.normalize_ar_phone(pa.whatsapp) = c.phone_digits), '[]'::jsonb) as partners,
              ${appsSql} as applications
         from ops.partner_prospect c
        where c.partner_id is null and c.phone_digits is not null
     ) s
     where jsonb_array_length(s.partners) + jsonb_array_length(s.applications) > 0
     order by jsonb_array_length(s.partners) desc, s.name`,
  )
  return rows.map((r) => ({
    prospect: {
      id: r.id,
      name: r.name,
      phone: r.phone,
      locality: r.locality,
      status: r.status as ProspectStatus,
      ownerId: r.owner_id,
    },
    partners: r.partners,
    applications: r.applications,
  }))
}

/** Las localidades cargadas, para el filtro de zona. Crudas: son texto libre. */
export async function listProspectLocalities(): Promise<Array<string>> {
  const rows = await sql<{ locality: string }>(
    `select distinct btrim(locality) as locality
       from ops.partner_prospect
      where nullif(btrim(locality), '') is not null
      order by 1`,
  )
  return rows.map((r) => r.locality)
}

// ── Charlas (030) ──────────────────────────────────────────────────────────

interface InteractionRow {
  id: string
  occurred_at: Date | string
  channel: string
  answered: boolean | null
  talked_to_decider: boolean | null
  told_how_orders: boolean
  told_profile: boolean
  told_zone_demand: boolean
  told_asistir24: boolean
  offered_model: string | null
  offered_amount: string | null
  reaction: string | null
  questions_answers: string | null
  objection: string | null
  objection_other: string | null
  jobs_per_month_to_pay: number | null
  pitch_notes: string | null
  status_after: string
  discard_reason: string | null
  next_step: string
  next_follow_up_on: string | null
  actor_name: string | null
}

/** El historial de un contacto, de la más nueva a la más vieja. */
export async function listInteractions(prospectId: string): Promise<Array<ProspectInteraction>> {
  const rows = await sql<InteractionRow>(
    `select i.id, i.occurred_at, i.channel, i.answered, i.talked_to_decider,
            i.told_how_orders, i.told_profile, i.told_zone_demand, i.told_asistir24,
            i.offered_model, i.offered_amount, i.reaction, i.questions_answers,
            i.objection, i.objection_other, i.jobs_per_month_to_pay, i.pitch_notes,
            i.status_after, i.discard_reason, i.next_step,
            to_char(i.next_follow_up_on, 'YYYY-MM-DD') as next_follow_up_on,
            coalesce(nullif(btrim(u.name), ''), u.email) as actor_name
       from ops.partner_prospect_interaction i
       left join users u on u.id = i.actor_id
      where i.prospect_id = $1
      order by i.occurred_at desc, i.created_at desc`,
    [prospectId],
  )
  return rows.map((r) => ({
    id: r.id,
    occurredAt: toIso(r.occurred_at),
    channel: r.channel as InteractionChannel,
    answered: r.answered,
    talkedToDecider: r.talked_to_decider,
    toldHowOrders: r.told_how_orders === true,
    toldProfile: r.told_profile === true,
    toldZoneDemand: r.told_zone_demand === true,
    toldAsistir24: r.told_asistir24 === true,
    offeredModel: r.offered_model as OfferedModel | null,
    offeredAmount: r.offered_amount,
    reaction: r.reaction as Reaction | null,
    questionsAnswers: r.questions_answers,
    objection: r.objection as Objection | null,
    objectionOther: r.objection_other,
    jobsPerMonthToPay: r.jobs_per_month_to_pay === null ? null : Number(r.jobs_per_month_to_pay),
    pitchNotes: r.pitch_notes,
    statusAfter: r.status_after as ProspectStatus,
    discardReason: r.discard_reason,
    nextStep: r.next_step,
    nextFollowUpOn: r.next_follow_up_on,
    actorName: r.actor_name,
  }))
}

/** El id de un pedido por su número público (`AL-n`). `null` si no existe. */
export async function findQuoteRequestIdByNumber(publicNumber: number): Promise<string | null> {
  const row = await sqlOne<{ id: string }>(
    `select id from quote_requests where public_number = $1`,
    [publicNumber],
  )
  return row?.id ?? null
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

export async function createProspect(
  input: CreateProspectInput,
  actorId: string,
  quotes: boolean,
): Promise<PartnerProspect> {
  const row = await sqlOne<{ r: { id: string } | null }>(
    `SELECT ops.create_partner_prospect(p_actor_id => $1, p_data => $2::jsonb) AS r`,
    [actorId, JSON.stringify(toSpPatch(input))],
  )
  return reread(row?.r?.id, quotes)
}

/** Parche: sólo viajan las claves que cambiaron (autoguardado campo por campo). */
export async function updateProspect(
  id: string,
  patch: Parameters<typeof toSpPatch>[0],
  actorId: string,
  quotes: boolean,
): Promise<PartnerProspect> {
  const row = await sqlOne<{ r: { id: string } | null }>(
    `SELECT ops.update_partner_prospect(p_id => $1, p_actor_id => $2, p_patch => $3::jsonb) AS r`,
    [id, actorId, JSON.stringify(toSpPatch(patch))],
  )
  return reread(row?.r?.id, quotes)
}

/**
 * Una charla. El SP la guarda y mueve el contacto en la misma transacción
 * (migración 030); acá se relee el contacto con el SELECT de la pantalla.
 */
export async function addInteraction(
  input: AddInteractionInput,
  actorId: string,
  quotes: boolean,
): Promise<PartnerProspect> {
  await sqlOne<{ r: unknown }>(
    `SELECT ops.add_partner_prospect_interaction(p_prospect_id => $1, p_actor_id => $2, p_data => $3::jsonb) AS r`,
    [input.prospectId, actorId, JSON.stringify(toSpInteraction(input))],
  )
  return reread(input.prospectId, quotes)
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
async function reread(id: string | undefined, quotes: boolean): Promise<PartnerProspect> {
  const prospect = id ? await findProspect(id, quotes) : null
  if (!prospect) throw new Error('PROSPECT_WRITE_FAILED')
  return prospect
}
