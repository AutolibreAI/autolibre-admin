import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { MAX_QUOTE_PROPOSAL_SLOTS } from '~/lib/quote-proposals'
import type { QuoteProposal, QuoteProposalItem, QuoteProposalSend, QuoteProposalsResult } from '~/lib/quote-proposals'

/**
 * «Propuestas en la app» — la LECTURA de `public.quote_request_proposals` y
 * `quote_request_proposal_sends`, del backend (migraciones 0120–0122).
 *
 * ── Ni una escritura ───────────────────────────────────────────────────────
 *
 * Las escrituras van por HTTP (`~/server/backend`): el backend asigna lugares,
 * manda el push, deduplica por `sendId` y mueve el pedido. Si aparece un
 * `INSERT`/`UPDATE` sobre estas tablas acá, está mal. → `~/lib/quote-proposals`
 *
 * ── No toca `READ_COLUMNS` de pedidos ──────────────────────────────────────
 *
 * Las columnas nuevas de `quote_requests` (`selected_*`, `proposals_search_*`)
 * se leen ACÁ, detrás de este guard, y no en `quote-requests.repo.ts`: sumarlas
 * allá haría que `/leads/pedidos` entero dijera "falta la 0093" en producción,
 * donde el backend todavía no desplegó 0120–0122.
 */

const toNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v)

// ── Disponibilidad ─────────────────────────────────────────────────────────

/** Las columnas que 0120 suma a `quote_request_proposals` y este repo LEE. */
const PROPOSAL_COLUMNS = [
  'send_id',
  'position',
  'provider_address',
  'provider_phone',
  'items',
  'is_recommended',
  'recommendation_reason',
  'withdrawn_at',
  'updated_at',
] as const

/** Las columnas que 0120–0122 suman a `quote_requests` y este repo LEE. */
const QUOTE_REQUEST_COLUMNS = [
  'selected_proposal_id',
  'selected_at',
  'proposals_search_closed_at',
  'proposals_search_closure_id',
] as const

/**
 * ¿Tiene esta base las migraciones 0120–0122 del backend?
 *
 * `to_regclass` de la tabla de envíos NO alcanza solo: producción tiene
 * `quote_request_proposals` VIEJA (sin `send_id`, sin `withdrawn_at`), y leer
 * una columna faltante explota al planificarse — un 500 en la ficha. Por eso
 * se cuentan también las columnas que se leen. Mismo patrón que
 * `quoteRequestsAvailability()`: `information_schema` y no un `select … limit 0`
 * con try/catch, que termina tragándose los errores reales.
 *
 * **Si se lee una columna nueva, se suma a estas listas el mismo día**, o el
 * guard dice "disponible" y la pantalla explota igual.
 */
export async function quoteProposalsAvailability(opts: { signal?: AbortSignal } = {}): Promise<boolean> {
  void opts.signal

  const row = await sqlOne<{ has_sends: boolean; p_cols: number; qr_cols: number }>(
    `select to_regclass('public.quote_request_proposal_sends') is not null as has_sends,
            (select count(*)::int from information_schema.columns
              where table_schema = 'public' and table_name = 'quote_request_proposals'
                and column_name = any($1::text[])) as p_cols,
            (select count(*)::int from information_schema.columns
              where table_schema = 'public' and table_name = 'quote_requests'
                and column_name = any($2::text[])) as qr_cols`,
    [PROPOSAL_COLUMNS, QUOTE_REQUEST_COLUMNS],
  )
  return (
    row?.has_sends === true &&
    Number(row.p_cols) === PROPOSAL_COLUMNS.length &&
    Number(row.qr_cols) === QUOTE_REQUEST_COLUMNS.length
  )
}

// ── Lectura ────────────────────────────────────────────────────────────────

