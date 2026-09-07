import '@tanstack/react-start/server-only'

import { sql } from './db'
import {
  FINE_STALE_AFTER_DAYS,
  type FineDebtorRow,
  type FineSearch,
  type FineSortKey,
} from '~/lib/fines'

/**
 * Multas — la cola de vehículos con deuda.
 *
 * ── Ni una escritura ───────────────────────────────────────────────────────
 *
 * Una multa la escribe el backend cuando sincroniza con el proveedor. Es un
 * hecho, no un estado que el admin mueva — mismo criterio que `driving_sessions`
 * y `insurances`. Si aparece un `UPDATE`/`INSERT` acá, está mal.
 *
 * ── El grano es el VEHÍCULO consultado ─────────────────────────────────────
 *
 * Se parte de `vehicle_fine_syncs` (1:1 por vehículo, PK `vehicle_id`): "los
 * autos a los que se les consultó". Un auto con sync y sin multas es una fila
 * con `debt_amount = 0` — se muestra, no se esconde (mismo null-vs-0 que la
 * ficha de usuario: "consultado sin deuda" ≠ "nunca consultado", y acá TODAS
 * las filas fueron consultadas).
 */

const toInt = (v: unknown): number => Number(v ?? 0)
const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v)

interface Row {
  vehicle_id: string
  plate: string
  archived: boolean
  brand: string
  model: string
  year: number | string
  user_id: string
  user_name: string | null
  user_email: string
  consulted_at: Date | string
  days_since_consult: number | string
  fine_count: number | string
  debt_amount: number | string
  oldest_infraction: Date | string | null
  jurisdictions: Array<string> | null
}

/**
 * Mapa cerrado `FineSortKey → expresión SQL`. Es lo que hace seguro interpolar
 * la columna y `dir` directo en el `ORDER BY`: los dos valores salen de un enum
 * de zod y de este `Record` que los tipos obligan a cubrir. `ORDER BY $1` con
 * parámetro no existe en `pg`.
 */
const SORT_COLUMNS: Record<FineSortKey, string> = {
  debt: 'debt_amount',
  fineCount: 'fine_count',
  consultedAt: 'consulted_at',
  oldestInfraction: 'oldest_infraction',
  plate: 'plate',
  user: 'user_email',
  jurisdictions: 'jurisdictions',
}

/**
 * ── Va envuelto en `select * from (...) s`, igual que `listUsers` ───────────
 *
 * `debt_amount`, `fine_count`, `jurisdictions`, `days_since_consult` y
 * `oldest_infraction` son subconsultas escalares del SELECT. Filtrar u ordenar
 * por ellas en el mismo nivel obligaría a repetir cada subconsulta en el
 * `where`/`order by` (Postgres no deja usar un alias del SELECT en su propio
 * nivel). Se envuelve una vez y se referencia el alias afuera.
 *
 * ── `JOIN`, no `LEFT JOIN` ──────────────────────────────────────────────────
 *
 * `vehicle_fine_syncs.vehicle_id`, `vehicles.user_id` y
 * `vehicles.vehicle_catalog_spec_id` son todas FK a filas únicas. Un `LEFT JOIN`
 * escondería una corrupción de datos detrás de celdas vacías. Mismo criterio
 * que `findUserDetail`.
 *
 * ── "Adeudado" = `status = 'pending'` ──────────────────────────────────────
 *
 * `paid` está saldada, `appealed` en disputa: ninguna es deuda a cobrar. Al
 * 2026-09-06 las 240 multas de producción están todas `pending`, pero el filtro
 * tiene que estar para el día que alguien marque una pagada. `round()` porque
 * `amount` es `numeric` y las multas son enteras de pesos.
 */
export async function listFineDebtors(
  search: FineSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<FineDebtorRow>> {
  void opts.signal // `pg` no acepta AbortSignal; queda documentado el hueco.

  const params: Array<unknown> = []
  const outerWhere: Array<string> = []

  if (search.q) {
    params.push(`%${search.q}%`)
    const p = `$${params.length}`
    outerWhere.push(
      `(plate ilike ${p} or user_email ilike ${p} or coalesce(user_name, '') ilike ${p})`,
    )
  }

  if (search.jurisdiction) {
    params.push(search.jurisdiction)
    outerWhere.push(`$${params.length} = any(jurisdictions)`)
  }

  if (search.debt === 'with') outerWhere.push('debt_amount > 0')
  else if (search.debt === 'without') outerWhere.push('debt_amount = 0')

  if (search.freshness === 'stale') {
    outerWhere.push(`days_since_consult > ${FINE_STALE_AFTER_DAYS}`)
  } else if (search.freshness === 'fresh') {
    outerWhere.push(`days_since_consult <= ${FINE_STALE_AFTER_DAYS}`)
  }

  const sortColumn = SORT_COLUMNS[search.sort]

  const rows = await sql<Row>(
    `
    select * from (
      select
        v.id as vehicle_id,
        v.plate,
        v.archived,
        vc.brand, vc.model, vc.year,
        u.id as user_id, u.name as user_name, u.email as user_email,
        vfs.last_synced_at as consulted_at,
        (current_date - vfs.last_synced_at::date)::int as days_since_consult,
        (select count(*)::int from fines f
          where f.vehicle_id = v.id and f.status = 'pending') as fine_count,
        (select coalesce(round(sum(f.amount)), 0)::bigint from fines f
          where f.vehicle_id = v.id and f.status = 'pending') as debt_amount,
        (select min(f.infraction_date) from fines f
          where f.vehicle_id = v.id and f.status = 'pending') as oldest_infraction,
        (select array_agg(distinct f.jurisdiction::text order by f.jurisdiction::text)
           from fines f
          where f.vehicle_id = v.id and f.status = 'pending'
            and f.jurisdiction is not null) as jurisdictions
      from vehicle_fine_syncs vfs
      join vehicles v on v.id = vfs.vehicle_id
      join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
      join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
      join users u on u.id = v.user_id
    ) s
    ${outerWhere.length ? `where ${outerWhere.join(' and ')}` : ''}
    order by ${sortColumn} ${search.dir} nulls last, plate
    `,
    params,
  )

  return rows.map((r) => ({
    vehicleId: r.vehicle_id,
    plate: r.plate,
    archived: r.archived,
    brand: r.brand,
    model: r.model,
    year: toInt(r.year),
    userId: r.user_id,
    userName: r.user_name,
    userEmail: r.user_email,
    consultedAt: toIso(r.consulted_at) as string,
    daysSinceConsult: toInt(r.days_since_consult),
    fineCount: toInt(r.fine_count),
    debtAmount: toInt(r.debt_amount),
    oldestInfraction: toIso(r.oldest_infraction),
    jurisdictions: r.jurisdictions ?? [],
  }))
}

/**
 * Las jurisdicciones que de hecho aparecen en multas pendientes, para armar los
 * chips del filtro. Mismo patrón que `listDistinctChatModels` en `chats.repo.ts`:
 * hardcodear las 9 del enum mostraría chips que nunca filtran nada.
 */
export async function listFineJurisdictions(
  opts: { signal?: AbortSignal } = {},
): Promise<Array<string>> {
  void opts.signal
  const rows = await sql<{ jurisdiction: string }>(
    `select distinct jurisdiction::text as jurisdiction
       from fines
      where status = 'pending' and jurisdiction is not null
      order by 1`,
  )
  return rows.map((r) => r.jurisdiction)
}
