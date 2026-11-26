import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { INTERNAL_PREDICATE } from './ops.repo'
import {
  ACCOUNT_REVIEW_UNAVAILABLE,
  ACCOUNT_TYPES,
  lastTenDigits,
  type AccountMatch,
  type AccountReviewKind,
  type AccountReviewQueue,
  type AccountReviewRow,
  type AccountType,
  type AccountTypeCensus,
  type MarkAccountReviewedInput,
} from '~/lib/account-type'

/**
 * Tipo de cuenta — la expresión SQL ÚNICA. Todo conteo de usuarios del panel
 * pasa por `realUserPredicate()` o `accountTypeSql()`; si aparece un conteo de
 * `users` que no pasa por acá, va a contar talleres como usuarios.
 * → `~/lib/account-type`, `.claude/rules/account-types.md`
 *
 * Las piezas que dependen de tablas que una base puede no tener
 * (`partner_members` 0141, `quote_requests`, `driver_licenses.archived`) se
 * arman según `accountTypeContext()`: un `exists` contra una tabla que no
 * existe explota al planificarse, aunque esté en una rama muerta.
 */

export interface AccountTypeContext {
  members: boolean
  quotes: boolean
  licensesArchived: boolean
}

let cached: AccountTypeContext | null = null

/** Qué tablas hay. Se cachea sólo cuando están todas (una base no "pierde" tablas). */
export async function accountTypeContext(): Promise<AccountTypeContext> {
  if (cached) return cached
  const row = await sqlOne<{ members: boolean; quotes: boolean; licenses: boolean }>(
    `select to_regclass('public.partner_members') is not null as members,
            exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'quote_requests'
                       and column_name = 'close_reason_code') as quotes,
            exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'driver_licenses'
                       and column_name = 'archived') as licenses`,
  )
  const ctx = {
    members: row?.members === true,
    quotes: row?.quotes === true,
    licensesArchived: row?.licenses === true,
  }
  if (ctx.members && ctx.quotes && ctx.licensesArchived) cached = ctx
  return ctx
}

/** Membresía activa en algún taller. */
export const isPartnerSql = (alias: string, ctx: AccountTypeContext) =>
  ctx.members
    ? `exists (select 1 from partner_members pm_at
                where pm_at.user_id = ${alias}.id and pm_at.revoked_at is null)`
    : `false`

/** Uso como dueño: auto no archivado, pedido propio real o registro no archivado. */
export const ownerUseSql = (alias: string, ctx: AccountTypeContext) =>
  `(exists (select 1 from vehicles v_at where v_at.user_id = ${alias}.id and not v_at.archived)
    ${
      ctx.quotes
        ? `or exists (select 1 from quote_requests q_at
                      where q_at.user_id = ${alias}.id
                        and q_at.close_reason_code is distinct from 'duplicate')`
        : ''
    }
    or exists (select 1 from driver_licenses d_at
                where d_at.user_id = ${alias}.id ${ctx.licensesArchived ? 'and not d_at.archived' : ''}))`

/** `'usuario' | 'partner' | 'partner_dueno' | 'admin'`. Espejo de `accountType()` de `~/lib`. */
export const accountTypeSql = (alias: string, ctx: AccountTypeContext) =>
  `(case when ${alias}.role::text = 'admin' then 'admin'
         when ${isPartnerSql(alias, ctx)}
           then case when ${ownerUseSql(alias, ctx)} then 'partner_dueno' else 'partner' end
         else 'usuario' end)`

/** Cuenta como usuario de la app: Usuario o Partner + dueño. Sin el corte de internos. */
export const countsAsUserSql = (alias: string, ctx: AccountTypeContext) =>
  `(${alias}.role::text <> 'admin'
    and (not ${isPartnerSql(alias, ctx)} or ${ownerUseSql(alias, ctx)}))`

/**
 * "Usuario real": no interno (`ops.excluded_email_domains`) Y cuenta como
 * usuario. El alias tiene que ser `u` (lo pide `INTERNAL_PREDICATE`).
 */
export async function realUserPredicate(): Promise<string> {
  const ctx = await accountTypeContext()
  return `(not ${INTERNAL_PREDICATE} and ${countsAsUserSql('u', ctx)})`
}

/** Cuántas cuentas hay de cada tipo. La suma de `byType` es `total`, por construcción. */
export async function accountTypeCensus(): Promise<AccountTypeCensus> {
  const ctx = await accountTypeContext()
  const rows = await sql<{ t: AccountType; n: number; stale: number }>(
    `select t, count(*)::int as n,
            count(*) filter (where t in ('partner', 'partner_dueno') and role <> 'partner')::int as stale
       from (select u.role::text as role, ${accountTypeSql('u', ctx)} as t from users u) s
      group by t`,
  )
  const byType = Object.fromEntries(ACCOUNT_TYPES.map((t) => [t, 0])) as Record<AccountType, number>
  let stale = 0
  for (const r of rows) {
    byType[r.t] = Number(r.n)
    stale += Number(r.stale)
  }
  return {
    membersAvailable: ctx.members,
    total: ACCOUNT_TYPES.reduce((s, t) => s + byType[t], 0),
    byType,
    partnersWithStaleRole: stale,
  }
}

// ── Cola «Revisar cuentas» ───────────────────────────────────────────────────

let reviewsSeen = false
export async function accountReviewsAvailable(): Promise<boolean> {
  if (reviewsSeen) return true
  const row = await sqlOne<{ ok: boolean }>(`select to_regclass('ops.account_review') is not null as ok`)
  reviewsSeen = row?.ok === true
  return reviewsSeen
}

const toIso = (v: Date | string) => (v instanceof Date ? v.toISOString() : String(v))

