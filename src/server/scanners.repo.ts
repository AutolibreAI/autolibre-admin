import '@tanstack/react-start/server-only'

import { sql } from './db'
import { scannerTypeLabel, sessionBucket } from '~/lib/scanners'
import type {
  CompatibilityMatrix,
  CompatibilityRow,
  CompatibilityTotals,
  ScannerSearch,
  ScannerSessionDetail,
  ScannerSessionsMode,
  ScannerSessionsView,
  ScannerVariant,
} from '~/lib/scanners'

/**
 * Compatibilidad escáner ↔ vehículo — SOLO LECTURA.
 *
 * Mismo dueño de SQL que `ops.repo.ts`, `users.repo.ts` y `catalog.repo.ts`:
 * **nosotros, sobre tablas de `public`**, con las consultas versionadas en este
 * archivo y no como funciones de `ops`. Motivo idéntico y ya documentado en
 * `.claude/rules/ops-metrics.md`: una función de `ops` que lee `public` es una
 * dependencia cruzada escrita adentro de la base, invisible para las
 * migraciones de Drizzle del backend. Con el SQL acá, un rename lo encuentra
 * `rg` y el diff queda versionado.
 *
 * **Ni una escritura.** `driving_sessions` la escribe el backend cuando el
 * teléfono sube los chunks. El panel no tiene nada que corregir ahí: una sesión
 * es un hecho que pasó, no un estado que el admin mueva.
 */

const toInt = (value: unknown): number => Number(value ?? 0)

const toIso = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString()
    : value === null || value === undefined
      ? null
      : String(value)

/**
 * Los tres predicados que parten una sesión, definidos UNA vez.
 *
 * Los tres niveles del `GROUPING SETS` y la consulta de totales usan estas
 * mismas cadenas. Si divergieran, las celdas contarían una cosa y los totales
 * otra, y nada lo delataría — misma lección que `INTERNAL_PREDICATE` en
 * `ops.repo.ts`.
 *
 * ── `NO_DATA` es nuestro, no del dominio ────────────────────────────────────
 *
 * `driving_session_status` no tiene forma de decir "enganchó y no trajo nada":
 * esas sesiones quedan `completed`. Se deduce de `total_readings`, y el corte
 * en la base real es limpio — 11 sesiones entre 9 y 4.571 lecturas, 6 con
 * exactamente 0 y duración 0. No hay ningún caso ambiguo en el medio.
 *
 * El predicado va sobre `total_readings` y NO sobre `scanner_firmware is null`,
 * aunque hoy los dos partan la base igual: la ausencia de firmware es un
 * síntoma, cero lecturas es el resultado. El resultado sigue significando lo
 * mismo el día que una versión de la app reporte firmware y falle igual.
 */
const OK = `ds.status::text = 'completed' and coalesce(ds.total_readings, 0) > 0`
const NO_DATA = `ds.status::text = 'completed' and coalesce(ds.total_readings, 0) = 0`
const FAILED = `ds.status::text = 'failed'`
const PENDING = `ds.status::text = 'pending_chunks'`

/**
 * El salto de `driving_sessions` al catálogo.
 *
 * ── LA TRAMPA, y es la misma que documenta `catalog.repo.ts` ────────────────
 *
 * `vehicles` **no apunta al catálogo**: apunta al SPEC.
 * `vehicles.vehicle_catalog_spec_id` → `vehicle_catalog_specs.id`, y recién ese
 * tiene `vehicle_catalog_id`. La versión de un solo join no compila.
 *
 * ── Y el grano correcto es el CATÁLOGO, no el spec ──────────────────────────
 *
 * Se agrupa por `vc.id`, que ya es "versión concreta del modelo": la etiqueta
 * `TOYOTA COROLLA XEI 1.8 M/T 2013` sale entera de `vehicle_catalogs`, porque
 * `trim` y `year` son columnas suyas.
 *
 * Bajar al spec parece más preciso y es peor. Verificado contra la base: el
 * `VOLKSWAGEN VENTO 2.5 2007` tiene DOS specs que difieren únicamente en que a
 * una le falta `engine`. Agrupando por spec, ese auto se parte en dos filas que
 * son el mismo auto, y la tabla afirma que el escáner se probó en dos versiones
 * distintas. Es un número plausible, más desagregado que el real, y por lo tanto
 * de los que no se cachan.
 *
 * Los joins son `LEFT` aunque `vehicle_catalog_spec_id` sea NOT NULL: la FK
 * garantiza que el spec exista, no que el catálogo exista. Un `INNER` acá
 * descartaría sesiones en silencio, que es justo lo que la fila huérfana existe
 * para no hacer.
 */
