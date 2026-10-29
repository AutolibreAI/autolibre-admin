import { z } from 'zod'
import { normalizeForMatch } from '~/lib/catalog'

/**
 * Seguimiento comercial: los proveedores que el equipo sale a buscar
 * (`ops.partner_prospect`, migración 024). → `.claude/rules/partner-prospects.md`
 *
 * ── Vocabulario ────────────────────────────────────────────────────────────
 *
 * En el código es `PartnerProspect` (regla dura 7: `Partner`, nunca
 * `Provider`). En la UI es "contacto" y "proveedor", que es como habla el
 * equipo — gomerías, lavaderos, gestorías y grúas también, no sólo talleres.
 */

// ── Estados ────────────────────────────────────────────────────────────────

/** El orden es el del embudo, y es el de los chips y el del selector. */
export const PROSPECT_STATUSES = [
  'pending',
  'no_answer',
  'visit',
  'thinking',
  'interested',
  'registered',
  'not_interested',
] as const
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number]

export const PROSPECT_STATUS_LABELS: Record<ProspectStatus, string> = {
  pending: 'Pendiente',
  no_answer: 'Llamé, no atendió',
  visit: 'Ir en persona',
  thinking: 'Lo piensa',
  interested: 'Interesado',
  registered: 'Registrado',
  not_interested: 'No le interesa',
}

/**
 * Clases de color por estado, todas de tokens (`design-system.md`).
 *
 * **"Interesado" va en VIOLETA, no en azul**: el design system de mobile no
 * tiene azul, a propósito (`tokens.ts`: "Esta app NO TIENE azul a propósito —
 * la marca migró de #007AFF a verde"). El violeta es el único color de estado
 * que queda libre. Si se quiere azul, se agrega primero en mobile.
 */
export const PROSPECT_STATUS_CLASSES: Record<ProspectStatus, string> = {
  pending: 'border-border bg-surface-2 text-muted-foreground',
  no_answer: 'border-border bg-card text-muted-foreground',
  visit: 'border-action bg-action text-primary-foreground',
  thinking: 'border-status-yellow/30 bg-status-yellow-bg text-status-yellow',
  interested: 'border-status-violet/30 bg-status-violet-bg text-status-violet',
  registered: 'border-status-green/30 bg-status-green-bg text-status-green',
  not_interested: 'border-status-red/30 bg-status-red-bg text-status-red',
}

/** Los que ya no necesitan seguimiento: fuera de la vista "Hoy". */
export const CLOSED_PROSPECT_STATUSES: ReadonlyArray<ProspectStatus> = ['registered', 'not_interested']

// ── Plan ───────────────────────────────────────────────────────────────────

export const PROSPECT_PLANS = ['undecided', 'free', 'plus'] as const
export type ProspectPlan = (typeof PROSPECT_PLANS)[number]

export const PROSPECT_PLAN_LABELS: Record<ProspectPlan, string> = {
  undecided: 'Sin definir',
  free: 'Gratis',
  plus: 'Plus',
}

// ── Teléfono ───────────────────────────────────────────────────────────────

/**
 * ESPEJO de `ops.normalize_ar_phone` (migración 024): `549` + 10 dígitos, o
 * `null`. La verdad es la de la base —ahí vive el índice único de
 * duplicados—; esto existe para el botón de WhatsApp y la vista previa del
 * CSV. Si divergen, la vista previa dice "nuevo" y la base lo rechaza como
 * duplicado: falla fuerte, nunca guarda dos veces. Se tocan juntas.
 *
 * Nunca se completa una característica: un número de 8 dígitos o un "15"
 * suelto sin código de área dan `null`.
 */
export function normalizeArPhone(phone: string | null | undefined): string | null {
  const v = (phone ?? '').replace(/[^0-9]/g, '')
  if (/^549[0-9]{10}$/.test(v)) return v
  if (/^54[0-9]{10}$/.test(v)) return `549${v.slice(2)}`
  if (/^0?1115[0-9]{8}$/.test(v)) return `54911${v.slice(-8)}`
  if (/^0[0-9]{10}$/.test(v)) return `549${v.slice(1)}`
  if (/^(11[0-9]{8}|[23][0-9]{9})$/.test(v)) return `549${v}`
  return null
}

