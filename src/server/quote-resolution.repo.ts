import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { quoteProposalsAvailability } from './quote-proposals.repo'
import { notDuplicatePredicate } from './quote-requests.repo'
import { QUOTE_USER_FLOW_COLUMNS, quoteUserFlowColumnsAvailability } from './quote-user-flow.repo'
import { AI_SERVICE_LOW_SCORE } from '~/lib/quote-requests'
import type {
  QuoteResolutionPartnerOption,
  QuoteResolutionRow,
  QuoteResolutionSearch,
  QuoteResolutionServicesSource,
  QuoteResolutionSortKey,
} from '~/lib/quote-resolution'
import { userOutcomeReporter, type QuoteUserFlowSource } from '~/lib/quote-user-flow'

/**
 * «Resolución de pedidos» — UNA sentencia para todo el listado (nada de N+1):
 * lo que no es una columna de `quote_requests` va como subconsulta ESCALAR o
 * como `LEFT JOIN` 1:1 (la propuesta elegida, el admin que declaró), así una
 * fila de pedido nunca se multiplica. → `~/lib/quote-resolution`
 *
 * ── Guards: cada pieza opcional, por separado ─────────────────────────────
 *
 * Nombrar una tabla o columna inexistente explota al PLANIFICAR la sentencia,
 * así que lo que puede faltar en una base se mira antes y, si falta, la columna
 * sale `NULL` en vez de romper la pantalla. Mismo criterio que
 * `listExtraColumns()` de `quote-requests.repo.ts`:
 *
 * - propuestas (0120–0122): `quoteProposalsAvailability()` — NO `to_regclass`,
 *   producción tuvo la tabla vieja;
 * - procedencia, fecha del trabajo y autor (0169), y aparte el motivo y la
 *   observación de «No fue»: `quoteUserFlowColumnsAvailability()`, con los
 *   nombres de `QUOTE_USER_FLOW_COLUMNS` (la única fuente);
 * - servicios del operador (0155), rubros de `ops` (013/016) y servicios de la
 *   IA (0124): `to_regclass` / `information_schema`, como la ficha.
 *
 * El guard de `quote_requests` (`quoteRequestsAvailability`) lo corre el
 * server function ANTES de llamar acá.
 */

const toIso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v)

export interface Pieces {
  proposals: boolean
  userFlow: boolean
  notHired: boolean
  operatorServices: boolean
  rubros: boolean
  ai: boolean
}

export async function availablePieces(): Promise<Pieces> {
  const [proposals, userFlowColumns, tables] = await Promise.all([
    quoteProposalsAvailability(),
    quoteUserFlowColumnsAvailability(),
    sqlOne<{ operator_services: boolean; rubros: boolean; ai: boolean }>(
      `select to_regclass('public.quote_request_operator_services') is not null as operator_services,
              to_regclass('ops.quote_request_rubro') is not null as rubros,
              to_regclass('public.quote_request_services') is not null
                and exists (select 1 from information_schema.columns
                             where table_schema = 'public' and table_name = 'quote_requests'
                               and column_name = 'classified_at') as ai`,
    ),
  ])
  return {
    proposals,
    userFlow: userFlowColumns.provenance,
    notHired: userFlowColumns.notHired,
    operatorServices: tables?.operator_services === true,
    rubros: tables?.rubros === true,
    ai: tables?.ai === true,
  }
}

/**
 * Las columnas que dependen de un guard. Los identificadores salen de
 * constantes cerradas (nunca del request): interpolarlos es seguro. El umbral
 * de la IA también es una constante del código, no un parámetro del usuario.
 */
