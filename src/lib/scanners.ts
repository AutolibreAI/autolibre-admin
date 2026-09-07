import { z } from 'zod'

/**
 * Compatibilidad escáner ↔ vehículo — el contrato compartido.
 *
 * ── Qué consulta de DBeaver reemplaza ───────────────────────────────────────
 *
 * Ninguna, y el motivo importa: **la consulta no se corría porque no se te
 * ocurre.** Para saber con qué autos anda bien un escáner hay que cruzar
 * `driving_sessions` con `vehicles`, saltar a `vehicle_catalog_specs` y recién
 * ahí llegar a `vehicle_catalogs`, agrupando por `scanner_type` y firmware, y
 * además separar los intentos que trajeron datos de los que no. Nadie escribe
 * eso a mano para contestar una pregunta de soporte.
 *
 * Lo que sí pasaba: alguien preguntaba "¿le recomiendo este escáner a un
 * Vento?" y se contestaba de memoria.
 */

// ── El corte que define si una conexión sirvió ───────────────────────────────

/**
 * Una sesión cae en exactamente uno de estos tres cubos.
 *
 * ── `noData` es DERIVADO por nosotros, y hay que decirlo ────────────────────
 *
 * `driving_session_status` es `pending_chunks | completed | failed`. El dominio
 * tiene un estado terminal de falla, `failed`, y al 2026-09-04 **tiene cero
 * filas**. Si nos quedáramos con eso, la pantalla diría que todo funciona
 * siempre.
 *
 * Pero la base dice otra cosa, y el corte es perfecto: de las 17 sesiones,
 * **6 tienen `total_readings = 0` Y duración exactamente 0 minutos Y ningún
 * firmware reportado.** Las otras 11 traen entre 9 y 4.571 lecturas. No hay un
 * solo caso en el medio. Eso no es un usuario que abrió y cerró la app: es el
 * escáner que nunca llegó a identificarse ni a leer un dato — un pareo que
 * falló, guardado como `completed`.
 *
 * **La primera versión de esta pantalla las contaba como éxitos**, que es
 * exactamente el error que la pantalla existe para no cometer.
 *
 * Que la señal sea DERIVADA y no del dominio no es una licencia para inventar:
 * es la misma forma que `stuck` en `/operacion`, que tampoco lo escribe nadie y
 * se deduce del reloj con umbrales documentados. Por eso `noData` y `failed`
 * son contadores SEPARADOS y nunca se suman en un solo número "fallas": uno lo
 * afirma el backend, el otro lo deducimos nosotros, y el día que el backend
 * escriba `failed` de verdad hay que poder ver los dos.
 *
 * El predicado es sobre `total_readings` y no sobre `scanner_firmware`, aunque
 * hoy los dos partan la base igual. La ausencia de firmware es un SÍNTOMA; cero
 * lecturas es el RESULTADO, y es lo que sigue significando lo mismo el día que
 * una versión de la app reporte firmware y falle igual.
 */
export interface CompatibilityCounts {
  /** `completed` con al menos una lectura. La conexión sirvió. */
  ok: number
  /** `completed` con cero lecturas. Derivado: enganchó y no trajo nada. */
  noData: number
  /** `failed`. El estado terminal del dominio. Hoy siempre cero. */
  failed: number
  /** `ok + noData + failed`. `pending_chunks` NO entra: todavía no hay veredicto. */
  attempts: number
  /** Autos DISTINTOS con al menos una conexión exitosa. */
  okVehicles: number
}

/** `null` cuando no hubo ni un intento — distinto de 0, que es "se intentó y falló siempre". */
export function successRate(counts: CompatibilityCounts): number | null {
  return counts.attempts === 0 ? null : counts.ok / counts.attempts
}

// ── El eje horizontal ────────────────────────────────────────────────────────