/** `https://wa.me/549…` — sólo con la forma canónica. */
export function prospectWhatsAppUrl(phoneDigits: string | null): string | null {
  return phoneDigits ? `https://wa.me/${phoneDigits}` : null
}

// ── Lo que viaja ───────────────────────────────────────────────────────────

export interface PartnerProspect {
  id: string
  name: string
  phone: string | null
  phoneDigits: string | null
  locality: string | null
  shortNote: string | null
  categorySlugs: Array<string>
  originSlug: string
  status: ProspectStatus
  ownerId: string | null
  talkedTo: string | null
  plan: ProspectPlan
  /** `YYYY-MM-DD`, armado en SQL: un `date` pasado por `Date` corre el día. */
  lastContactOn: string | null
  nextFollowUpOn: string | null
  /**
   * Días hasta el próximo seguimiento, contra HOY en Buenos Aires. Lo calcula
   * Postgres: la pantalla es SSR y restar contra el reloj del navegador daría
   * otro número (mismatch de hidratación), mismo patrón que `age_minutes` de
   * `/actividad`. Negativo = vencido.
   */
  followUpInDays: number | null
  notes: string | null
  partnerId: string | null
  partnerName: string | null
  partnerStatus: string | null
  createdAt: string
  updatedAt: string
}

export interface ProspectOrigin {
  slug: string
  label: string
}

/** Un comercial: un admin del panel. */
export interface ProspectOwner {
  id: string
  name: string
  email: string
}

export interface ProspectCategoryOption {
  slug: string
  name: string
}

/**
 * Los contadores de arriba. Siguen a TODOS los filtros menos el de estado:
 * son justamente el desglose por estado, y con el filtro de estado puesto
 * dirían "3 interesados de 3".
 */
export interface ProspectSummary {
  total: number
  /** Todo lo que no está `pending`: se lo llamó o se lo visitó al menos una vez. */
  contacted: number
  interested: number
  registered: number
  notInterested: number
  /** Seguimientos vencidos o de hoy, de contactos abiertos. */
  dueToday: number
}

export interface ProspectFacets {
  origins: Array<ProspectOrigin>
  owners: Array<ProspectOwner>
  categories: Array<ProspectCategoryOption>
}

export type ProspectListResult =
  | { available: false }
  | {
      available: true
      rows: Array<PartnerProspect>
      /** Cuántos matchean el filtro; `rows` corta en `PROSPECT_LIST_LIMIT`. */
      matched: number
      summary: ProspectSummary
      facets: ProspectFacets
    }

export type ProspectTodayResult =
  | { available: false }
  | {
      available: true
      rows: Array<PartnerProspect>
      summary: ProspectSummary
      facets: ProspectFacets
    }

export const PROSPECT_LIST_LIMIT = 300

/** Un proveedor del marketplace, para vincular. */
export interface PartnerMatch {
  id: string
  name: string
  whatsapp: string | null
  coverageZone: string | null
  status: string
}

/** Lo que ya existe con alguno de estos teléfonos (alta manual y CSV). */
export interface PhoneMatches {
  prospects: Array<{ id: string; name: string; phoneDigits: string }>
  partners: Array<{ id: string; name: string; phoneDigits: string }>
}

export interface ImportResult {
  created: number
  skipped: Array<{ index: number; existingId: string }>
}

// ── Search params ──────────────────────────────────────────────────────────

/**
 * Calificados `prospect*`: `status`, `origin` u `owner` pelados chocarían con
 * otras rutas en el merge de `FullSearchSchema` (`notifications.md`). `q` se
 * comparte.
 */
export const prospectSearchSchema = z.object({
  q: z.string().trim().max(200).optional().catch(undefined),
  prospectStatus: z.enum(PROSPECT_STATUSES).optional().catch(undefined),
  prospectOrigin: z.string().trim().max(60).optional().catch(undefined),
  prospectRubro: z.string().trim().max(80).optional().catch(undefined),
  /** Un uuid, o `none` = sin comercial asignado. */
  prospectOwner: z.union([z.uuid(), z.literal('none')]).optional().catch(undefined),
})
export type ProspectSearch = z.infer<typeof prospectSearchSchema>

// ── Escrituras ─────────────────────────────────────────────────────────────

const text = (max: number) => z.string().max(max)
const optionalDate = z.union([z.iso.date(), z.literal('')])

