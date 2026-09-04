import { z } from 'zod'

/**
 * Catálogo de vehículos y sus manuales.
 *
 * ── El manual cuelga del CATÁLOGO, no del spec ───────────────────────────────
 *
 * Es el error que hay que no cometer, y el schema del backend es explícito:
 *
 *   vehicle_catalogs (brand, model, year, trim)
 *   ├── vehicle_catalog_specs   (engine, fuel_type, transmission, gear_count)
 *   └── vehicle_catalog_manuals (catalog_id → vehicle_catalogs.id)
 *
 * `vehicle_catalog_manuals.catalog_id` apunta a `vehicle_catalogs`. El spec es
 * el POWERTRAIN y es HERMANO del manual, no su padre. Y está bien que sea así:
 * el manual de usuario es del modelo/año/versión, no de la variante de motor —
 * un Corolla 2021 XEI tiene UN manual, no uno por cada caja. Colgarlo del spec
 * obligaría a subir el mismo PDF N veces.
 *
 * ── Este módulo es el único del panel cuyas escrituras NO son SQL ────────────
 *
 * El resto del panel escribe con stored procedures de `ops`. Acá no, y no es
 * preferencia: el PDF va a DigitalOcean Spaces, y el panel no tiene ese
 * adapter, ni las credenciales, ni el sniffing de magic bytes. Además el
 * backend SÍ tiene el camino —a diferencia de partners y leads—, así que la
 * excepción de `.claude/rules/ops-write-actions.md` no aplica.
 * → `.claude/rules/vehicle-manuals.md`
 */

// ── Espejos del backend ──────────────────────────────────────────────────────
//
// Valores definidos del otro lado, repetidos acá para poder rechazar antes del
// round trip. Son ESPEJOS, no la autoridad: el backend vuelve a validarlos y su
// chequeo es el que no se puede saltear.

/**
 * `MAX_DIRECT_UPLOAD_FILE_SIZE_BYTES` en
 * `autolibre-backend-hex/src/files/file/application/direct-upload.ts`.
 *
 * ── Por qué 100MB y no 10 ni 4.5 ────────────────────────────────────────────
 *
 * Porque el archivo ya no pasa por ningún servidor nuestro. El 2026-09-04 esta
 * pantalla fallaba con `FUNCTION_PAYLOAD_TOO_LARGE`: Vercel corta el cuerpo de
 * una Serverless Function en 4.5MB, límite de plataforma no configurable, y el
 * PDF ni siquiera llegaba al backend. El backend, a su vez, cortaba en 10MB.
 *
 * Ninguno de los dos números servía para un manual de 300 páginas, y subirlos
 * tampoco era el arreglo: **lo que estaba mal era proxear el archivo.** El
 * panel ahora pide una URL firmada y el navegador sube DIRECTO a DigitalOcean
 * Spaces, así que los dos techos desaparecieron y el único que queda es el que
 * el backend decidió para ese flujo.
 *
 * Ese número existe igual, y no es burocracia: una URL de subida sin tope es
 * una invitación a que cualquier usuario autenticado nos llene el bucket. El
 * backend además lo firma DENTRO de la URL como `ContentLength` exacto, así que
 * un PUT de otro tamaño lo rechaza Spaces.
 */
export const MAX_MANUAL_FILE_SIZE_BYTES = 100 * 1024 * 1024

export const MAX_MANUAL_FILE_SIZE_MB = MAX_MANUAL_FILE_SIZE_BYTES / 1024 / 1024

/**
 * `POST /files` acepta JPEG, PNG, WebP y PDF. El panel acepta SÓLO PDF para
 * manuales, y eso es una decisión del panel: un manual de usuario en .png es un
 * dato roto que nadie va a poder abrir en la app.
 */
export const MANUAL_MIME_TYPE = 'application/pdf'

// ── Idioma: convención del panel, no del dominio ─────────────────────────────
//
// `vehicle_catalog_manuals.language` es `text NULL` — el backend no valida
// nada. Un input libre se llena de "Español", "español", "ES", "es-AR" y
// "castellano", que es EXACTAMENTE el desorden que dejó el import del
// `legacy_sheet` en `partners`. Elegir de una lista cerrada no inventa dominio
// (la columna sigue siendo text libre): impone una convención en el único
// lugar donde hoy se escribe esa columna.
//
// Si mañana hace falta un idioma que no está, se agrega acá — una línea.

export const MANUAL_LANGUAGES = ['es', 'pt', 'en'] as const
export type ManualLanguage = (typeof MANUAL_LANGUAGES)[number]

export const MANUAL_LANGUAGE_LABELS: Record<ManualLanguage, string> = {
  es: 'Español',
  pt: 'Portugués',
  en: 'Inglés',
}

