import { publicProfile } from '~/lib/partners'

/**
 * El mensaje de bienvenida que el equipo le manda a mano a un proveedor cuya
 * solicitud se aprobó (tarjeta de Trello del 06/11/26). El panel sólo lo
 * COMPLETA: el envío sigue siendo manual (copiar y pegar en WhatsApp).
 *
 * ⚠ El texto de abajo es un BORRADOR. El pedido decía "el template de
 * bienvenida que ya existe", y al 06/11/26 no aparece en ningún lado que este
 * repo pueda leer: ni en `src/`, ni en `docs/`, ni en las plantillas de
 * `ops.quote_message_template_version`, ni en el backend (`main`). Se dejó un
 * texto mínimo marcado como ejemplo en la pantalla; el real se pega ACÁ, en
 * `PARTNER_WELCOME_TEMPLATE`, con las dos variables tal cual, y se pasa
 * `PARTNER_WELCOME_IS_DRAFT` a `false`. No hace falta tocar nada más.
 *
 * Variables (llaves simples, como en la tarjeta):
 * - `{nombre_taller}`: el nombre del partner si ya está aprobado, si no el de
 *   la solicitud.
 * - `{link_perfil}`: el perfil público, el MISMO que usa la ficha
 *   (`publicProfile()` de `~/lib/partners`). Es `/proveedores/<slug>`, NO
 *   `/p/<slug>`: `/p/` da 404 (verificado el 03/11/26).
 *
 * El slug lo crea el trigger `partner_profile_slug_on_insert` (backend, 0107)
 * AL INSERTARSE el partner, o sea al aprobar la solicitud. Antes de aprobar no
 * hay slug ni link; y la web publica sólo los `active`, así que un pausado o
 * archivado tampoco tiene link. **Nunca se deja una variable vacía ni la llave
 * literal**: lo que falta sale como aviso entre corchetes y el copiado queda
 * deshabilitado.
 */
export const PARTNER_WELCOME_TEMPLATE =
  'Hola {nombre_taller}! Te damos la bienvenida a AutoLibre. Ya está publicado tu perfil: {link_perfil}'

/** `true` mientras `PARTNER_WELCOME_TEMPLATE` sea el borrador del panel y no el texto oficial. */
export const PARTNER_WELCOME_IS_DRAFT = true

export type WelcomeVariable = 'nombre_taller' | 'link_perfil'

export interface WelcomeMessage {
  text: string
  /** Lo que no se pudo completar, con el motivo. Vacío = listo para copiar. */
  missing: Array<{ variable: WelcomeVariable; reason: string }>
}

export function renderPartnerWelcome(input: {
  businessName: string
  partner: { name: string; status: string; publicSlug: string | null } | null
}): WelcomeMessage {
  const missing: WelcomeMessage['missing'] = []

  const name = (input.partner?.name || input.businessName).trim()
  if (!name) missing.push({ variable: 'nombre_taller', reason: 'la solicitud no tiene nombre' })

  let link: string | null = null
  if (!input.partner) {
    missing.push({
      variable: 'link_perfil',
      reason: 'todavía no está aprobada: el perfil público (y su dirección) se crea al aprobar',
    })
  } else {
    const profile = publicProfile(input.partner.status, input.partner.publicSlug)
    if (profile.url === null) missing.push({ variable: 'link_perfil', reason: profile.reason })
    else link = profile.url
  }

  const values: Record<WelcomeVariable, string> = {
    nombre_taller: name || '[falta el nombre del taller]',
    link_perfil: link ?? '[falta el link del perfil]',
  }
  const text = PARTNER_WELCOME_TEMPLATE.replace(/\{(nombre_taller|link_perfil)\}/g, (_, key: WelcomeVariable) => values[key])
  return { text, missing }
}

// Guardrail en tiempo de módulo: si alguien pega el texto oficial y se come una
// variable, que rompa al cargar y no en el primer mensaje que sale incompleto.
for (const v of ['nombre_taller', 'link_perfil'] as const) {
  if (!PARTNER_WELCOME_TEMPLATE.includes(`{${v}}`)) {
    throw new Error(`PARTNER_WELCOME_TEMPLATE no tiene {${v}}`)
  }
}
