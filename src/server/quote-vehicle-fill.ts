import '@tanstack/react-start/server-only'

import { canonicalPlate } from '~/lib/quote-plate'
import type { QuoteVehicleFill } from '~/lib/quote-plate'
import { canChangeQuoteLocation } from '~/lib/quote-location'
import { identifyQuoteRequestVehicleByPlate } from './backend'
import {
  plateIsCached,
  quote036Available,
  readQuoteVehicleState,
  readVehicleSuggestion,
  setQuoteRequestVehicleDescription,
} from './quote-requests.repo'

/**
 * Tarjeta T73NyHFN (A): el vehículo identificado por patente entra solo al
 * pedido, en `vehicle_description`, SIN pisar lo que alguien escribió a mano.
 *
 * - Completa sólo si el campo está VACÍO (`expected = null` en el SP de la
 *   036). Si ya tenía algo, devuelve `kept` y la ficha ofrece «Usar este
 *   vehículo» (`applyVehicleSuggestion`).
 * - El modelo de catálogo (`vehicle_catalog_id`) ya lo guarda el backend al
 *   identificar: acá no se toca.
 * - Nada de esto bloquea: un error de identificación o de escritura vuelve
 *   como estado, nunca como excepción. La carga manual sigue igual.
 */
export async function fillVehicleDescription(quoteRequestId: string, actorId: string): Promise<QuoteVehicleFill> {
  const suggestion = await readVehicleSuggestion(quoteRequestId)
  if (!suggestion) return { applied: 'none', suggestion: null }
  if (!(await quote036Available())) return { applied: 'unavailable', suggestion: suggestion.text }
  try {
    const r = await setQuoteRequestVehicleDescription(quoteRequestId, actorId, suggestion.text, null)
    return { applied: r.changed ? 'filled' : 'same', suggestion: suggestion.text }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes('VEHICLE_DESCRIPTION_CHANGED')) return { applied: 'kept', suggestion: suggestion.text }
    console.warn(`quote request ${quoteRequestId}: vehicle description not filled — ${msg}`)
    return { applied: 'failed', suggestion: suggestion.text }
  }
}

/**
 * Después de guardar un pedido con patente («Cargar pedido» o «Editar datos»):
 * identificarla SOLA, pero sólo si no cuesta. El proveedor de patentes factura
 * cada consulta; el backend cachea las encontradas SIN vencimiento
 * (`vehicle_plate_lookups`, `CachedVehicleDataProvider`), así que una patente
 * que ya está ahí se resuelve gratis. Una que no está NO se consulta acá: la
 * ficha deja la patente precargada en «Identificar vehículo» para que la
 * consulta paga la dispare una persona.
 *
 * Sin catálogo y con el pedido abierto (las mismas condiciones del botón).
 * Nunca tira.
 */
export async function autoIdentifyIfCached(
  quoteRequestId: string,
  actorId: string,
): Promise<{ identified: 'resolved' | 'not_resolved' | 'not_cached' | 'skipped' | 'failed'; fill: QuoteVehicleFill | null }> {
  try {
    const state = await readQuoteVehicleState(quoteRequestId)
    const plate = state?.plate ? canonicalPlate(state.plate) : null
    if (!state || !plate) return { identified: 'skipped', fill: null }

    let identified: 'resolved' | 'not_resolved' | 'not_cached' | 'skipped' = 'skipped'
    if (state.vehicleCatalogId === null && canChangeQuoteLocation(state.status)) {
      if (!(await plateIsCached(plate))) return { identified: 'not_cached', fill: null }
      const res = await identifyQuoteRequestVehicleByPlate(quoteRequestId, plate)
      identified = res.status === 'resolved' ? 'resolved' : 'not_resolved'
    }
    const fill = await fillVehicleDescription(quoteRequestId, actorId)
    return { identified, fill }
  } catch (error) {
    console.warn(
      `quote request ${quoteRequestId}: auto-identify skipped — ${error instanceof Error ? error.message : String(error)}`,
    )
    return { identified: 'failed', fill: null }
  }
}
