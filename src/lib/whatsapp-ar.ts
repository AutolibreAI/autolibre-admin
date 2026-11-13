/**
 * Normaliza un teléfono argentino a la forma que exige `wa.me`: `549` + código
 * de área (sin 0) + número (sin 15), sólo dígitos — 13 en total.
 *
 * Es para ARMAR el mensaje de presupuestos (`~/lib/quote-templates`): no se
 * persiste nada. No reemplaza a `canonicalWhatsAppDigits` (`~/lib/partners`,
 * que sólo acepta lo que YA está en forma canónica) ni a `normalizeArPhone`
 * (`~/lib/partner-prospects`, espejo de `ops.normalize_ar_phone`: si cambia,
 * cambia el índice de duplicados de la base).
 *
 * Nunca inventa un código de área: si no quedan exactamente 10 dígitos
 * nacionales, devuelve `ok: false` con el motivo. Un número mal completado le
 * escribe a otra persona.
 *
 * Archivo sin imports a propósito: lo corren los tests con `node --test`.
 */
export type WhatsAppARResult = { ok: true; digits: string } | { ok: false; reason: string }

export function toWhatsAppAR(phone: string): WhatsAppARResult {
  let d = (phone ?? '').replace(/\D/g, '')
  if (d === '') return { ok: false, reason: 'no tiene dígitos' }

  // Prefijo internacional de discado.
  if (d.startsWith('00')) d = d.slice(2)
  // Código de país y el 9 de móvil (se vuelve a poner al final). Ningún código
  // de área argentino empieza con 5 ni con 9, así que no hay ambigüedad.
  if (d.startsWith('54')) {
    d = d.slice(2)
    if (d.startsWith('9')) d = d.slice(1)
  }
  // El 0 de larga distancia nacional.
  if (d.startsWith('0')) d = d.slice(1)

  // 12 dígitos: casi seguro un "15" pegado después del código de área. Las
  // características tienen 2, 3 o 4 dígitos y código + número suman 10. La de
  // 2 dígitos es sólo 11 (ninguna de 3 o 4 empieza con 1), así que con 11
  // adelante el 15 va en la posición 2; si no, en la 3 o la 4 — y las dos no
  // pueden coincidir a la vez (pedirían que el 5º dígito sea 1 y 5).
  if (d.length === 12) {
    const positions = d.startsWith('11') ? [2] : [3, 4]
    const matches = positions.filter((p) => d.slice(p, p + 2) === '15')
    if (matches.length !== 1) {
      return { ok: false, reason: `tiene ${d.length} dígitos y no se sabe dónde está el 15` }
    }
    const p = matches[0]!
    d = d.slice(0, p) + d.slice(p + 2)
  }

  if (d.length !== 10) {
    return {
      ok: false,
      reason:
        d.length < 10
          ? `tiene ${d.length} dígitos: falta el código de área`
          : `tiene ${d.length} dígitos, sobran para un número argentino`,
    }
  }
  // Las características argentinas empiezan con 11, 2 o 3.
  if (!/^(11|2|3)/.test(d)) return { ok: false, reason: `el código de área no es argentino (${d.slice(0, 4)}…)` }

  return { ok: true, digits: `549${d}` }
}
