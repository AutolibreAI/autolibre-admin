import { z } from 'zod'

/**
 * Detecciones de escáner — la pestaña `/escaneres/detecciones`.
 *
 * ── Qué consulta de DBeaver reemplaza ───────────────────────────────────────
 *
 * Ninguna que alguien corriera: para saber "qué falla aparece más seguido y en
 * cuántos autos distintos" hay que unnestear `session_dtc_snapshots.codes`,
 * unnestear el jsonb `driving_telemetry_analysis.anomalies`, y contar cada uno
 * sobre su universo de sesiones (los DTC sobre todas las `completed`, las
 * anomalías sobre las que trajeron datos — ver `DetectionsView`). Es la
 * agregación transversal de lo que `/escaneres/sesiones` muestra fila por fila.
 *
 * ── Cómo se relaciona con las otras dos pestañas ────────────────────────────
 *
 * `/compatibilidad` cruza escáner × modelo ("¿con qué autos anda?").
 * `/sesiones` es el escaneo crudo, uno por fila. Ésta agrega por DTC/anomalía:
 * cada fila es un código o un tipo de anomalía, no un escaneo.
 *
 * ── Ni una escritura ────────────────────────────────────────────────────────
 *
 * `session_dtc_snapshots` y `driving_telemetry_analysis` los escribe el backend
 * cuando el teléfono sube los chunks. Una detección es un hecho que pasó. Si
 * aparece un `UPDATE`/`INSERT` en `detections.repo.ts`, está mal.
 */

// ── Severidad ──────────────────────────────────────────────────────────────
//
// El MISMO eje de tres niveles del catálogo de DTC del backend y de las
// anomalías de telemetría (`rojo` / `violeta` / `amarillo`, ver
// `design-system.md`). El jsonb lo trae en inglés; se espeja tal cual y un
// valor nuevo se muestra crudo.

/** Rojo > violeta > amarillo. Un valor desconocido queda en 0 (ordena último). */
export const SEVERITY_RANK: Record<string, number> = {
  red: 3,
  violet: 2,
  yellow: 1,
}

export const SEVERITY_LABELS: Record<string, string> = {
  red: 'Roja',
  violet: 'Violeta',
  yellow: 'Amarilla',
}

// ── La familia de un código DTC ────────────────────────────────────────────

export type DtcSystem = 'P' | 'C' | 'B' | 'U'

export const DTC_SYSTEM_LABELS: Record<DtcSystem, string> = {
  P: 'Motor y transmisión',
  C: 'Chasis',
  B: 'Carrocería',
  U: 'Red / comunicación',
}

export interface DtcFamily {
  /** Primera letra. `null` si el código no arranca con una conocida. */
  system: DtcSystem | null
  systemLabel: string
  /**
   * Genérico (definido por norma, `P0`/`P2`/`P34`…) vs. de fabricante
   * (`P1`/`P3`, `C1`, …). El segundo dígito lo decide. `null` si no se puede
   * leer. Sólo tiene sentido pleno para `P`; para el resto se informa igual.
   */
  generic: boolean | null
}

/**
 * Lee la familia de un código DTC de su forma (`P0171` → Powertrain, genérico).
 * No consulta nada: la letra y el dígito SON la taxonomía OBD-II. Un código con
 * forma rara devuelve `system: null` y se muestra crudo, nunca se esconde.
 */
export function dtcFamily(code: string): DtcFamily {
  const c = code.trim().toUpperCase()
  const first = c[0]
  const system: DtcSystem | null =
    first === 'P' || first === 'C' || first === 'B' || first === 'U' ? first : null
  const second = c[1]
  const generic =
    second === undefined || !/[0-9]/.test(second)
      ? null
      : second === '0' || second === '2'
  return {
    system,
    systemLabel: system ? DTC_SYSTEM_LABELS[system] : 'Código no estándar',
    generic,
  }
}

// ── La fila ────────────────────────────────────────────────────────────────

export type DetectionKind = 'dtc' | 'anomaly'

export interface DetectionRow {
  kind: DetectionKind
  /** DTC: el código (`P0171`). Anomalía: el tipo del backend (`UNSTABLE_MAF`). */
  key: string
  /** Legible: el código tal cual para DTC, el tipo traducido para anomalía. */
  label: string

  /**
   * DTC: título del catálogo local `src/server/dtc-codes.json`
   * (`P0420` → "Catalizador con eficiencia baja"). `null` si el código no está
   * cargado ahí — esas filas alimentan `DetectionsView.missingDtcs`. Siempre
   * `null` para anomalías (su `label` ya es el título).
   */
  dtcTitle: string | null
  /** DTC: el sistema del catálogo local ("Control de emisiones"). `null` si no está cargado. */
  dtcSystem: string | null

  /**
   * Anomalía: severidades vistas, la más grave primero. Puede tener más de una
   * si el mismo tipo se disparó con distinto peso en sesiones distintas.
   * `[]` para DTC — un código no lleva severidad en estas tablas.
   */
  severities: Array<string>

