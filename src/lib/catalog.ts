import { z } from 'zod'

/**
 * Catálogo de servicios — las dos alturas de la taxonomía.
 *
 * RUBRO (`services`, 79) es lo que el formulario de alta declara hoy, lo que
 * `partner_services` guarda y por lo que filtra la app.
 * FAMILIA (`service_categories`, 16) agrupa rubros en pantalla — y fue lo que
 * el formulario declaró durante un tramo, así que sigue apareciendo en
 * `declared_services` de solicitudes reales.
 *
 * No son intercambiables, y confundirlas es de dónde sale el modo de falla
 * silencioso de todo el flujo de partners. Lo que SÍ hace el admin es aceptar
 * las dos al LEER lo ya escrito, que es otra cosa: ver `expandDeclaredSlugs`.
 */

export interface ServiceItem {
  id: string
  slug: string
  name: string
}

export interface ServiceFamily {
  slug: string
  name: string
  services: Array<ServiceItem>
}

export interface PartnerListItem {
  id: string
  name: string
  status: string
  coverageZone: string
  serviceCount: number
  /** Sin un solo rubro: se lista sin filtro pero no sale bajo ningún chip. */
  invisible: boolean
}

export interface PartnerServicesView {
  partner: {
    id: string
    name: string
    status: string
    coverageZone: string
    /** La solicitud de origen, si vino por ahí (`source = 'application'`). */
    applicationId: string | null
    /** Lo que declaró en el formulario. Vacío para los de planilla o manuales. */
    declaredServices: Array<string>
  }
  /** El catálogo completo, para poder agregar cualquier rubro. */
  families: Array<ServiceFamily>
  /** Ids de `services` que este partner tiene hoy. */
  assignedServiceIds: Array<string>
  /**
   * Para cada slug declarado que no resolvió a ningún rubro, los que se le
   * parecen.
   *
   * Nace de un caso real: "Batata Taller" declaró `"Chapa y pintura"` —un label
   * del formulario viejo— que no resuelve a nada, pero `chapa-y-pintura` SÍ
   * existe como rubro. El runbook te deja buscándolo a mano en la consulta 8;
   * acá se ofrece resuelto.
   */
  suggestions: Array<{ declaredSlug: string; matches: Array<ServiceItem> }>
}

/**
 * Normaliza para comparar un texto declarado contra un slug del catálogo.
 *
 * Se hace en JS y no en SQL a propósito: la versión en Postgres necesitaría la
 * extensión `unaccent`, que agrega una dependencia de infraestructura para algo
 * que acá es una comparación de strings sobre 79 filas que ya están en memoria.
 */
export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // marcas diacríticas combinantes
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// ── Search params ────────────────────────────────────────────────────────────

export const partnerSearchSchema = z.object({
  q: z.string().trim().max(80).optional(),
  /** Solo los que quedaron sin rubros — el chequeo de la consulta 6. */
  onlyInvisible: z.coerce.boolean().catch(false).default(false),
})

export type PartnerSearch = z.infer<typeof partnerSearchSchema>

export const editServicesSchema = z.object({
  partnerId: z.uuid(),
  /** Ids de `services` a agregar. */
  add: z.array(z.uuid()).max(200).default([]),
  /** Ids de `services` a sacar. */
  remove: z.array(z.uuid()).max(200).default([]),
})
