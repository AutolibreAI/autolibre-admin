/**
 * ⚠ MOCK — la elección "¿querés que te avisemos por WhatsApp?" al crear el
 * pedido todavía no existe ni en la app ni en la base.
 *
 * Reemplaza a: `quote_requests.notify_whatsapp` (boolean nullable) leído con el
 * resto del pedido. Tarjeta "Pedidos (app): al crear el pedido, preguntar si
 * quiere que le avisen por WhatsApp".
 *
 * Devuelve `null` ("sin dato") para TODOS los pedidos, que es la verdad hoy: no
 * se inventa un sí o un no sobre pedidos reales. Es sincrónico porque el dato
 * real va a llegar como un campo más de la fila, no como otra consulta.
 */
export function whatsappOptInMock(_quoteRequestId: string): boolean | null {
  return null
}