/**
 * Una variante de escáner: el tipo del dominio MÁS el firmware que reportó.
 *
 * ── Por qué la columna no es `scanner_type` a secas ─────────────────────────
 *
 * Porque el enum `scanner_type` del backend tiene **un solo valor** (`elm327`),
 * y una matriz de una columna no es una matriz. El firmware es lo que de hecho
 * varía en la base, y es además lo que distingue en la vida real a un clon
 * barato de uno que engancha.
 *
 * El día que el enum tenga más valores, el eje se llena solo — `scannerType`
 * sigue siendo la agrupación primaria y no hay que tocar nada acá.
 *
 * ── La columna "no identificado" no es un escáner ───────────────────────────
 *
 * `firmware: null` tiene su propia columna, y hoy es **100% fallas**: 6
 * intentos, 0 exitosos. Tiene sentido que sea así — si el escáner nunca se
 * identificó, no sabemos cuál era. Meterla adentro de `ELM327 v2.1` le
 * atribuiría a ese firmware fallas que capaz no son suyas; borrarla escondería
 * seis intentos que sí pasaron. Queda como columna propia y etiquetada.
 */
export interface ScannerVariant extends CompatibilityCounts {
  /** `scannerType` + `firmware`, estable entre renders. Es la clave de la celda. */
  key: string
  scannerType: string
  firmware: string | null
  /** `false` cuando el dispositivo nunca dijo qué era. */
  identified: boolean
  /** Protocolos OBD vistos con esta variante. Contexto, no eje. */
  protocols: Array<string>
  catalogs: number
}

// ── Las celdas ───────────────────────────────────────────────────────────────

/**
 * La intersección vehículo × variante de escáner.
 *
 * `okVehicles` es el que decide si el número sirve: **cuatro conexiones del
 * mismo auto no son evidencia de que el modelo sea compatible, son evidencia de
 * que a esa persona le anduvo.** Para recomendarle a un cliente hacen falta
 * autos distintos, no sesiones repetidas.
 */
export interface CompatibilityCell extends CompatibilityCounts {
  variantKey: string
  /** Último éxito. Un firmware que anduvo hace dos años no es un aval. */
  lastOk: string | null
}

/**
 * Una fila: un modelo del catálogo, con TODO su detalle.
 *
 * ── Por qué la etiqueta lleva `trim` y `year` ───────────────────────────────
 *
 * Porque "TOYOTA COROLLA" no alcanza para decidir compatibilidad y "TOYOTA
 * COROLLA XEI 1.8 M/T 2013" sí. Un 1.8 manual de 2013 y un 2.0 automático de
 * 2020 son ECUs distintas: que el escáner ande con uno no dice nada del otro.
 *
 * El dato ya estaba en `vehicle_catalogs` —`trim` y `year` son columnas de esa
 * tabla— y la primera versión de esta pantalla simplemente no lo mostraba. **No
 * hizo falta cambiar el grano de la consulta**: el catálogo YA es el nivel de
 * "versión concreta del modelo". Bajar al SPEC habría sido peor, y no mejor —
 * un mismo catálogo puede tener dos specs que difieren sólo en que a una le
 * falta el motor, y ahí el Vento se parte en dos filas que son el mismo auto.
 */
export interface CompatibilityRow extends CompatibilityCounts {
  /** `null` cuando el auto no resuelve a ningún catálogo. Ver `orphanSessions`. */
  catalogId: string | null
  /** `BRAND MODEL TRIM YEAR`, ya armada por el repo. */
  label: string
  brand: string | null
  model: string | null
  trim: string | null
  year: number | null
  /**
   * Del SPEC, no del catálogo, y por eso son listas: un catálogo puede tener
   * varias specs. Van como detalle secundario porque para compatibilidad OBD el
   * combustible importa —un CNG o un diésel no responden igual— y la caja suele
   * venir ya adentro del `trim` ("1.8 M/T", "AT9 4X4").
   */
  fuels: Array<string>
  transmissions: Array<string>
  cells: Array<CompatibilityCell>
}

/**
 * Cuántos AUTOS DISTINTOS con éxito hacen que una celda valga como recomendación.
 *
 * Tres es un piso deliberadamente bajo y aun así hoy no lo alcanza ninguna
 * celda — con 11 conexiones exitosas sobre 7 autos, la tabla entera es
 * preliminar. Que se note es el punto: un tilde verde sobre una muestra de uno
 * es exactamente la mentira que esta pantalla existe para no decir.
 *
 * Se sube cuando haya volumen. No se baja.
 */
export const MIN_VEHICLES_FOR_CONFIDENCE = 3

