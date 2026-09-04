import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import type {
  CatalogDetail,
  CatalogListItem,
  CatalogManual,
  CatalogSearch,
  CatalogSpec,
  VehicleType,
} from '~/lib/manuals'

/**
 * Catálogo de vehículos — SOLO LECTURA.
 *
 * Mismo dueño de SQL que `ops.repo.ts` y `users.repo.ts`: **nosotros, sobre
 * tablas de `public`**, con las consultas versionadas en este archivo y no como
 * funciones de `ops`. El motivo es el mismo: una función de `ops` que lee
 * `public` es una dependencia cruzada escrita adentro de la base, invisible
 * para las migraciones de Drizzle del backend — el día que el backend renombre
 * una columna, su migración pasa verde y la función revienta en runtime sin que
 * ningún build avise. Con el SQL acá, `rg` lo encuentra y el diff queda.
 *
 * ── Y ACÁ NO HAY NINGUNA ESCRITURA, a diferencia de partners ────────────────
 *
 * Ni una. Las escrituras de manuales van por HTTP contra el backend hex — ver
 * `src/server/backend.ts`, que explica por qué. Si alguna vez tenés que agregar
 * un `INSERT INTO vehicle_catalog_manuals` acá, pará: significa que estás
 * escribiendo una fila que apunta a un `file_id` que el panel no puede crear,
 * o creando un manual sin PDF. Las dos cosas son el bug, no el atajo.
 */

const toInt = (value: unknown): number => Number(value ?? 0)

const toIso = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString()
    : value === null || value === undefined
      ? null
      : String(value)

const toIsoRequired = (value: unknown): string => toIso(value) ?? ''

// ── Listado ──────────────────────────────────────────────────────────────────

interface CatalogListRow {
  id: string
  brand: string
  model: string
  year: number | string
  trim: string
  vehicle_type: VehicleType
  manual_count: number | string
  spec_count: number | string
  vehicle_count: number | string
}

/**
 * El listado del catálogo.
 *
 * ── LA TRAMPA DE ESTA CONSULTA: `vehicles` NO apunta al catálogo ────────────
 *
 * Apunta al SPEC. `vehicles.vehicle_catalog_spec_id` es NOT NULL con FK a
 * `vehicle_catalog_specs`, y recién ese tiene `vehicle_catalog_id`. La versión
 * obvia —`where v.vehicle_catalog_id = c.id`— ni siquiera compila, pero la
 * versión sutilmente equivocada (contar specs y llamarlo vehículos) da un
 * número plausible y MÁS CHICO que el real. Un número plausible y equivocado no
 * lo cachás nunca.
 *
 * ── Subconsultas escalares, no JOINs ────────────────────────────────────────
 *
 * Tres contadores sobre tres tablas distintas: con `left join` + `group by` el
 * primero se multiplica por las filas del segundo. Es el fan-out, y su modo de
 * falla es el peor: da un número más grande, no un error. Mismo criterio que
 * `listUsers` en `users.repo.ts`.
 */