const CATALOG_JOIN = `
  join vehicles v on v.id = ds.vehicle_id
  left join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
  left join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
`

/** Los contadores, idénticos en los tres niveles del GROUPING SETS. */
const COUNTER_COLUMNS = `
  count(*) filter (where ${OK})::int                                as ok,
  count(*) filter (where ${NO_DATA})::int                           as no_data,
  count(*) filter (where ${FAILED})::int                            as failed,
  count(*) filter (where not (${PENDING}))::int                     as attempts,
  count(distinct ds.vehicle_id) filter (where ${OK})::int           as ok_vehicles
`

/**
 * La recencia va aparte porque SOLO la matriz la necesita: los totales no
 * muestran "última conexión". Se separó después de escribir la version obvia,
 * que recortaba esta columna de `COUNTER_COLUMNS` con un `.replace()` de regex
 * sobre el propio SQL — un string de consulta editado por expresión regular
 * es exactamente el tipo de cosa que sigue compilando y empieza a devolver
 * cualquier cosa cuando alguien reordena las columnas.
 */
const LAST_OK_COLUMN = `max(ds.started_at) filter (where ${OK}) as last_ok`

interface MatrixRow {
  level: string
  catalog_id: string | null
  brand: string | null
  model: string | null
  trim: string | null
  year: number | string | null
  fuels: Array<string> | null
  transmissions: Array<string> | null
  scanner_type: string | null
  firmware: string | null
  protocols: Array<string> | null
  catalogs: number | string
  ok: number | string
  no_data: number | string
  failed: number | string
  attempts: number | string
  ok_vehicles: number | string
  last_ok: Date | string | null
}

interface TotalsRow {
  sessions: number | string
  ok: number | string
  no_data: number | string
  failed: number | string
  attempts: number | string
  pending: number | string
  ok_vehicles: number | string
  vehicles: number | string
  catalogs: number | string
  orphan_sessions: number | string
}

/**
 * La matriz entera: filas de catálogo × columnas de variante de escáner.
 *
 * ── Por qué GROUPING SETS y no tres consultas ───────────────────────────────
 *
 * Porque los tres niveles —celda, total de fila, total de columna— necesitan
 * `count(distinct vehicle_id)`, y **ese número NO se puede derivar del nivel de
 * abajo.** Un mismo auto puede haberse conectado con dos firmwares distintos:
 * sumar sus celdas lo cuenta dos veces, y tomar el máximo lo cuenta de menos.
 * Las dos versiones dan un número plausible y equivocado, que es el modo de
 * falla que no se nota nunca.
 *
 * La primera versión de este archivo hacía exactamente eso (`Math.max` sobre
 * las celdas) y estaba mal. Postgres es el único que puede contestar "cuántos
 * autos distintos" en cada nivel, así que se le pregunta a él, en una sola
 * sentencia y por lo tanto sobre un solo snapshot.
 *
 * ── Un pivot en JavaScript, no en SQL ───────────────────────────────────────
 *
 * El SQL devuelve celdas; las columnas las arma JS. La alternativa —`crosstab`,
 * o un `count(*) filter (where scanner_type = '…')` por columna— exige conocer
 * las columnas al ESCRIBIR el SQL, y acá las columnas son datos: el día que
 * aparezca un `scanner_type` nuevo, la versión pivoteada lo ignora sin avisar y
 * la matriz miente por omisión. Ésta lo muestra sola.
 *
 * ── Por qué no hay filtro de ventana temporal ───────────────────────────────
 *
 * Deliberado. La pregunta que contesta la pantalla —"¿con qué autos anda este
 * escáner?"— es acumulativa: una compatibilidad no caduca a los 30 días. Con 17
 * sesiones en la base, cualquier ventana vaciaría la tabla y dejaría al operador
 * creyendo que no hay dato. La recencia se sirve con `lastOk` por celda, que
 * informa sin esconder.
 */
