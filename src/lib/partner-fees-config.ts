/**
 * La regla de cobro a proveedores, en UN solo lugar. → `~/lib/partner-fees`,
 * `.claude/rules/partner-fees.md`.
 *
 * Decidido por Nicolás el 2026-11-25. Cambiar un número acá cambia lo que la
 * pantalla calcula como PENDIENTE; lo ya avisado o cobrado guarda su monto en
 * `ops.partner_fee_charge` y no se mueve.
 *
 * Sin imports: lo prueba `node --test` directo.
 */
export const PARTNER_FEE_CONFIG = {
  /** ARS por trabajo confirmado. Se cobra cada trabajo, cliente nuevo o no. */
  FEE_POR_TRABAJO: 20000,

  /**
   * No cobrar a proveedores con plan pago (suscripción `trialing`/`active`) a la
   * fecha del trabajo. PREPARADO, APAGADO hasta que Nicolás lo confirme.
   * Ojo: el backend no guarda el historial de estados de la suscripción; "a la
   * fecha del trabajo" se aproxima con `authorized_at`/`ended_at`/`access_until`.
   */
  EXCLUIR_PLAN_PAGO: false,

  /**
   * El primer trabajo de cada taller no se cobra, salvo que haya sido un auto
   * en grúa. PREPARADO, APAGADO hasta que Nicolás lo confirme.
   * Ojo: "cliente nuevo" no se puede saber (no sabemos si la persona ya iba a
   * ese taller), así que se aplica al PRIMER trabajo del taller; "grúa" se
   * detecta por el servicio del pedido.
   */
  PRIMER_CLIENTE_GRATIS: false,

  /** `YYYY-MM-DD` (día del trabajo, hora de Buenos Aires) desde el que se cobra. `null` = desde siempre. */
  FECHA_INICIO: null as string | null,

  /**
   * Cómo pagar, en el mensaje de cobro. Va entre corchetes a propósito: el
   * alias/CBU de AutoLibre no se escribe en el código; lo completa quien manda.
   */
  FORMA_DE_PAGO: '[completar: alias de Mercado Pago o CBU de AutoLibre]',
} as const

export type PartnerFeeConfig = {
  FEE_POR_TRABAJO: number
  EXCLUIR_PLAN_PAGO: boolean
  PRIMER_CLIENTE_GRATIS: boolean
  FECHA_INICIO: string | null
  FORMA_DE_PAGO: string
}
