import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { INTERNAL_PREDICATE } from './ops.repo'
import { notDuplicatePredicate, vehicleTextSource } from './quote-requests.repo'
import { availablePieces, selectPieces } from './quote-resolution.repo'
import { teamAvailable } from './team.repo'
import {
  PARTNER_FEES_UNAVAILABLE,
  type AttributePartnerFeeInput,
  type FeeJobFacts,
  type FeePartnerFacts,
  type FeeStatus,
  type SetPartnerFeeStatusInput,
} from '~/lib/partner-fees'
import {
  PARTNER_PACKAGES_UNAVAILABLE,
  type CreatePackageInput,
  type PackageAllocation,
  type PackagesData,
  type PartnerPackage,
} from '~/lib/partner-packages'

/**
 * Liquidaciones a proveedores — migración 038. LEE `public` (pedidos,
 * propuestas, partners, billing) y ESCRIBE sólo `ops` por sus SP.
 * → `.claude/rules/partner-fees.md`
 *
 * Una sola sentencia trae todos los trabajos confirmados (son decenas): la
 * regla —disputa, sin atribuir, primer trabajo de cada taller— se aplica en
 * `~/lib/partner-fees`, que necesita verlos todos juntos.
 */

const BA = 'America/Argentina/Buenos_Aires'

const toIso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v)
const toNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

/** ¿Está aplicada la 038? Se cachea sólo el `true`. */
let feesSeen = false
export async function partnerFeesAvailable(): Promise<boolean> {
  if (feesSeen) return true
  const row = await sqlOne<{ ok: boolean }>(
    `select to_regclass('ops.partner_fee_attribution') is not null
        and to_regclass('ops.partner_fee_charge') is not null as ok`,
  )
  feesSeen = row?.ok === true
  return feesSeen
}

interface JobRow {
  id: string
  public_number: number | string
  created_at: Date | string
  job_day: string
  job_day_source: 'performed_on' | 'closed_at' | 'created_at'
  outcome: string | null
  user_outcome: string | null
  outcome_note: string | null
  closed_reason: string | null
  internal_notes: string | null
  vehicle_label: string | null
  op_services: Array<string> | null
  op_rubros: Array<string> | null
  ai_services: Array<string> | null
  selected_partner_id: string | null
  selected_provider_name: string | null
  proposals: Array<{ partner_id: string | null; name: string; amount_min: unknown; amount_max: unknown; withdrawn: boolean }> | null
  fa_partner_id: string | null
  fa_partner_name: string | null
  fa_note: string | null
  fa_by: string | null
  fa_at: Date | string | null
  fc_partner_id: string | null
  fc_status: FeeStatus | null
  fc_amount: unknown
  fc_notified_at: Date | string | null
  fc_paid_on: string | null
  fc_payment_method: string | null
  fc_note: string | null
  fc_void_reason: string | null
  fc_by: string | null
  fc_updated_at: Date | string | null
}

const USER_LABEL = (a: string) => `coalesce(nullif(btrim(${a}.name), ''), ${a}.email)`

/**
 * Los trabajos confirmados: `outcome` o `user_outcome` = `hired`, sin
 * duplicados/pruebas y sin cuentas internas (mismos predicados que el resto
 * del panel). Sin la 038 devuelve `null`.
 */