interface ProposalRow {
  id: string
  send_id: string
  position: number
  partner_id: string | null
  provider_name: string | null
  provider_address: string | null
  provider_phone: string | null
  partner_has_whatsapp: boolean
  resolved_address: string | null
  resolved_phone: string | null
  resolved_hours: string | null
  partner_slug: string | null
  amount_min: string | null
  amount_max: string | null
  currency: string
  items: unknown
  description: string
  internal_notes: string | null
  valid_until: string | null
  expired: boolean | null
  is_recommended: boolean
  recommendation_reason: string | null
  withdrawn_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string | null
}

/** `jsonb` llega parseado de `pg`. Defensivo con cualquier otra forma: el JSON es del backend. */
function toItems(v: unknown): Array<QuoteProposalItem> {
  const raw: unknown = typeof v === 'string' ? JSON.parse(v) : v
  if (!Array.isArray(raw)) return []
  return raw.flatMap((it: unknown) => {
    if (typeof it !== 'object' || it === null) return []
    const o = it as Record<string, unknown>
    const amount = Number(o.amount)
    if (typeof o.label !== 'string' || !Number.isFinite(amount)) return []
    return [{ label: o.label, amount, optional: o.optional === true }]
  })
}

function mapProposal(r: ProposalRow): QuoteProposal {
  return {
    id: r.id,
    sendId: r.send_id,
    position: Number(r.position),
    partnerId: r.partner_id,
    providerName: r.provider_name ?? 'taller sin nombre',
    providerAddress: r.provider_address,
    providerPhone: r.provider_phone,
    partnerHasWhatsapp: r.partner_has_whatsapp === true,
    address: r.resolved_address,
    phone: r.resolved_phone,
    hours: r.resolved_hours,
    partnerSlug: r.partner_slug,
    // `numeric` llega como string. `toNum` preserva el null: "a confirmar" ≠ "sin cargo".
    amountMin: toNum(r.amount_min),
    amountMax: toNum(r.amount_max),
    currency: r.currency,
    items: toItems(r.items),
    description: r.description,
    internalNotes: r.internal_notes,
    validUntil: r.valid_until,
    expired: r.expired,
    isRecommended: r.is_recommended === true,
    recommendationReason: r.recommendation_reason,
    withdrawnAt: toIso(r.withdrawn_at),
    createdAt: toIso(r.created_at) ?? '',
    updatedAt: toIso(r.updated_at),
  }
}

/**
 * Todo lo de las propuestas de UN pedido, en tres consultas en paralelo — son
 * granos distintos (propuestas, envíos, el pedido) y unirlas en una sola
 * multiplicaría filas.
 *
 * - `valid_until` sale por `to_char`: un `date` pasado por `Date` en JS corre
 *   el día al este de UTC (la trampa de `toPlainDay`).
 * - `expired` lo calcula Postgres: la ficha es SSR y el reloj del navegador
 *   daría un mismatch de hidratación por fila.
 * - El nombre se RESUELVE en el SELECT (`coalesce(pa.name, p.provider_name)`),
 *   igual que en `quote-responses.repo.ts`. `LEFT JOIN` porque `partner_id` es
 *   nullable: un `JOIN` escondería a los talleres de afuera.
 * - Dirección, WhatsApp, horarios y slug se resuelven como en
 *   `quote-responses.repo.ts`: son lo que arma el mensaje «Presupuestos» desde
 *   el 2026-10-27, y tienen que decir lo mismo que decía aquél.
 * - `freeSlots` se calcula ACÁ: es el número que el envío re-lee antes del
 *   fetch, y la UI y el handler tienen que partir del mismo.
 *
 * Llamar SÓLO con el guard en `true`: sin 0120 estas consultas explotan.
 */
