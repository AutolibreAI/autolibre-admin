import { z } from 'zod'

/**
 * Documentos de vehículo extraídos por OCR — `/documentos`.
 *
 * El backend recibe una foto o un PDF (seguro, cédula, registro de conducir,
 * VTV), le pasa un OCR y guarda los campos como columnas de texto en cuatro
 * tablas de `public`. El OCR falla seguido — verificado contra producción el
 * 2026-09-05: `registration_cards.holder_name` cargado en 4 de 10 filas, una
 * `insurances` con `policy_number = '1'`, otra con `plate` NULL.
 *
 * Esta pantalla es para REVISAR eso. Todavía no edita: escribir estas tablas
 * necesita un stored procedure de `ops` con auditoría y una migración
 * (`.claude/rules/ops-write-actions.md`), y eso es una decisión aparte.
 *
 * ── Qué documentos entran ────────────────────────────────────────────────────
 *
 * Los que pasaron por OCR, y sólo esos: el predicado es `file_id IS NOT NULL`.
 * Para VTV además `source = 'manual'` — las filas `source = 'provider'` son una
 * consulta a una API por patente, no un documento escaneado.
 *
 * ── El contraste, que es el corazón de la pantalla ───────────────────────────
 *
 * Sin poder mostrar la imagen (el backend sólo firma un archivo para su dueño, y
 * el admin nunca lo es), la forma de detectar un error de OCR es cruzar lo
 * extraído contra lo que ya sabemos: la patente del seguro contra la patente
 * real del vehículo, el VIN contra el VIN, la marca contra el catálogo.
 * `crossCheck()` arma esa tabla; `fieldMismatch` en el listado la resume en un
 * flag.
 */

export const DOC_TYPES = ['seguro', 'cedula', 'registro', 'vtv'] as const
export type DocType = (typeof DOC_TYPES)[number]

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  seguro: 'Seguro',
  cedula: 'Cédula',
  registro: 'Registro de conducir',
  vtv: 'VTV',
}

/**
 * `status` de `document_status` (lo tienen `insurances`, `driver_licenses` y
 * `vehicle_inspections`; `registration_cards` no tiene la columna). Se muestra
 * crudo si aparece un valor que no está acá — mismo criterio que el resto del
 * panel: un enum copiado se desincroniza el día que el backend agrega un valor.
 */
export const DOC_STATUS_LABELS: Record<string, string> = {
  active: 'Vigente',
  expired: 'Vencido',
  pending_renewal: 'A renovar',
}

// ── Search params ────────────────────────────────────────────────────────────

export const DOC_TYPE_FILTERS = ['all', ...DOC_TYPES] as const
export type DocTypeFilter = (typeof DOC_TYPE_FILTERS)[number]

/**
 * `por_vencer` son los próximos 30 días. `vigente` incluye a `por_vencer` (no es
 * excluyente): es "todavía no venció". Los tres cortes dejan afuera a los
 * documentos sin fecha de vencimiento — ésos sólo salen con `all`.
 */
export const EXPIRY_FILTERS = ['all', 'vigente', 'por_vencer', 'vencido'] as const
export type ExpiryFilter = (typeof EXPIRY_FILTERS)[number]

export const EXPIRY_FILTER_LABELS: Record<ExpiryFilter, string> = {
  all: 'Todos',
  vigente: 'Vigente',
  por_vencer: 'Por vencer',
  vencido: 'Vencido',
}

/** Ventana de "por vencer", en días. */
export const EXPIRING_SOON_DAYS = 30

export const DOC_SORT_KEYS = ['user', 'type', 'vehicle', 'expiration', 'uploaded'] as const
export type DocSortKey = (typeof DOC_SORT_KEYS)[number]

export const DOC_SORT_DIRS = ['asc', 'desc'] as const
export type DocSortDir = (typeof DOC_SORT_DIRS)[number]

export const documentSearchSchema = z.object({
  /** Busca en usuario (email/nombre), patente, nº de documento y dato principal. */
  q: z.string().trim().max(120).optional(),
  /**
   * El filtro por tipo de documento. Se llama `kind` y no `type` a propósito:
   * TanStack mergea los search params de TODAS las rutas en un solo tipo, y
   * `/chats` ya tiene un `type` con otro enum — dos `type` distintos rompen el
   * updater funcional de los `<Link search={(prev) => …}>`.
   */
  kind: z.enum(DOC_TYPE_FILTERS).catch('all').default('all'),
  expiry: z.enum(EXPIRY_FILTERS).catch('all').default('all'),
  /**
   * Toggles a filas problemáticas — tono `warn` en la UI, mismo criterio que
   * `onlyLegacyNative` en `/usuarios`. `.catch(false)`: un `?onlyMismatches=x`
   * de un link viejo no rompe la pantalla.
   */
  onlyMismatches: z.coerce.boolean().catch(false).default(false),
  onlyMissingFields: z.coerce.boolean().catch(false).default(false),
  /**
   * Default `uploaded desc`: lo recién subido es lo que todavía nadie revisó.
   * Mismo criterio que `/usuarios` (alta descendente) y `/chats`.
   */
  sort: z.enum(DOC_SORT_KEYS).catch('uploaded').default('uploaded'),
  dir: z.enum(DOC_SORT_DIRS).catch('desc').default('desc'),
})

