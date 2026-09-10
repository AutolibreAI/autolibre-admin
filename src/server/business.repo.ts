import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import { INTERNAL_PREDICATE } from './ops.repo'
import { USER_ACTIVITY_SIGNALS, lastSignalSql } from '~/lib/activity'
import {
  BUSINESS_MONTH_WINDOW_COUNT,
  USER_CHURN_AFTER_DAYS,
  type BusinessMetrics,
  type BusinessMonthWindow,
  type InternalTaskMonthRow,
  type ProviderMonthRow,
  type UserMonthRow,
} from '~/lib/business'

/**
 * Negocio — las consultas del P&L mensual (Fase 1: lectura pura).
 *
 * Mismo dueño de SQL que `ops.repo.ts` y `users.repo.ts`: **nosotros, sobre
 * tablas de `public`**. Se aplica la misma regla y por el mismo motivo (una
 * función de `ops` que lee `public` es una dependencia cruzada invisible para
 * las migraciones del backend). Con el SQL acá, un rename del backend rompe en
 * runtime igual, pero `rg` lo encuentra y el diff queda versionado.
 *
 * Corolario, literal: **ninguna consulta de este archivo escribe nada.** Las
 * escrituras del plan (tarifas, FX, planes) llegan con sus migraciones en fases
 * siguientes, y aun ahí son sobre `ops`, no sobre `public`.
 *
 * ── Por qué CADA bloque es una sola sentencia ───────────────────────────────
 *
 * Las columnas de un bloque comparten el snapshot de Postgres, así que cuadran
 * entre sí. Con seis consultas sueltas por bloque, una fila insertada en el
 * medio del barrido entra en un contador y no en otro. Mismo argumento que el
 * censo de `users.repo.ts` y el `UNION ALL` de `queueHealth`.
 *
 * El eje de meses (`generate_series` sobre `date_trunc('month', …)` en UTC) es
 * IDÉNTICO en los tres bloques, para que las tres tablas se lean fila por fila
 * una contra otra. Un mes sin altas sale en 0, no desaparece.
 */

const toInt = (value: unknown): number => Number(value ?? 0)

/**
 * El CTE de meses, compartido textual por los tres bloques.
 *
 * `$1` = meses hacia atrás a mostrar (`int`), o `null` para "todo". `greatest`
 * y `least` de Postgres IGNORAN los `null`, así que `greatest(data_lo, null)` =
 * `data_lo` cuando la ventana es "todo".
 *
 * El piso absoluto (`data_lo`) es el mes de la primera fila entre usuarios,
 * partners y ocurrencias de mantenimiento — no de una sola tabla — para que el
 * eje cubra todo lo que los tres bloques pueden mostrar.
 */
const MONTHS_CTE = `
  bounds as (
    select
      date_trunc('month', least(
        (select min(created_at) from users),
        (select min(created_at) from partners),
        (select min(created_at) from maintenance_occurrences)
      ) at time zone 'UTC') as data_lo,
      date_trunc('month', now() at time zone 'UTC') as cur
  ),
  window_lo as (
    select greatest(
      (select data_lo from bounds),
      case when $1::int is null then null
           else (select cur from bounds) - make_interval(months => $1::int - 1) end
    ) as lo
  ),
  months as (
    select generate_series((select lo from window_lo), (select cur from bounds), interval '1 month') as m
  )
`

/** `m.m` (timestamp UTC, primer día del mes) → `'YYYY-MM'` + flag de mes en curso. */
const MONTH_SELECT = `to_char(m.m, 'YYYY-MM') as month, (m.m = (select cur from bounds)) as partial`

interface UserRawRow {
  month: string
  partial: boolean
  altas: number | string
  acumulados: number | string
  churn_acum: number | string
}