export function selectPieces(p: Pieces): { columns: string; joins: string } {
  const opServices = p.operatorServices
    ? `(select array_agg(sv.name order by qos.position)
          from quote_request_operator_services qos
          join services sv on sv.id = qos.service_id
         where qos.quote_request_id = qr.id)`
    : `null::text[]`
  const rubros = p.rubros
    ? `(select array_agg(coalesce(c.name, r.category_slug) order by coalesce(c.name, r.category_slug))
          from ops.quote_request_rubro r
          left join service_categories c on c.slug = r.category_slug
         where r.quote_request_id = qr.id)`
    : `null::text[]`
  // Sin clasificar no hay sugerencia; los dudosos (< AI_SERVICE_LOW_SCORE) no
  // entran, igual que en la plantilla y el despacho.
  const ai = p.ai
    ? `case when qr.classified_at is null then null else (
         select array_agg(sv.name order by qrs.score desc, sv.name)
           from quote_request_services qrs
           join services sv           on sv.id = qrs.service_id
           join service_categories c  on c.id = sv.category_id
          where qrs.quote_request_id = qr.id and sv.active and c.active
            and qrs.score >= ${Number(AI_SERVICE_LOW_SCORE)}
       ) end`
    : `null::text[]`

  // Activas: las retiradas liberaron su lugar. Elegida: el nombre resuelto igual
  // que `quote-proposals.repo.ts` (`coalesce(pa.name, p.provider_name)`).
  const proposals = p.proposals
    ? `(select count(*)::int from quote_request_proposals ap
         where ap.quote_request_id = qr.id and ap.withdrawn_at is null) as active_proposals,
       coalesce(spa.name, sp.provider_name) as selected_provider_name,
       sp.partner_id as selected_partner_id`
    : `null::int as active_proposals, null::text as selected_provider_name, null::uuid as selected_partner_id`
  const proposalJoins = p.proposals
    ? `left join quote_request_proposals sp on sp.id = qr.selected_proposal_id
       left join partners spa on spa.id = sp.partner_id`
    : ''

  const c = QUOTE_USER_FLOW_COLUMNS
  const flow = p.userFlow
    ? `qr.${c.outcomeSource}::text as outcome_source,
       qr.${c.outcomeDeclaredBy} as declared_by,
       ob.name as declared_by_name, ob.email as declared_by_email,
       to_char(qr.${c.outcomePerformedOn}, 'YYYY-MM-DD') as performed_on`
    : `null::text as outcome_source, null::uuid as declared_by,
       null::text as declared_by_name, null::text as declared_by_email, null::text as performed_on`
  const flowJoins = p.userFlow ? `left join users ob on ob.id = qr.${c.outcomeDeclaredBy}` : ''
  const notHired = p.notHired
    ? `qr.${c.notHiredReason}::text as not_hired_reason, qr.${c.notHiredNote} as not_hired_note`
    : `null::text as not_hired_reason, null::text as not_hired_note`

  return {
    columns: `,
      ${opServices} as op_services,
      ${rubros} as op_rubros,
      ${ai} as ai_services,
      ${proposals},
      ${flow},
      ${notHired}`,
    joins: `${proposalJoins}\n${flowJoins}`,
  }
}

/**
 * Orden: mapa cerrado clave → expresión sobre los alias del envoltorio (lo que
 * hace seguro interpolar columna y `dir`). `status` por el RECORRIDO, igual que
 * `/leads/pedidos`.
 */
const SORT_COLUMNS: Record<QuoteResolutionSortKey, string> = {
  createdAt: 'created_at',
  channel: 'channel',
  contact: 'lower(coalesce(contact_name, contact_phone))',
  proposals: 'active_proposals',
  userOutcome: 'user_outcome',
  outcome: 'outcome',
  partner: 'lower(selected_provider_name)',
  performedOn: 'performed_on',
  status: `array_position(array['received','contacted','answered','closed']::text[], status)`,
}

interface ResolutionRow {
  id: string
  public_number: number | string
  created_at: Date | string
  channel: string
  entered_manually: boolean | null
  has_account: boolean
  contact_name: string | null
  contact_phone: string | null
  op_services: Array<string> | null
  op_rubros: Array<string> | null
  ai_services: Array<string> | null
  active_proposals: number | string | null
  user_outcome: string | null
  outcome: string | null
  selected_provider_name: string | null
  selected_partner_id: string | null
  outcome_source: string | null
  declared_by: string | null
  declared_by_name: string | null
  declared_by_email: string | null
  performed_on: string | null
  not_hired_reason: string | null
  not_hired_note: string | null
  status: string
  close_reason_code: string | null
  closed_at: Date | string | null
  outcome_note: string | null
}

