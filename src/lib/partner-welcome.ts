import { publicProfile } from '~/lib/partners'

/**
 * El mensaje de bienvenida que el equipo le manda a mano a un proveedor cuya
 * solicitud se aprobó (tarjeta de Trello del 06/11/26). El panel sólo lo
 * COMPLETA: el envío sigue siendo manual (copiar y pegar en WhatsApp).
 *
 * El texto es el oficial, pasado por el equipo el 06/11/26, TAL CUAL: lo único
 * que se cambió es su `[LINK]` por la variable `{link_perfil}`. Para cambiarlo
 * se edita `PARTNER_WELCOME_TEMPLATE` y nada más.
 *
 * Variables (llaves simples, como en la tarjeta). Una variable que el texto no
 * usa no se exige ni se avisa:
 * - `{nombre_taller}`: el nombre del partner si ya está aprobado, si no el de
 *   la solicitud. El texto oficial no la usa hoy.
 * - `{link_perfil}`: el perfil público, el MISMO que usa la ficha
 *   (`publicProfile()` de `~/lib/partners`). Es `/proveedores/<slug>`, NO
 *   `/p/<slug>`: `/p/` da 404 (verificado el 03/11/26). Obligatoria: el mensaje
 *   existe para mandar el link.
 *
 * El slug lo crea el trigger `partner_profile_slug_on_insert` (backend, 0107)
 * AL INSERTARSE el partner, o sea al aprobar la solicitud. Antes de aprobar no
 * hay slug ni link; y la web publica sólo los `active`, así que un pausado o
 * archivado tampoco tiene link. **Nunca se deja una variable vacía ni la llave
 * literal**: lo que falta sale como aviso entre corchetes y el copiado queda
 * deshabilitado.
 */
export const PARTNER_WELCOME_TEMPLATE = `¡Hola! Bienvenido a AutoLibre 🙌

Ya estás en nuestra red de proveedores. AutoLibre conecta dueños de autos con proveedores de confianza de su zona, y desde hoy te pueden encontrar.

Este es tu perfil en nuestra web:
👉 {link_perfil}

Usalo como tu propia página: compartilo con tus clientes, sumalo a tu bio de Instagram y a tu ficha de Google Maps.

Cualquier duda, escribime por acá. ¡Gracias por sumarte!`

/** `true` mientras `PARTNER_WELCOME_TEMPLATE` sea un borrador y no el texto oficial. */
export const PARTNER_WELCOME_IS_DRAFT = false

export type WelcomeVariable = 'nombre_taller' | 'link_perfil'

const uses = (v: WelcomeVariable) => PARTNER_WELCOME_TEMPLATE.includes(`{${v}}`)

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
  if (uses('nombre_taller') && !name) {
    missing.push({ variable: 'nombre_taller', reason: 'la solicitud no tiene nombre' })
  }

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

// Guardrail en tiempo de módulo: si alguien cambia el texto y se come el link,
// que rompa al cargar y no en el primer mensaje que sale sin él.
if (!uses('link_perfil')) throw new Error('PARTNER_WELCOME_TEMPLATE no tiene {link_perfil}')