export async function compatibilityMatrix(
  search: ScannerSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<CompatibilityMatrix> {
  void opts.signal // `pg` no acepta AbortSignal; queda documentado el hueco.

  const params: Array<unknown> = []
  let rowFilter = ''

  if (search.q) {
    params.push(`%${search.q}%`)
    /**
     * Se busca sobre la etiqueta ARMADA —marca, modelo, versión y año— para que
     * "corolla xei" y "vento 2007" encuentren algo. `concat_ws` ignora los
     * NULL, así que un catálogo sin `trim` no rompe la búsqueda ni matchea de
     * más. Mismo criterio de separador que `listCatalogs`: sin él "fordka"
     * matchearía "Ford" + "Ka".
     */
    rowFilter = `where concat_ws(' ', vc.brand, vc.model, vc.trim, vc.year::text) ilike $${params.length}`
  }

  const [rows, totals] = await Promise.all([
    sql<MatrixRow>(
      `
      select case
               when grouping(ds.scanner_type, ds.scanner_firmware) = 0
                    and grouping(vc.id) = 0 then 'cell'
               when grouping(vc.id) = 0     then 'row'
               else                              'variant'
             end                                    as level,
             vc.id                                  as catalog_id,
             max(vc.brand)                          as brand,
             max(vc.model)                          as model,
             max(vc.trim)                           as trim,
             max(vc.year)                           as year,
             array_agg(distinct vcs.fuel_type::text)
               filter (where vcs.fuel_type is not null)     as fuels,
             array_agg(distinct vcs.transmission::text)
               filter (where vcs.transmission is not null)  as transmissions,
             ds.scanner_type::text                  as scanner_type,
             ds.scanner_firmware                    as firmware,
             -- El protocolo NO entra en el group by: si entrara, una celda
             -- llegaría partida en una fila por protocolo y habría que
             -- fusionarlas en JS. Se agrega como conjunto y el problema no
             -- existe. \`filter\` porque array_agg(distinct null) devuelve {NULL}.
             array_agg(distinct ds.obd_protocol)
               filter (where ds.obd_protocol is not null)   as protocols,
             count(distinct vc.id)::int             as catalogs,
             ${COUNTER_COLUMNS},
             ${LAST_OK_COLUMN}
      from driving_sessions ds
      ${CATALOG_JOIN}
      ${rowFilter}
      group by grouping sets (
        (vc.id, ds.scanner_type, ds.scanner_firmware),
        (vc.id),
        (ds.scanner_type, ds.scanner_firmware)
      )
      `,
      params,
    ),

    /**
     * Los totales salen de su PROPIA consulta y a propósito **no** llevan el
     * filtro de texto: son el marco de la tabla, no su contenido. Si `q` los
     * recortara, buscar "toyota" diría "0 fallas" sobre las fallas de Toyota y
     * se leería como "0 fallas en el sistema" — la conclusión tranquilizadora
     * equivocada que este módulo entero existe para no permitir.
     */
    sql<TotalsRow>(
      `
      select count(*)::int                                            as sessions,
             count(*) filter (where ${PENDING})::int                  as pending,
             count(distinct ds.vehicle_id)::int                       as vehicles,
             count(distinct vc.id)::int                               as catalogs,
             count(*) filter (where ${OK} and vc.id is null)::int      as orphan_sessions,
             ${COUNTER_COLUMNS}
      from driving_sessions ds
      ${CATALOG_JOIN}
      `,
    ),
  ])

  return {
    variants: buildVariants(rows),
    rows: buildRows(rows),
    totals: buildTotals(totals[0]),
  }
}

// ── El pivot ─────────────────────────────────────────────────────────────────

/**
 * La clave de columna.
 *
 * El separador es un carácter de control (`\u001f`, unit separator) y no un
 * espacio o un guión: un firmware es texto libre que viene del dispositivo, y
 * cualquier separador imprimible puede aparecer adentro. Con uno legible, un
 * firmware llamado `elm327 x` colisionaría con el tipo `elm327` y firmware `x`.
 *
 * Se escribe como ESCAPE. Pegar el byte crudo acá vuelve el `.ts` binario para
 * `grep` y para cualquier edición por texto exacto — pasó, y está anotado en
 * `.claude/rules/scanner-compatibility.md`.
 */
const variantKey = (scannerType: string, firmware: string | null): string =>
  `${scannerType}\u001f${firmware ?? ''}`

/**
 * Las columnas, deducidas del dato.
 *
 * Orden: primero por tipo de escáner, después por firmware, los dos
 * alfabéticos, con la columna sin identificar SIEMPRE al final. **No por
 * volumen**, a propósito: un eje ordenado por conteo se reordena solo entre
 * visitas, y ahí dos capturas de la misma tabla dejan de ser comparables.
 */
function buildVariants(rows: Array<MatrixRow>): Array<ScannerVariant> {
  return rows
    .filter((r) => r.level === 'variant' && r.scanner_type !== null)
    .map((r) => ({
      key: variantKey(r.scanner_type as string, r.firmware),
      scannerType: r.scanner_type as string,
      firmware: r.firmware,
      identified: r.firmware !== null,
      protocols: r.protocols ?? [],
      catalogs: toInt(r.catalogs),
      ok: toInt(r.ok),
      noData: toInt(r.no_data),
      failed: toInt(r.failed),
      attempts: toInt(r.attempts),
      okVehicles: toInt(r.ok_vehicles),
    }))
    .sort((a, b) => {
      // La no identificada va última: no es un escáner, es la ausencia de uno.
      if (a.identified !== b.identified) return a.identified ? -1 : 1
      return (
        a.scannerType.localeCompare(b.scannerType) ||
        (a.firmware ?? '').localeCompare(b.firmware ?? '')
      )
    })
}

/**
 * Las filas, con sus celdas colgadas.
 *
 * Ordenadas por autos DISTINTOS con éxito, y recién después por conexiones
 * exitosas: el modelo sobre el que anduvo en más autos diferentes es el que más
 * dice, aunque otro tenga más sesiones repetidas del mismo auto. Es la misma
 * distinción que hace `MIN_VEHICLES_FOR_CONFIDENCE`, aplicada al orden.
 *
 * La fila huérfana (`catalogId: null`) va SIEMPRE al final, sin importar su
 * conteo: es un problema de datos, no un modelo. Mezclarla en el orden la
 * pondría arriba el día que tenga volumen, y se leería como un vehículo real.
 */
function buildRows(rows: Array<MatrixRow>): Array<CompatibilityRow> {
  const byCatalog = new Map<string, CompatibilityRow>()
  const keyOf = (catalogId: string | null) => catalogId ?? ' orphan'

  for (const r of rows.filter((x) => x.level === 'row')) {
    byCatalog.set(keyOf(r.catalog_id), {
      catalogId: r.catalog_id,
      label: r.catalog_id
        ? [r.brand, r.model, r.trim, r.year].filter(Boolean).join(' ')
        : 'Sin modelo de catálogo',
      brand: r.brand,
      model: r.model,
      trim: r.trim,
      year: r.year === null ? null : toInt(r.year),
      fuels: r.fuels ?? [],
      transmissions: r.transmissions ?? [],
      cells: [],
      ok: toInt(r.ok),
      noData: toInt(r.no_data),
      failed: toInt(r.failed),
      attempts: toInt(r.attempts),
      okVehicles: toInt(r.ok_vehicles),
    })
  }

  for (const r of rows.filter((x) => x.level === 'cell')) {
    const row = byCatalog.get(keyOf(r.catalog_id))
    // Un `cell` sin su `row` sería un bug de la consulta, no un caso de datos.
    // Se ignora en vez de romper la pantalla entera por una celda.
    if (!row || r.scanner_type === null) continue

    row.cells.push({
      variantKey: variantKey(r.scanner_type, r.firmware),
      lastOk: toIso(r.last_ok),
      ok: toInt(r.ok),
      noData: toInt(r.no_data),
      failed: toInt(r.failed),
      attempts: toInt(r.attempts),
      okVehicles: toInt(r.ok_vehicles),
    })
  }

  return [...byCatalog.values()].sort((a, b) => {
    if (a.catalogId === null) return 1
    if (b.catalogId === null) return -1
    return b.okVehicles - a.okVehicles || b.ok - a.ok || a.label.localeCompare(b.label)
  })
}

function buildTotals(row: TotalsRow | undefined): CompatibilityTotals {
  return {
    sessions: toInt(row?.sessions),
    pending: toInt(row?.pending),
    vehicles: toInt(row?.vehicles),
    catalogs: toInt(row?.catalogs),
    orphanSessions: toInt(row?.orphan_sessions),
    ok: toInt(row?.ok),
    noData: toInt(row?.no_data),
    failed: toInt(row?.failed),
    attempts: toInt(row?.attempts),
    okVehicles: toInt(row?.ok_vehicles),
  }
}

// ── El historial de una celda ────────────────────────────────────────────────

interface SessionRow {
  id: string
  external_session_id: string
  status: string
  user_id: string
  user_email: string
  user_name: string | null
  vehicle_id: string
  plate: string
  alias: string | null
  brand: string | null
  model: string | null
  trim: string | null
  year: number | string | null
  scanner_type: string
  scanner_firmware: string | null
  obd_protocol: string | null
  detected_vin: string | null
  battery_voltage: string | null
  total_readings: number | string
  total_chunks: number | string
  chunk_size: number | string
  chunks_uploaded: number | string
  distance_since_dtc_clear_km: number | string | null
  dtc_codes: Array<string> | null
  dtc_detail_count: number | string
  produced_ai_diagnostic: boolean
  produced_telemetry_analysis: boolean
  started_at: Date | string
  ended_at: Date | string | null
  created_at: Date | string
}

/**
 * Las conexiones detrás de una celda (o una fila, o una columna) de la matriz.
 *
 * Es el drill-down de "1 / 1" y "0 / 4": qué sesiones son, quién las hizo, sobre
 * qué auto, con qué firmware y protocolo, qué VIN detectó el escáner, cuántas
 * lecturas trajo, y qué produjo después (un diagnóstico de IA, un análisis de
 * telemetría, códigos DTC).
 *
 * El cubo de cada sesión (`bucket`) se calcula en JS con `sessionBucket()` — la
 * MISMA regla que las cadenas `OK`/`NO_DATA` de este archivo aplican en SQL para
 * la matriz. Si la matriz dice "0 de 4" y acá aparecen sesiones marcadas `ok`,
 * es que las dos expresiones divergieron.
 *
 * El filtro por variante usa `IS NOT DISTINCT FROM` para el firmware: cuando
 * `fw` es `''` (escáner no identificado) tiene que matchear `NULL`, y `= NULL`
 * no lo hace. Los joins a `users` y `vehicles` son `JOIN` y no `LEFT` porque las
 * dos FK son NOT NULL en `driving_sessions` — la fila huérfana de la matriz es
 * por el CATÁLOGO ausente, no por el vehículo.
 */
export async function scannerSessions(
  search: ScannerSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<ScannerSessionsView | null> {
  void opts.signal

  const hasCatalog = Boolean(search.catalogId)
  const hasVariant = Boolean(search.scanner)
  if (!hasCatalog && !hasVariant) return null

  const params: Array<unknown> = []
  const where: Array<string> = []

  if (search.catalogId === 'orphan') {
    where.push('vc.id is null')
  } else if (search.catalogId) {
    params.push(search.catalogId)
    where.push(`vc.id = $${params.length}`)
  }

  if (search.scanner) {
    params.push(search.scanner)
    where.push(`ds.scanner_type::text = $${params.length}`)
    // `fw` viaja siempre con `scanner`. `''` = no identificado = NULL en la base.
    const fw = search.fw ?? ''
    params.push(fw === '' ? null : fw)
    where.push(`ds.scanner_firmware is not distinct from $${params.length}`)
  }

  const rows = await sql<SessionRow>(
    `
    select
      ds.id,
      ds.external_session_id,
      ds.status::text                        as status,
      ds.user_id,
      u.email                                as user_email,
      u.name                                 as user_name,
      ds.vehicle_id,
      v.plate,
      v.alias,
      vc.brand, vc.model, vc.trim, vc.year,
      ds.scanner_type::text                  as scanner_type,
      ds.scanner_firmware,
      ds.obd_protocol,
      ds.detected_vin,
      ds.battery_voltage,
      ds.total_readings,
      ds.total_chunks,
      ds.chunk_size,
      ds.distance_since_dtc_clear_km,
      (select count(*)::int from driving_session_chunks dsc where dsc.session_id = ds.id)
                                             as chunks_uploaded,
      coalesce(
        (select s.codes from session_dtc_snapshots s where s.session_id = ds.id limit 1),
        array[]::text[]
      )                                      as dtc_codes,
      (select count(*)::int from diagnostic_dtcs d where d.session_id = ds.id)
                                             as dtc_detail_count,
      exists (select 1 from ai_diagnostics a where a.session_id = ds.id)
                                             as produced_ai_diagnostic,
      exists (select 1 from driving_telemetry_analysis t where t.session_id = ds.id)
                                             as produced_telemetry_analysis,
      ds.started_at,
      ds.ended_at,
      ds.created_at
    from driving_sessions ds
    join users u on u.id = ds.user_id
    join vehicles v on v.id = ds.vehicle_id
    left join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
    left join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
    ${where.length ? `where ${where.join(' and ')}` : ''}
    order by ds.started_at desc, ds.id
    `,
    params,
  )

  const sessions: Array<ScannerSessionDetail> = rows.map((r) => ({
    id: r.id,
    externalSessionId: r.external_session_id,
    bucket: sessionBucket(r.status, toInt(r.total_readings)),
    status: r.status,
    userId: r.user_id,
    userEmail: r.user_email,
    userName: r.user_name,
    vehicleId: r.vehicle_id,
    vehiclePlate: r.plate,
    vehicleAlias: r.alias,
    catalogLabel: r.brand
      ? [r.brand, r.model, r.trim, r.year].filter(Boolean).join(' ')
      : null,
    scannerType: r.scanner_type,
    firmware: r.scanner_firmware,
    obdProtocol: r.obd_protocol,
    detectedVin: r.detected_vin,
    batteryVoltage: r.battery_voltage,
    totalReadings: toInt(r.total_readings),
    totalChunks: toInt(r.total_chunks),
    chunkSize: toInt(r.chunk_size),
    chunksUploaded: toInt(r.chunks_uploaded),
    distanceSinceDtcClearKm:
      r.distance_since_dtc_clear_km === null ? null : toInt(r.distance_since_dtc_clear_km),
    dtcCodes: r.dtc_codes ?? [],
    dtcDetailCount: toInt(r.dtc_detail_count),
    producedAiDiagnostic: r.produced_ai_diagnostic,
    producedTelemetryAnalysis: r.produced_telemetry_analysis,
    startedAt: toIso(r.started_at) as string,
    endedAt: toIso(r.ended_at),
    createdAt: toIso(r.created_at) as string,
  }))

  const mode: ScannerSessionsMode = hasCatalog && hasVariant ? 'cell' : hasCatalog ? 'row' : 'variant'

  // El encabezado del panel. El nombre del auto sale de la primera sesión (todas
  // comparten catálogo); el del escáner, de `search`.
  const carLabel =
    search.catalogId === 'orphan'
      ? 'Autos sin modelo de catálogo'
      : (sessions[0]?.catalogLabel ?? 'Ese modelo')
  const scannerName = search.scanner
    ? `${scannerTypeLabel(search.scanner)} ${search.fw ? search.fw : '(no identificado)'}`.trim()
    : null

  const label =
    mode === 'cell'
      ? `${carLabel} · ${scannerName}`
      : mode === 'row'
        ? `${carLabel} · todos los escáneres`
        : `${scannerName} · todos los vehículos`

  return { mode, label, sessions }
}
