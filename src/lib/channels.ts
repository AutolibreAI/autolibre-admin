import type { GrowthUnit } from './ops'

/**
 * Personas por canal de llegada — `/metricas`, sección Crecimiento.
 *
 * Desde que existen los pedidos por web y WhatsApp (`quote_requests.channel`)
 * hay gente que usa AutoLibre sin tener cuenta en la app. No vale lo mismo que
 * un usuario de la app (no tiene auto cargado, ni escaneos, ni notificaciones),
 * así que NUNCA se suma con ellos en un solo número sin decir de qué canal es.
 *
 * ── Quién es "una persona" de web/WhatsApp ──────────────────────────────────
 *
 * No hay tabla de contactos: una persona es un TELÉFONO (normalizado a
 * dígitos) o un EMAIL que aparece en un pedido. Dos pedidos con el mismo
 * teléfono, o con el mismo email, son la misma persona — y la relación es
 * transitiva (teléfono A + email X, después email X + teléfono B → una sola).
 *
 * Sólo cuentan los pedidos REALES: los cerrados como `duplicate` son también
 * las pruebas del equipo (`notDuplicatePredicate`, el mismo corte que la card
 * "Pedidos totales"). Y una persona cuyo email es de un dominio excluido es
 * interna, igual que en "Usuarios reales".
 *
 * ── Los duplicados: alguien que llegó por WhatsApp y después bajó la app ────
 *
 * `users.phone` está VACÍO para todos los usuarios (250 de 250 al
 * 2026-10-03), así que el teléfono de un contacto no se puede cruzar contra
 * `users` directo. Los dos puentes que SÍ hay:
 *
 *   1. un pedido por la APP trae `user_id` y `contact_phone` — si ese teléfono
 *      ya había escrito por WhatsApp o web, es la misma persona;
 *   2. el email del pedido web coincide con `users.email`.
 *
 * Una persona con cuenta se cuenta UNA vez, como usuario de la app, y además
 * se dice por dónde llegó: si su primer pedido por web/WhatsApp es ANTERIOR a
 * su alta, "llegó por WhatsApp/web". Si ya tenía cuenta cuando escribió, es un
 * usuario de la app que además escribió — no cambia de canal.
 *
 * Lo que este cruce NO ve: quien escribió por WhatsApp, bajó la app y nunca
 * pidió un presupuesto desde ella (ni dejó el mismo email). Queda contado dos
 * veces —como "sólo WhatsApp" y como usuario de la app— hasta que el backend
 * guarde el teléfono en `users`. Está en el `.md` para los devs.
 */

export interface ChannelPeople {
  /** `false` = la base no tiene `quote_requests`: sólo hay usuarios de la app. */
  available: boolean
  /** Usuarios reales de la app — el MISMO número que "Usuarios reales" de Inicio. */
  appUsers: number
  /** De `appUsers`, cuántos escribieron primero por WhatsApp / web y después se dieron de alta. */
  appFromWhatsapp: number
  appFromWeb: number
  /** Personas sin cuenta, por el canal de su PRIMER pedido. */
  whatsappOnly: number
  webOnly: number
  unit: GrowthUnit
  /**
   * Personas que llegaron por WhatsApp o web, por el período de su primer
   * pedido (con o sin cuenta después). Mismo agrupamiento en hora de Buenos
   * Aires que el resto de Crecimiento.
   */
  series: Array<{ bucket: string; whatsapp: number; web: number }>
}