export type DocumentSearch = z.infer<typeof documentSearchSchema>

// ── Formas de lectura ────────────────────────────────────────────────────────

export type ExpiryState = 'vigente' | 'por_vencer' | 'vencido' | 'sin_fecha'

export function expiryState(daysUntilExpiration: number | null): ExpiryState {
  if (daysUntilExpiration === null) return 'sin_fecha'
  if (daysUntilExpiration < 0) return 'vencido'
  if (daysUntilExpiration <= EXPIRING_SOON_DAYS) return 'por_vencer'
  return 'vigente'
}

export interface DocumentListItem {
  id: string
  docType: DocType
  userId: string
  userEmail: string
  userName: string | null
  /** `null` para el registro de conducir — no cuelga de un vehículo. */
  vehiclePlate: string | null
  /** Aseguradora / titular / nombre y apellido / centro de verificación. */
  primaryLabel: string | null
  /** Nº de póliza / de cédula / de licencia / de oblea. */
  documentNumber: string | null
  issueDate: string | null
  expirationDate: string | null
  /**
   * Precalculado en Postgres (`expiration_date - current_date`). NO se calcula
   * en el componente: la pantalla es SSR completo y restar contra `new Date()`
   * puede dar distinto en servidor y cliente si cruzan medianoche UTC — mismo
   * motivo que `driverLicenseDaysUntilExpiration` en `users.repo.ts`.
   */
  daysUntilExpiration: number | null
  hasFile: boolean
  fileMimeType: string | null
  uploadedAt: string | null
  /**
   * Un campo extraído contradice al vehículo real (patente o VIN). Sólo aplica a
   * seguro y cédula; siempre `false` para registro y VTV.
   */
  fieldMismatch: boolean
  /** Falta al menos uno de los campos que ese tipo de documento debería traer. */
  missingFields: boolean
}

export interface CrossCheckRow {
  label: string
  ocr: string | null
  real: string | null
  /** `true` sólo si los dos están cargados y coinciden. Vacío ⇒ ni ok ni mismatch. */
  ok: boolean
}

export interface DocumentDetail {
  id: string
  docType: DocType
  userId: string
  userEmail: string
  userName: string | null
  archived: boolean
  createdAt: string
  updatedAt: string

  // Archivo — metadatos, nunca la URL (el backend sólo la firma para el dueño).
  fileId: string | null
  fileMimeType: string | null
  fileSizeBytes: number | null
  fileUploadedAt: string | null
  uploaderEmail: string | null

  // El vehículo real, para el contraste. Todo `null` en el registro de conducir.
  vehicleId: string | null
  vehiclePlate: string | null
  vehicleVin: string | null
  vehicleBrand: string | null
  vehicleModel: string | null
  vehicleYear: number | null

  // Campos crudos, planos y nullable. Cada `docType` usa un subconjunto —
  // ver DOC_FIELDS.
  status: string | null
  issueDate: string | null
  expirationDate: string | null
  daysUntilExpiration: number | null

  insurer: string | null
  policyNumber: string | null
  coverageType: string | null
  insuredName: string | null

  registrationNumber: string | null
  holderName: string | null
  dni: string | null
  brand: string | null
  model: string | null

  licenseNumber: string | null
  category: string | null
  firstName: string | null
  lastName: string | null
  address: string | null

  facility: string | null
  stickerNumber: string | null
  inspectionType: string | null

  /** OCR'd en seguro y cédula. */
  plate: string | null
  vin: string | null
  engineNumber: string | null
}

/**
 * Qué campos muestra la ficha por tipo, en orden, y con qué etiqueta. Una sola
 * definición: la lista de campos, el título y el orden salen de acá — mismo
 * criterio que `CENSUS_ENTRIES` en `~/lib/users`.
 *
 * `key` es una propiedad de `DocumentDetail`.
 */
type DetailFieldKey = keyof Pick<
  DocumentDetail,
  | 'status'
  | 'issueDate'
  | 'expirationDate'
  | 'insurer'
  | 'policyNumber'
  | 'coverageType'
  | 'insuredName'
  | 'registrationNumber'
  | 'holderName'
  | 'dni'
  | 'brand'
  | 'model'
  | 'licenseNumber'
  | 'category'
  | 'firstName'
  | 'lastName'
  | 'address'
  | 'facility'
  | 'stickerNumber'
  | 'inspectionType'
  | 'plate'
  | 'vin'
  | 'engineNumber'
>

