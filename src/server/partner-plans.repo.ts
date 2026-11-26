import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { effectiveCap } from '~/lib/partner-plans'
import type { PartnerPlansResult, PartnerSubscriptionInfo, PlanInfo, SubscriptionHistoryEntry } from '~/lib/partner-plans'

/**
 * El plan de cada proveedor — la LECTURA de billing del backend
 * (`public.subscription_plans` + `public.partner_subscriptions`). Ni una
 * escritura: el plan lo contrata el dueño del taller por Mercado Pago, y una
 * fila escrita por SQL se saltearía el cobro. Si aparece un `INSERT`/`UPDATE`
 * sobre esas tablas acá, está mal.
 */

const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v)

/** Las columnas que este repo LEE, por tabla. Se tocan junto con los SELECT. */
const PLAN_COLUMNS = ['id', 'code', 'name', 'monthly_whatsapp_request_limit', 'active', 'sort_order'] as const
const SUBSCRIPTION_COLUMNS = [
  'partner_id',
  'plan_id',
  'status',
  'trial_ends_at',
  'current_period_end',
  'access_until',
  'cancel_at_period_end',
  'scheduled_plan_id',
  'scheduled_plan_at',
] as const

/**
 * ¿Tiene esta base el billing del backend? `to_regclass` + las columnas que se
 * leen, por `information_schema` — mismo patrón que `partnerMembersAvailability()`.
 */
export async function partnerPlansAvailability(): Promise<boolean> {
  const row = await sqlOne<{ has_plans: boolean; has_subs: boolean; plan_cols: number; sub_cols: number }>(
    `select to_regclass('public.subscription_plans') is not null as has_plans,
            to_regclass('public.partner_subscriptions') is not null as has_subs,
            (select count(*)::int from information_schema.columns
              where table_schema = 'public' and table_name = 'subscription_plans'
                and column_name = any($1::text[])) as plan_cols,
            (select count(*)::int from information_schema.columns
              where table_schema = 'public' and table_name = 'partner_subscriptions'
                and column_name = any($2::text[])) as sub_cols`,
    [PLAN_COLUMNS, SUBSCRIPTION_COLUMNS],
  )
  return (
    row?.has_plans === true &&
    row.has_subs === true &&
    Number(row.plan_cols) === PLAN_COLUMNS.length &&
    Number(row.sub_cols) === SUBSCRIPTION_COLUMNS.length
  )
}

interface PlanRow {
  code: string
  name: string
  cap: number | null
  active: boolean
}

interface SubscriptionRow {
  partner_id: string
  status: string
  plan_code: string
  grants_access: boolean
  trial_ends_at: unknown
  current_period_end: unknown
  access_until: unknown
  cancel_at_period_end: boolean
  scheduled_plan_code: string | null
  scheduled_plan_at: unknown
}

/**
 * El catálogo entero (también los inactivos: una suscripción vieja puede
 * apuntar a uno) y las suscripciones VIVAS. Una cancelada nunca da acceso
 * (regla del backend), así que con las vivas alcanza para el plan efectivo.
 *
 * `grants_access` es la regla de `DrizzlePartnerEntitlementsReader`
 * (`trialing`/`active` con `access_until` nulo o futuro). Si cambia allá,
 * cambia acá.
 */
export async function listPartnerPlans(opts: { partnerId?: string } = {}): Promise<PartnerPlansResult> {
  if (!(await partnerPlansAvailability())) return { available: false }
  const [plans, subs] = await Promise.all([
    sql<PlanRow>(
      `select code, name, monthly_whatsapp_request_limit as cap, active
         from subscription_plans
        order by sort_order, code`,
    ),
    sql<SubscriptionRow>(
      `select s.partner_id,
              s.status::text as status,
              p.code as plan_code,
              (s.status in ('trialing', 'active')
                and (s.access_until is null or s.access_until > now())) as grants_access,
              s.trial_ends_at, s.current_period_end, s.access_until, s.cancel_at_period_end,
              sp.code as scheduled_plan_code, s.scheduled_plan_at
         from partner_subscriptions s
         join subscription_plans p on p.id = s.plan_id
         left join subscription_plans sp on sp.id = s.scheduled_plan_id
        where s.status in ('pending', 'trialing', 'active', 'paused')
          and ($1::uuid is null or s.partner_id = $1::uuid)`,
      [opts.partnerId ?? null],
    ),
  ])
  const catalog: Array<PlanInfo> = plans.map((r) => ({
    code: r.code,
    name: r.name,
    cap: effectiveCap(r.code, r.cap === null ? null : Number(r.cap)),
    active: r.active,
  }))
  const subscriptions: Array<PartnerSubscriptionInfo> = subs.map((r) => ({
    partnerId: r.partner_id,
    status: r.status,
    planCode: r.plan_code,
    grantsAccess: r.grants_access,
    trialEndsAt: toIso(r.trial_ends_at),
    currentPeriodEnd: toIso(r.current_period_end),
    accessUntil: toIso(r.access_until),
    cancelAtPeriodEnd: r.cancel_at_period_end,
    scheduledPlanCode: r.scheduled_plan_code,
    scheduledPlanAt: toIso(r.scheduled_plan_at),
  }))
  return { available: true, catalog, subscriptions }
}

// ── Suscripción (histórico) — desde el 2026-11-26 ───────────────────────────

/**
 * Todas las suscripciones de un proveedor (también canceladas), para la
 * tarjeta «Suscripción (histórico)» de la ficha. Ya no se venden: esto es sólo
 * lectura del pasado. `null` sin billing en la base.
 */
export async function listSubscriptionHistory(partnerId: string): Promise<Array<SubscriptionHistoryEntry> | null> {
  const has = await sqlOne<{ ok: boolean }>(
    `select to_regclass('public.partner_subscriptions') is not null
        and to_regclass('public.subscription_plans') is not null as ok`,
  )
  if (!has?.ok) return null
  const rows = await sql<{
    id: string
    status: string
    plan_name: string
    price: string | null
    created_at: unknown
    authorized_at: unknown
    trial_ends_at: unknown
    current_period_end: unknown
    access_until: unknown
    ended_at: unknown
    end_reason: string | null
  }>(
    `select s.id, s.status::text as status, p.name as plan_name, p.price_amount::text as price,
            s.created_at, s.authorized_at, s.trial_ends_at, s.current_period_end, s.access_until,
            s.ended_at, s.end_reason::text as end_reason
       from partner_subscriptions s
       join subscription_plans p on p.id = s.plan_id
      where s.partner_id = $1
      order by s.created_at desc`,
    [partnerId],
  )
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    planName: r.plan_name,
    price: r.price === null ? null : Number(r.price),
    createdAt: toIso(r.created_at),
    authorizedAt: toIso(r.authorized_at),
    trialEndsAt: toIso(r.trial_ends_at),
    currentPeriodEnd: toIso(r.current_period_end),
    accessUntil: toIso(r.access_until),
    endedAt: toIso(r.ended_at),
    endReason: r.end_reason,
  }))
}