export const VEHICLE_TYPES = ['car', 'motorcycle'] as const
export type VehicleType = (typeof VEHICLE_TYPES)[number]

export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  car: 'Auto',
  motorcycle: 'Moto',
}

// ── Contratos de lectura ─────────────────────────────────────────────────────

export interface CatalogListItem {
  id: string
  brand: string
  model: string
  year: number
  trim: string
  vehicleType: VehicleType
  /** Cuántos manuales tiene. Cero es el estado normal hoy — y es el que se busca. */
  manualCount: number
  /** Cuántas variantes de powertrain. Contexto, no acción. */
  specCount: number
  /** Cuántos vehículos de usuarios apuntan a este catálogo: a cuánta gente le sirve el manual. */
  vehicleCount: number
}

export interface CatalogSpec {
  id: string
  engine: string | null
  fuelType: string | null
  transmission: string | null
  gearCount: number | null
}

/**
 * Un manual, con lo que el `LEFT JOIN files` sabe del PDF.
 *
 * `file` es null en dos casos DISTINTOS que la UI tiene que separar:
 *  - `fileId` es null — la fila se creó sin archivo (`fileId` es opcional en el
 *    DTO del backend). Es un manual anunciado y no subido.
 *  - `fileId` apunta a una fila de `files` que ya no está. No debería pasar (hay
 *    FK), pero si pasa, la pantalla no puede decir lo mismo que en el caso de
 *    arriba.
 */
export interface CatalogManual {
  id: string
  fileId: string | null
  version: string | null
  language: string | null
  createdAt: string
  file: {
    mimeType: string | null
    sizeBytes: number | null
    uploadedAt: string
    /**
     * Quién subió el PDF.
     *
     * NO es decoración. `GET /files/:id/url` del backend está acotado por
     * `userId`: el admin que subió es el ÚNICO que puede después pedir la URL
     * firmada desde el panel. Mostrar el email es lo que convierte un "no se
     * puede descargar" incomprensible en "pedísela a fulano".
     */
    uploaderEmail: string | null
  } | null
}

export interface CatalogDetail {
  id: string
  brand: string
  model: string
  year: number
  trim: string
  vehicleType: VehicleType
  createdAt: string
  vehicleCount: number
  specs: Array<CatalogSpec>
  manuals: Array<CatalogManual>
}

/** El nombre humano de un catálogo, en un solo lugar para que no diverja. */
export function catalogTitle(c: {
  brand: string
  model: string
  year: number
  trim: string
}): string {
  return `${c.brand} ${c.model} ${c.year} ${c.trim}`.trim()
}

// ── Search params ────────────────────────────────────────────────────────────

export const catalogSearchSchema = z.object({
  /** Busca en marca, modelo y versión. */
  q: z.string().trim().max(120).optional(),
  /**
   * El filtro que motiva la pantalla: al 2026-09-04 los 83 catálogos tienen
   * CERO manuales. Cuando eso deje de ser cierto, este chip es la lista de
   * trabajo pendiente.
   */
  onlyWithoutManual: z.coerce.boolean().catch(false).default(false),
})

export type CatalogSearch = z.infer<typeof catalogSearchSchema>

// ── Borde de escritura ───────────────────────────────────────────────────────

/**
 * Los campos NO-archivo de la carga.
 *
 * El PDF no entra acá: viaja como `File` dentro de un `FormData` y se valida
 * aparte (ver `parseManualUpload`), porque zod no puede describir un binario
 * que en el servidor es un `File` global de Node y en el cliente uno del DOM.
 *
 * `version` y `language` son opcionales en el backend (`text NULL`). Acá el
 * default es `''` y se traduce a "no mandar el campo" en el borde HTTP: mandar
 * `""` guardaría un string vacío, que es el mismo dato roto que dejó el
 * `legacy_sheet` y que obliga a escribir `coalesce(x,'') = ''` en todo el repo.
 */
export const manualUploadFieldsSchema = z.object({
  catalogId: z.uuid(),
  version: z.string().trim().max(60).default(''),
  language: z.enum(MANUAL_LANGUAGES).or(z.literal('')).catch('').default(''),
})

export type ManualUploadFields = z.infer<typeof manualUploadFieldsSchema>

/**
 * El resultado de una carga, tal como lo necesita la pantalla.
 *
 * Devuelve el `fileId` aunque la UI no lo muestre en grande: si el segundo paso
 * (atar el archivo al catálogo) falla después de que el primero (subir el PDF)
 * salió bien, el archivo YA está en Spaces y este id es lo único que permite
 * recuperarlo sin volver a subir 8MB. Ver `uploadCatalogManual`.
 */
export interface ManualUploadResult {
  fileId: string
  /** `false` cuando el PDF subió pero no se pudo atar al catálogo. */
  linked: boolean
}
