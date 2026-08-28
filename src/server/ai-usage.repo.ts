import '@tanstack/react-start/server-only'

import { sql } from './db'
import { WINDOW_DAYS } from '~/lib/ai-usage'
import type {
  ModelPrice,
  SurfaceCoverage,
  UsageByModel,
  UsageByUser,
  UsageDay,
  UsageSummary,
  UsageWindow,
} from '~/lib/ai-usage'

/**
 * Costos de IA — lectura del schema `ops`.
 *
 * Todo lo de acá llama funciones de `ops`, no arma agregaciones a mano. Es la
 * misma decisión que el marketplace toma con `approve_partner_application()`:
 * la unidad de trabajo vive en la base y este archivo la invoca por nombre.
 *
 * La diferencia con `partners.repo.ts` es de qué lado está el dueño. Ahí el SQL
 * es del backend y el panel lo consume; acá el SQL es NUESTRO — vive en
 * `migrations/`, lo versiona este repo, lo aplica `pnpm db:migrate`. El repo
 * del backend no conoce `ops` y no tiene por qué.
 */

// ── Conversión ───────────────────────────────────────────────────────────────

/**
 * `pg` devuelve `bigint` y `numeric` como STRING, y esto no es un detalle
 * cosmético: `count(*)::bigint` llega como `"14"`, y `"14" + "3"` en JavaScript
 * es `"143"`. Un total de tokens concatenado en vez de sumado se ve plausible
 * en una fila y absurdo en el agregado, y la primera vez cuesta media hora.
 *
 * El driver hace eso a propósito — `bigint` excede `Number.MAX_SAFE_INTEGER` y
 * `numeric` es decimal exacto. Para lo que muestra este panel (tokens y montos
 * chicos) `number` alcanza de sobra; el día que haya que sumar plata de verdad,
 * el lugar de arreglarlo es acá, no en los componentes.
 */
const toInt = (value: unknown): number => Number(value ?? 0)

/**
 * Variante que PRESERVA el null.
 *
 * `toInt` mandaría un costo desconocido a 0, que es exactamente la mentira que
 * el LEFT JOIN de `ops.v_ai_usage_costed` existe para evitar. Cero es un
 * precio; null es "no sabemos". Ver el comentario de `formatUsd`.
 */
const toNum = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)

const toIso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value === null ? null : String(value)

/**
 * Un `date` de Postgres → 'YYYY-MM-DD', sin pasar por ninguna zona horaria.
 *
 * `pg` construye ese Date a MEDIANOCHE LOCAL del proceso, y de ahí sale un bug
 * que solo aparece en algunos servidores. Con el proceso en ART (UTC-3), el día
 * 2026-06-30 llega como `2026-06-30T03:00:00Z` y `toISOString().slice(0,10)`
 * devuelve el día correcto. Con el proceso al ESTE de UTC llega como
 * `2026-06-29T22:00:00Z` y el mismo slice devuelve 2026-06-29: la serie diaria
 * entera corrida un día, y los totales por día dejando de cuadrar con el total
 * del período.
 *
 * Vercel corre en UTC, así que hoy no muerde. Es exactamente la clase de bug
 * que espera a un cambio de región para aparecer.
 *
 * Leer los componentes LOCALES deshace la conversión que hizo `pg` y devuelve
 * el mismo día que agrupó `ops.ai_usage_daily`, corra donde corra el proceso.
 */
