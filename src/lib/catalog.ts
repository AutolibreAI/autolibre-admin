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
    tier: string
    coverageZone: string
    /** La solicitud de origen, si vino por ahí (`source = 'application'`). */
    applicationId: string | null
    /** Lo que declaró en el formulario. Vacío para los de planilla o manuales. */
    declaredServices: Array<string>
    /**
     * La ficha editable.
     *
     * Viven acá y no en `PartnerListItem` porque son de la pantalla de detalle:
     * traerlas en el listado sería cargar seis columnas de texto por fila para
     * mostrar ninguna.
     */
    whatsapp: string | null
    email: string | null
    redirectLink: string | null
    hours: string | null
    address: string | null
    latitude: number | null
    longitude: number | null
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

// ── Acciones sobre la ficha (migración 007) ──────────────────────────────────
//
// Estas tres son el borde de entrada de `ops.set_partner_status`,
// `ops.set_partner_location` y `ops.set_partner_contact`.
//
// El `p_actor_id` de esas funciones NO está en ningún schema de acá a propósito:
// sale de la sesión de Clerk en el server function. Aceptarlo por payload
// dejaría que quien llama firme la auditoría con la identidad de otro — el
// mismo motivo por el que `approveSchema` tampoco lleva reviewer.

export const PARTNER_STATUSES = ['active', 'paused', 'archived'] as const
export type PartnerStatus = (typeof PARTNER_STATUSES)[number]

export const PARTNER_STATUS_LABELS: Record<PartnerStatus, string> = {
  active: 'Publicado',
  paused: 'Pausado',
  archived: 'Archivado',
}

export const setPartnerStatusSchema = z.object({
  partnerId: z.uuid(),
  status: z.enum(PARTNER_STATUSES),
  note: z.string().trim().max(280).optional(),
})

/**
 * Las dos coordenadas viajan juntas o ninguna.
 *
 * El `refine` duplica a propósito la validación que ya hace
 * `ops.set_partner_location`. No es redundancia inútil: acá el error llega como
 * un issue de zod con el path del campo, que el formulario puede mostrar al
 * lado del input; desde el SP llega como una excepción de Postgres después de
 * un round trip. La del SP es la que no se puede saltear — es la que protege a
 * cualquier otro llamador.
 */
export const setPartnerLocationSchema = z
  .object({
    partnerId: z.uuid(),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
  })
  .refine((d) => (d.latitude === null) === (d.longitude === null), {
    message: 'Cargá las dos coordenadas, o dejá las dos vacías para borrarlas.',
    path: ['longitude'],
  })

/**
 * La ficha de contacto entera, siempre completa.
 *
 * El SP distingue `NULL` ("no toques este campo") de `''` ("borralo"). El
 * formulario manda SIEMPRE los cinco como string, así que nunca usa el primer
 * modo: lo que el operador ve en pantalla es exactamente lo que queda guardado.
 * Un form que manda parches parciales es más eficiente y es imposible de leer
 * cuando algo sale mal.
 */
export const setPartnerContactSchema = z.object({
  partnerId: z.uuid(),
  whatsapp: z.string().trim().max(60).default(''),
  email: z.string().trim().max(160).default(''),
  redirectLink: z.string().trim().max(500).default(''),
  hours: z.string().trim().max(200).default(''),
  address: z.string().trim().max(300).default(''),
})
