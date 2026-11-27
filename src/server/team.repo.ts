import '@tanstack/react-start/server-only'
import { sql, sqlOne } from './db'
import {
  SOURCING_PERIODS,
  TEAM_UNAVAILABLE,
  type ApplicationSourcing,
  type PanelUserOption,
  type SourcerRef,
  type SourcingCountRow,
  type SourcingCounts,
  type SourcingUnit,
  type TeamMember,
} from '~/lib/team'

/**
 * El equipo y "Alta por" — migración 035. Lee y escribe SÓLO `ops`: la
 * asignación referencia `partner_applications.id` por UUID pelado.
 * → `.claude/rules/team-sourcing.md`
 */

const BA = 'America/Argentina/Buenos_Aires'

/**
 * ¿Está aplicada la 035? Sin ella, cualquier SELECT a `ops.team_member`
 * explota al planificarse: se pregunta antes. Se cachea sólo el `true`.
 */
let teamSeen = false
export async function teamAvailable(): Promise<boolean> {
  if (teamSeen) return true
  const row = await sqlOne<{ ok: boolean }>(
    `select to_regclass('ops.team_member') is not null
        and to_regclass('ops.partner_application_sourcer') is not null
        and to_regclass('ops.partner_application_sourcer_log') is not null as ok`,
  )
  teamSeen = row?.ok === true
  return teamSeen
}

export async function assertTeamAvailable(): Promise<void> {
  if (!(await teamAvailable())) throw new Error(TEAM_UNAVAILABLE)
}

/** Etiqueta de un usuario del panel: nombre, o el email si no tiene. */
const USER_LABEL = (alias: string) => `coalesce(nullif(btrim(${alias}.name), ''), ${alias}.email)`

interface MemberRow {
  id: string
  name: string
  role: string
  active: boolean
  active_since: string
  inactive_since: string | null
  user_id: string | null
  user_label: string | null
  application_count: number
  earns_award: boolean | null
}

/** Activas primero, después por nombre. */
export async function listTeamMembers(): Promise<Array<TeamMember>> {
  if (!(await teamAvailable())) return []
  const earns = await sqlOne<{ ok: boolean }>(
    `select exists (select 1 from information_schema.columns
                     where table_schema = 'ops' and table_name = 'team_member' and column_name = 'earns_award') as ok`,
  )
  const rows = await sql<MemberRow>(
    `select m.id, m.name, m.role, m.active, ${earns?.ok ? 'm.earns_award' : 'null::boolean'} as earns_award,
            to_char(m.active_since, 'YYYY-MM-DD') as active_since,
            to_char(m.inactive_since, 'YYYY-MM-DD') as inactive_since,
            m.user_id, ${USER_LABEL('u')} as user_label,
            (select count(*)::int from ops.partner_application_sourcer s where s.member_id = m.id) as application_count
       from ops.team_member m
       left join users u on u.id = m.user_id
      order by m.active desc, lower(m.name)`,
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    active: r.active,
    activeSince: r.active_since,
    inactiveSince: r.inactive_since,
    userId: r.user_id,
    userLabel: r.user_label,
    applicationCount: Number(r.application_count),
    earnsAward: r.earns_award,
  }))
}

/** La persona vinculada a un usuario del panel (para "Es mío"). */
export async function findMemberIdForUser(userId: string): Promise<string | null> {
  if (!(await teamAvailable())) return null
  const row = await sqlOne<{ id: string }>(
    `select id from ops.team_member where user_id = $1 and active`,
    [userId],
  )
  return row?.id ?? null
}

/**
 * Usuarios del panel que se pueden vincular: admins con cuenta de Clerk (los
 * únicos que entran). Sin el corte por `clerk`, DEV traería 876 admins
 * `native` heredados (`CLAUDE.md`).
 */
export async function listPanelUsers(): Promise<Array<PanelUserOption>> {
  const linked = await teamAvailable()
  const rows = await sql<{ id: string; label: string; linked_member_id: string | null }>(
    `select u.id, ${USER_LABEL('u')} as label,
            ${linked ? '(select m.id from ops.team_member m where m.user_id = u.id)' : 'null::uuid'} as linked_member_id
       from users u
      where u.role = 'admin' and u.auth_provider = 'clerk'
      order by 2`,
  )
  return rows.map((r) => ({ id: r.id, label: r.label, linkedMemberId: r.linked_member_id }))
}