export async function listFeeJobFacts(): Promise<Array<FeeJobFacts> | null> {
  if (!(await partnerFeesAvailable())) return null

  const [pieces, textSource, extra] = await Promise.all([
    availablePieces(),
    vehicleTextSource(),
    sqlOne<{ catalog_id: boolean }>(
      `select exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = 'quote_requests'
                         and column_name = 'vehicle_catalog_id') as catalog_id`,
    ),
  ])
  const { columns, joins } = selectPieces(pieces)

  const vehicleText =
    textSource === 'column'
      ? `qr.vehicle_description`
      : textSource === 'ops'
        ? `(select vt.vehicle_text from ops.quote_request_vehicle_text vt where vt.quote_request_id = qr.id)`
        : `null::text`
  // El catálogo identificado por patente (sin vehículo vinculado).
  const catalogById =
    extra?.catalog_id === true
      ? `(select nullif(btrim(concat_ws(' ', c2.brand, c2.model, c2.year::text)), '')
            from vehicle_catalogs c2 where c2.id = qr.vehicle_catalog_id)`
      : `null::text`
  const proposals = pieces.proposals
    ? `(select json_agg(json_build_object(
                 'partner_id', p.partner_id,
                 'name', coalesce(pp.name, p.provider_name, '—'),
                 'amount_min', p.amount_min,
                 'amount_max', p.amount_max,
                 'withdrawn', p.withdrawn_at is not null) order by p.position, p.created_at)
          from quote_request_proposals p
          left join partners pp on pp.id = p.partner_id
         where p.quote_request_id = qr.id)`
    : `null::json`
  const rows = await sql<JobRow>(
    `
    select t.*
      from (
        select s.*,
               coalesce(s.performed_on,
                        to_char(s.closed_at at time zone '${BA}', 'YYYY-MM-DD'),
                        to_char(s.created_at at time zone '${BA}', 'YYYY-MM-DD')) as job_day,
               case when s.performed_on is not null then 'performed_on'
                    when s.closed_at is not null then 'closed_at'
                    else 'created_at' end as job_day_source
          from (
            select qr.id, qr.public_number, qr.created_at, qr.closed_at,
                   qr.outcome::text as outcome,
                   qr.user_outcome::text as user_outcome,
                   qr.outcome_note, qr.closed_reason, qr.internal_notes,
                   coalesce(
                     nullif(btrim(concat_ws(' ', vc.brand, vc.model, vc.year::text)), ''),
                     ${catalogById},
                     nullif(btrim(${vehicleText}), '')
                   ) as vehicle_label,
                   ${proposals} as proposals,
                   fa.partner_id as fa_partner_id, fap.name as fa_partner_name, fa.note as fa_note,
                   ${USER_LABEL('fau')} as fa_by, fa.updated_at as fa_at,
                   fc.partner_id as fc_partner_id, fc.status as fc_status, fc.amount as fc_amount,
                   fc.notified_at as fc_notified_at, to_char(fc.paid_on, 'YYYY-MM-DD') as fc_paid_on,
                   fc.payment_method as fc_payment_method, fc.note as fc_note, fc.void_reason as fc_void_reason,
                   ${USER_LABEL('fcu')} as fc_by, fc.updated_at as fc_updated_at${columns}
              from quote_requests qr
              left join users u on u.id = qr.user_id
              left join vehicles v on v.id = qr.vehicle_id
              left join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
              left join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
              left join ops.partner_fee_attribution fa on fa.quote_request_id = qr.id
              left join partners fap on fap.id = fa.partner_id
              left join users fau on fau.id = fa.attributed_by
              left join ops.partner_fee_charge fc on fc.quote_request_id = qr.id
              left join users fcu on fcu.id = fc.updated_by
              ${joins}
             where (qr.outcome = 'hired' or qr.user_outcome = 'hired')
               and ${notDuplicatePredicate('qr.')}
               and not (qr.user_id is not null and ${INTERNAL_PREDICATE})
          ) s
      ) t
     order by t.job_day desc, t.public_number desc
    `,
  )

  return rows.map((r) => ({
    quoteRequestId: r.id,
    publicNumber: Number(r.public_number),
    createdAt: toIso(r.created_at) ?? '',
    jobDay: r.job_day,
    jobDaySource: r.job_day_source,
    outcome: r.outcome,
    userOutcome: r.user_outcome,
    outcomeNote: r.outcome_note,
    closedReason: r.closed_reason,
    internalNotes: r.internal_notes,
    vehicleLabel: r.vehicle_label,
    services: r.op_services?.length ? r.op_services : r.op_rubros?.length ? r.op_rubros : (r.ai_services ?? []),
    selectedPartnerId: r.selected_partner_id,
    selectedPartnerName: r.selected_provider_name,
    attribution: r.fa_partner_id
      ? { partnerId: r.fa_partner_id, partnerName: r.fa_partner_name, note: r.fa_note, byName: r.fa_by, at: toIso(r.fa_at) ?? '' }
      : null,
    proposals: (r.proposals ?? []).map((p) => ({
      partnerId: p.partner_id,
      name: p.name,
      amountMin: toNum(p.amount_min),
      amountMax: toNum(p.amount_max),
      withdrawn: p.withdrawn === true,
    })),
    charge:
      r.fc_partner_id && r.fc_status
        ? {
            partnerId: r.fc_partner_id,
            status: r.fc_status,
            amount: toNum(r.fc_amount),
            notifiedAt: toIso(r.fc_notified_at),
            paidOn: r.fc_paid_on,
            paymentMethod: r.fc_payment_method,
            note: r.fc_note,
            voidReason: r.fc_void_reason,
            updatedByName: r.fc_by,
            updatedAt: toIso(r.fc_updated_at) ?? '',
          }
        : null,
  }))
}

/**
 * Los proveedores que aparecen en los trabajos, con WhatsApp y «Alta por». El WhatsApp es del TALLER (para mandarle el cobro), no de
 * ninguna persona cliente.
 */
