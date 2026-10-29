/**
 * ⚠ MOCK — vincular un pedido a una cuenta de AutoLibre no se guarda.
 *
 * Reemplaza a: `POST /admin/quote-requests/:id/link-user` (auditado, con el
 * actor de la sesión). Tarjeta "Admin: asignar a un usuario activo de la app
 * los pedidos creados manualmente (los que entran por WhatsApp)".
 *
 * La BÚSQUEDA de usuarios es real (`searchNotificationRecipients`, por email y
 * nombre); sólo el vínculo es de ejemplo. Vive en memoria y se pierde al
 * recargar: el pedido sigue sin cuenta en la base.
 */
export interface QuoteUserLink {
  userId: string
  email: string
  name: string | null
  linkedAt: string
}

const links = new Map<string, QuoteUserLink>()

export async function fetchQuoteUserLinkMock(quoteRequestId: string): Promise<QuoteUserLink | null> {
  return links.get(quoteRequestId) ?? null
}

export async function linkQuoteUserMock(
  quoteRequestId: string,
  user: Omit<QuoteUserLink, 'linkedAt'>,
): Promise<QuoteUserLink> {
  const link = { ...user, linkedAt: new Date().toISOString() }
  links.set(quoteRequestId, link)
  return link
}

export async function unlinkQuoteUserMock(quoteRequestId: string): Promise<void> {
  links.delete(quoteRequestId)
}