export async function createTeamMember(
  input: { name: string; role: string; userId: string | null },
  actorId: string,
): Promise<{ id: string }> {
  await assertTeamAvailable()
  const row = await sqlOne<{ r: { id: string } }>(
    `select ops.create_team_member(p_actor_id => $1, p_name => $2, p_role => $3, p_user_id => $4) as r`,
    [actorId, input.name, input.role, input.userId],
  )
  return { id: row!.r.id }
}

/** Parche camelCase → snake_case, explícito (una clave mal mapeada no se guardaría). */
export async function updateTeamMember(
  memberId: string,
  patch: { name?: string; role?: string; active?: boolean; userId?: string | null },
  actorId: string,
): Promise<void> {
  await assertTeamAvailable()
  const body: Record<string, unknown> = {}
  if (patch.name !== undefined) body.name = patch.name
  if (patch.role !== undefined) body.role = patch.role
  if (patch.active !== undefined) body.active = patch.active
  if (patch.userId !== undefined) body.user_id = patch.userId
  await sql(
    `select ops.update_team_member(p_id => $1, p_actor_id => $2, p_patch => $3::jsonb)`,
    [memberId, actorId, JSON.stringify(body)],
  )
}

export async function setApplicationSourcer(
  input: { applicationId: string; memberId: string | null; expectedMemberId: string | null },
  actorId: string,
): Promise<{ changed: boolean }> {
  await assertTeamAvailable()
  const row = await sqlOne<{ r: { changed: boolean } }>(
    `select ops.set_application_sourcer(
              p_application_id => $1, p_member_id => $2,
              p_expected_member_id => $3, p_actor_id => $4) as r`,
    [input.applicationId, input.memberId, input.expectedMemberId, actorId],
  )
  return { changed: row?.r.changed === true }
}

/** La asignación vigente de varias solicitudes, en una consulta. */
export async function sourcersByApplication(
  applicationIds: ReadonlyArray<string>,
): Promise<Map<string, SourcerRef>> {
  if (applicationIds.length === 0 || !(await teamAvailable())) return new Map()
  const rows = await sql<{ application_id: string; member_id: string; name: string; active: boolean }>(
    `select s.application_id, m.id as member_id, m.name, m.active
       from ops.partner_application_sourcer s
       join ops.team_member m on m.id = s.member_id
      where s.application_id = any($1::uuid[])`,
    [applicationIds],
  )
  return new Map(rows.map((r) => [r.application_id, { memberId: r.member_id, name: r.name, active: r.active }]))
}

/** La asignación vigente y el historial completo (más nuevo primero). */
export async function getApplicationSourcing(applicationId: string): Promise<ApplicationSourcing> {
  if (!(await teamAvailable())) return { current: null, history: [] }
  const [current, history] = await Promise.all([
    sqlOne<{ member_id: string; name: string; active: boolean; assigned_at: string; assigned_by_label: string | null }>(
      `select m.id as member_id, m.name, m.active, s.assigned_at, ${USER_LABEL('u')} as assigned_by_label
         from ops.partner_application_sourcer s
         join ops.team_member m on m.id = s.member_id
         left join users u on u.id = s.assigned_by
        where s.application_id = $1`,
      [applicationId],
    ),
    sql<{
      id: string
      before_id: string | null
      before_name: string | null
      before_active: boolean | null
      after_id: string | null
      after_name: string | null
      after_active: boolean | null
      actor_label: string | null
      created_at: string
    }>(
      `select l.id,
              b.id as before_id, b.name as before_name, b.active as before_active,
              a.id as after_id, a.name as after_name, a.active as after_active,
              ${USER_LABEL('u')} as actor_label, l.created_at
         from ops.partner_application_sourcer_log l
         left join ops.team_member b on b.id = l.before_member_id
         left join ops.team_member a on a.id = l.after_member_id
         left join users u on u.id = l.actor_id
        where l.application_id = $1
        order by l.created_at desc, l.id`,
      [applicationId],
    ),
  ])
  const ref = (id: string | null, name: string | null, active: boolean | null): SourcerRef | null =>
    id && name ? { memberId: id, name, active: active ?? true } : null
  return {
    current: current
      ? {
          memberId: current.member_id,
          name: current.name,
          active: current.active,
          assignedAt: new Date(current.assigned_at).toISOString(),
          assignedByLabel: current.assigned_by_label,
        }
      : null,
    history: history.map((h) => ({
      id: h.id,
      before: ref(h.before_id, h.before_name, h.before_active),
      after: ref(h.after_id, h.after_name, h.after_active),
      actorLabel: h.actor_label,
      at: new Date(h.created_at).toISOString(),
    })),
  }
}

