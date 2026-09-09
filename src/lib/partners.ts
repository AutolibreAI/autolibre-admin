import { z } from 'zod'

/**
 * Marketplace — contrato de la cola de solicitudes.
 *
 * Vocabulario (regla del backend, no negociable):
 *  - `PartnerApplication` = el taller viniendo HACIA nosotros (se anota desde
 *    la landing).
 *  - `Lead` = el usuario yendo HACIA el taller (pide contacto).
 *  - `Partner` = el taller ya publicado. Nunca "Provider": ese sufijo está
 *    reservado para integraciones externas.
 */

/**
 * Espeja el enum `partner_application_status` de Postgres.
 *
 * El orden es el del embudo, y se usa para renderizarlo — no lo reordenes por
 * gusto alfabético.
 */
export const APPLICATION_STATUSES = [
  'not_contacted',
  'contacted',
  'in_conversation',
  'verbal_agreement',
  'discarded',
] as const

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

/**
 * Los estados que una persona PUEDE poner a mano desde el panel.
 *
 * `verbal_agreement` está deliberadamente afuera y no es un olvido:
 * `approve_partner_application()` lleva `AND status <> 'verbal_agreement'` como
 * lock optimista. Una solicitud marcada a mano con ese valor queda TRABADA —
 * la función la rechaza para siempre con "inexistente o ya aprobada", y encima
 * sin partner. Ya pasó una vez.
 *
 * El único camino legítimo a `verbal_agreement` es aprobar.
 */
export const MANUAL_STATUSES = [
  'not_contacted',
  'contacted',
  'in_conversation',
  'discarded',
] as const satisfies ReadonlyArray<ApplicationStatus>

export type ManualStatus = (typeof MANUAL_STATUSES)[number]

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  not_contacted: 'Sin contactar',
  contacted: 'Contactado',
  in_conversation: 'En conversación',
  verbal_agreement: 'Acuerdo verbal',
  discarded: 'Descartado',
}

/**
 * Qué pasaría si se aprobara esta solicitud, resuelto ANTES de aprobar.
 *
 * Existe porque el flujo tiene un modo de falla silencioso: si lo declarado no
 * resuelve a ningún rubro activo, la carga automática no inserta NADA — el
 * partner queda activo, listado sin filtro, e invisible bajo todo chip de la
 * app.
 *
 * Lo declarado puede ser un RUBRO (lo que manda el formulario hoy) o una
 * FAMILIA (lo que mandó durante un tramo, y sigue escrito en filas reales). Las
 * dos resuelven; ver `expandDeclaredSlugs` en `partners.repo.ts`.
 *
 * El runbook de DBeaver detecta eso DESPUÉS (consulta 6, con el partner ya
 * creado). Acá se detecta antes, que es la razón de ser de esta pantalla.
 */
export interface ResolvedServices {
  /**
   * Las familias que se van a cargar, con CUÁNTOS de sus rubros.
   *
   * Ojo: `serviceCount` es cuántos rubros de esa familia entran, no cuántos
   * tiene. Declarar la familia `motor` da los 10; declarar dos de sus rubros da
   * 2. Antes las dos cosas coincidían siempre y el nombre no mentía.
   */
  matchedFamilies: Array<{ slug: string; name: string; serviceCount: number }>
  /**
   * Slugs declarados que no resuelven a ningún rubro activo: labels del
   * formulario viejo ("Chapa y pintura"), o rubros y familias dados de baja
   * después de ser declarados.
   */
  unknownSlugs: Array<string>
  /** Total de rubros que la carga automática insertaría. */
  totalServices: number
}

export interface ApplicationListItem {
  id: string
  businessName: string
  email: string
  whatsapp: string
  address: string
  status: ApplicationStatus
  nextStep: string | null
  followUpDate: string | null
  declaredServices: Array<string>
  howFound: string | null
  createdAt: string
  /** De la vista `v_partner_application_queue`. */
  alreadyPublished: boolean
  resolved: ResolvedServices
}

export interface ApplicationDetail extends ApplicationListItem {
  brandSpecialized: boolean
  declaredBrands: Array<string>
  declaredFuelTypes: Array<string>
  vehicleTypes: Array<string>
  serviceOther: string | null
  howFoundOther: string | null
  contactChannel: string | null
  firstContactedAt: string | null
  agreementType: string | null
  agreementDetail: string | null
  internalNotes: string | null
  reviewNote: string | null
  reviewedAt: string | null
  /** Si ya se publicó, el partner resultante. */
  partner: { id: string; name: string; coverageZone: string; serviceCount: number } | null
}

/**
 * Los tres chequeos de salud del runbook, como indicador permanente.
 *
 * El del medio es el que importa: un panel existe para que ese modo de falla
 * sea imposible de olvidar, no para que alguien se acuerde de correr una query.
 */
export interface PipelineHealth {
  /** Consulta 5: `verbal_agreement` sin partner. La invariante está rota. */
  stuckApplications: number
  /** Consulta 6: partners activos sin un solo rubro. Invisibles en la app. */
  invisiblePartners: number
  /** Solicitudes pendientes que hoy producirían un partner invisible. */
  wouldBeInvisible: number
}

