import { z } from 'zod'

/**
 * Negocio — el contrato de la pantalla `/negocio` (P&L mensual).
 *
 * Qué contesta: cuánta plata entra, cuánta sale y qué queda, mes a mes. Es la
 * primera pantalla del panel que **no reemplaza una consulta de DBeaver** — el
 * P&L no se puede correr hoy ni a mano, porque cruza `public` con `ops` y con
 * números que no viven en ninguna tabla (planes, tipo de cambio, infra). Misma
 * excepción que ya se aceptó para `/ai-costos`.
 *
 * Regla que ordena todo el módulo, y vale para cada fila: **una fila que no se
 * puede medir se declara como agujero, no se estima en silencio.** Un panel de
 * plata que rellena un hueco con un número plausible es peor que no tener panel.
 *
 * ── Alcance de la Fase 1 (esta entrega) ─────────────────────────────────────
 *
 * Lectura pura, sin migración y sin una sola escritura: usuarios, proveedores,
 * pedidos (declarado ausente) y tareas internas. Los bloques de costos,
 * ingresos y margen del plan llegan con sus migraciones (011–013) en fases
 * siguientes. → `.claude/plans/` / el plan de `/negocio`.
 */

// ── Churn ────────────────────────────────────────────────────────────────────

/**
 * Días corridos sin ninguna señal de actividad tras los cuales un usuario
 * cuenta como baja. Constante nombrada y documentada, igual que
 * `NOTIFICATION_DELAYED_AFTER_MIN` — nunca un `60` suelto en el SQL.
 *
 * La condición COMPLETA de churn (ver `business.repo.ts`):
 *  - pasaron ≥ 60 días desde la última señal, con piso en `users.created_at`
 *    (sin piso, el que se registró y nunca hizo nada no churnearía jamás);
 *  - Y no tenía NINGÚN vehículo creado a fin de ese mes. La condición del
 *    vehículo se evalúa sobre `created_at` (inmutable), NUNCA sobre `archived`:
 *    archivar un auto hoy no puede reescribir la serie histórica hacia atrás.
 *
 * La lista de señales se importa de `~/lib/activity` — la misma que
 * `last_activity_at` de `/usuarios`.
 */
export const USER_CHURN_AFTER_DAYS = 60

// ── Ventana de meses ─────────────────────────────────────────────────────────

/**
 * `businessMonths`, NO `window`. `window` ya lo usan `/operacion` y `/ai-costos`
 * con enums distintos, y el merge de `FullSearchSchema` de TanStack rompería el
 * typecheck en la ruta ajena. → `.claude/rules/notifications.md`.
 *
 * Default `all` mientras haya dos meses de historia. `6m` / `12m` recortan las
 * filas mostradas; los acumulados y el churn acumulado se siguen calculando
 * absolutos a la fecha, así que recortar la vista no miente.
 */
export const BUSINESS_MONTH_WINDOWS = ['all', '6m', '12m'] as const
export type BusinessMonthWindow = (typeof BUSINESS_MONTH_WINDOWS)[number]

export const BUSINESS_MONTH_WINDOW_LABELS: Record<BusinessMonthWindow, string> = {
  all: 'Todo',
  '6m': 'Últimos 6 meses',
  '12m': 'Últimos 12 meses',
}

/** `null` = sin corte. Se traduce a un `date` límite en el repo, nunca en el componente. */
export const BUSINESS_MONTH_WINDOW_COUNT: Record<BusinessMonthWindow, number | null> = {
  all: null,
  '6m': 6,
  '12m': 12,
}

export const businessSearchSchema = z.object({
  businessMonths: z.enum(BUSINESS_MONTH_WINDOWS).catch('all').default('all'),
})

export type BusinessSearch = z.infer<typeof businessSearchSchema>

// ── Filas por mes ────────────────────────────────────────────────────────────

interface MonthRow {
  /** `'YYYY-MM'`, primer día del mes truncado en UTC del lado de Postgres. */
  month: string
  /** El mes en curso: su fila se marca parcial para que un 1º de mes no se lea como caída. */
  partial: boolean
}

