import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import {
  type DocType,
  type DocumentDetail,
  type DocumentListItem,
  type DocumentSearch,
  type DocSortKey,
} from '~/lib/documents'

/**
 * Documentos de vehículo extraídos por OCR — SOLO LECTURA, igual que
 * `chats.repo.ts` / `users.repo.ts`: `insurances`, `registration_cards`,
 * `driver_licenses` y `vehicle_inspections` son dominio del backend
 * (`vehicle-management/`), este repo sólo consulta.
 *
 * Editar estas tablas es otra cosa y todavía no está: necesita un stored
 * procedure de `ops` con auditoría (`ops.action_log`) y una migración —
 * `.claude/rules/ops-write-actions.md`. Si aparece un `UPDATE` acá, está mal.
 */

const toInt = (value: unknown): number => Number(value ?? 0)
const toIntOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)
const toIso = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString()
    : value === null || value === undefined
      ? null
      : String(value)
const toIsoRequired = (value: unknown): string => toIso(value) ?? ''

/**
 * `DocType → tabla`. `Record` cerrado que los tipos obligan a cubrir, así que es
 * seguro de interpolar — mismo criterio que `SORT_COLUMNS` en `chats.repo.ts`.
 * NUNCA se arma con texto suelto.
 */
const DOC_TYPE_TABLE: Record<DocType, string> = {
  seguro: 'insurances',
  cedula: 'registration_cards',
  registro: 'driver_licenses',
  vtv: 'vehicle_inspections',
}

/**
 * Mapa cerrado `DocSortKey → columna del SELECT externo`. Igual que arriba: sale
 * de un `Record` tipado, no de la URL.
 */
const SORT_COLUMNS: Record<DocSortKey, string> = {
  user: 'user_email',
  type: 'doc_type',
  vehicle: 'vehicle_plate',
  expiration: 'expiration_date',
  uploaded: 'uploaded_at',
}

// ── Listado ──────────────────────────────────────────────────────────────────

interface DocListRow {
  id: string
  doc_type: DocType
  user_id: string
  user_email: string
  user_name: string | null
  vehicle_plate: string | null
  primary_label: string | null
  document_number: string | null
  issue_date: Date | string | null
  expiration_date: Date | string | null
  days_until_expiration: number | string | null
  has_file: boolean
  file_mime_type: string | null
  uploaded_at: Date | string | null
  field_mismatch: boolean
  missing_fields: boolean
}

/**
 * El contraste OCR ↔ vehículo, en SQL, para el flag del listado.
 *
 * Un mismatch es: los DOS lados cargados y distintos. Un lado vacío NO es
 * mismatch (es un faltante, y de eso se ocupa `missing_fields`). Se normaliza
 * sacando espacios, puntos y guiones con `translate` — no `regexp_replace`, que
 * obligaría a escapar `\s` dentro de un template literal de JS y ya mordió en
 * otros repos.
 */
function mismatchExpr(ocrPlate: string, ocrVin: string, vPlate: string, vVin: string): string {
  const nPlateOcr = `nullif(translate(upper(${ocrPlate}), ' .-', ''), '')`
  const nPlateV = `nullif(translate(upper(${vPlate}), ' .-', ''), '')`
  const nVinOcr = `nullif(upper(btrim(${ocrVin})), '')`
  const nVinV = `nullif(upper(btrim(${vVin})), '')`
  return `(
    (${nPlateOcr} is not null and ${nPlateV} is not null and ${nPlateOcr} <> ${nPlateV})
    or (${nVinOcr} is not null and ${nVinV} is not null and ${nVinOcr} <> ${nVinV})
  )`
}

/** `coalesce(x,'') = ''` para cada campo — el import del legacy sheet dejó ''s. */
const emptyAny = (...cols: Array<string>): string =>
  '(' + cols.map((c) => `coalesce(${c}::text, '') = ''`).join(' or ') + ')'

/**
 * El listado de documentos OCR de las cuatro tablas, en una sola consulta.
 *
 * `UNION ALL` normalizado a una forma común (mismo patrón que la lista de
 * escáneres y el `GROUPING SETS` de ahí no, acá alcanza un union). Envuelto en
 * `select * from (...) s` por el mismo motivo que `listChats`: `primary_label`,
 * `field_mismatch` y demás son expresiones del SELECT interno, y los filtros de
 * la URL (`q`, `expiry`, …) necesitan buscar sobre ellas.
 *
 * Predicado "es OCR": `file_id is not null`. Para VTV además `source = 'manual'`
 * — las `provider` son una consulta a una API por patente, no un escaneo.
 *
 * Los joins al vehículo/catálogo son `LEFT` en las tres patas: `vehicle_id` de
 * `insurances`/`registration_cards` es NOT NULL, pero la FK garantiza que el
 * SPEC exista, no el catálogo — misma trampa que `scanner-compatibility.md`.
 * `driver_licenses` no tiene `vehicle_id`: ese branch no joinea vehículo.
 */