  /**
   * Sesiones donde apareció al menos una vez. Numerador de la columna
   * «Sesiones»; el denominador es `dtcSessions` o `anomalySessions` de
   * `DetectionsView` según `kind`.
   */
  sessions: number
  /**
   * Disparos crudos. Para DTC es igual a `sessions` (el código es un conjunto
   * por sesión). Para anomalías puede ser mayor: un tipo se dispara dos veces
   * en la misma sesión si afecta a dos PIDs distintos.
   */
  occurrences: number
  /**
   * Vehículos DISTINTOS. Numerador de «Vehículos»; denominador `dtcVehicles` o
   * `anomalyVehicles` según `kind`.
   */
  vehicles: number
  /** Modelos distintos del catálogo (`TOYOTA COROLLA XEI…`) donde apareció. */
  models: number

  /** Escaneo más antiguo / más reciente donde apareció. */
  firstSeen: string
  lastSeen: string
}

/**
 * Un código DTC que apareció en un escaneo con datos pero NO está en
 * `src/server/dtc-codes.json`. La lista se calcula SIN los filtros de la tabla
 * (es "todo lo que falta cargar", no "lo que falta en esta vista") y la
 * pantalla la muestra en un bloque aparte arriba de la tabla.
 */
export interface MissingDtc {
  code: string
  /** Sesiones `completed` donde apareció. */
  sessions: number
  /** Vehículos distintos. */
  vehicles: number
  firstSeen: string
  lastSeen: string
}

export interface DetectionsView {
  rows: Array<DetectionRow>
  /** Detectados y sin título en el catálogo local. Vacío = no falta ninguno. */
  missingDtcs: Array<MissingDtc>

  /**
   * Los DOS universos, y son distintos a propósito:
   *
   * - **DTC**: se leen de `session_dtc_snapshots`, que existe para toda sesión
   *   `completed` — incluso las que "engancharon sin traer nada". Un código DTC
   *   NO es el stream de telemetría en vivo (lo dice `scanner-compatibility.md`),
   *   así que se cuenta sobre TODAS las sesiones que terminaron.
   * - **Anomalía**: sale del análisis de telemetría, que sólo existe cuando el
   *   escaneo trajo datos. Se cuenta sobre ese subconjunto.
   *
   * Al 2026-09-09: `dtcSessions = 34`, `anomalySessions = 28`, y P0171 / P0170
   * aparecen SÓLO en sesiones sin datos — con un denominador único
   * desaparecerían de la tabla.
   */
  dtcSessions: number
  dtcVehicles: number
  anomalySessions: number
  anomalyVehicles: number
}

// ── Orden y filtros ────────────────────────────────────────────────────────

export const DETECTION_SORT_KEYS = [
  'label',
  'kind',
  'severity',
  'sessions',
  'vehicles',
  'models',
  'first',
  'last',
] as const
export type DetectionSortKey = (typeof DETECTION_SORT_KEYS)[number]

export const DETECTION_KIND_FILTERS = ['all', 'dtc', 'anomaly'] as const
export type DetectionKindFilter = (typeof DETECTION_KIND_FILTERS)[number]

export const DETECTION_KIND_FILTER_LABELS: Record<DetectionKindFilter, string> = {
  all: 'Todo',
  dtc: 'Códigos DTC',
  anomaly: 'Anomalías',
}

export const DETECTION_SEVERITY_FILTERS = ['all', 'red', 'violet', 'yellow'] as const
export type DetectionSeverityFilter = (typeof DETECTION_SEVERITY_FILTERS)[number]

export const DETECTION_FAMILY_FILTERS = ['all', 'P', 'C', 'B', 'U'] as const
export type DetectionFamilyFilter = (typeof DETECTION_FAMILY_FILTERS)[number]

/**
 * Nombres CALIFICADOS por dominio, no `kind` / `severity` / `family` pelados:
 * `kind` ya lo usan `/documentos` y `/notificaciones` con otros enums, y el
 * merge de search params de TanStack rompería el typecheck en la ruta ajena.
 * → `.claude/rules/notifications.md`
 *
 * `sort`/`dir` pelados: es lo que `SortHeader` lee, y ninguna otra ruta
 * comparte search params con `/escaneres/detecciones` vía un `<Link>` con
 * spread (las pestañas linkean sin `{...prev}`). Mismo criterio que
 * `/escaneres/sesiones`.
 */
export const detectionSearchSchema = z.object({
  q: z.string().trim().max(80).optional(),
  detectionKind: z.enum(DETECTION_KIND_FILTERS).catch('all').default('all'),
  detectionSeverity: z.enum(DETECTION_SEVERITY_FILTERS).catch('all').default('all'),
  detectionFamily: z.enum(DETECTION_FAMILY_FILTERS).catch('all').default('all'),
  sort: z.enum(DETECTION_SORT_KEYS).catch('sessions').default('sessions'),
  dir: z.enum(['asc', 'desc']).catch('desc').default('desc'),
})
export type DetectionSearch = z.infer<typeof detectionSearchSchema>

/** `12 / 28` sesiones → `43%`. Sin decimales: los volúmenes son chicos. */
export function ratioPct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return Math.round((numerator / denominator) * 100)
}