/**
 * Un mes del bloque «Usuarios».
 *
 * La identidad TIENE que cerrar en toda la tabla, y va un test de cuadre:
 *
 *   activosFinDeMes(m) = activosFinDeMes(m-1) + altas(m) − bajas(m)
 *
 * `bajas` sale de la diferencia de churn acumulado (`churnAcum(m) −
 * churnAcum(m-1)`), así que la identidad se cumple por construcción — pero el
 * test la verifica igual, porque un bug en el SQL de `churnAcum` la rompe.
 */
export interface UserMonthRow extends MonthRow {
  /** Altas del mes. Excluye cuentas internas (`INTERNAL_PREDICATE`). */
  altas: number
  /** Altas acumuladas a fin de mes. */
  acumulados: number
  /**
   * Bajas por churn del mes. Puede ser negativa: si un usuario que había
   * churneado vuelve a dar señal o carga un auto, sale del churn acumulado.
   */
  bajas: number
  /** `altas − bajas`. */
  crecimientoNeto: number
  /** `null` cuando `bajas <= 0` — jamás `∞` ni `0`, que se leerían como datos. */
  ratioAltasBajas: number | null
  /** `acumulados − churnAcum`. */
  activosFinDeMes: number
}

/** Un mes del bloque «Proveedores». Sin churn — no hay histórico de estado. */
export interface ProviderMonthRow extends MonthRow {
  altas: number
  /** De las altas del mes, cuántas vinieron del `legacy_sheet` (import, no captación). */
  altasFromSheet: number
  acumulados: number
}

/**
 * Un mes del bloque «Tareas internas del usuario» (`maintenance_occurrences`).
 * Métrica de USO del producto, no de negocio: no entra al margen.
 *
 * Las dos columnas se bucketean por `created_at` (cuándo se registró la
 * ocurrencia en la app), NO por `performed_at` — esa fecha es texto que el
 * usuario carga para su historial y llega hasta 2023, lo que estiraría el eje
 * con decenas de meses vacíos.
 */
export interface InternalTaskMonthRow extends MonthRow {
  /** Ocurrencias creadas en el mes. */
  generated: number
  /** De ésas, cuántas tienen `performed_at` cargado (marcadas como hechas). */
  done: number
}

// ── Agregado de pantalla ─────────────────────────────────────────────────────

export interface BusinessUsers {
  rows: Array<UserMonthRow>
  /** Umbral de churn, para que la pantalla lo diga en voz alta. */
  churnAfterDays: number
  /**
   * Registrados que nunca hicieron NADA (ni un auto cargado). Es lo único del
   * bloque de churn con contenido hoy: caen como baja a los 60 días de
   * registrarse.
   */
  neverActivated: number
}

export interface BusinessProviders {
  rows: Array<ProviderMonthRow>
  /**
   * Guardián que se autodenuncia: partners con `status <> 'active'`. Hoy 0. Si
   * deja de serlo, la serie de acumulado dejó de ser verdad (`partners.status`
   * es el estado ACTUAL, no histórico) y la pantalla lo muestra en ámbar en vez
   * de seguir dibujando una curva que ya no describe la realidad.
   */
  nonActiveCount: number
}

export interface BusinessMetrics {
  /** Rango de meses efectivamente devuelto (ya recortado por `businessMonths`). */
  window: BusinessMonthWindow
  users: BusinessUsers
  providers: BusinessProviders
  internalTasks: { rows: Array<InternalTaskMonthRow> }
  /**
   * Pedidos: modelado, no fabricado. `tracked: false` — no hay tabla, no hay
   * flujo, no hay una sola fila. La fila existe en el contrato desde el día uno
   * (mismo patrón que `ops.ai_surface_registry` con `tracked = false`) para que
   * la pantalla pueda mostrar el agujero. El día que el backend tenga el
   * aggregate (`QuoteRequest` / `QuoteOffer`, a confirmar), esto pasa a traer
   * filas.
   */
  orders: { tracked: false }
}