export async function listDocuments(
  search: DocumentSearch,
  opts: { signal?: AbortSignal } = {},
): Promise<Array<DocumentListItem>> {
  void opts.signal

  const params: Array<unknown> = []
  const outerWhere: Array<string> = []

  if (search.q) {
    params.push(`%${search.q}%`)
    const p = `$${params.length}`
    outerWhere.push(
      `(user_email ilike ${p} or coalesce(user_name,'') ilike ${p} ` +
        `or coalesce(vehicle_plate,'') ilike ${p} or coalesce(document_number,'') ilike ${p} ` +
        `or coalesce(primary_label,'') ilike ${p})`,
    )
  }

  if (search.kind !== 'all') {
    params.push(search.kind)
    outerWhere.push(`doc_type = $${params.length}`)
  }

  if (search.expiry === 'vigente') {
    outerWhere.push('days_until_expiration is not null and days_until_expiration >= 0')
  } else if (search.expiry === 'por_vencer') {
    outerWhere.push('days_until_expiration is not null and days_until_expiration between 0 and 30')
  } else if (search.expiry === 'vencido') {
    outerWhere.push('days_until_expiration is not null and days_until_expiration < 0')
  }

  if (search.onlyMismatches) outerWhere.push('field_mismatch')
  if (search.onlyMissingFields) outerWhere.push('missing_fields')

  const sortColumn = SORT_COLUMNS[search.sort]

  const rows = await sql<DocListRow>(
    `
    select * from (
      -- ── seguro ──
      select
        i.id, 'seguro'::text as doc_type,
        i.user_id, u.email as user_email, u.name as user_name,
        v.plate as vehicle_plate,
        i.insurer as primary_label,
        i.policy_number as document_number,
        i.issue_date, i.expiration_date,
        (i.expiration_date - current_date)::int as days_until_expiration,
        (i.file_id is not null) as has_file,
        f.mime_type as file_mime_type,
        f.uploaded_at,
        ${mismatchExpr('i.plate', 'i.vin', 'v.plate', 'v.vin')} as field_mismatch,
        ${emptyAny('i.insurer', 'i.policy_number', 'i.plate')} as missing_fields
      from insurances i
      join users u on u.id = i.user_id
      left join vehicles v on v.id = i.vehicle_id
      left join files f on f.id = i.file_id
      where i.file_id is not null

      union all

      -- ── cédula ──
      select
        r.id, 'cedula'::text,
        r.user_id, u.email, u.name,
        v.plate,
        r.holder_name,
        r.registration_number,
        r.issue_date, r.expiration_date,
        (r.expiration_date - current_date)::int,
        (r.file_id is not null),
        f.mime_type,
        f.uploaded_at,
        ${mismatchExpr('r.plate', 'r.vin', 'v.plate', 'v.vin')},
        ${emptyAny('r.registration_number', 'r.holder_name', 'r.plate', 'r.vin')}
      from registration_cards r
      join users u on u.id = r.user_id
      left join vehicles v on v.id = r.vehicle_id
      left join files f on f.id = r.file_id
      where r.file_id is not null

      union all

      -- ── registro de conducir (no cuelga de un vehículo) ──
      select
        l.id, 'registro'::text,
        l.user_id, u.email, u.name,
        null,
        nullif(btrim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')), ''),
        l.license_number,
        l.issue_date, l.expiration_date,
        (l.expiration_date - current_date)::int,
        (l.file_id is not null),
        f.mime_type,
        f.uploaded_at,
        false,
        ${emptyAny('l.license_number', 'l.first_name', 'l.last_name')}
      from driver_licenses l
      join users u on u.id = l.user_id
      left join files f on f.id = l.file_id
      where l.file_id is not null

      union all

      -- ── VTV ──
      select
        vi.id, 'vtv'::text,
        vi.user_id, u.email, u.name,
        v.plate,
        vi.facility,
        vi.sticker_number,
        vi.issue_date, vi.expiration_date,
        (vi.expiration_date - current_date)::int,
        (vi.file_id is not null),
        f.mime_type,
        f.uploaded_at,
        false,
        ${emptyAny('vi.sticker_number')}
      from vehicle_inspections vi
      join users u on u.id = vi.user_id
      left join vehicles v on v.id = vi.vehicle_id
      left join files f on f.id = vi.file_id
      where vi.file_id is not null and vi.source = 'manual'
    ) s
    ${outerWhere.length ? `where ${outerWhere.join(' and ')}` : ''}
    order by ${sortColumn} ${search.dir} nulls last, id
    limit 500
    `,
    params,
  )

  return rows.map(
    (r): DocumentListItem => ({
      id: r.id,
      docType: r.doc_type,
      userId: r.user_id,
      userEmail: r.user_email,
      userName: r.user_name,
      vehiclePlate: r.vehicle_plate,
      primaryLabel: r.primary_label,
      documentNumber: r.document_number,
      issueDate: toIso(r.issue_date),
      expirationDate: toIso(r.expiration_date),
      daysUntilExpiration: toIntOrNull(r.days_until_expiration),
      hasFile: r.has_file,
      fileMimeType: r.file_mime_type,
      uploadedAt: toIso(r.uploaded_at),
      fieldMismatch: r.field_mismatch,
      missingFields: r.missing_fields,
    }),
  )
}

