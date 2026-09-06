import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import {
  INSURANCE_WINDOW_DAYS,
  type ExpiringInsurance,
  type InsuranceStatus,
  type InsuranceSummary,
  type InsuranceWindow,
} from '~/lib/insurance'

/**
 * Seguros — la cola de pólizas por vencer.
 *
 * ── Qué reemplaza ──────────────────────────────────────────────────────────
 *
 * El `select … from insurances where expiration_date < …` que hoy nadie corre
 * en forma sistemática. Es una lista de trabajo (a quién contactar para
 * ofrecerle una alternativa), no una métrica.
 *
 * ── Ni una escritura ───────────────────────────────────────────────────────
 *
 * Una póliza es un hecho que el backend escribe cuando el usuario la carga en
 * la app — mismo criterio que `driving_sessions` en `scanner-compatibility.md`
 * y `conversations` en `chats.md`. Si aparece un `UPDATE`/`INSERT` acá, está
 * mal.
 */

const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v)

interface Row {
  id: string
  insurer: string
  policy_number: string
  coverage_type: string | null
  issue_date: Date | null
  expiration_date: Date
  days_to_expiry: number
  status: InsuranceStatus
  insured_name: string | null
  plate: string | null
  vin: string | null
  engine_number: string | null
  has_pdf: boolean
  created_at: Date
  user_id: string
  user_name: string | null
  user_email: string | null
  vehicle_id: string
  vehicle_alias: string | null
}

/**
 * Las pólizas por vencer dentro de la ventana, la más próxima primero (las ya
 * vencidas arriba de todo, con `days_to_expiry` negativo).
 *
 * ── `days_to_expiry` sale de `expiration_date`, NUNCA de `status` ────────────
 *
 * Verificado contra producción el 2026-09-06: hay pólizas en `active` a 28 días
 * de vencer y pólizas en `pending_renewal` a 7. A `status` lo mueve alguien (o
 * algún proceso del backend) y no se puede usar como reloj. Los días son
 * aritmética sobre la fecha; `status` viaja aparte, como una columna más. Misma
 * forma que `noData` vs `failed` en `/escaneres` y `stuck` vs `failed` en
 * `/operacion`.
 *
 * ── `JOIN`, no `LEFT JOIN` ──────────────────────────────────────────────────
 *
 * `insurances.user_id` y `insurances.vehicle_id` son NOT NULL con FK. Un
 * `LEFT JOIN` escondería una corrupción de datos —una póliza apuntando a un
 * usuario o vehículo que no existe— detrás de celdas vacías. Mismo criterio que
 * `findUserDetail` contra el catálogo del vehículo en `~/server/users.repo`.
 *
 * ── `coalesce(x,'') = ''`, no `x IS NULL` ───────────────────────────────────
 *
 * `insurer`/`coverage_type`/`plate` pueden venir como string vacío del import
 * de datos, no sólo como `NULL`. Se normaliza con `nullif(btrim(...), '')` para
 * que la UI muestre "—" en los dos casos y no una celda con un espacio.
 */
export async function listExpiringInsurances(
  window: InsuranceWindow,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<ExpiringInsurance>> {
  void opts.signal // `pg` no acepta AbortSignal; queda documentado el hueco.

  const days = INSURANCE_WINDOW_DAYS[window]

  const rows = await sql<Row>(
    `SELECT i.id,
            i.insurer,
            i.policy_number,
            nullif(btrim(coalesce(i.coverage_type, '')), '') AS coverage_type,
            i.issue_date,
            i.expiration_date,
            (i.expiration_date - current_date)::int AS days_to_expiry,
            i.status::text AS status,
            nullif(btrim(coalesce(i.insured_name, '')), '') AS insured_name,
            coalesce(nullif(btrim(coalesce(i.plate, '')), ''), v.plate) AS plate,
            nullif(btrim(coalesce(i.vin, '')), '') AS vin,
            nullif(btrim(coalesce(i.engine_number, '')), '') AS engine_number,
            i.file_id IS NOT NULL AS has_pdf,
            i.created_at,
            u.id AS user_id, u.name AS user_name, u.email AS user_email,
            v.id AS vehicle_id,
            nullif(btrim(coalesce(v.alias, '')), '') AS vehicle_alias
       FROM insurances i
       JOIN users u ON u.id = i.user_id
       JOIN vehicles v ON v.id = i.vehicle_id
      WHERE NOT i.archived
        AND ($1::int IS NULL
             OR i.expiration_date <= current_date + make_interval(days => $1::int))
      ORDER BY i.expiration_date ASC`,
    [days],
  )

  return rows.map((r) => ({
    id: r.id,
    insurer: r.insurer,
    policyNumber: r.policy_number,
    coverageType: r.coverage_type,
    issueDate: toIso(r.issue_date),
    expirationDate: toIso(r.expiration_date) as string,
    daysToExpiry: Number(r.days_to_expiry),
    status: r.status,
    insuredName: r.insured_name,
    plate: r.plate,
    vin: r.vin,
    engineNumber: r.engine_number,
    hasPdf: r.has_pdf,
    createdAt: toIso(r.created_at) as string,
    userId: r.user_id,
    userName: r.user_name,
    userEmail: r.user_email,
    vehicleId: r.vehicle_id,
    vehicleAlias: r.vehicle_alias,
  }))
}

/**
 * Los contadores de las tarjetas de arriba, en una sentencia.
 *
 * Se calculan siempre sobre los mismos tres cortes fijos —vencidas, ≤30, 31–90—
 * sin importar la ventana elegida en la UI: son un panorama, no el resultado
 * del filtro. Misma decisión que las tarjetas de cola en `/operacion`, que
 * están siempre incluso en cero.
 *
 * `count(*)` de `pg` vuelve como STRING; el `::int` en SQL lo arregla en el
 * borde. Ver `ops-metrics.md` §4.
 */
export async function insuranceSummary(
  opts: { signal?: AbortSignal } = {},
): Promise<InsuranceSummary> {
  void opts.signal

  const row = await sqlOne<{
    expired: number
    next30: number
    next90: number
    live: number
  }>(
    `SELECT count(*) FILTER (WHERE expiration_date < current_date)::int AS expired,
            count(*) FILTER (
              WHERE expiration_date >= current_date
                AND expiration_date < current_date + interval '30 days'
            )::int AS next30,
            count(*) FILTER (
              WHERE expiration_date >= current_date + interval '30 days'
                AND expiration_date < current_date + interval '90 days'
            )::int AS next90,
            count(*)::int AS live
       FROM insurances
      WHERE NOT archived`,
  )

  return row ?? { expired: 0, next30: 0, next90: 0, live: 0 }
}