/**
 * Quién dio de alta a un proveedor publicado: heredado de su solicitud
 * (`partners.application_id`). `null` si no vino de una solicitud o la
 * solicitud no está asignada.
 */
export async function sourcerForPartner(partnerId: string): Promise<SourcerRef | null> {
  if (!(await teamAvailable())) return null
  const row = await sqlOne<{ member_id: string; name: string; active: boolean }>(
    `select m.id as member_id, m.name, m.active
       from partners p
       join ops.partner_application_sourcer s on s.application_id = p.application_id
       join ops.team_member m on m.id = s.member_id
      where p.id = $1`,
    [partnerId],
  )
  return row ? { memberId: row.member_id, name: row.name, active: row.active } : null
}

/**
 * Progreso de la carga: solicitudes no descartadas sin asignar, sobre el total
 * no descartado. Todas las fechas y estados — incluidas las publicadas.
 */
export async function sourcingProgress(): Promise<{ unassigned: number; total: number } | null> {
  if (!(await teamAvailable())) return null
  const row = await sqlOne<{ unassigned: number; total: number }>(
    `select count(*) filter (where s.application_id is null)::int as unassigned,
            count(*)::int as total
       from partner_applications a
       left join ops.partner_application_sourcer s on s.application_id = a.id
      where a.status <> 'discarded'`,
  )
  return row ? { unassigned: Number(row.unassigned), total: Number(row.total) } : null
}

/**
 * Altas por persona por semana (lunes) o mes, en hora de Buenos Aires,
 * contadas por la FECHA DE LA SOLICITUD (`partner_applications.created_at`),
 * no por cuándo se asignó: así una alta vieja cargada hoy cae en su semana.
 * Sin las descartadas (no son altas). La clave `none` cuenta las sin asignar.
 */
export async function sourcingCounts(unit: SourcingUnit): Promise<SourcingCounts> {
  const periodsBack = SOURCING_PERIODS[unit]
  const empty: SourcingCounts = {
    available: false,
    unit,
    periods: [],
    members: [],
    unassigned: 0,
    totalApplications: 0,
  }
  if (!(await teamAvailable())) return empty

  const rows = await sql<{ period: string; member_id: string | null; n: number }>(
    `with periods as (
       select generate_series(
                date_trunc($1, now() at time zone $2) - make_interval(
                  weeks => case when $1 = 'week' then $3::int - 1 else 0 end,
                  months => case when $1 = 'month' then $3::int - 1 else 0 end),
                date_trunc($1, now() at time zone $2),
                case when $1 = 'week' then interval '1 week' else interval '1 month' end
              ) as p
     )
     select to_char(pr.p, 'YYYY-MM-DD') as period, s.member_id, count(a.id)::int as n
       from periods pr
       left join partner_applications a
              on a.status <> 'discarded'
             and date_trunc($1, a.created_at at time zone $2) = pr.p
       left join ops.partner_application_sourcer s on s.application_id = a.id
      group by pr.p, s.member_id
      order by pr.p desc`,
    [unit, BA, periodsBack],
  )

  const byPeriod = new Map<string, SourcingCountRow>()
  const seenMembers = new Set<string>()
  for (const r of rows) {
    const row = byPeriod.get(r.period) ?? { period: r.period, counts: {}, total: 0 }
    const n = Number(r.n)
    if (n > 0) {
      const key = r.member_id ?? 'none'
      row.counts[key] = (row.counts[key] ?? 0) + n
      row.total += n
      if (r.member_id) seenMembers.add(r.member_id)
    }
    byPeriod.set(r.period, row)
  }

  const [members, progress] = await Promise.all([listTeamMembers(), sourcingProgress()])
  return {
    available: true,
    unit,
    periods: [...byPeriod.values()],
    members: members
      .filter((m) => m.active || seenMembers.has(m.id))
      .map((m) => ({ memberId: m.id, name: m.name, active: m.active })),
    unassigned: progress?.unassigned ?? 0,
    totalApplications: progress?.total ?? 0,
  }
}