const toSource = (v: string | null): QuoteUserFlowSource | null => (v === 'user' || v === 'operator' ? v : null)

/** La precedencia de «Rubro / servicio»: operador (servicios, después rubros) → IA. */
function pickServices(r: ResolutionRow): { services: Array<string>; source: QuoteResolutionServicesSource | null } {
  if (r.op_services?.length) return { services: r.op_services, source: 'operator_services' }
  if (r.op_rubros?.length) return { services: r.op_rubros, source: 'operator_rubros' }
  if (r.ai_services?.length) return { services: r.ai_services, source: 'ai' }
  return { services: [], source: null }
}

function mapRow(r: ResolutionRow, userFlowAvailable: boolean): QuoteResolutionRow {
  const { services, source } = pickServices(r)
  return {
    id: r.id,
    publicNumber: Number(r.public_number),
    createdAt: toIso(r.created_at) ?? '',
    channel: r.channel,
    enteredManually: r.entered_manually === true,
    hasAccount: r.has_account,
    contactName: r.contact_name,
    contactPhone: r.contact_phone,
    services,
    servicesSource: source,
    activeProposals: r.active_proposals === null ? null : Number(r.active_proposals),
    userOutcome: r.user_outcome,
    outcome: r.outcome,
    selectedProviderName: r.selected_provider_name,
    selectedPartnerId: r.selected_partner_id,
    performedOn: r.performed_on,
    notHiredReason: r.not_hired_reason,
    notHiredNote: r.not_hired_note,
    reporter: userOutcomeReporter({
      hasValue: r.user_outcome !== null,
      hasAccount: r.has_account,
      provenanceAvailable: userFlowAvailable,
      source: toSource(r.outcome_source),
      by: r.declared_by
        ? { id: r.declared_by, name: r.declared_by_name, email: r.declared_by_email }
        : null,
    }),
    status: r.status,
    closeReasonCode: r.close_reason_code,
    closedAt: toIso(r.closed_at),
    outcomeNote: r.outcome_note,
  }
}

export interface QuoteResolutionListing {
  rows: Array<QuoteResolutionRow>
  truncated: boolean
  proposalsAvailable: boolean
  userFlowAvailable: boolean
  notHiredAvailable: boolean
}

/**
 * El listado filtrado. Trae `limit + 1` para saber si hay más sin un
 * `count(*)` aparte. Los filtros van en el `where` de AFUERA porque varios son
 * alias del SELECT interno (taller, fecha del trabajo), igual que
 * `listQuoteRequests`.
 */
