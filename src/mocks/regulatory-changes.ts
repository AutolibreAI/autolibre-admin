import type { RegulatoryChange } from '~/lib/regulatory-changes'

/**
 * ⚠ MOCK — fichas de cambios normativos de EJEMPLO.
 *
 * Reemplaza a: la tabla `regulatory_changes` y el job que la llena,
 * `GET /admin/regulatory-changes`, `POST /admin/regulatory-changes/:id/approve`
 * (que tiene que subir la versión nueva del .md con `supersedesDocumentId` y
 * guardar `change_summary`) y `POST /admin/regulatory-changes/:id/reject`.
 * Tarjeta "automatizar cambios normativos a .md de la IA".
 *
 * Nada de esto es una norma real: jurisdicciones, normas, valores y URLs son
 * inventados y lo dicen ("(ejemplo)", `example.org`). El texto de la sección
 * también: el .md vigente no se puede bajar (falta
 * `GET /admin/knowledge-documents/:id/content`). Aprobar o rechazar vive en
 * memoria y se pierde al recargar; aprobar NO sube nada.
 */
const SEED: ReadonlyArray<RegulatoryChange> = [
  {
    id: 'ejemplo-norma-1',
    topic: 'VTV: frecuencia de la revisión para autos de 4 a 10 años',
    jurisdiction: 'Jurisdicción A (ejemplo)',
    oldValue: 'cada 2 años',
    newValue: 'cada año',
    effectiveFrom: '2027-01-01',
    norm: 'Resolución 000/2026 (ejemplo)',
    sourceUrl: 'https://example.org/norma-ejemplo-1',
    quote: '«Los vehículos de cuatro a diez años de antigüedad deberán realizar la revisión cada año.» (texto de ejemplo)',
    proposedBy: 'detector',
    detectedAt: '2026-10-28T13:20:00.000Z',
    documentTitle: 'Guía de VTV (ejemplo)',
    section: '## Cada cuánto se hace',
    sectionBefore: [
      '## Cada cuánto se hace',
      '',
      '- Autos 0 km: la primera a los 3 años.',
      '- Autos de 4 a 10 años: cada 2 años.',
      '- Autos de más de 10 años: cada año.',
    ].join('\n'),
    sectionAfter: [
      '## Cada cuánto se hace',
      '',
      '- Autos 0 km: la primera a los 3 años.',
      '- Autos de 4 a 10 años: cada año (desde el 1/1/2027).',
      '- Autos de más de 10 años: cada año.',
    ].join('\n'),
    status: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    changeSummary: null,
  },
  {
    id: 'ejemplo-norma-2',
    topic: 'Multas: descuento por pago voluntario',
    jurisdiction: 'Jurisdicción B (ejemplo)',
    oldValue: '50 %',
    newValue: '30 %',
    effectiveFrom: '2026-12-01',
    norm: 'Ley 0000 (ejemplo)',
    sourceUrl: 'https://example.org/norma-ejemplo-2',
    quote: '«El pago voluntario dentro de los sesenta días gozará de una reducción del treinta por ciento.» (texto de ejemplo)',
    proposedBy: 'detector',
    detectedAt: '2026-10-27T18:05:00.000Z',
    documentTitle: 'Guía de multas (ejemplo)',
    section: '## Pagar con descuento',
    sectionBefore: [
      '## Pagar con descuento',
      '',
      'Si pagás dentro de los 60 días tenés un 50 % de descuento.',
      'El descuento no aplica a multas con apelación en curso.',
    ].join('\n'),
    // A propósito: el texto propuesto deja el valor viejo en otro renglón, y
    // la ficha NO se puede aprobar. Es el caso que los chequeos existen para frenar.
    sectionAfter: [
      '## Pagar con descuento',
      '',
      'Si pagás dentro de los 60 días tenés un 30 % de descuento.',
      'El descuento no aplica a multas con apelación en curso.',
      'Ojo: el 50 % de descuento se mantiene para multas leves.',
    ].join('\n'),
    status: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    changeSummary: null,
  },
  {
    id: 'ejemplo-norma-3',
    topic: 'Licencia de conducir: vigencia para mayores de 65 años',
    jurisdiction: 'Jurisdicción A (ejemplo)',
    oldValue: '3 años',
    newValue: '2 años',
    effectiveFrom: '2026-11-15',
    norm: 'Disposición 00/2026 (ejemplo)',
    sourceUrl: 'https://example.org/norma-ejemplo-3',
    quote: '«Para titulares mayores de sesenta y cinco años la vigencia será de dos años.» (texto de ejemplo)',
    proposedBy: 'person',
    detectedAt: '2026-10-25T11:40:00.000Z',
    documentTitle: 'Guía de licencia de conducir (ejemplo)',
    section: '## Cuánto dura',
    sectionBefore: ['## Cuánto dura', '', 'Hasta 65 años: 5 años.', 'Más de 65 años: 3 años.'].join('\n'),
    sectionAfter: ['## Cuánto dura', '', 'Hasta 65 años: 5 años.', 'Más de 65 años: 2 años.'].join('\n'),
    status: 'approved',
    reviewedBy: 'ejemplo@autolibre',
    reviewedAt: '2026-10-26T14:00:00.000Z',
    rejectionReason: null,
    changeSummary: 'Vigencia para mayores de 65 años: de 3 a 2 años.',
  },
  {
    id: 'ejemplo-norma-4',
    topic: 'Seguro obligatorio: cobertura mínima',
    jurisdiction: 'Nacional (ejemplo)',
    oldValue: '$ 1.000.000',
    newValue: '$ 1.500.000',
    effectiveFrom: '2026-11-01',
    norm: 'Resolución 0000/2026 (ejemplo)',
    sourceUrl: 'https://example.org/norma-ejemplo-4',
    quote: '«Fíjase la suma mínima en pesos un millón quinientos mil.» (texto de ejemplo)',
    proposedBy: 'detector',
    detectedAt: '2026-10-24T09:10:00.000Z',
    documentTitle: 'Guía de seguros (ejemplo)',
    section: '## Qué cubre el obligatorio',
    sectionBefore: ['## Qué cubre el obligatorio', '', 'La cobertura mínima es de $ 1.000.000.'].join('\n'),
    sectionAfter: ['## Qué cubre el obligatorio', '', 'La cobertura mínima es de $ 1.500.000.'].join('\n'),
    status: 'rejected',
    reviewedBy: 'ejemplo@autolibre',
    reviewedAt: '2026-10-24T16:30:00.000Z',
    rejectionReason: 'La resolución está publicada pero suspendida por una medida judicial; esperar.',
    changeSummary: null,
  },
]