export async function listFeePartnerFacts(partnerIds: ReadonlyArray<string>): Promise<Array<FeePartnerFacts>> {
  if (partnerIds.length === 0) return []
  const team = await teamAvailable()
  const [rows] = await Promise.all([
    sql<{ id: string; name: string; whatsapp: string | null; tier: string | null; member_id: string | null; member_name: string | null; member_active: boolean | null }>(
      `select p.id, p.name, nullif(btrim(p.whatsapp), '') as whatsapp, p.tier::text as tier,
              ${team ? 'm.id' : 'null::uuid'} as member_id,
              ${team ? 'm.name' : 'null::text'} as member_name,
              ${team ? 'm.active' : 'null::boolean'} as member_active
         from partners p
         ${team ? `left join ops.partner_application_sourcer s on s.application_id = p.application_id
                   left join ops.team_member m on m.id = s.member_id` : ''}
        where p.id = any($1::uuid[])`,
      [partnerIds],
    ),
  ])
  return rows.map((r) => {
    return {
      id: r.id,
      name: r.name,
      whatsapp: r.whatsapp,
      tier: r.tier,
      sourcer: r.member_id && r.member_name ? { memberId: r.member_id, name: r.member_name, active: r.member_active === true } : null,
    }
  })
}

export async function attributePartnerFee(input: AttributePartnerFeeInput, actorId: string): Promise<void> {
  if (!(await partnerFeesAvailable())) throw new Error(PARTNER_FEES_UNAVAILABLE)
  await sql(
    `select ops.set_partner_fee_attribution(
       p_quote_request_id => $1, p_partner_id => $2, p_note => $3, p_actor_id => $4)`,
    [input.quoteRequestId, input.partnerId, input.note || null, actorId],
  )
}

export async function setPartnerFeeStatus(
  input: SetPartnerFeeStatusInput & { amount: number | null },
  actorId: string,
): Promise<number> {
  if (!(await partnerFeesAvailable())) throw new Error(PARTNER_FEES_UNAVAILABLE)
  const row = await sqlOne<{ n: number }>(
    `select ops.set_partner_fee_charges(
       p_quote_request_ids => $1::uuid[], p_partner_id => $2, p_status => $3, p_amount => $4,
       p_paid_on => $5, p_payment_method => $6, p_note => $7, p_void_reason => $8, p_actor_id => $9) as n`,
    [
      input.quoteRequestIds,
      input.partnerId,
      input.status,
      input.amount,
      input.status === 'cobrado' ? (input.paidOn ?? null) : null,
      input.status === 'cobrado' ? (input.paymentMethod ?? null) : null,
      input.note || null,
      input.status === 'anulado' ? input.voidReason || null : null,
      actorId,
    ],
  )
  return Number(row?.n ?? 0)
}

// ── Paquetes de trabajos (044) ──────────────────────────────────────────────

/** ¿Está aplicada la 044? Se cachea sólo el `true`. */
let packagesSeen = false
export async function partnerPackagesAvailable(): Promise<boolean> {
  if (packagesSeen) return true
  const row = await sqlOne<{ ok: boolean }>(
    `select to_regclass('ops.partner_job_package') is not null
        and to_regclass('ops.partner_job_package_allocation') is not null as ok`,
  )
  packagesSeen = row?.ok === true
  return packagesSeen
}

