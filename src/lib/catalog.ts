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
  /** Cuántos `services` tiene cargados en `partner_services` ("Servicios" en la UI). */
  serviceCount: number
  /** Cuántas `service_categories` distintas cubren esos servicios ("Rubros" en la UI). */
  categoryCount: number
  /** Los rubros (categorías) que cubre, en orden de catálogo. */
  categories: Array<{ slug: string; name: string }>
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
    /** El texto de la tarjeta del marketplace. Ver `DESCRIPTION_IDEAL_LENGTH`. */
    description: string | null
    /**
     * Cuántos OTROS partners se llaman igual que éste.
     *
     * Existe porque `partners.name` no tiene índice único y el stored procedure
     * deliberadamente no valida unicidad —eso es regla de negocio, y el SP
     * valida representabilidad—. Este número es lo que permite que la ficha
     * AVISE en vez de impedir, igual que el aviso de "sin forma de contacto".
     *
     * Se calcula al leer, así que refleja el nombre GUARDADO y no el que se
     * está tipeando: el aviso aparece después de guardar, que es cuando el
     * problema pasó a ser real.
     */
    nameCollisions: number
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
    /**
     * Todos los links del partner, de cualquier kind.
     *
     * Vienen COMPLETOS y sin filtrar por lo que la UI sepa mostrar: el guardado
     * deja la tabla igual al formulario, así que un kind que no llegue hasta acá
     * se borraría en el próximo guardado sin que nadie lo note.
     */
    links: Array<PartnerLink>
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

/**
 * Vocabulario de la UI de Partners: "Rubro" = `service_categories` (16),
 * "Servicio" = `services` (79). Ver `~/lib/partners-coverage`.
 */
export const PARTNER_LIST_SORT_KEYS = [
  'services',
  'categories',
  'name',
  'zone',
  'status',
] as const
export type PartnerListSortKey = (typeof PARTNER_LIST_SORT_KEYS)[number]

export const PARTNER_STATUS_FILTERS = ['all', 'active', 'paused', 'archived'] as const
export type PartnerStatusFilter = (typeof PARTNER_STATUS_FILTERS)[number]

export const PARTNER_STATUS_FILTER_LABELS: Record<PartnerStatusFilter, string> = {
  all: 'Todos',
  active: 'Publicados',
  paused: 'Pausados',
  archived: 'Archivados',
}