/**
 * Bloque «Usuarios»: altas, churn y activos por mes.
 *
 * ── El criterio de churn, y sus tres trampas ────────────────────────────────
 *
 *  1. La condición del vehículo se evalúa sobre `created_at`, NUNCA sobre
 *     `archived`. `vehicles.archived` no tiene fecha: si alguien archiva su auto
 *     hoy, la condición cambiaría también para agosto y la serie histórica se
 *     reescribiría sola. La pregunta correcta es "¿tenía algún vehículo creado a
 *     fin de ese mes?".
 *  2. El piso de la señal es `users.created_at` (`lastSignalSql(..., floor)`).
 *     Sin piso, el que se registró y nunca hizo nada no churnearía jamás; con
 *     piso, cae como baja a los 60 días de registrarse — deliberado.
 *  3. La lista de señales vive en `~/lib/activity`, compartida con
 *     `last_activity_at` de `/usuarios`. Si se amplía, se amplía para las dos.
 *
 * `churn_acum` es el churn ACUMULADO a fin de mes. `bajas(m)` se deriva en JS
 * de `churn_acum(m) − churn_acum(m-1)` — así la identidad
 * `activos(m) = activos(m-1) + altas(m) − bajas(m)` se cumple por construcción.
 */
export async function businessUserMonths(monthsBack: number | null): Promise<Array<UserRawRow>> {
  return sql<UserRawRow>(
    `
    with ${MONTHS_CTE},
    real_users as (
      select u.id, u.created_at
      from users u
      where not ${INTERNAL_PREDICATE}
    ),
    us as (
      select ru.id, ru.created_at,
        ${lastSignalSql('ru.id', { floor: 'ru.created_at' })} as last_signal,
        (select min(v.created_at) from vehicles v where v.user_id = ru.id) as first_vehicle_at
      from real_users ru
    )
    select
      ${MONTH_SELECT},
      (select count(*) from us
        where date_trunc('month', us.created_at at time zone 'UTC') = m.m)::int as altas,
      (select count(*) from us
        where us.created_at at time zone 'UTC' < m.m + interval '1 month')::int as acumulados,
      (select count(*) from us
        where us.created_at at time zone 'UTC' < m.m + interval '1 month'
          and us.last_signal <= (m.m + interval '1 month') at time zone 'UTC' - make_interval(days => $2::int)
          and (us.first_vehicle_at is null
               or us.first_vehicle_at >= (m.m + interval '1 month') at time zone 'UTC'))::int as churn_acum
    from months m
    order by m.m
    `,
    [monthsBack, USER_CHURN_AFTER_DAYS],
  )
}

/**
 * De `altas` / `acumulados` / `churn_acum` a las seis columnas de la tabla, con
 * la identidad cerrando por construcción.
 */
function deriveUserRows(raw: Array<UserRawRow>): Array<UserMonthRow> {
  let prevChurnAcum = 0
  return raw.map((r) => {
    const altas = toInt(r.altas)
    const acumulados = toInt(r.acumulados)
    const churnAcum = toInt(r.churn_acum)
    const bajas = churnAcum - prevChurnAcum
    prevChurnAcum = churnAcum
    return {
      month: r.month,
      partial: r.partial,
      altas,
      acumulados,
      bajas,
      crecimientoNeto: altas - bajas,
      // `null` cuando no hay bajas: `∞` (bajas=0) y `0` se leerían como datos.
      ratioAltasBajas: bajas > 0 ? altas / bajas : null,
      activosFinDeMes: acumulados - churnAcum,
    }
  })
}

interface ProviderRawRow {
  month: string
  partial: boolean
  altas: number | string
  altas_from_sheet: number | string
  acumulados: number | string
}

/**
 * Bloque «Proveedores»: altas y acumulado por `created_at` (columna inmutable →
 * serie estable). SIN churn: no hay histórico de estado y no se inventa uno.
 */
export async function businessProviderMonths(monthsBack: number | null): Promise<Array<ProviderRawRow>> {
  return sql<ProviderRawRow>(
    `
    with ${MONTHS_CTE}
    select
      ${MONTH_SELECT},
      (select count(*) from partners p
        where date_trunc('month', p.created_at at time zone 'UTC') = m.m)::int as altas,
      (select count(*) from partners p
        where p.source = 'legacy_sheet'
          and date_trunc('month', p.created_at at time zone 'UTC') = m.m)::int as altas_from_sheet,
      (select count(*) from partners p
        where p.created_at at time zone 'UTC' < m.m + interval '1 month')::int as acumulados
    from months m
    order by m.m
    `,
    [monthsBack],
  )
}