interface QueueRow {
  kind: AccountReviewKind
  id: string
  email: string
  phone: string | null
  name: string | null
  role: string
  created_at: Date | string
  vehicle_count: number
  quote_count: number
  matches: Array<{
    field: AccountMatch['field']
    partner_id: string | null
    partner_name: string | null
    application_id: string | null
    application_name: string | null
  }> | null
  reviewed_at: Date | string | null
  reviewed_by: string | null
  review_note: string | null
}

/**
 * (a) `possible_partner`: rol `user`, sin membresía activa, con mail igual
 * (`lower(btrim)`) al de un taller o una solicitud, o teléfono cuyos últimos
 * 10 dígitos coinciden con el WhatsApp de un taller.
 * (b) `stale_role`: membresía activa y rol que no es `partner` ni `admin`.
 *
 * Trae mail y teléfono: es la única superficie del panel que los muestra
 * juntos con el taller, y pasa por `adminMiddleware`.
 */
export async function listAccountReviewQueue(): Promise<AccountReviewQueue> {
  const ctx = await accountTypeContext()
  const reviews = await accountReviewsAvailable()
  if (!ctx.members) return { reviewsAvailable: reviews, membersAvailable: false, rows: [] }

  const digits = (x: string) => `right(regexp_replace(coalesce(${x}, ''), '\\D', '', 'g'), 10)`
  const quoteCount = ctx.quotes
    ? `(select count(*) from quote_requests q where q.user_id = u.id
          and q.close_reason_code is distinct from 'duplicate')::int`
    : `0`
  const review = (kind: string) =>
    reviews
      ? `r.reviewed_at, coalesce(nullif(btrim(ru.name), ''), ru.email) as reviewed_by, r.note as review_note
           from users u
           left join ops.account_review r on r.user_id = u.id and r.kind = '${kind}'
           left join users ru on ru.id = r.reviewed_by`
      : `null::timestamptz as reviewed_at, null::text as reviewed_by, null::text as review_note
           from users u`

  const rows = await sql<QueueRow>(
    `
    with a as (
      select 'possible_partner'::text as kind, u.id, u.email, nullif(btrim(u.phone), '') as phone,
             u.name, u.role::text as role, u.created_at,
             (select count(*) from vehicles v where v.user_id = u.id and not v.archived)::int as vehicle_count,
             ${quoteCount} as quote_count,
             (select json_agg(m) from (
                select 'partner_email' as field, p.id as partner_id, p.name as partner_name,
                       null::uuid as application_id, null::text as application_name
                  from partners p
                 where nullif(lower(btrim(p.email)), '') = lower(btrim(u.email))
                union all
                select 'application_email', pa.id, pa.name, a2.id, a2.business_name
                  from partner_applications a2
                  left join partners pa on pa.application_id = a2.id
                 where nullif(lower(btrim(a2.email)), '') = lower(btrim(u.email))
                union all
                select 'partner_whatsapp', p.id, p.name, null::uuid, null::text
                  from partners p
                 where length(${digits('u.phone')}) = 10
                   and ${digits('p.whatsapp')} = ${digits('u.phone')}
             ) m) as matches,
             ${review('possible_partner')}
       where u.role::text = 'user'
         and not exists (select 1 from partner_members pm where pm.user_id = u.id and pm.revoked_at is null)
    ),
    b as (
      select 'stale_role'::text as kind, u.id, u.email, nullif(btrim(u.phone), '') as phone,
             u.name, u.role::text as role, u.created_at,
             (select count(*) from vehicles v where v.user_id = u.id and not v.archived)::int as vehicle_count,
             ${quoteCount} as quote_count,
             (select json_agg(json_build_object(
                       'field', 'member', 'partner_id', p.id, 'partner_name', p.name,
                       'application_id', null, 'application_name', null))
                from partner_members pm join partners p on p.id = pm.partner_id
               where pm.user_id = u.id and pm.revoked_at is null) as matches,
             ${review('stale_role')}
       where u.role::text not in ('partner', 'admin')
         and exists (select 1 from partner_members pm where pm.user_id = u.id and pm.revoked_at is null)
    )
    select * from a where matches is not null
    union all
    select * from b
    order by created_at desc
    `,
  )

  return {
    reviewsAvailable: reviews,
    membersAvailable: true,
    rows: rows.map(
      (r): AccountReviewRow => ({
        kind: r.kind,
        userId: r.id,
        email: r.email,
        phone: r.phone,
        name: r.name,
        role: r.role,
        createdAt: toIso(r.created_at),
        vehicleCount: Number(r.vehicle_count),
        quoteCount: Number(r.quote_count),
        matches: (r.matches ?? []).map((m) => ({
          field: m.field,
          partnerId: m.partner_id,
          partnerName: m.partner_name,
          applicationId: m.application_id,
          applicationName: m.application_name,
        })),
        review: r.reviewed_at
          ? { at: toIso(r.reviewed_at), byLabel: r.reviewed_by, note: r.review_note }
          : null,
      }),
    ),
  }
}

// Guardia: el espejo de los 10 dígitos existe para los tests; que nadie lo borre sin mirar el SQL.
void lastTenDigits

export async function markAccountReviewed(input: MarkAccountReviewedInput, actorId: string): Promise<void> {
  if (!(await accountReviewsAvailable())) throw new Error(ACCOUNT_REVIEW_UNAVAILABLE)
  await sql(
    `select ops.set_account_reviewed(
       p_user_id => $1, p_kind => $2, p_reviewed => $3, p_note => $4, p_actor_id => $5)`,
    [input.userId, input.kind, input.reviewed, input.note || null, actorId],
  )
}
