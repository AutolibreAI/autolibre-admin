import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import type { PartnerMember } from '~/lib/partner-members'

/**
 * Miembros de un partner — la LECTURA de `public.partner_members` (0141 del
 * backend). Ni una escritura: revocar va por HTTP (`~/server/backend`). Si
 * aparece un `INSERT`/`UPDATE` sobre `partner_members` acá, está mal.
 */

const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v)

/** Las columnas de `partner_members` que este repo LEE. Se tocan junto con el SELECT. */
const MEMBER_COLUMNS = [
  'id',
  'partner_id',
  'user_id',
  'member_role',
  'verified_via',
  'created_at',
  'revoked_at',
  'revoked_by_id',
] as const

/**
 * ¿Tiene esta base la 0141? `to_regclass` + las columnas que se leen, por
 * `information_schema` y no con un `select … limit 0` en try/catch (que termina
 * tragándose errores reales). Mismo patrón que `quoteProposalsAvailability()`.
 */
export async function partnerMembersAvailability(opts: { signal?: AbortSignal } = {}): Promise<boolean> {
  void opts.signal
  const row = await sqlOne<{ has_table: boolean; cols: number }>(
    `select to_regclass('public.partner_members') is not null as has_table,
            (select count(*)::int from information_schema.columns
              where table_schema = 'public' and table_name = 'partner_members'
                and column_name = any($1::text[])) as cols`,
    [MEMBER_COLUMNS],
  )
  return row?.has_table === true && Number(row.cols) === MEMBER_COLUMNS.length
}

interface MemberRow {
  id: string
  user_id: string
  user_email: string
  user_name: string | null
  member_role: string
  verified_via: string
  created_at: unknown
  revoked_at: unknown
  revoked_by_id: string | null
  revoked_by_email: string | null
}

/**
 * Activos primero, dueño antes que staff, después lo más nuevo arriba.
 *
 * `join users u` (no `left`): `user_id` es NOT NULL con FK; un `left`
 * escondería corrupción. `left join users r`: `revoked_by_id` es nullable y
 * `ON DELETE SET NULL`. Los enums viajan `::text` porque son abiertos.
 */
export async function listPartnerMembers(
  partnerId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<PartnerMember>> {
  void opts.signal
  const rows = await sql<MemberRow>(
    `select pm.id,
            pm.user_id,
            u.email as user_email,
            nullif(btrim(coalesce(u.name, '')), '') as user_name,
            pm.member_role::text as member_role,
            pm.verified_via::text as verified_via,
            pm.created_at,
            pm.revoked_at,
            pm.revoked_by_id,
            r.email as revoked_by_email
       from partner_members pm
       join users u on u.id = pm.user_id
       left join users r on r.id = pm.revoked_by_id
      where pm.partner_id = $1
      order by (pm.revoked_at is null) desc,
               (pm.member_role::text = 'owner') desc,
               pm.created_at desc,
               pm.id`,
    [partnerId],
  )

  // Mapeo explícito, campo por campo (mismo criterio que `mapCensus`).
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    userEmail: r.user_email,
    userName: r.user_name,
    memberRole: r.member_role,
    verifiedVia: r.verified_via,
    createdAt: toIso(r.created_at) ?? '',
    revokedAt: toIso(r.revoked_at),
    revokedById: r.revoked_by_id,
    revokedByEmail: r.revoked_by_email,
  }))
}

/**
 * ¿Ese miembro es de ESTE partner? Se chequea antes de revocar para que un id
 * suelto del payload no se revoque a través de la ficha de otro taller.
 */
export async function memberBelongsToPartner(memberId: string, partnerId: string): Promise<boolean> {
  const row = await sqlOne<{ ok: boolean }>(
    `select exists (select 1 from partner_members where id = $1 and partner_id = $2) as ok`,
    [memberId, partnerId],
  )
  return row?.ok === true
}