/** Todos los paquetes e imputaciones (son pocos). `null` sin la 044. */
export async function listPackagesData(opts: { partnerId?: string } = {}): Promise<PackagesData | null> {
  if (!(await partnerPackagesAvailable())) return null
  const params = opts.partnerId ? [opts.partnerId] : []
  const [packages, allocations] = await Promise.all([
    sql<{
      id: string
      partner_id: string
      jobs: number
      validity_days: number
      purchased_on: string
      expires_on: string
      price_paid: string
      payment_method: string
      note: string | null
      created_by: string | null
      created_at: Date | string
      voided_at: Date | string | null
      void_reason: string | null
      voided_by: string | null
    }>(
      `select k.id, k.partner_id, k.jobs, k.validity_days,
              to_char(k.purchased_on, 'YYYY-MM-DD') as purchased_on,
              to_char(k.expires_on, 'YYYY-MM-DD') as expires_on,
              k.price_paid::text as price_paid, k.payment_method, k.note,
              ${USER_LABEL('cu')} as created_by, k.created_at,
              k.voided_at, k.void_reason, ${USER_LABEL('vu')} as voided_by
         from ops.partner_job_package k
         left join users cu on cu.id = k.created_by
         left join users vu on vu.id = k.voided_by
        ${opts.partnerId ? 'where k.partner_id = $1' : ''}
        order by k.purchased_on desc, k.created_at desc`,
      params,
    ),
    sql<{
      id: string
      quote_request_id: string
      package_id: string
      created_at: Date | string
      created_by: string | null
      undone_at: Date | string | null
      undo_reason: string | null
      undone_by: string | null
      reopened_at: Date | string | null
    }>(
      `select a.id, a.quote_request_id, a.package_id, a.created_at, ${USER_LABEL('cu')} as created_by,
              a.undone_at, a.undo_reason, ${USER_LABEL('uu')} as undone_by, a.reopened_at
         from ops.partner_job_package_allocation a
         join ops.partner_job_package k on k.id = a.package_id
         left join users cu on cu.id = a.created_by
         left join users uu on uu.id = a.undone_by
        ${opts.partnerId ? 'where k.partner_id = $1' : ''}
        order by a.created_at`,
      params,
    ),
  ])
  return {
    packages: packages.map(
      (r): PartnerPackage => ({
        id: r.id,
        partnerId: r.partner_id,
        jobs: Number(r.jobs),
        validityDays: Number(r.validity_days),
        purchasedOn: r.purchased_on,
        expiresOn: r.expires_on,
        pricePaid: Number(r.price_paid),
        paymentMethod: r.payment_method,
        note: r.note,
        createdByName: r.created_by,
        createdAt: toIso(r.created_at) ?? '',
        voidedAt: toIso(r.voided_at),
        voidReason: r.void_reason,
        voidedByName: r.voided_by,
      }),
    ),
    allocations: allocations.map(
      (r): PackageAllocation => ({
        id: r.id,
        quoteRequestId: r.quote_request_id,
        packageId: r.package_id,
        createdAt: toIso(r.created_at) ?? '',
        createdByName: r.created_by,
        undoneAt: toIso(r.undone_at),
        undoReason: r.undo_reason,
        undoneByName: r.undone_by,
        reopenedAt: toIso(r.reopened_at),
      }),
    ),
  }
}

export async function createPartnerPackage(input: CreatePackageInput, actorId: string): Promise<void> {
  if (!(await partnerPackagesAvailable())) throw new Error(PARTNER_PACKAGES_UNAVAILABLE)
  await sql(
    `select ops.create_partner_job_package(
       p_partner_id => $1, p_jobs => $2, p_validity_days => $3, p_purchased_on => $4::date,
       p_price_paid => $5, p_payment_method => $6, p_note => $7, p_actor_id => $8)`,
    [input.partnerId, input.jobs, input.validityDays, input.purchasedOn, input.pricePaid, input.paymentMethod, input.note || null, actorId],
  )
}

export async function voidPartnerPackage(packageId: string, reason: string, actorId: string): Promise<void> {
  if (!(await partnerPackagesAvailable())) throw new Error(PARTNER_PACKAGES_UNAVAILABLE)
  await sql(`select ops.void_partner_job_package(p_package_id => $1, p_reason => $2, p_actor_id => $3)`, [
    packageId,
    reason,
    actorId,
  ])
}

export async function allocateJobToPackage(quoteRequestId: string, packageId: string, actorId: string): Promise<void> {
  if (!(await partnerPackagesAvailable())) throw new Error(PARTNER_PACKAGES_UNAVAILABLE)
  await sql(
    `select ops.allocate_job_to_package(p_quote_request_id => $1, p_package_id => $2, p_actor_id => $3)`,
    [quoteRequestId, packageId, actorId],
  )
}

export async function undoJobPackageAllocation(
  quoteRequestId: string,
  packageId: string | null,
  reason: string,
  actorId: string,
): Promise<void> {
  if (!(await partnerPackagesAvailable())) throw new Error(PARTNER_PACKAGES_UNAVAILABLE)
  await sql(
    `select ops.undo_job_package_allocation(
       p_quote_request_id => $1, p_package_id => $2, p_reason => $3, p_actor_id => $4)`,
    [quoteRequestId, packageId, reason, actorId],
  )
}

export async function reopenJobPackageAllocation(quoteRequestId: string, actorId: string): Promise<void> {
  if (!(await partnerPackagesAvailable())) throw new Error(PARTNER_PACKAGES_UNAVAILABLE)
  await sql(`select ops.reopen_job_package_allocation(p_quote_request_id => $1, p_actor_id => $2)`, [
    quoteRequestId,
    actorId,
  ])
}

export async function setPartnerPackagePrice(
  packageId: string,
  pricePaid: number,
  reason: string | null,
  actorId: string,
): Promise<void> {
  if (!(await partnerPackagesAvailable())) throw new Error(PARTNER_PACKAGES_UNAVAILABLE)
  await sql(
    `select ops.set_partner_job_package_price(p_package_id => $1, p_price_paid => $2, p_reason => $3, p_actor_id => $4)`,
    [packageId, pricePaid, reason, actorId],
  )
}
