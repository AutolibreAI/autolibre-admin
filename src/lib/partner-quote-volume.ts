/**
 * Presupuestos por proveedor, desde el principio — el contrato compartido.
 *
 * La cuenta la hace `ops.partner_quote_volume()` (migración 025): une
 * `ops.quote_request_response` (hasta el 2026-10-27) con
 * `public.quote_request_proposals` (desde esa fecha), sin pedidos de prueba y
 * sin contar dos veces el mismo presupuesto. El panel y el conector MCP de los
 * ejecutivos leen LA MISMA función: si el panel tuviera su copia del SQL, los
 * dos números se separarían sin que nada lo delate.
 *
 * Qué NO es: cuántos pedidos le MANDAMOS a cada taller. Esa derivación no se
 * registra (el botón "Pedir cotización" no escribe nada), así que no se puede
 * contar. Esto es "cotizó para un pedido nuestro".
 */

export interface PartnerQuoteVolumeRow {
  /** `null` = taller de afuera del directorio (no se le puede ofrecer un plan). */
  partnerId: string | null
  partnerName: string
  /** `founding` (Aliado) / `standard`. `null` para un taller de afuera. */
  tier: string | null
  /** `active` / `paused` / `archived`. `null` para un taller de afuera. */
  status: string | null
  isExternal: boolean
  /** Pedidos distintos en los que cotizó. El número que no se infla. */
  requests: number
  /** Presupuestos vigentes (de las dos tablas, sin retirados). */
  quotes: number
  /** Retirados de la tabla nueva: el taller cotizó igual, se cuentan aparte. */
  withdrawn: number
  /** Cuántas filas vienen de la tabla vieja (`ops`) y cuántas de la app. */
  fromOps: number
  fromApp: number
  /** `YYYY-MM-DD` en hora de Buenos Aires. */
  firstQuotedOn: string
  lastQuotedOn: string
}

export type PartnerQuoteVolumeResult =
  | { available: true; rows: Array<PartnerQuoteVolumeRow> }
  /** `no_function`: la 025 no está aplicada en esta base. `missing`: la función tiró `QUOTE_VOLUME_UNAVAILABLE`. */
  | { available: false; reason: 'no_function' | 'missing'; detail: string | null }

/**
 * Uso del plan por proveedor y mes — `ops.partner_proposal_usage_monthly()`.
 * Sólo la tabla nueva y desde `PROPOSAL_COUNT_START`: lo cargado antes en `ops`
 * no se publicó en la app y no cuenta contra un tope. Usadas = sent + withdrawn.
 */
export interface PartnerProposalUsageMonthRow {
  partnerId: string | null
  partnerName: string
  tier: string | null
  status: string | null
  isExternal: boolean
  /** `YYYY-MM`, mes del envío en hora de Buenos Aires. */
  month: string
  sent: number
  withdrawn: number
  selected: number
}

export type PartnerProposalUsageResult =
  | { available: true; rows: Array<PartnerProposalUsageMonthRow> }
  | { available: false; reason: 'no_function' | 'missing'; detail: string | null }