export async function listCatalogs(
  search: CatalogSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<CatalogListItem>> {
  void opts.signal // `pg` no acepta AbortSignal; queda documentado el hueco.

  const params: Array<unknown> = []
  const where: Array<string> = []

  if (search.q) {
    params.push(`%${search.q}%`)
    // Se busca sobre las tres columnas de texto juntas para que "corolla xei"
    // encuentre algo. Concatenar con espacios y no con `||` pelado: sin el
    // separador, "fordka" matchearía "Ford" + "Ka".
    where.push(`(c.brand || ' ' || c.model || ' ' || c.trim) ILIKE $${params.length}`)
  }

  if (search.onlyWithoutManual) {
    where.push(
      `NOT EXISTS (SELECT 1 FROM vehicle_catalog_manuals m WHERE m.catalog_id = c.id)`,
    )
  }

  const rows = await sql<CatalogListRow>(
    `SELECT c.id,
            c.brand,
            c.model,
            c.year,
            c.trim,
            c.vehicle_type,
            (SELECT count(*)::int
               FROM vehicle_catalog_manuals m
              WHERE m.catalog_id = c.id)             AS manual_count,
            (SELECT count(*)::int
               FROM vehicle_catalog_specs s
              WHERE s.vehicle_catalog_id = c.id)     AS spec_count,
            -- Dos saltos, no uno. Ver el comentario de arriba.
            (SELECT count(*)::int
               FROM vehicles v
               JOIN vehicle_catalog_specs s ON s.id = v.vehicle_catalog_spec_id
              WHERE s.vehicle_catalog_id = c.id)     AS vehicle_count
       FROM vehicle_catalogs c
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      -- Marca y modelo alfabético, pero el año DESCENDENTE dentro del modelo:
      -- los autos nuevos son los que todavía no tienen manual cargado.
      ORDER BY c.brand ASC, c.model ASC, c.year DESC, c.trim ASC
      LIMIT 500`,
    params,
  )

  return rows.map((row) => ({
    id: row.id,
    brand: row.brand,
    model: row.model,
    year: toInt(row.year),
    trim: row.trim,
    vehicleType: row.vehicle_type,
    manualCount: toInt(row.manual_count),
    specCount: toInt(row.spec_count),
    vehicleCount: toInt(row.vehicle_count),
  }))
}

// ── Ficha ────────────────────────────────────────────────────────────────────

interface CatalogHeadRow {
  id: string
  brand: string
  model: string
  year: number | string
  trim: string
  vehicle_type: VehicleType
  created_at: Date | string
  vehicle_count: number | string
}

interface SpecRow {
  id: string
  engine: string | null
  fuel_type: string | null
  transmission: string | null
  gear_count: number | string | null
}

interface ManualRow {
  id: string
  file_id: string | null
  version: string | null
  language: string | null
  created_at: Date | string
  file_mime_type: string | null
  file_size_bytes: number | string | null
  file_uploaded_at: Date | string | null
  uploader_email: string | null
}

/**
 * La ficha de un catálogo: sus variantes de powertrain y sus manuales.
 *
 * Son TRES consultas y no una sola con `UNION ALL`, a diferencia del censo de
 * usuarios. La diferencia es qué se está midiendo: allá se cuentan 29
 * relaciones y una fila insertada en el medio del barrido aparecería en un
 * contador y no en otro, dando un expediente que nunca existió. Acá se traen
 * FILAS, no conteos — si un manual se crea mientras corre esto, el peor caso es
 * que no aparezca hasta el próximo render, que es lo que cualquiera espera.
 */
export async function findCatalog(
  catalogId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<CatalogDetail | null> {
  void opts.signal

  const head = await sqlOne<CatalogHeadRow>(
    `SELECT c.id,
            c.brand,
            c.model,
            c.year,
            c.trim,
            c.vehicle_type,
            c.created_at,
            (SELECT count(*)::int
               FROM vehicles v
               JOIN vehicle_catalog_specs s ON s.id = v.vehicle_catalog_spec_id
              WHERE s.vehicle_catalog_id = c.id) AS vehicle_count
       FROM vehicle_catalogs c
      WHERE c.id = $1`,
    [catalogId],
  )

  if (!head) return null

  const specRows = await sql<SpecRow>(
    `SELECT id, engine, fuel_type::text, transmission::text, gear_count
       FROM vehicle_catalog_specs
      WHERE vehicle_catalog_id = $1
      ORDER BY engine NULLS LAST, transmission NULLS LAST`,
    [catalogId],
  )

  /**
   * `LEFT JOIN` en los dos saltos, y cada uno por su motivo:
   *
   *  - `files`: `vehicle_catalog_manuals.file_id` es NULLABLE. El DTO del
   *    backend lo declara opcional, así que un manual sin PDF es representable
   *    y hay que poder verlo — es justamente el estado roto que se vino a
   *    buscar.
   *  - `users`: existe la FK, pero el email del que subió es un dato de
   *    conveniencia. Un `JOIN` acá escondería el manual entero si esa fila
   *    faltara, que es cambiar un dato ausente por una fila ausente.
   *
   * Compará con el `join` (no `left`) contra el catálogo en `users.repo.ts`:
   * allá la FK es NOT NULL, así que un `left join` habría escondido corrupción
   * detrás de celdas vacías. La regla no es "usar siempre left" — es mirar si
   * el null es representable.
   */
  const manualRows = await sql<ManualRow>(
    `SELECT m.id,
            m.file_id,
            m.version,
            m.language,
            m.created_at,
            f.mime_type   AS file_mime_type,
            f.size_bytes  AS file_size_bytes,
            f.uploaded_at AS file_uploaded_at,
            u.email       AS uploader_email
       FROM vehicle_catalog_manuals m
       LEFT JOIN files f ON f.id = m.file_id
       LEFT JOIN users u ON u.id = f.user_id
      WHERE m.catalog_id = $1
      ORDER BY m.created_at DESC`,
    [catalogId],
  )

  return {
    id: head.id,
    brand: head.brand,
    model: head.model,
    year: toInt(head.year),
    trim: head.trim,
    vehicleType: head.vehicle_type,
    createdAt: toIsoRequired(head.created_at),
    vehicleCount: toInt(head.vehicle_count),
    specs: specRows.map(mapSpec),
    manuals: manualRows.map(mapManual),
  }
}

/**
 * Los dos `map` se escriben campo por campo, explícitos.
 *
 * Es la misma regla que `mapCensus` en `users.repo.ts`: un `Object.entries` que
 * traduzca `snake_case` → `camelCase` sigue compilando el día que alguien
 * renombre una columna del SELECT, y devuelve `undefined` en silencio. En una
 * ficha de manuales eso se ve como "este manual no tiene archivo" — o sea, como
 * el problema exacto que la pantalla existe para detectar.
 */
function mapSpec(row: SpecRow): CatalogSpec {
  return {
    id: row.id,
    engine: row.engine,
    fuelType: row.fuel_type,
    transmission: row.transmission,
    gearCount: row.gear_count === null ? null : toInt(row.gear_count),
  }
}

function mapManual(row: ManualRow): CatalogManual {
  return {
    id: row.id,
    fileId: row.file_id,
    version: row.version,
    language: row.language,
    createdAt: toIsoRequired(row.created_at),
    /**
     * `file` es null cuando NO HAY archivo, y se decide por `file_id`, no por
     * `file_uploaded_at`. Mirar la columna del join daría el mismo null para
     * "nunca hubo archivo" y para "el archivo desapareció", que son dos
     * problemas distintos con dos arreglos distintos.
     */
    file:
      row.file_id === null
        ? null
        : {
            mimeType: row.file_mime_type,
            sizeBytes: row.file_size_bytes === null ? null : toInt(row.file_size_bytes),
            uploadedAt: toIsoRequired(row.file_uploaded_at),
            uploaderEmail: row.uploader_email,
          },
  }
}