export const DOC_FIELDS: Record<DocType, ReadonlyArray<{ key: DetailFieldKey; label: string }>> = {
  seguro: [
    { key: 'insurer', label: 'Aseguradora' },
    { key: 'policyNumber', label: 'Nº de póliza' },
    { key: 'coverageType', label: 'Tipo de cobertura' },
    { key: 'insuredName', label: 'Asegurado' },
    { key: 'plate', label: 'Patente' },
    { key: 'vin', label: 'VIN / chasis' },
    { key: 'engineNumber', label: 'Nº de motor' },
    { key: 'issueDate', label: 'Emisión' },
    { key: 'expirationDate', label: 'Vencimiento' },
    { key: 'status', label: 'Estado' },
  ],
  cedula: [
    { key: 'registrationNumber', label: 'Nº de cédula' },
    { key: 'holderName', label: 'Titular' },
    { key: 'dni', label: 'DNI' },
    { key: 'plate', label: 'Patente' },
    { key: 'vin', label: 'VIN / chasis' },
    { key: 'brand', label: 'Marca' },
    { key: 'model', label: 'Modelo' },
    { key: 'engineNumber', label: 'Nº de motor' },
    { key: 'issueDate', label: 'Emisión' },
    { key: 'expirationDate', label: 'Vencimiento' },
  ],
  registro: [
    { key: 'licenseNumber', label: 'Nº de licencia' },
    { key: 'firstName', label: 'Nombre' },
    { key: 'lastName', label: 'Apellido' },
    { key: 'category', label: 'Categoría' },
    { key: 'address', label: 'Domicilio' },
    { key: 'issueDate', label: 'Emisión' },
    { key: 'expirationDate', label: 'Vencimiento' },
    { key: 'status', label: 'Estado' },
  ],
  vtv: [
    { key: 'facility', label: 'Centro de verificación' },
    { key: 'stickerNumber', label: 'Nº de oblea' },
    { key: 'inspectionType', label: 'Tipo' },
    { key: 'issueDate', label: 'Emisión' },
    { key: 'expirationDate', label: 'Vencimiento' },
    { key: 'status', label: 'Estado' },
  ],
}

/**
 * Campos que ese tipo de documento DEBERÍA traer del OCR. Alimenta el flag
 * `missingFields`: si alguno está vacío, la fila se marca. `holder_name` está en
 * la lista de la cédula a propósito — es justo el que más falla (6 de 10 en
 * prod), y el objetivo de la pantalla es que eso se vea.
 *
 * `dni` no está en la de la cédula: la mitad de las cédulas reales no lo traen
 * impreso, así que marcarlo sería ruido.
 */
export const DOC_EXPECTED_FIELDS: Record<DocType, ReadonlyArray<DetailFieldKey>> = {
  seguro: ['insurer', 'policyNumber', 'expirationDate', 'plate'],
  cedula: ['registrationNumber', 'holderName', 'plate', 'vin'],
  registro: ['licenseNumber', 'firstName', 'lastName', 'expirationDate'],
  vtv: ['stickerNumber', 'expirationDate'],
}

// ── Contraste OCR ↔ vehículo ─────────────────────────────────────────────────

const norm = (v: string | null): string | null => {
  const t = (v ?? '').trim()
  return t === '' ? null : t
}
const normPlate = (v: string | null): string | null => {
  const t = norm(v)
  return t === null ? null : t.toUpperCase().replace(/[\s-]/g, '')
}

/**
 * Lo que el OCR sacó contra lo que el vehículo ya tiene cargado. Sólo tiene
 * sentido para seguro y cédula — el registro de conducir no cuelga de un
 * vehículo.
 *
 * `ok` es `true` únicamente cuando los dos lados están cargados y coinciden. Si
 * el OCR dejó el campo vacío, la fila NO es un mismatch (es un faltante, y de
 * eso se ocupa `missingFields`): `ok` queda `false` pero sin pintar de rojo.
 */
export function crossCheck(d: DocumentDetail): Array<CrossCheckRow> {
  if (d.docType !== 'seguro' && d.docType !== 'cedula') return []

  const rows: Array<CrossCheckRow> = [
    {
      label: 'Patente',
      ocr: normPlate(d.plate),
      real: normPlate(d.vehiclePlate),
      ok: false,
    },
    {
      label: 'VIN / chasis',
      ocr: norm(d.vin)?.toUpperCase() ?? null,
      real: norm(d.vehicleVin)?.toUpperCase() ?? null,
      ok: false,
    },
  ]

  if (d.docType === 'cedula') {
    rows.push(
      { label: 'Marca', ocr: norm(d.brand)?.toUpperCase() ?? null, real: norm(d.vehicleBrand)?.toUpperCase() ?? null, ok: false },
      { label: 'Modelo', ocr: norm(d.model)?.toUpperCase() ?? null, real: norm(d.vehicleModel)?.toUpperCase() ?? null, ok: false },
    )
  }

  return rows.map((r) => ({ ...r, ok: r.ocr !== null && r.real !== null && r.ocr === r.real }))
}

/** Un campo del contraste que contradice al vehículo (los dos cargados y distintos). */
export function isMismatch(row: CrossCheckRow): boolean {
  return row.ocr !== null && row.real !== null && row.ocr !== row.real
}
