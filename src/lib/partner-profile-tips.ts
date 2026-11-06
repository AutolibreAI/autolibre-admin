/**
 * «Cómo mejorar tu perfil»: el bloque del Reporte de Partners › Estudio.
 *
 * Reglas FIJAS, sin IA: el mismo perfil da siempre el mismo texto. Usa sólo
 * lo que el panel ya lee de `partners` (+ el logo de la solicitud, que es en
 * lo que cae el perfil público sin `partners.logo_url`). Vale la misma regla
 * del reporte: no nombra clientes ni a otros proveedores.
 *
 * "Fotos" es el LOGO: al 2026-11-06 el perfil no tiene galería (no hay tabla
 * de fotos del partner en el backend), así que no se le pide al taller algo
 * que no puede cargar.
 *
 * El orden es por impacto: sin servicios no aparece en ninguna búsqueda; sin
 * ubicación no entra al orden por cercanía ni al despacho de pedidos; el resto
 * es cómo se ve la ficha.
 */

/** Sólo banderas y conteos: ningún dato del perfil viaja al navegador. */
export interface PartnerProfileFacts {
  partnerId: string
  hasLogo: boolean
  hasDescription: boolean
  /** `description` corta: menos de `SHORT_DESCRIPTION` caracteres. */
  shortDescription: boolean
  hasHours: boolean
  hasAddress: boolean
  hasLocation: boolean
  hasWhatsapp: boolean
  serviceCount: number
  linkCount: number
}

export const SHORT_DESCRIPTION = 40
/** Con menos servicios que esto, se sugiere completar los que hace. */
export const FEW_SERVICES = 3

export function profileTips(f: PartnerProfileFacts): Array<string> {
  const tips: Array<string> = []
  if (f.serviceCount === 0) {
    tips.push('Cargá los servicios que hacés: sin servicios no aparecés en ninguna búsqueda de la app.')
  } else if (f.serviceCount < FEW_SERVICES) {
    tips.push('Sumá todos los servicios que hacés: cada uno es una búsqueda más en la que podés aparecer.')
  }
  if (!f.hasLocation) {
    tips.push('Confirmanos la ubicación exacta del local, así te mostramos a quien está cerca.')
  }
  if (!f.hasLogo) tips.push('Mandanos tu logo o una foto del local: un perfil con imagen se elige más.')
  if (!f.hasDescription) {
    tips.push('Contanos en una o dos líneas qué hacés y en qué te especializás.')
  } else if (f.shortDescription) {
    tips.push('Ampliá un poco la descripción: qué hacés y en qué te especializás.')
  }
  if (!f.hasHours) tips.push('Pasanos tus horarios de atención.')
  if (!f.hasAddress) tips.push('Pasanos la dirección del local.')
  if (!f.hasWhatsapp) tips.push('Pasanos un WhatsApp de contacto para que te escriban directo.')
  if (f.linkCount === 0) tips.push('Si tenés Instagram, web o Google Maps, pasanos el link y lo sumamos.')
  return tips
}

/** El bloque tal cual va al final del reporte. Sin datos del perfil, no se agrega nada. */
export function profileTipsBlock(f: PartnerProfileFacts | null): string {
  if (!f) return ''
  const tips = profileTips(f)
  if (tips.length === 0) return 'Cómo mejorar tu perfil: está completo. ¡Bien ahí!'
  return ['Cómo mejorar tu perfil:', ...tips.map((t) => `• ${t}`)].join('\n')
}