interface TaskRawRow {
  month: string
  partial: boolean
  generated: number | string
  done: number | string
}

/**
 * Bloque «Tareas internas»: ocurrencias de mantenimiento generadas vs. hechas.
 *
 * Las dos por `created_at`, NO por `performed_at` — esa fecha es texto de
 * historial que el usuario carga y llega hasta 2023 (verificado en producción),
 * lo que estiraría el eje con decenas de meses vacíos.
 */
export async function businessTaskMonths(monthsBack: number | null): Promise<Array<TaskRawRow>> {
  return sql<TaskRawRow>(
    `
    with ${MONTHS_CTE}
    select
      ${MONTH_SELECT},
      (select count(*) from maintenance_occurrences o
        where date_trunc('month', o.created_at at time zone 'UTC') = m.m)::int as generated,
      (select count(*) from maintenance_occurrences o
        where o.performed_at is not null
          and date_trunc('month', o.created_at at time zone 'UTC') = m.m)::int as done
    from months m
    order by m.m
    `,
    [monthsBack],
  )
}

/**
 * Los dos escalares de un solo snapshot que acompañan a las series:
 *  - `neverActivated`: registrados reales sin NINGUNA señal (las de `~/lib/activity`).
 *  - `providersNonActive`: partners con `status <> 'active'` — el guardián de la
 *    serie de proveedores (hoy 0).
 */
async function businessScalars(): Promise<{ neverActivated: number; providersNonActive: number }> {
  const noSignal = USER_ACTIVITY_SIGNALS.map(
    (s) => `not exists (select 1 from ${s.table} t where t.${s.userColumn} = u.id)`,
  ).join(' and ')

  const row = await sqlOne<{ never_activated: number | string; providers_non_active: number | string }>(
    `
    select
      (select count(*) from users u
        where not ${INTERNAL_PREDICATE} and ${noSignal})::int as never_activated,
      (select count(*) from partners where status <> 'active')::int as providers_non_active
    `,
  )
  return {
    neverActivated: toInt(row?.never_activated),
    providersNonActive: toInt(row?.providers_non_active),
  }
}

/**
 * El agregado de pantalla. Cinco consultas en paralelo contra el pool (`max: 5`)
 * — tres series, un escalar, y nada más: los bloques de costos / ingresos /
 * margen del plan aún no existen.
 */
export async function businessMetrics(
  window: BusinessMonthWindow,
  opts: { signal?: AbortSignal } = {},
): Promise<BusinessMetrics> {
  void opts.signal // `pg` no acepta AbortSignal; queda documentado el hueco.

  const monthsBack = BUSINESS_MONTH_WINDOW_COUNT[window]

  const [userRaw, providerRaw, taskRaw, scalars] = await Promise.all([
    businessUserMonths(monthsBack),
    businessProviderMonths(monthsBack),
    businessTaskMonths(monthsBack),
    businessScalars(),
  ])

  const providers: Array<ProviderMonthRow> = providerRaw.map((r) => ({
    month: r.month,
    partial: r.partial,
    altas: toInt(r.altas),
    altasFromSheet: toInt(r.altas_from_sheet),
    acumulados: toInt(r.acumulados),
  }))

  const internalTasks: Array<InternalTaskMonthRow> = taskRaw.map((r) => ({
    month: r.month,
    partial: r.partial,
    generated: toInt(r.generated),
    done: toInt(r.done),
  }))

  return {
    window,
    users: {
      rows: deriveUserRows(userRaw),
      churnAfterDays: USER_CHURN_AFTER_DAYS,
      neverActivated: scalars.neverActivated,
    },
    providers: {
      rows: providers,
      nonActiveCount: scalars.providersNonActive,
    },
    internalTasks: { rows: internalTasks },
    orders: { tracked: false },
  }
}
