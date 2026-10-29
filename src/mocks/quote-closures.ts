import type { DisputeResolution, QuoteClosure } from '~/lib/quote-closures'

/**
 * ⚠ MOCK — cierres declarados y disputas de EJEMPLO.
 *
 * Reemplaza a: las columnas de declaración de cierre en `quote_requests`, la
 * respuesta del proveedor, `GET /admin/quote-requests/disputes` y
 * `POST /admin/quote-requests/:id/dispute-resolution`. Tarjeta "Pedidos:
 * "Contraté / No contraté"…".
 *
 * Los pedidos de ejemplo usan números AL-90xx, que no existen: no linkean a
 * ningún pedido real, y los nombres de proveedor son genéricos a propósito. Las
 * resoluciones viven en memoria y se pierden al recargar.
 */
const EXAMPLES: ReadonlyArray<QuoteClosure> = [
  {
    quoteRequestId: 'ejemplo-1',
    publicNumber: 9001,
    declaredAt: '2026-10-28T15:10:00.000Z',
    hired: true,
    hiredWith: 'proposal',
    providerName: 'Taller de ejemplo A',
    externalProviderPhone: null,
    finalAmount: 185000,
    workStatus: 'disputed',
    closureCode: 'resolved',
    notHiredReason: null,
    providerAnswer: 'not_recognized',
    providerAnswerAt: '2026-10-29T12:00:00.000Z',
    providerAnswerNote: 'No tenemos registro de ese auto en el taller.',
  },
  {
    quoteRequestId: 'ejemplo-2',
    publicNumber: 9002,
    declaredAt: '2026-10-27T20:40:00.000Z',
    hired: true,
    hiredWith: 'external',
    providerName: 'Gomería de ejemplo B',
    externalProviderPhone: '11 0000-0000',
    finalAmount: 42000,
    workStatus: 'unverified',
    closureCode: 'resolved',
    notHiredReason: null,
    providerAnswer: null,
    providerAnswerAt: null,
    providerAnswerNote: null,
  },
  {
    quoteRequestId: 'ejemplo-3',
    publicNumber: 9003,
    declaredAt: '2026-10-28T09:05:00.000Z',
    hired: false,
    hiredWith: null,
    providerName: null,
    externalProviderPhone: null,
    finalAmount: null,
    workStatus: 'unverified',
    closureCode: 'too_expensive',
    notHiredReason: 'Las tres propuestas superaban lo que tenía pensado gastar.',
    providerAnswer: null,
    providerAnswerAt: null,
    providerAnswerNote: null,
  },
  {
    quoteRequestId: 'ejemplo-4',
    publicNumber: 9004,
    declaredAt: '2026-10-29T11:30:00.000Z',
    hired: false,
    hiredWith: null,
    providerName: null,
    externalProviderPhone: null,
    finalAmount: null,
    workStatus: 'unverified',
    closureCode: 'user_not_hired',
    notHiredReason: 'Lo resolvió un conocido.',
    providerAnswer: null,
    providerAnswerAt: null,
    providerAnswerNote: null,
  },
  {
    quoteRequestId: 'ejemplo-5',
    publicNumber: 9005,
    declaredAt: '2026-10-26T18:00:00.000Z',
    hired: true,
    hiredWith: 'other_partner',
    providerName: 'Lavadero de ejemplo C',
    externalProviderPhone: null,
    finalAmount: 15000,
    workStatus: 'verified',
    closureCode: 'resolved',
    notHiredReason: null,
    providerAnswer: 'confirmed',
    providerAnswerAt: '2026-10-27T10:00:00.000Z',
    providerAnswerNote: null,
  },
]

const resolutions = new Map<string, DisputeResolution>()
const sentToProspects = new Set<string>()

export async function listQuoteClosuresMock(): Promise<Array<QuoteClosure>> {
  return EXAMPLES.map((c) => (resolutions.has(c.quoteRequestId) && c.workStatus === 'disputed'
    ? { ...c, workStatus: resolutions.get(c.quoteRequestId)!.decision === 'discard' ? 'unverified' : 'verified' }
    : c))
}

/** La declaración de UN pedido real. Hoy siempre `null`: no hay de dónde leerla. */
export async function fetchQuoteClosureMock(_quoteRequestId: string): Promise<QuoteClosure | null> {
  return null
}

export async function listDisputeResolutionsMock(): Promise<Map<string, DisputeResolution>> {
  return new Map(resolutions)
}

export async function resolveDisputeMock(id: string, resolution: Omit<DisputeResolution, 'resolvedAt'>): Promise<void> {
  resolutions.set(id, { ...resolution, resolvedAt: new Date().toISOString() })
}

/** Reemplaza al evento `external_provider_declared` → alta en Comercial. NO escribe Comercial. */
export async function sendExternalToProspectsMock(id: string): Promise<void> {
  sentToProspects.add(id)
}

export async function listSentToProspectsMock(): Promise<Set<string>> {
  return new Set(sentToProspects)
}