function toPlainDay(value: Date | string): string {
  if (!(value instanceof Date)) return String(value).slice(0, 10)
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${value.getFullYear()}-${month}-${day}`
}

/**
 * Traduce la ventana de la URL al `p_from` de las funciones.
 *
 * Se calcula acá y no en SQL con `now() - interval` a propósito: así las cuatro
 * consultas de una misma carga de pantalla comparten EXACTAMENTE el mismo
 * corte. Resolviéndolo por consulta, cada `now()` cae unos milisegundos después
 * y un evento en el borde puede entrar en el total pero no en la serie diaria —
 * las dos tablas dejan de sumar lo mismo por una razón invisible.
 */
export function windowStart(window: UsageWindow): Date | null {
  const days = WINDOW_DAYS[window]
  if (days === null) return null
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

interface Filters {
  window: UsageWindow
  surface?: string
}

/** Los tres parámetros posicionales que comparten las funciones de `ops`. */
function params({ window, surface }: Filters): [Date | null, null, string | null] {
  return [windowStart(window), null, surface ?? null]
}

// ── Lecturas ─────────────────────────────────────────────────────────────────

interface SummaryRow {
  events: string
  input_tokens: string
  output_tokens: string
  total_usd: string | null
  priced_events: string
  unpriced_events: string
  models: string
  users: string
  first_event: Date | null
  last_event: Date | null
  internal_events: string
}

export async function usageSummary(
  filters: Filters,
  opts: { signal?: AbortSignal } = {},
): Promise<UsageSummary> {
  void opts.signal // `pg` no acepta signal; queda documentado el hueco.

  const rows = await sql<SummaryRow>(
    'SELECT * FROM ops.ai_usage_summary($1, $2, $3)',
    params(filters),
  )

  /**
   * La función siempre devuelve una fila (es un agregado sin GROUP BY), pero el
   * fallback no sobra: sin él, un `ops` todavía sin migrar tiraría un
   * "cannot read property of undefined" en vez del error de Postgres, que es el
   * que dice qué pasa realmente.
   */
  const row = rows[0]
  if (!row) {
    return {
      events: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalUsd: null,
      pricedEvents: 0,
      unpricedEvents: 0,
      models: 0,
      users: 0,
      firstEvent: null,
      lastEvent: null,
      internalEvents: 0,
    }
  }

  return {
    events: toInt(row.events),
    inputTokens: toInt(row.input_tokens),
    outputTokens: toInt(row.output_tokens),
    totalUsd: toNum(row.total_usd),
    pricedEvents: toInt(row.priced_events),
    unpricedEvents: toInt(row.unpriced_events),
    models: toInt(row.models),
    users: toInt(row.users),
    firstEvent: toIso(row.first_event),
    lastEvent: toIso(row.last_event),
    internalEvents: toInt(row.internal_events),
  }
}

interface ByModelRow {
  model: string
  provider: string | null
  events: string
  input_tokens: string
  output_tokens: string
  total_usd: string | null
  unpriced: boolean
  input_usd_per_mtok: string | null
  output_usd_per_mtok: string | null
}

export async function usageByModel(
  filters: Filters,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<UsageByModel>> {
  void opts.signal

  const rows = await sql<ByModelRow>(
    'SELECT * FROM ops.ai_usage_by_model($1, $2, $3)',
    params(filters),
  )

  return rows.map((r) => ({
    model: r.model,
    provider: r.provider,
    events: toInt(r.events),
    inputTokens: toInt(r.input_tokens),
    outputTokens: toInt(r.output_tokens),
    totalUsd: toNum(r.total_usd),
    unpriced: r.unpriced,
    inputUsdPerMtok: toNum(r.input_usd_per_mtok),
    outputUsdPerMtok: toNum(r.output_usd_per_mtok),
  }))
}

interface DailyRow {
  day: Date | string
  events: string
  input_tokens: string
  output_tokens: string
  total_usd: string | null
  unpriced_events: string
}

export async function usageDaily(
  filters: Filters,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<UsageDay>> {
  void opts.signal

  const rows = await sql<DailyRow>(
    'SELECT * FROM ops.ai_usage_daily($1, $2, $3)',
    params(filters),
  )

  return rows.map((r) => ({
    day: toPlainDay(r.day),
    events: toInt(r.events),
    inputTokens: toInt(r.input_tokens),
    outputTokens: toInt(r.output_tokens),
    totalUsd: toNum(r.total_usd),
    unpricedEvents: toInt(r.unpriced_events),
  }))
}

interface ByUserRow {
  user_id: string | null
  user_name: string | null
  user_email: string | null
  events: string
  input_tokens: string
  output_tokens: string
  total_usd: string | null
}

export async function usageByUser(
  filters: Filters,
  limit = 20,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<UsageByUser>> {
  void opts.signal

  const [from, to, surface] = params(filters)
  const rows = await sql<ByUserRow>(
    'SELECT * FROM ops.ai_usage_by_user($1, $2, $3, $4)',
    [from, to, surface, limit],
  )

  return rows.map((r) => ({
    userId: r.user_id,
    name: r.user_name,
    email: r.user_email,
    events: toInt(r.events),
    inputTokens: toInt(r.input_tokens),
    outputTokens: toInt(r.output_tokens),
    totalUsd: toNum(r.total_usd),
  }))
}

interface CoverageRow {
  surface: string
  label: string
  source_table: string
  tracked: boolean
  has_token_columns: boolean
  total_rows: string | null
  measured_events: string
  note: string | null
}

/**
 * El informe de agujeros. NO acepta filtros y eso es intencional.
 *
 * Es una foto del producto entero, no del período elegido: "esta superficie no
 * mide nada" es verdad en los 7 días y en los 90. Filtrarla por ventana la
 * haría desaparecer justo cuando el período no tiene datos — que es exactamente
 * cuando más importa saber que la superficie existe y nadie la está midiendo.
 */
export async function surfaceCoverage(
  opts: { signal?: AbortSignal } = {},
): Promise<Array<SurfaceCoverage>> {
  void opts.signal

  const rows = await sql<CoverageRow>('SELECT * FROM ops.ai_surface_coverage()')

  return rows.map((r) => ({
    surface: r.surface,
    label: r.label,
    sourceTable: r.source_table,
    tracked: r.tracked,
    hasTokenColumns: r.has_token_columns,
    totalRows: toNum(r.total_rows),
    measuredEvents: toInt(r.measured_events),
    note: r.note,
  }))
}

interface PriceRow {
  id: string
  provider: string
  model: string
  input_usd_per_mtok: string
  output_usd_per_mtok: string
  valid_from: Date
  valid_to: Date | null
  source: string | null
  source_url: string | null
  verified_at: Date | null
  note: string | null
  current: boolean
}

/**
 * Las tarifas cargadas, para que la pantalla pueda mostrar CON QUÉ calculó.
 *
 * Un total de costo sin la tarifa a la vista es un número que nadie puede
 * auditar: si alguien sospecha que está mal, no tiene con qué comprobarlo sin
 * abrir DBeaver — que es el hábito que este panel viene a reemplazar.
 */
export async function modelPrices(
  opts: { signal?: AbortSignal } = {},
): Promise<Array<ModelPrice>> {
  void opts.signal

  const rows = await sql<PriceRow>(
    `SELECT p.id,
            p.provider,
            p.model,
            p.input_usd_per_mtok,
            p.output_usd_per_mtok,
            p.valid_from,
            p.valid_to,
            p.source,
            p.source_url,
            p.verified_at,
            p.note,
            (p.valid_to IS NULL OR p.valid_to > now()) AS current
       FROM ops.ai_model_pricing p
      ORDER BY p.provider, p.model, p.valid_from DESC`,
  )

  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    model: r.model,
    inputUsdPerMtok: Number(r.input_usd_per_mtok),
    outputUsdPerMtok: Number(r.output_usd_per_mtok),
    validFrom: toIso(r.valid_from) ?? '',
    validTo: toIso(r.valid_to),
    source: r.source,
    sourceUrl: r.source_url,
    verifiedAt: toIso(r.verified_at),
    note: r.note,
    current: r.current,
  }))
}