/**
 * Las claves editables, en camelCase. Todas opcionales: la edición es un
 * PARCHE (autoguardado campo por campo, ver la cabecera de la 024). Una clave
 * ausente no se toca; `''`/`null` borra.
 */
const prospectFieldsSchema = z.object({
  name: text(200),
  phone: text(60),
  locality: text(200),
  shortNote: text(280),
  categorySlugs: z.array(z.string().max(80)).max(20),
  originSlug: z.string().min(1).max(60),
  status: z.enum(PROSPECT_STATUSES),
  ownerId: z.uuid().nullable(),
  talkedTo: text(200),
  plan: z.enum(PROSPECT_PLANS),
  lastContactOn: optionalDate,
  nextFollowUpOn: optionalDate,
  notes: text(5000),
  partnerId: z.uuid().nullable(),
})
export type ProspectFields = z.infer<typeof prospectFieldsSchema>
export type ProspectPatch = Partial<ProspectFields>

/**
 * camelCase → la clave del SP. Explícito y no con una regex: una clave mal
 * mapeada sería un campo que "se guarda" y no se guarda (el SP además rechaza
 * claves desconocidas con `UNKNOWN_FIELD`).
 */
export const PROSPECT_PATCH_KEYS: Record<keyof ProspectFields, string> = {
  name: 'name',
  phone: 'phone',
  locality: 'locality',
  shortNote: 'short_note',
  categorySlugs: 'category_slugs',
  originSlug: 'origin_slug',
  status: 'status',
  ownerId: 'owner_id',
  talkedTo: 'talked_to',
  plan: 'plan',
  lastContactOn: 'last_contact_on',
  nextFollowUpOn: 'next_follow_up_on',
  notes: 'notes',
  partnerId: 'partner_id',
}

export function toSpPatch(patch: ProspectPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(PROSPECT_PATCH_KEYS) as Array<keyof ProspectFields>) {
    if (patch[key] !== undefined) out[PROSPECT_PATCH_KEYS[key]] = patch[key]
  }
  return out
}

export const createProspectSchema = prospectFieldsSchema
  .partial()
  .extend({ name: z.string().trim().min(1, 'Falta el nombre').max(200), originSlug: z.string().min(1).max(60) })
export type CreateProspectInput = z.infer<typeof createProspectSchema>

export const updateProspectSchema = z.object({
  id: z.uuid(),
  patch: prospectFieldsSchema.partial().refine((p) => Object.keys(p).length > 0, 'Parche vacío'),
})
export type UpdateProspectInput = z.infer<typeof updateProspectSchema>

export const PROSPECT_IMPORT_MAX = 2000

export const importProspectsSchema = z.object({
  rows: z.array(createProspectSchema).min(1).max(PROSPECT_IMPORT_MAX),
})
export type ImportProspectsInput = z.infer<typeof importProspectsSchema>

export const addOriginSchema = z.object({
  label: z.string().trim().min(1).max(60),
})

export const prospectIdSchema = z.object({ id: z.uuid() })

export const phoneLookupSchema = z.object({
  phones: z.array(z.string().regex(/^549[0-9]{10}$/)).max(PROSPECT_IMPORT_MAX),
})

export const searchPartnersSchema = z.object({
  q: z.string().trim().min(2).max(100),
})

/** "Feria de Autopartes" → `feria-de-autopartes`. El SP valida el formato. */
export function originSlug(label: string): string {
  return normalizeForMatch(label)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// ── Errores ────────────────────────────────────────────────────────────────

export const PROSPECTS_UNAVAILABLE = 'PROSPECTS_UNAVAILABLE'

/** El texto legible de un error de escritura. Las sentinelas son de la 024. */
export function readableProspectError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  if (msg.includes(PROSPECTS_UNAVAILABLE))
    return 'Falta aplicar la migración 024 en esta base (pnpm db:migrate).'
  if (msg.includes('DUPLICATE_PHONE')) return 'Ya hay otro contacto con ese teléfono.'
  if (msg.includes('NAME_REQUIRED')) return 'El nombre no puede quedar vacío.'
  if (msg.includes('INVALID_ORIGIN')) return 'Ese origen no existe. Recargá la página.'
  if (msg.includes('INVALID_CATEGORY_SLUG')) return 'Uno de los rubros ya no existe en el catálogo.'
  if (msg.includes('PARTNER_NOT_FOUND')) return 'Ese proveedor ya no existe en el marketplace.'
  if (msg.includes('OWNER_NOT_FOUND')) return 'Ese comercial ya no existe.'
  if (msg.includes('PROSPECT_NOT_FOUND')) return 'El contacto ya no existe. Recargá la página.'
  if (msg.includes('INVALID_DATE')) return 'Fecha inválida.'
  const row = /IMPORT_ROW_INVALID: (\d+)/.exec(msg)
  if (row) return `La fila ${Number(row[1]) + 1} del CSV no es válida; no se importó nada.`
  if (msg.includes('IMPORT_TOO_LARGE')) return `Hasta ${PROSPECT_IMPORT_MAX} filas por importación.`
  if (msg.includes('FORBIDDEN') || msg.includes('UNAUTHENTICATED'))
    return 'Tu sesión no tiene permisos de admin. Volvé a entrar.'
  return 'No se pudo guardar. Probá de nuevo.'
}

