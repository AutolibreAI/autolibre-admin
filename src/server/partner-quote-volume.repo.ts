import '@tanstack/react-start/server-only'

import { sql, sqlOne } from './db'
import type { PartnerProposalUsageResult, PartnerQuoteVolumeResult } from '~/lib/partner-quote-volume'

/** La sentinela de las dos funciones de la 025 cuando falta una tabla o columna. */
const UNAVAILABLE = 'QUOTE_VOLUME_UNAVAILABLE:'

/**
 * Presupuestos por proveedor — llama a `ops.partner_quote_volume()` (025).
 *
 * El SQL NO vive acá a propósito: es la misma función que leen los ejecutivos
 * por el conector MCP. Una copia en este archivo sería una segunda definición
 * que diverge sola. Si hay que cambiar qué cuenta, es una migración nueva.
 *
 * Ni una escritura.
 */

interface VolumeRow {
  partner_id: string | null
  partner_name: string
  tier: string | null
  status: string | null
  is_external: boolean
  requests: number
  quotes: number
  withdrawn: number
  from_ops: number
  from_app: number
  first_quoted_on: string
  last_quoted_on: string
}

export async function listPartnerQuoteVolume(): Promise<PartnerQuoteVolumeResult> {
  // Sin la 025 aplicada no hay función: se dice, en vez de un 500.
  const fn = await sqlOne<{ ok: boolean }>(
    `select to_regprocedure('ops.partner_quote_volume()') is not null as ok`,
  )
  if (!fn?.ok) return { available: false, reason: 'no_function', detail: null }

  try {
    // Las fechas viajan como texto: un `date` de `pg` llega a medianoche
    // LOCAL del proceso y corre el día (`ai-costs.md`, `toPlainDay`).
    const rows = await sql<VolumeRow>(
      `select partner_id, partner_name, tier, status, is_external,
              requests, quotes, withdrawn, from_ops, from_app,
              first_quoted_on::text as first_quoted_on,
              last_quoted_on::text  as last_quoted_on
         from ops.partner_quote_volume()`,
    )
    return {
      available: true,
      rows: rows.map((r) => ({
        partnerId: r.partner_id,
        partnerName: r.partner_name,
        tier: r.tier,
        status: r.status,
        isExternal: r.is_external,
        requests: Number(r.requests),
        quotes: Number(r.quotes),
        withdrawn: Number(r.withdrawn),
        fromOps: Number(r.from_ops),
        fromApp: Number(r.from_app),
        firstQuotedOn: r.first_quoted_on,
        lastQuotedOn: r.last_quoted_on,
      })),
    }
  } catch (cause) {
    // Sólo la sentinela propia se traduce; cualquier otro error es real y sube.
    const unavailable = readUnavailable(cause)
    if (unavailable) return unavailable
    throw cause
  }
}

interface UsageRow {
  partner_id: string | null
  partner_name: string
  tier: string | null
  status: string | null
  is_external: boolean
  month: string
  sent: number
  withdrawn: number
  selected: number
}

/**
 * Uso del plan por proveedor y mes — `ops.partner_proposal_usage_monthly()`.
 * `from` es `PROPOSAL_COUNT_START`: se pasa explícito para que el panel no
 * dependa del default de la función (los dos dicen lo mismo y se tocan juntos).
 */
export async function listPartnerProposalUsageMonthly(from: string): Promise<PartnerProposalUsageResult> {
  const fn = await sqlOne<{ ok: boolean }>(
    `select to_regprocedure('ops.partner_proposal_usage_monthly(timestamptz)') is not null as ok`,
  )
  if (!fn?.ok) return { available: false, reason: 'no_function', detail: null }

  try {
    const rows = await sql<UsageRow>(
      `select partner_id, partner_name, tier, status, is_external, month, sent, withdrawn, selected
         from ops.partner_proposal_usage_monthly($1::timestamptz)`,
      [from],
    )
    return {
      available: true,
      rows: rows.map((r) => ({
        partnerId: r.partner_id,
        partnerName: r.partner_name,
        tier: r.tier,
        status: r.status,
        isExternal: r.is_external,
        month: r.month,
        sent: Number(r.sent),
        withdrawn: Number(r.withdrawn),
        selected: Number(r.selected),
      })),
    }
  } catch (cause) {
    const unavailable = readUnavailable(cause)
    if (unavailable) return unavailable
    throw cause
  }
}

function readUnavailable(cause: unknown): { available: false; reason: 'missing'; detail: string } | null {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (!message.startsWith(UNAVAILABLE)) return null
  return { available: false, reason: 'missing', detail: message.slice(UNAVAILABLE.length).trim() }
}