export const partnerSearchSchema = z.object({
  q: z.string().trim().max(80).optional(),
  /** Solo los que quedaron sin rubros — el chequeo de la consulta 6. */
  onlyInvisible: z.coerce.boolean().catch(false).default(false),
  /**
   * Estado del partner. Se llama `partnerStatus` y NO `status` a propósito:
   * `/solicitudes` ya usa `status` con el enum `partner_application_status`, y
   * dos search params con la misma clave y enums disjuntos rompen el typecheck
   * de la ruta ajena (ver `.claude/rules/notifications.md`).
   */
  partnerStatus: z.enum(PARTNER_STATUS_FILTERS).catch('all').default('all'),
  /** Slug de `service_categories`: filtra a los que cubren ≥1 servicio de ese rubro. */
  category: z.string().trim().max(60).optional(),
  /** Slug de `services`: filtra a los que tienen ese servicio puntual. */
  service: z.string().trim().max(80).optional(),
  /**
   * Default `services` asc: los de menos servicios —los invisibles— van
   * primero. Reproduce el `ORDER BY count(ps.service_id), p.name` que la regla
   * de `partner-approval.md` puso a propósito para que el modo de falla no se
   * esconda en el medio de la lista. El operador puede re-ordenar.
   */
  sort: z.enum(PARTNER_LIST_SORT_KEYS).catch('services').default('services'),
  dir: z.enum(['asc', 'desc']).catch('asc').default('asc'),
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

// ── Acciones sobre la ficha (migración 008) ──────────────────────────────────
//
// Perfil y links. Mismo borde y mismas reglas que los tres de arriba: el
// `p_actor_id` no viaja en el payload, sale de la sesión.

/**
 * El badge de aliado ES `partner_tier`.
 *
 * El equipo lo llama "aliado" y la UI lo dice así, pero el código dice `tier` y
 * `founding` porque **el vocabulario es el del backend** (regla dura 7). Un
 * campo llamado `aliado` en el front sería intraducible el día que alguien lea
 * el schema y encuentre `partner_tier`.
 */
export const PARTNER_TIERS = ['founding', 'standard'] as const
export type PartnerTier = (typeof PARTNER_TIERS)[number]

export const PARTNER_TIER_LABELS: Record<PartnerTier, string> = {
  founding: 'Aliado',
  standard: 'Estándar',
}

/**
 * El largo IDEAL de la descripción para la tarjeta del marketplace.
 *
 * No es un límite: es una meta. Al 2026-09-04, **25 de los 34 partners con
 * descripción ya lo pasan** (promedio 114, máximo 248). Un formulario que
 * bloqueara acá haría imposible corregir un teléfono en tres cuartos del
 * directorio, y el stored procedure a propósito no lo valida.
 *
 * El contador avisa. No impide.
 */
export const DESCRIPTION_IDEAL_LENGTH = 90

/**
 * El techo duro, que sí es un límite y no una meta.
 *
 * 600 no sale de ningún requisito de diseño: es holgura sobre el máximo real
 * (248) para que nadie pegue un documento entero en el campo. La columna es
 * `text` sin restricción, así que sin esto el único techo sería el de Postgres.
 */
export const DESCRIPTION_MAX_LENGTH = 600

// ── Links ────────────────────────────────────────────────────────────────────

/**
 * El enum `partner_link_kind` del backend, espejado tal cual.
 *
 * ── FALTA `maps`, Y NO ES UN OLVIDO NUESTRO ─────────────────────────────────
 *
 * El enum vive en el schema del backend y este repo no lo migra. Pero el link
 * de Google Maps es de los que más se cargan: al 2026-09-04, **10 de los 11
 * links guardados como `other` son de `maps.app.goo.gl`**. O sea que `other` ya
 * venía funcionando como el cajón de maps, sin que nadie lo dijera.
 *
 * La ficha lo muestra como campo propio y lo guarda como `other`. Es una
 * heurística y está documentada como tal en
 * `.claude/rules/ops-write-actions.md`; el arreglo de verdad es un valor nuevo
 * en el enum del backend.
 *
 * `mercado_libre` se muestra AUNQUE nadie lo haya pedido, y ése es el punto: el
 * guardado deja la tabla igual al formulario, así que un kind que el formulario
 * no muestre se borraría al primer guardado. Hoy hay 1 link de `mercado_libre`
 * en producción que desaparecería sin que nadie lo note.
 */
export const PARTNER_LINK_KINDS = [
  'instagram',
  'facebook',
  'x',
  'tiktok',
  'website',
  'mercado_libre',
  'other',
] as const
export type PartnerLinkKind = (typeof PARTNER_LINK_KINDS)[number]

/** Los que tienen campo único, en el orden en que se muestran. */
export const SINGLE_LINK_KINDS = [
  'instagram',
  'facebook',
  'x',
  'tiktok',
  'website',
  'mercado_libre',
] as const satisfies ReadonlyArray<PartnerLinkKind>

export type SingleLinkKind = (typeof SINGLE_LINK_KINDS)[number]

export const PARTNER_LINK_LABELS: Record<PartnerLinkKind, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X',
  tiktok: 'TikTok',
  website: 'Sitio web',
  mercado_libre: 'Mercado Libre',
  other: 'Otro',
}

export interface PartnerLink {
  kind: PartnerLinkKind
  url: string
}

/**
 * ¿Este link es de Google Maps?
 *
 * La heurística que hace posible mostrar "Maps" como campo propio sin que el
 * enum del backend lo tenga. Se mide contra la realidad: hoy acierta en 10 de
 * los 11 `other` de producción.
 *
 * El que NO matchea es `https://share.google/hNP1lXzbykdC3muYU`, un acortador
 * genérico de Google que **puede apuntar a cualquier cosa**. Se lo deja fuera a
 * propósito: clasificarlo como maps por venir de un dominio de Google sería
 * adivinar, y el costo de adivinar mal es mover el link de alguien a un campo
 * donde no lo va a buscar.
 *
 * Ante la duda, un link cae en "otros". Ese cajón es visible y editable; un
 * campo equivocado es invisible.
 */
export function isMapsUrl(url: string): boolean {
  let host: string
  let path: string
  try {
    const parsed = new URL(url.trim())
    host = parsed.hostname.toLowerCase()
    path = parsed.pathname.toLowerCase()
  } catch {
    // Un string que no parsea no es una URL de maps ni de nada. Cae en "otros",
    // donde el operador lo ve y lo puede arreglar.
    return false
  }

  if (host === 'maps.app.goo.gl') return true
  if (host === 'goo.gl' && path.startsWith('/maps')) return true
  if (host.startsWith('maps.google.')) return true
  if (/^(www\.)?google\.[a-z.]+$/.test(host) && path.startsWith('/maps')) return true
  return false
}

// ── Schemas ──────────────────────────────────────────────────────────────────

/**
 * Perfil: zona de cobertura, descripción y tier, juntos.
 *
 * Van juntos porque son una sola cosa —cómo se PRESENTA el partner en la
 * tarjeta del marketplace— y se editan en la misma sentada. Separarlos daría
 * tres entradas de `ops.action_log` para un solo acto de edición.
 *
 * `coverageZone` tiene `.min(1)` porque `partners.coverage_zone` es NOT NULL en
 * el schema del backend: vaciarlo no es "borrar el dato", es un valor que la
 * columna no puede representar. La validación está DUPLICADA en el SP a
 * propósito — la de zod llega como issue con el path del campo y el formulario
 * la muestra al lado del input; la del SP es la que no se puede saltear.
 */
export const setPartnerProfileSchema = z.object({
  partnerId: z.uuid(),
  /**
   * `partners.name` es NOT NULL, igual que `coverageZone`: vaciarlo no borra el
   * dato, es un valor que la columna no puede representar.
   *
   * El techo de 120 es holgura sobre el máximo real (30 al 2026-09-04), no un
   * requisito de diseño: la columna es `text` sin restricción, así que sin esto
   * el único límite sería el de Postgres.
   *
   * **No se valida unicidad.** `partners.name` no tiene índice único, así que
   * dos partners con el mismo nombre son REPRESENTABLES, y el SP a propósito no
   * decide eso. La ficha avisa después de guardar.
   */
  name: z.string().trim().min(1, 'El nombre no puede quedar vacío.').max(120),
  coverageZone: z
    .string()
    .trim()
    .min(1, 'La zona de cobertura no puede quedar vacía.')
    .max(200),
  // '' BORRA la descripción; la columna sí es nullable. Mismo contrato que
  // `setPartnerContactSchema`.
  description: z.string().trim().max(DESCRIPTION_MAX_LENGTH).default(''),
  tier: z.enum(PARTNER_TIERS),
})

/**
 * Links: el juego completo, siempre.
 *
 * **Lo que se manda REEMPLAZA lo que hay.** Un kind ausente se borra, y por eso
 * el formulario tiene que renderizar los siete — incluido `mercado_libre`, que
 * nadie pidió y que hoy tiene un link en producción.
 *
 * Las URLs vacías se filtran del lado del SP, no acá: el formulario manda los
 * campos que el operador dejó en blanco, y obligarlo a no mandarlos sería
 * mover el problema a quien llama.
 */
export const setPartnerLinksSchema = z.object({
  partnerId: z.uuid(),
  links: z
    .array(
      z.object({
        kind: z.enum(PARTNER_LINK_KINDS),
        /**
         * Se valida que PAREZCA una URL, no que exista.
         *
         * `z.url()` rechazaría `instagram.com/taller` sin protocolo, que es
         * exactamente lo que alguien pega desde la barra del navegador. Se
         * acepta y el formulario le antepone `https://` al guardar: rebotarle
         * un link correcto por un detalle de tipeo es peor que normalizarlo.
         */
        url: z.string().trim().max(500).default(''),
      }),
    )
    .max(50),
})