// ── CSV ────────────────────────────────────────────────────────────────────

/**
 * CSV mínimo: comillas dobles, `""` adentro de comillas, separador `,` o `;`
 * (el que más aparezca en la primera línea: Excel en castellano exporta con
 * `;`). Sin dependencias: el archivo lo arma Toby desde una planilla, no es
 * un formato hostil.
 */
export function parseCsv(input: string): Array<Array<string>> {
  const textIn = input.replace(/^﻿/, '')
  const firstLine = textIn.split(/\r?\n/, 1)[0] ?? ''
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','

  const rows: Array<Array<string>> = []
  let row: Array<string> = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < textIn.length; i++) {
    const ch = textIn[i]
    if (quoted) {
      if (ch === '"' && textIn[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && textIn[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** Las columnas que se reconocen, por nombre de encabezado. */
export const CSV_COLUMNS = ['name', 'phone', 'locality', 'rubro', 'shortNote'] as const
export type CsvColumn = (typeof CSV_COLUMNS)[number]

export const CSV_COLUMN_LABELS: Record<CsvColumn, string> = {
  name: 'Nombre',
  phone: 'Teléfono',
  locality: 'Localidad',
  rubro: 'Rubro',
  shortNote: 'Nota',
}

const HEADER_ALIASES: Record<CsvColumn, ReadonlyArray<string>> = {
  // Ya normalizados con `normalizeForMatch` (minúsculas, sin acentos, `-`).
  name: ['nombre', 'name', 'proveedor', 'razon-social', 'negocio', 'taller', 'comercio', 'titulo', 'title'],
  phone: ['telefono', 'tel', 'phone', 'whatsapp', 'celular', 'cel', 'movil', 'numero'],
  locality: ['localidad', 'ciudad', 'zona', 'barrio', 'partido', 'direccion', 'ubicacion', 'address'],
  rubro: ['rubro', 'rubros', 'categoria', 'category', 'tipo'],
  shortNote: ['nota', 'notas', 'observaciones', 'comentario', 'detalle'],
}

/** Índice de cada columna conocida en el encabezado, o `null` si no está. */
export function detectCsvColumns(header: ReadonlyArray<string>): Record<CsvColumn, number | null> {
  const norm = header.map((h) => normalizeForMatch(h))
  const out = {} as Record<CsvColumn, number | null>
  for (const col of CSV_COLUMNS) {
    const aliases = HEADER_ALIASES[col]
    const exact = norm.findIndex((h) => aliases.includes(h))
    const partial = exact >= 0 ? exact : norm.findIndex((h) => aliases.some((a) => h.startsWith(a)))
    out[col] = partial >= 0 ? partial : null
  }
  return out
}

/**
 * Un rubro del CSV contra los del marketplace, por nombre o slug normalizado.
 * Sin match devuelve `null` y la vista previa lo dice: no se inventa uno.
 */
export function matchCategory(
  raw: string,
  categories: ReadonlyArray<ProspectCategoryOption>,
): string | null {
  const needle = normalizeForMatch(raw)
  if (needle === '') return null
  const hit =
    categories.find((c) => normalizeForMatch(c.name) === needle || c.slug === needle) ??
    categories.find((c) => normalizeForMatch(c.name).startsWith(needle))
  return hit?.slug ?? null
}
