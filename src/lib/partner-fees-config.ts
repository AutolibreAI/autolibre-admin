/**
 * La regla de cobro a proveedores, en UN solo lugar. → `~/lib/partner-fees`,
 * `~/lib/partner-packages`, `.claude/rules/partner-fees.md`.
 *
 * Modelo vigente (Nicolás, 2026-11-26): SIN suscripciones ni tope de
 * respuestas. Se cobra por trabajo confirmado; el primero de cada proveedor es
 * gratis; un proveedor puede pagar por adelantado un paquete de trabajos.
 *
 * Cambiar un número acá cambia lo que la pantalla calcula como PENDIENTE; lo ya
 * avisado o cobrado guarda su monto en `ops.partner_fee_charge` y no se mueve.
 *
 * Sin imports: lo prueba `node --test` directo.
 */
export const PARTNER_FEE_CONFIG = {
  /** ARS por trabajo confirmado. */
  FEE_POR_TRABAJO: 20000,

  /**
   * El PRIMER trabajo confirmado de cada proveedor no se cobra. Encendido para
   * todos desde el 2026-11-26 (antes estaba preparado y apagado, con excepción
   * de grúa: ya no hay excepción).
   */
  PRIMER_TRABAJO_GRATIS: true,

  /** `YYYY-MM-DD` (día del trabajo, hora de Buenos Aires) desde el que se cobra. `null` = desde siempre. A definir. */
  FECHA_INICIO: null as string | null,

  /**
   * Cómo pagar, en el mensaje de cobro. Va entre corchetes a propósito: el
   * alias/CBU de AutoLibre no se escribe en el código; lo completa quien manda.
   */
  FORMA_DE_PAGO: '[completar: alias de Mercado Pago o CBU de AutoLibre]',

  // ── Paquetes de trabajos (044) ────────────────────────────────────────────

  /** Trabajos que trae un paquete, por defecto en el formulario de carga. */
  PAQUETE_TRABAJOS: 5,
  /** Vigencia en días desde la compra (vence = compra + vigencia), por defecto. */
  PAQUETE_VIGENCIA_DIAS: 90,
  /** Precio de referencia en ARS. `null` = a definir (el formulario lo pide a mano). */
  PAQUETE_PRECIO_REFERENCIA: null as number | null,
  /** Días antes del vencimiento en que un paquete figura «por vencer». */
  PAQUETE_POR_VENCER_DIAS: 15,

  // ── Premio a los comerciales (045) ────────────────────────────────────────

  /**
   * ARS por alta de un comercial, cuando ese taller tiene su primer trabajo
   * confirmado. `null` = a definir: la pantalla muestra las altas pero no
   * deja marcar pagado.
   */
  PREMIO_POR_ALTA: null as number | null,
} as const

export type PartnerFeeConfig = {
  FEE_POR_TRABAJO: number
  PRIMER_TRABAJO_GRATIS: boolean
  FECHA_INICIO: string | null
  FORMA_DE_PAGO: string
  PAQUETE_TRABAJOS: number
  PAQUETE_VIGENCIA_DIAS: number
  PAQUETE_PRECIO_REFERENCIA: number | null
  PAQUETE_POR_VENCER_DIAS: number
  PREMIO_POR_ALTA: number | null
}
