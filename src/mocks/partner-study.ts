/**
 * ⚠ MOCK — lo del estudio de proveedores que no tiene de dónde leerse.
 *
 * Reemplaza a: el registro de matcheo (`quote_request_partner_matches`), la
 * confirmación/disputa del cierre, los motivos de "no contraté" y los eventos
 * de vista de perfil y clic, todo dentro de
 * `GET /admin/partner-performance`. Tarjeta "Panel admin: estudio de
 * proveedores…".
 *
 * Números de un hash del id (estables). `matched` nunca es menor que lo enviado
 * de verdad, para que la tasa de respuesta no pase de 100 %.
 */
export interface PartnerStudyExtras {
  matched: number
  expiredUnanswered: number
  confirmed: number
  disputed: number
  notHiredReasons: Record<string, number>
  profileViews: number
  contactClicks: number
}

export function partnerStudyExtrasMock(partnerId: string, sentInPeriod: number): PartnerStudyExtras {
  let h = 0
  for (let i = 0; i < partnerId.length; i++) h = (h * 31 + partnerId.charCodeAt(i)) >>> 0
  const r = (k: number, mod: number) => (h >>> k) % mod
  const matched = sentInPeriod + r(1, 6)
  return {
    matched,
    expiredUnanswered: Math.min(matched - sentInPeriod, r(3, 3)),
    confirmed: Math.min(sentInPeriod, r(5, 3)),
    disputed: r(7, 5) === 0 ? 1 : 0,
    notHiredReasons: { 'Muy caro': r(9, 3), 'Lo resolvió por su cuenta': r(11, 2) },
    profileViews: r(13, 60),
    contactClicks: r(15, 12),
  }
}