export async function listQuoteProposals(
  quoteRequestId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Extract<QuoteProposalsResult, { available: true }>> {
  void opts.signal

  // `partner_slugs` es del backend (drizzle 0107) y puede no estar: nombrarla
  // sin que exista explota al planificarse. Mismo guard que `quote-responses.repo.ts`.
  const slugs = await sqlOne<{ ok: boolean }>(`select to_regclass('public.partner_slugs') is not null as ok`)
  const slugColumn =
    slugs?.ok === true
      ? `case when pa.status = 'active' then (
           select ps.slug from partner_slugs ps where ps.partner_id = pa.id and ps.is_current
         ) end as partner_slug`
      : `null::text as partner_slug`

  const [proposalRows, sendRows, request] = await Promise.all([
    sql<ProposalRow>(
      `select p.id, p.send_id, p.position, p.partner_id,
              coalesce(pa.name, p.provider_name) as provider_name,
              p.provider_address, p.provider_phone,
              coalesce(btrim(pa.whatsapp), '') <> '' as partner_has_whatsapp,
              -- Lo que va al mensaje de WhatsApp: del directorio si es partner, lo tipeado si es de afuera.
              nullif(btrim(coalesce(pa.address, p.provider_address, '')), '') as resolved_address,
              nullif(btrim(coalesce(pa.whatsapp, p.provider_phone, '')), '') as resolved_phone,
              nullif(btrim(coalesce(pa.hours, '')), '') as resolved_hours,
              ${slugColumn},
              p.amount_min, p.amount_max, p.currency::text as currency, p.items,
              p.description, p.internal_notes,
              to_char(p.valid_until, 'YYYY-MM-DD') as valid_until,
              case when p.valid_until is null then null else p.valid_until < current_date end as expired,
              p.is_recommended, p.recommendation_reason, p.withdrawn_at, p.created_at, p.updated_at
         from quote_request_proposals p
         left join partners pa on pa.id = p.partner_id
        where p.quote_request_id = $1
        order by p.withdrawn_at nulls first, p.position, p.created_at`,
      [quoteRequestId],
    ),
    sql<{ id: string; closes_search: boolean; sent_at: Date | string; sent_by_email: string | null }>(
      `select s.id, s.closes_search, s.sent_at, u.email as sent_by_email
         from quote_request_proposal_sends s
         left join users u on u.id = s.sent_by
        where s.quote_request_id = $1
        order by s.sent_at`,
      [quoteRequestId],
    ),
    sqlOne<{
      selected_proposal_id: string | null
      selected_at: Date | string | null
      proposals_search_closed_at: Date | string | null
    }>(
      `select selected_proposal_id, selected_at, proposals_search_closed_at
         from quote_requests where id = $1`,
      [quoteRequestId],
    ),
  ])

  const all = proposalRows.map(mapProposal)
  const active = all.filter((p) => p.withdrawnAt === null)
  const withdrawn = all.filter((p) => p.withdrawnAt !== null)
  const sends: Array<QuoteProposalSend> = sendRows.map((s) => ({
    id: s.id,
    closesSearch: s.closes_search === true,
    sentAt: toIso(s.sent_at) ?? '',
    sentByEmail: s.sent_by_email,
  }))

  return {
    available: true,
    active,
    withdrawn,
    sends,
    selectedProposalId: request?.selected_proposal_id ?? null,
    selectedAt: toIso(request?.selected_at ?? null),
    searchClosedAt: toIso(request?.proposals_search_closed_at ?? null),
    freeSlots: Math.max(0, MAX_QUOTE_PROPOSAL_SLOTS - active.length),
    hasAppSends: sends.length > 0,
  }
}

/**
 * Cuántas activas tiene el pedido AHORA. Lo usa el handler del envío para
 * re-chequear los lugares libres justo antes del fetch: el backend rechaza el
 * exceso con un 400 SIN code, indistinguible de otro error de validación.
 */
export async function activeProposalCount(quoteRequestId: string): Promise<number> {
  const row = await sqlOne<{ n: number }>(
    `select count(*)::int as n from quote_request_proposals
      where quote_request_id = $1 and withdrawn_at is null`,
    [quoteRequestId],
  )
  return Number(row?.n ?? 0)
}