/** Verde: anduvo, y en suficientes autos distintos como para recomendarlo. */
export function isConfident(counts: CompatibilityCounts): boolean {
  return counts.okVehicles >= MIN_VEHICLES_FOR_CONFIDENCE
}

/**
 * Rojo: se intentó y NO funcionó nunca.
 *
 * Esto sí se puede afirmar, y es la diferencia con la celda vacía. Una celda
 * ausente es "nunca se probó"; ésta es "se probó `attempts` veces y no salió
 * ninguna". Son las dos únicas cosas que la tabla puede decir sobre un fracaso,
 * y confundirlas es lo que hace que una recomendación salga mal.
 */
export function isBroken(counts: CompatibilityCounts): boolean {
  return counts.attempts > 0 && counts.ok === 0
}

// ── El total ─────────────────────────────────────────────────────────────────

export interface CompatibilityTotals extends CompatibilityCounts {
  /** Todas las sesiones de la tabla, incluidas las `pending_chunks`. */
  sessions: number
  /** En vuelo: los chunks todavía subiendo. No cuentan como intento. */
  pending: number
  vehicles: number
  catalogs: number
  /** Sesiones cuyo vehículo no resuelve a un catálogo. Caen en su propia fila. */
  orphanSessions: number
}

export interface CompatibilityMatrix {
  variants: Array<ScannerVariant>
  rows: Array<CompatibilityRow>
  totals: CompatibilityTotals
}

// ── El detalle de una conexión ───────────────────────────────────────────────

/**
 * El cubo de una sesión, derivado de `status` + `total_readings`.
 *
 * ⚠ Es la TERCERA expresión del mismo corte: las otras dos son las cadenas SQL
 * `OK` / `NO_DATA` / `FAILED` / `PENDING` de `scanners.repo.ts` (que la matriz
 * agrega con `GROUPING SETS`) y el predicado de la columna «Escaneos» en
 * `users.repo.ts`. **Las tres se tocan juntas.** No se puede compartir con las
 * de SQL —son SQL—, así que la única defensa es que estén al lado en la rule y
 * que esta función sea la única forma en que el panel clasifica una sesión en
 * JavaScript. → `.claude/rules/scanner-compatibility.md`
 */
export type SessionBucket = 'ok' | 'noData' | 'failed' | 'pending'

export function sessionBucket(status: string, totalReadings: number): SessionBucket {
  if (status === 'failed') return 'failed'
  if (status === 'pending_chunks') return 'pending'
  // `completed`: sirvió sólo si trajo al menos una lectura.
  return totalReadings > 0 ? 'ok' : 'noData'
}

export const SESSION_BUCKET_LABELS: Record<SessionBucket, string> = {
  ok: 'Trajo datos',
  noData: 'Enganchó sin traer nada',
  failed: 'Falló (según el backend)',
  pending: 'Subiendo todavía',
}

/**
 * Todo lo que el panel sabe de una conexión: la sesión, quién la hizo, sobre
 * qué auto, y qué produjo. Sale de `driving_sessions` más los joins a `users` y
 * al catálogo, más contadores de las tablas que cuelgan de `session_id`.
 */
export interface ScannerSessionDetail {
  id: string
  externalSessionId: string
  bucket: SessionBucket
  status: string

  userId: string
  userEmail: string
  userName: string | null

  vehicleId: string
  vehiclePlate: string
  vehicleAlias: string | null
  /** `BRAND MODEL TRIM YEAR` si el auto resuelve a un catálogo; si no, `null`. */
  catalogLabel: string | null

  scannerType: string
  firmware: string | null
  obdProtocol: string | null
  detectedVin: string | null
  batteryVoltage: string | null

  totalReadings: number
  totalChunks: number
  chunkSize: number
  chunksUploaded: number
  distanceSinceDtcClearKm: number | null

  /** Códigos DTC vistos en esta sesión (`session_dtc_snapshots.codes`). */
  dtcCodes: Array<string>
  /** Filas en `diagnostic_dtcs` para esta sesión — el detalle con descripción. */
  dtcDetailCount: number
  producedAiDiagnostic: boolean
  producedTelemetryAnalysis: boolean

