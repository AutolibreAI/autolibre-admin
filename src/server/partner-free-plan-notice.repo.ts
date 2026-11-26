import '@tanstack/react-start/server-only'
import { sql, sqlOne } from './db'
import { listPartnerPlans } from './partner-plans.repo'
import { FREE_PLAN_CODE, effectivePlans } from '~/lib/partner-plans'
import {
  FREE_PLAN_NOTICE_UNAVAILABLE,
  type FreePlanNotice,
  type FreePlanNoticeList,
  type SetFreePlanNoticeInput,
} from '~/lib/partner-free-plan-notice'

/**
 * Aviso del cambio del plan gratis (migración 042). La lista cruza los
 * partners activos y pausados con su plan EFECTIVO (`effectivePlans`, la misma
 * regla que `/partners/propuestas`: no se reimplementa) y deja sólo los de plan
 * gratis. La escritura es `ops.set_partner_free_plan_notice`; nada de este
 * archivo escribe `public`. → `.claude/rules/partner-free-plan-notice.md`
 */

let noticeSeen = false

/** ¿Está aplicada la 042? Cachea sólo el `true` (una base que migra después lo ve). */
export async function freePlanNoticeAvailable(): Promise<boolean> {
  if (noticeSeen) return true
  const row = await sqlOne<{ ok: boolean }>(
    `select to_regclass('ops.partner_free_plan_notice') is not null
        and to_regclass('ops.partner_free_plan_notice_log') is not null as ok`,
  )
  noticeSeen = row?.ok === true
  return noticeSeen
}

export async function assertFreePlanNoticeAvailable(): Promise<void> {
  if (!(await freePlanNoticeAvailable())) throw new Error(FREE_PLAN_NOTICE_UNAVAILABLE)
}

const USER_LABEL = (alias: string) => `coalesce(nullif(btrim(${alias}.name), ''), ${alias}.email)`

interface NoticeRow {
  partner_id: string
  channel: string
  note: string | null
  notified_at: Date | string
  notified_by_label: string | null
}

const toIso = (v: Date | string) => (v instanceof Date ? v.toISOString() : String(v))

async function noticesByPartner(partnerIds: ReadonlyArray<string> | null): Promise<Map<string, FreePlanNotice>> {
  const rows = await sql<NoticeRow>(
    `select n.partner_id, n.channel, n.note, n.notified_at, ${USER_LABEL('u')} as notified_by_label
       from ops.partner_free_plan_notice n
       left join users u on u.id = n.notified_by
      where $1::uuid[] is null or n.partner_id = any($1::uuid[])`,
    [partnerIds],
  )
  return new Map(
    rows.map((r) => [
      r.partner_id,
      { channel: r.channel, note: r.note, notifiedAt: toIso(r.notified_at), notifiedByLabel: r.notified_by_label },
    ]),
  )
}

interface PartnerRow {
  id: string
  name: string
  zone: string | null
  whatsapp: string | null
  status: string
  tier: string
}

/**
 * Los proveedores con plan gratis HOY, activos y pausados (los archivados no
 * reciben pedidos ni vuelven: no tiene sentido avisarles). El universo del
 * contador lo acota la pantalla (activos, más pausados si se piden).
 */
export async function listFreePlanNotices(): Promise<FreePlanNoticeList> {
  if (!(await freePlanNoticeAvailable())) return { available: false, reason: 'migration' }
  const plans = await listPartnerPlans()
  if (!plans.available) return { available: false, reason: 'billing' }

  const partners = await sql<PartnerRow>(
    `select p.id, p.name, nullif(btrim(coalesce(p.coverage_zone, '')), '') as zone,
            nullif(btrim(coalesce(p.whatsapp, '')), '') as whatsapp,
            p.status::text as status, p.tier::text as tier
       from partners p
      where p.status in ('active', 'paused')
      order by lower(p.name)`,
  )
  const effective = effectivePlans(plans, partners.map((p) => p.id))
  const free = partners.filter((p) => effective.get(p.id)?.code === FREE_PLAN_CODE)
  const notices = await noticesByPartner(null)
  return {
    available: true,
    rows: free.map((p) => ({
      partnerId: p.id,
      name: p.name,
      zone: p.zone,
      whatsapp: p.whatsapp,
      status: p.status,
      tier: p.tier,
      notice: notices.get(p.id) ?? null,
    })),
  }
}

/** El aviso de UN partner, para la ficha. `null` = sin la 042. */
export async function getPartnerFreePlanNotice(
  partnerId: string,
): Promise<{ available: boolean; notice: FreePlanNotice | null }> {
  if (!(await freePlanNoticeAvailable())) return { available: false, notice: null }
  const map = await noticesByPartner([partnerId])
  return { available: true, notice: map.get(partnerId) ?? null }
}

export async function setFreePlanNotice(
  input: SetFreePlanNoticeInput,
  actorId: string,
): Promise<{ changed: boolean }> {
  await assertFreePlanNoticeAvailable()
  const row = await sqlOne<{ r: { changed: boolean } }>(
    `select ops.set_partner_free_plan_notice(
              p_partner_id => $1, p_notified => $2, p_channel => $3,
              p_note => $4, p_expected_notified => $5, p_actor_id => $6) as r`,
    [
      input.partnerId,
      input.notified,
      input.notified ? input.channel : null,
      input.note || null,
      input.expectedNotified,
      actorId,
    ],
  )
  return { changed: row?.r.changed === true }
}