// ── Detalle ──────────────────────────────────────────────────────────────────

interface DocDetailRow {
  id: string
  user_id: string
  user_email: string
  user_name: string | null
  archived: boolean
  created_at: Date | string
  updated_at: Date | string
  file_id: string | null
  file_mime_type: string | null
  file_size_bytes: number | string | null
  file_uploaded_at: Date | string | null
  uploader_email: string | null
  vehicle_id: string | null
  vehicle_plate: string | null
  vehicle_vin: string | null
  vehicle_brand: string | null
  vehicle_model: string | null
  vehicle_year: number | string | null
  status: string | null
  issue_date: Date | string | null
  expiration_date: Date | string | null
  days_until_expiration: number | string | null
  insurer: string | null
  policy_number: string | null
  coverage_type: string | null
  insured_name: string | null
  registration_number: string | null
  holder_name: string | null
  dni: string | null
  brand: string | null
  model: string | null
  license_number: string | null
  category: string | null
  first_name: string | null
  last_name: string | null
  address: string | null
  facility: string | null
  sticker_number: string | null
  inspection_type: string | null
  plate: string | null
  vin: string | null
  engine_number: string | null
}

/**
 * Cada tipo tiene su SELECT — las tablas no comparten columnas, así que
 * normalizar en una sola vista sería llenar de `null::text`. Cada query produce
 * el MISMO conjunto de columnas de salida (`DocDetailRow`), con `null::text` /
 * `null::date` para lo que esa tabla no tiene. Un solo mapper después.
 *
 * `$1` es el id.
 */
const COMMON_JOINS = `
  join users u on u.id = d.user_id
  left join files f on f.id = d.file_id
  left join users up on up.id = f.user_id
`
const VEHICLE_JOINS = `
  left join vehicles v on v.id = d.vehicle_id
  left join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
  left join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
`
const FILE_COLS = `
  d.file_id,
  f.mime_type as file_mime_type,
  f.size_bytes as file_size_bytes,
  f.uploaded_at as file_uploaded_at,
  up.email as uploader_email
`
const VEHICLE_COLS = `
  d.vehicle_id,
  v.plate as vehicle_plate, v.vin as vehicle_vin,
  vc.brand as vehicle_brand, vc.model as vehicle_model, vc.year as vehicle_year
`
const NO_VEHICLE_COLS = `
  null::uuid as vehicle_id,
  null::text as vehicle_plate, null::text as vehicle_vin,
  null::text as vehicle_brand, null::text as vehicle_model, null::int as vehicle_year
`

