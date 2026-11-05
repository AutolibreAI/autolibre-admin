import '@tanstack/react-start/server-only'

import { sqlOne } from './db'

/**
 * Despacho por WhatsApp — el ÚNICO SQL de la feature, y es un guard.
 *
 * Todo lo demás (borrador, aprobación, seguimiento) va por HTTP al backend.
 * Esto sólo evita pegarle a un backend cuya base todavía no tiene la 0142:
 * sin `partner_outreach` la tarjeta dice "falta desplegar" sin hacer fetch.
 * Ni una lectura ni una escritura sobre `partner_outreach` desde el panel.
 * → `.claude/rules/partner-dispatch.md`
 */
export async function partnerDispatchAvailability(opts: { signal?: AbortSignal } = {}): Promise<boolean> {
  void opts.signal
  const row = await sqlOne<{ has_table: boolean }>(
    `select to_regclass('public.partner_outreach') is not null as has_table`,
  )
  return row?.has_table === true
}