const store = new Map<string, RegulatoryChange>(SEED.map((c) => [c.id, c]))

export async function listRegulatoryChangesMock(): Promise<Array<RegulatoryChange>> {
  return [...store.values()].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
}

export async function approveRegulatoryChangeMock(
  id: string,
  input: { reviewedBy: string; changeSummary: string },
): Promise<RegulatoryChange> {
  const c = store.get(id)
  if (!c || c.status !== 'pending') throw new Error('REGULATORY_CHANGE_ALREADY_REVIEWED')
  const next: RegulatoryChange = {
    ...c,
    status: 'approved',
    reviewedBy: input.reviewedBy,
    reviewedAt: new Date().toISOString(),
    changeSummary: input.changeSummary.trim(),
  }
  store.set(id, next)
  return next
}

export async function rejectRegulatoryChangeMock(
  id: string,
  input: { reviewedBy: string; reason: string },
): Promise<RegulatoryChange> {
  const c = store.get(id)
  if (!c || c.status !== 'pending') throw new Error('REGULATORY_CHANGE_ALREADY_REVIEWED')
  const next: RegulatoryChange = {
    ...c,
    status: 'rejected',
    reviewedBy: input.reviewedBy,
    reviewedAt: new Date().toISOString(),
    rejectionReason: input.reason.trim(),
  }
  store.set(id, next)
  return next
}