const DETAIL_QUERIES: Record<DocType, string> = {
  seguro: `
    select
      d.id, d.user_id, u.email as user_email, u.name as user_name,
      d.archived, d.created_at, d.updated_at,
      ${FILE_COLS}, ${VEHICLE_COLS},
      d.status::text as status,
      d.issue_date, d.expiration_date,
      (d.expiration_date - current_date)::int as days_until_expiration,
      d.insurer, d.policy_number, d.coverage_type, d.insured_name,
      null::text as registration_number, null::text as holder_name, null::text as dni,
      null::text as brand, null::text as model,
      null::text as license_number, null::text as category,
      null::text as first_name, null::text as last_name, null::text as address,
      null::text as facility, null::text as sticker_number, null::text as inspection_type,
      d.plate, d.vin, d.engine_number
    from insurances d
    ${COMMON_JOINS} ${VEHICLE_JOINS}
    where d.id = $1
  `,
  cedula: `
    select
      d.id, d.user_id, u.email as user_email, u.name as user_name,
      d.archived, d.created_at, d.updated_at,
      ${FILE_COLS}, ${VEHICLE_COLS},
      null::text as status,
      d.issue_date, d.expiration_date,
      (d.expiration_date - current_date)::int as days_until_expiration,
      null::text as insurer, null::text as policy_number, null::text as coverage_type,
      null::text as insured_name,
      d.registration_number, d.holder_name, d.dni, d.brand, d.model,
      null::text as license_number, null::text as category,
      null::text as first_name, null::text as last_name, null::text as address,
      null::text as facility, null::text as sticker_number, null::text as inspection_type,
      d.plate, d.vin, d.engine_number
    from registration_cards d
    ${COMMON_JOINS} ${VEHICLE_JOINS}
    where d.id = $1
  `,
  registro: `
    select
      d.id, d.user_id, u.email as user_email, u.name as user_name,
      d.archived, d.created_at, d.updated_at,
      ${FILE_COLS}, ${NO_VEHICLE_COLS},
      d.status::text as status,
      d.issue_date, d.expiration_date,
      (d.expiration_date - current_date)::int as days_until_expiration,
      null::text as insurer, null::text as policy_number, null::text as coverage_type,
      null::text as insured_name,
      null::text as registration_number, null::text as holder_name, null::text as dni,
      null::text as brand, null::text as model,
      d.license_number, d.category, d.first_name, d.last_name, d.address,
      null::text as facility, null::text as sticker_number, null::text as inspection_type,
      null::text as plate, null::text as vin, null::text as engine_number
    from driver_licenses d
    ${COMMON_JOINS}
    where d.id = $1
  `,
  vtv: `
    select
      d.id, d.user_id, u.email as user_email, u.name as user_name,
      d.archived, d.created_at, d.updated_at,
      ${FILE_COLS}, ${VEHICLE_COLS},
      d.status::text as status,
      d.issue_date, d.expiration_date,
      (d.expiration_date - current_date)::int as days_until_expiration,
      null::text as insurer, null::text as policy_number, null::text as coverage_type,
      null::text as insured_name,
      null::text as registration_number, null::text as holder_name, null::text as dni,
      null::text as brand, null::text as model,
      null::text as license_number, null::text as category,
      null::text as first_name, null::text as last_name, null::text as address,
      d.facility, d.sticker_number, d.type::text as inspection_type,
      null::text as plate, null::text as vin, null::text as engine_number
    from vehicle_inspections d
    ${COMMON_JOINS} ${VEHICLE_JOINS}
    where d.id = $1
  `,
}

export async function findDocument(
  docType: DocType,
  docId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<DocumentDetail | null> {
  void opts.signal

  const row = await sqlOne<DocDetailRow>(DETAIL_QUERIES[docType], [docId])
  if (!row) return null

  return {
    id: row.id,
    docType,
    userId: row.user_id,
    userEmail: row.user_email,
    userName: row.user_name,
    archived: row.archived,
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),

    fileId: row.file_id,
    fileMimeType: row.file_mime_type,
    fileSizeBytes: toIntOrNull(row.file_size_bytes),
    fileUploadedAt: toIso(row.file_uploaded_at),
    uploaderEmail: row.uploader_email,

    vehicleId: row.vehicle_id,
    vehiclePlate: row.vehicle_plate,
    vehicleVin: row.vehicle_vin,
    vehicleBrand: row.vehicle_brand,
    vehicleModel: row.vehicle_model,
    vehicleYear: row.vehicle_year === null ? null : toInt(row.vehicle_year),

    status: row.status,
    issueDate: toIso(row.issue_date),
    expirationDate: toIso(row.expiration_date),
    daysUntilExpiration: toIntOrNull(row.days_until_expiration),

    insurer: row.insurer,
    policyNumber: row.policy_number,
    coverageType: row.coverage_type,
    insuredName: row.insured_name,

    registrationNumber: row.registration_number,
    holderName: row.holder_name,
    dni: row.dni,
    brand: row.brand,
    model: row.model,

    licenseNumber: row.license_number,
    category: row.category,
    firstName: row.first_name,
    lastName: row.last_name,
    address: row.address,

    facility: row.facility,
    stickerNumber: row.sticker_number,
    inspectionType: row.inspection_type,

    plate: row.plate,
    vin: row.vin,
    engineNumber: row.engine_number,
  }
}