export async function listQuoteResolution(
  search: QuoteResolutionSearch,
  opts: { limit: number; signal?: AbortSignal },
): Promise<QuoteResolutionListing> {
  void opts.signal

  const pieces = await availablePieces()
  const { columns, joins } = selectPieces(pieces)

  const params: Array<unknown> = []
  const where: Array<string> = []
  const param = (v: unknown) => {
    params.push(v)
    return `$${params.length}`
  }

  if (search.resChannel !== 'all') where.push(`channel = ${param(search.resChannel)}`)

  if (search.resUserOutcome === 'undeclared') where.push('user_outcome is null')
  else if (search.resUserOutcome !== 'all') where.push(`user_outcome = ${param(search.resUserOutcome)}`)

  if (search.resOutcome === 'unasked') where.push('outcome is null')
  else if (search.resOutcome !== 'all') where.push(`outcome = ${param(search.resOutcome)}`)

  // Sin la migración del motivo, el filtro se ignora (la pantalla no lo ofrece).
  // Cualquier valor acota a «No fue»: un motivo sólo existe ahí.
  if (pieces.notHired && search.resNotHiredReason !== 'all') {
    where.push(`user_outcome = 'not_hired'`)
    if (search.resNotHiredReason === 'none') where.push('not_hired_reason is null')
    else where.push(`not_hired_reason = ${param(search.resNotHiredReason)}`)
  }

  // Sin propuestas en la base no hay taller elegido que filtrar: se ignora (la
  // pantalla no ofrece el filtro), en vez de vaciar la lista.
  if (pieces.proposals && search.resPartner !== 'all') {
    if (search.resPartner === 'none') where.push('selected_provider_name is null')
    else if (search.resPartner === 'external')
      where.push('selected_provider_name is not null and selected_partner_id is null')
    else where.push(`selected_partner_id = ${param(search.resPartner)}::uuid`)
  }

  // El día del pedido en Buenos Aires: es el calendario del operador.
  const baDay = `(created_at at time zone 'America/Argentina/Buenos_Aires')::date`
  if (search.resFrom) where.push(`${baDay} >= ${param(search.resFrom)}::date`)
  if (search.resTo) where.push(`${baDay} <= ${param(search.resTo)}::date`)

  // Mismo corte que `hasIncompleteUserFlow` y que el chip de `/leads/pedidos`.
  if (search.resIncompleteFlow)
    where.push(
      `answered_at is not null and user_outcome is null
       and close_reason_code is distinct from 'cancelled_by_user'`,
    )

  if (!search.resShowDuplicates) where.push(notDuplicatePredicate())

  const limit = param(opts.limit + 1)

  const rows = await sql<ResolutionRow>(
    `
    select * from (
      select qr.id,
             qr.public_number,
             qr.created_at,
             qr.channel::text as channel,
             -- La marca de \`ops.create_quote_request\` (012) para lo cargado a mano.
             (qr.raw_submission->>'source' = 'admin_manual_entry') as entered_manually,
             qr.user_id is not null as has_account,
             -- Con cuenta, lo de la cuenta; si la cuenta no lo tiene, lo del pedido.
             coalesce(nullif(btrim(u.name), ''), qr.contact_name) as contact_name,
             coalesce(nullif(btrim(u.phone), ''), qr.contact_phone) as contact_phone,
             qr.user_outcome::text as user_outcome,
             qr.outcome::text as outcome,
             qr.status::text as status,
             qr.close_reason_code::text as close_reason_code,
             qr.closed_at,
             qr.answered_at,
             qr.outcome_note${columns}
        from quote_requests qr
        left join users u on u.id = qr.user_id
        ${joins}
    ) s
    ${where.length ? `where ${where.join(' and ')}` : ''}
    order by ${SORT_COLUMNS[search.resSort]} ${search.resDir === 'asc' ? 'asc' : 'desc'} nulls last, created_at desc, id
    limit ${limit}
    `,
    params,
  )

  return {
    rows: rows.slice(0, opts.limit).map((r) => mapRow(r, pieces.userFlow)),
    truncated: rows.length > opts.limit,
    proposalsAvailable: pieces.proposals,
    userFlowAvailable: pieces.userFlow,
    notHiredAvailable: pieces.notHired,
  }
}

/**
 * Las opciones del filtro «Taller»: los partners que alguna vez fueron la
 * propuesta elegida de un pedido. Sale de la base entera, no de las filas
 * filtradas: si no, filtrar por un taller haría desaparecer a los demás del
 * selector. Sin propuestas en la base, vacío.
 */
export async function listQuoteResolutionPartnerOptions(): Promise<Array<QuoteResolutionPartnerOption>> {
  if (!(await quoteProposalsAvailability())) return []
  const rows = await sql<{ id: string; name: string }>(
    `select distinct pa.id, pa.name
       from quote_requests qr
       join quote_request_proposals p on p.id = qr.selected_proposal_id
       join partners pa on pa.id = p.partner_id
      order by pa.name`,
  )
  return rows.map((r) => ({ id: r.id, name: r.name }))
}