  startedAt: string
  endedAt: string | null
  createdAt: string
}

export type ScannerSessionsMode = 'cell' | 'row' | 'variant'

export interface ScannerSessionsView {
  mode: ScannerSessionsMode
  /** Encabezado ya armado por el repo: "TOYOTA COROLLA … con ELM327 v2.1". */
  label: string
  sessions: Array<ScannerSessionDetail>
}

// ── Search params ────────────────────────────────────────────────────────────

/**
 * `q` filtra FILAS (marca, modelo, versión y año), nunca columnas.
 *
 * Filtrar columnas rompería la comparación, que es lo único que esta pantalla
 * hace: dos escáneres se comparan mirándolos juntos sobre la misma fila.
 *
 * `.catch(undefined)` y no un throw: un `?q=` guardado en un favorito debe
 * mostrar la tabla entera, no una pantalla de error.
 *
 * ── Los tres de abajo abren el panel de conexiones ──────────────────────────
 *
 * `catalogId` y `scanner` juntos → una celda; sólo `catalogId` → la fila
 * entera; sólo `scanner` → la columna entera. `fw` viaja siempre que viaje
 * `scanner` (string vacío = escáner no identificado), así que "no filtro por
 * firmware" y "firmware nulo" no se confunden. El mismo schema lo validan la
 * ruta, `getScannerCompatibility` (que ignora estos tres) y `getScannerSessions`
 * (que ignora `q`) — una definición, tres puntos de aplicación, regla dura 5.
 */
export const scannerSearchSchema = z.object({
  q: z.string().trim().min(1).max(80).optional().catch(undefined),
  /** uuid de `vehicle_catalogs`, o el literal `orphan` para la fila sin catálogo. */
  catalogId: z.string().trim().min(1).max(40).optional().catch(undefined),
  /** `scanner_type` (hoy sólo `elm327`). */
  scanner: z.string().trim().min(1).max(40).optional().catch(undefined),
  /** Firmware exacto. `''` = no identificado. Sólo se lee si `scanner` está. */
  fw: z.string().max(120).optional().catch(undefined),
})

export type ScannerSearch = z.infer<typeof scannerSearchSchema>

/** El panel de conexiones está abierto cuando hay por dónde acotarlo. */
export function sessionsPanelOpen(search: ScannerSearch): boolean {
  return Boolean(search.catalogId) || Boolean(search.scanner)
}

// ── Etiquetas ────────────────────────────────────────────────────────────────

/** El enum del backend es `scanner_type`. Se espeja tal cual, sin traducir. */
export const SCANNER_TYPE_LABELS: Record<string, string> = {
  elm327: 'ELM327',
}

/**
 * Primer uso de estos dos enums en el panel, así que viven acá.
 *
 * Si `/catalogo` termina necesitándolos, **se mueven a un módulo compartido, no
 * se copian**: un mapa de etiquetas duplicado no se ve mal el día uno, se ve mal
 * el día que el backend agrega `plug_in_hybrid` y sólo una de las dos copias se
 * entera. Es la misma lección que `components/Filters.tsx`.
 */
export const TRANSMISSION_LABELS: Record<string, string> = {
  manual: 'Manual',
  automatic: 'Automática',
  cvt: 'CVT',
}

export const FUEL_TYPE_LABELS: Record<string, string> = {
  gasoline: 'Nafta',
  diesel: 'Diésel',
  cng: 'GNC',
  electric: 'Eléctrico',
  hybrid: 'Híbrido',
}

export function scannerTypeLabel(scannerType: string): string {
  return SCANNER_TYPE_LABELS[scannerType] ?? scannerType
}

export function variantLabel(variant: ScannerVariant): string {
  return variant.firmware ?? 'Escáner no identificado'
}

/** Un valor desconocido se muestra CRUDO, nunca se esconde: un enum nuevo del
 *  backend tiene que verse feo en pantalla, no desaparecer. */
const labelOr = (map: Record<string, string>, value: string): string => map[value] ?? value

export const transmissionLabel = (value: string) => labelOr(TRANSMISSION_LABELS, value)
export const fuelTypeLabel = (value: string) => labelOr(FUEL_TYPE_LABELS, value)