// ── Search params ────────────────────────────────────────────────────────────

export const applicationSearchSchema = z.object({
  /**
   * Filtro por estado del embudo.
   *
   * Sin este param ("Todos") la cola excluye `discarded` — mismo criterio que
   * `published`: es una cola de trabajo pendiente, y una descartada no es
   * trabajo pendiente. La forma de verlas es elegir el chip `Descartado`
   * explícitamente, que sigue funcionando como filtro exacto — no hizo falta
   * agregar un control nuevo, el que ya existía alcanza como "desfiltrar".
   */
  status: z.enum(APPLICATION_STATUSES).optional(),

  /**
   * Ocultar las ya publicadas. Por default se ocultan: la cola es de trabajo
   * pendiente, igual que `WHERE NOT already_published` en la consulta 1.
   */
  published: z.enum(['hide', 'show']).catch('hide').default('hide'),

  q: z.string().trim().max(80).optional(),
})

export type ApplicationSearch = z.infer<typeof applicationSearchSchema>

/**
 * Zona de cobertura: texto libre, y es lo que el usuario ve en la ficha.
 * Escribila como la leería una persona ("CABA y GBA Norte"), no como un código.
 */
export const approveSchema = z.object({
  applicationId: z.uuid(),
  coverageZone: z.string().trim().min(3).max(120),
})

export const updateStatusSchema = z.object({
  applicationId: z.uuid(),
  status: z.enum(MANUAL_STATUSES),
})

/**
 * Editar la solicitud entera — migración 010, vía `ops.update_partner_application`.
 *
 * El formulario del panel manda SIEMPRE el juego completo (misma filosofía que
 * `setPartnerContactSchema` en `catalog.ts`): lo que el operador ve es lo que
 * queda guardado. Por eso los nullables van con `.default('')` en vez de
 * `.optional()` — un `''` es "borrá este campo", explícito.
 *
 * `business_name`/`email`/`whatsapp`/`address` son NOT NULL en la base: acá se
 * validan `.min(1)` para dar el error al lado del input, y el SP los vuelve a
 * rechazar (`*_REQUIRED`) para cualquier otro llamador.
 *
 * `status` NO está: tiene su propio editor y el lock de `verbal_agreement`.
 * `followUpDate` viaja como string; el SP la parsea y traduce el error de
 * formato a `INVALID_FOLLOW_UP_DATE`.
 */
const freeLabelArray = z.array(z.string().trim().min(1).max(120)).max(80)

export const editApplicationSchema = z.object({
  applicationId: z.uuid(),
  businessName: z.string().trim().min(1, 'El nombre del taller no puede quedar vacío.').max(200),
  email: z.string().trim().min(1, 'El email no puede quedar vacío.').max(200),
  whatsapp: z.string().trim().min(1, 'El WhatsApp no puede quedar vacío.').max(60),
  address: z.string().trim().min(1, 'La dirección no puede quedar vacía.').max(300),
  brandSpecialized: z.boolean(),
  contactChannel: z.string().trim().max(120).default(''),
  howFound: z.string().trim().max(200).default(''),
  howFoundOther: z.string().trim().max(200).default(''),
  serviceOther: z.string().trim().max(500).default(''),
  nextStep: z.string().trim().max(500).default(''),
  agreementType: z.string().trim().max(120).default(''),
  agreementDetail: z.string().trim().max(1000).default(''),
  internalNotes: z.string().trim().max(2000).default(''),
  reviewNote: z.string().trim().max(2000).default(''),
  followUpDate: z.string().trim().max(10).default(''),
  declaredServices: freeLabelArray,
  declaredBrands: freeLabelArray,
  declaredFuelTypes: freeLabelArray,
  vehicleTypes: freeLabelArray,
})

export type EditApplicationInput = z.infer<typeof editApplicationSchema>

/**
 * `EditApplicationInput` (camelCase) → las claves snake_case que espera el
 * `p_patch` de `ops.update_partner_application`. Explícito y no un
 * `Object.entries` con regex: una clave mal traducida es un campo que no se
 * guarda, en silencio.
 */
export const APPLICATION_PATCH_KEYS: Record<
  Exclude<keyof EditApplicationInput, 'applicationId'>,
  string
> = {
  businessName: 'business_name',
  email: 'email',
  whatsapp: 'whatsapp',
  address: 'address',
  brandSpecialized: 'brand_specialized',
  contactChannel: 'contact_channel',
  howFound: 'how_found',
  howFoundOther: 'how_found_other',
  serviceOther: 'service_other',
  nextStep: 'next_step',
  agreementType: 'agreement_type',
  agreementDetail: 'agreement_detail',
  internalNotes: 'internal_notes',
  reviewNote: 'review_note',
  followUpDate: 'follow_up_date',
  declaredServices: 'declared_services',
  declaredBrands: 'declared_brands',
  declaredFuelTypes: 'declared_fuel_types',
  vehicleTypes: 'vehicle_types',
}
