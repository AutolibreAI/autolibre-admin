// node --test tests/   (Node 24 corre TypeScript sin compilar)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PRESELECTED_DISPATCH,
  MAX_DISPATCH_SLOTS,
  approvePartnerDispatchSchema,
  defaultDispatchSelection,
  discardReducer,
  dispatchDraftSchema,
  dispatchRows,
  formatDispatchDistance,
  matchesPartnerSearch,
  normalizeForSearch,
  type DispatchCandidate,
  type DispatchDraft,
} from '../src/lib/partner-dispatch.ts'

// ── El contrato del borrador ────────────────────────────────────────────────

const candidateJson = (partnerId: string, name: string, extra: Record<string, unknown> = {}) => ({
  partnerId,
  name,
  distanceBucket: '1_to_3_km',
  templateRubros: 'Frenos',
  coveredRubros: ['Frenos'],
  uncoveredRubros: [],
  coversAllRubros: true,
  templatePreview: { text: 'hola' },
  ...extra,
})

const draftJson = (extra: Record<string, unknown> = {}) => ({
  readiness: { status: 'ready', reasons: [] },
  freeSlots: 10,
  rubros: [{ slug: 'frenos', name: 'Frenos', primary: false }],
  locality: 'Palermo',
  candidates: [candidateJson('a', 'Taller A')],
  excluded: [{ partnerId: 'x', name: 'Taller X', reason: 'opted_out' }],
  detailsPreview: { text: 'detalle' },
  piiFindings: [],
  piiWarning: null,
  ...extra,
})

test('el borrador de un backend viejo (sin distanceKm ni otherPartners) sigue validando', () => {
  const parsed = dispatchDraftSchema.parse(draftJson())
  assert.deepEqual(parsed.otherPartners, [])
  assert.equal(parsed.candidates[0]?.distanceKm, undefined)
})

test('el borrador nuevo trae distanceKm (también null) y otherPartners con bucket null', () => {
  const parsed = dispatchDraftSchema.parse(
    draftJson({
      candidates: [candidateJson('a', 'Taller A', { distanceKm: 2.3712 })],
      otherPartners: [
        candidateJson('b', 'Taller B', { distanceKm: 12.5, distanceBucket: 'over_10_km' }),
        candidateJson('c', 'Taller C', { distanceKm: null, distanceBucket: null, coveredRubros: [], coversAllRubros: false }),
      ],
      excluded: [{ partnerId: 'x', name: 'Taller X', reason: 'opted_out', distanceKm: 4.1 }],
    }),
  )
  assert.equal(parsed.candidates[0]?.distanceKm, 2.3712)
  assert.equal(parsed.otherPartners.length, 2)
  assert.equal(parsed.otherPartners[1]?.distanceKm, null)
  assert.equal(parsed.otherPartners[1]?.distanceBucket, null)
  assert.equal(parsed.excluded[0]?.distanceKm, 4.1)
})

// ── La aprobación: hasta 10 ─────────────────────────────────────────────────

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('el tope del despacho es 10', () => {
  assert.equal(MAX_DISPATCH_SLOTS, 10)
})

test('aprobar acepta 10 talleres y rechaza 11', () => {
  const base = { quoteRequestId: uuid(900), dispatchId: uuid(901) }
  const ten = Array.from({ length: 10 }, (_, i) => uuid(i + 1))
  assert.equal(approvePartnerDispatchSchema.safeParse({ ...base, partnerIds: ten }).success, true)
  assert.equal(approvePartnerDispatchSchema.safeParse({ ...base, partnerIds: [...ten, uuid(11)] }).success, false)
  assert.equal(approvePartnerDispatchSchema.safeParse({ ...base, partnerIds: [] }).success, false)
})

// ── La distancia exacta ─────────────────────────────────────────────────────

test('distanceKm se muestra con dos decimales y coma: 2,37 km', () => {
  assert.equal(formatDispatchDistance({ distanceKm: 2.3712, distanceBucket: '1_to_3_km' }), '2,37 km')
  assert.equal(formatDispatchDistance({ distanceKm: 0, distanceBucket: 'under_1_km' }), '0,00 km')
  assert.equal(formatDispatchDistance({ distanceKm: 1234.5, distanceBucket: null }), '1.234,50 km')
})

test('distanceKm null es «sin ubicación», aunque haya bucket', () => {
  assert.equal(formatDispatchDistance({ distanceKm: null, distanceBucket: null }), 'sin ubicación')
  assert.equal(formatDispatchDistance({ distanceKm: null, distanceBucket: 'over_10_km' }), 'sin ubicación')
})

test('sin distanceKm (backend viejo) cae a la etiqueta del bucket', () => {
  assert.equal(formatDispatchDistance({ distanceBucket: '3_to_5_km' }), 'a 3–5 km')
  assert.equal(formatDispatchDistance({ distanceBucket: null }), 'sin ubicación')
})

// ── La búsqueda ─────────────────────────────────────────────────────────────

test('normalizar ignora mayúsculas, tildes y espacios de más', () => {
  assert.equal(normalizeForSearch('  Mecánica   ÑANDÚ '), 'mecanica nandu')
})

test('la búsqueda por nombre es por contención, sin tildes ni mayúsculas', () => {
  assert.equal(matchesPartnerSearch('Taller Mecánico Gómez', 'gomez'), true)
  assert.equal(matchesPartnerSearch('Taller Mecánico Gómez', 'MECANICO'), true)
  assert.equal(matchesPartnerSearch('Taller Mecánico Gómez', 'perez'), false)
  assert.equal(matchesPartnerSearch('Taller Mecánico Gómez', '   '), true)
  assert.equal(matchesPartnerSearch(null, 'gomez'), false)
  assert.equal(matchesPartnerSearch(null, ''), true)
})

// ── Descartes (sólo del cliente) ────────────────────────────────────────────

test('descartar agrega una vez, restaurar saca, restaurar todo vacía', () => {
  let s = discardReducer([], { type: 'discard', partnerId: 'a' })
  s = discardReducer(s, { type: 'discard', partnerId: 'b' })
  s = discardReducer(s, { type: 'discard', partnerId: 'a' })
  assert.deepEqual(s, ['a', 'b'])
  s = discardReducer(s, { type: 'restore', partnerId: 'a' })
  assert.deepEqual(s, ['b'])
  assert.deepEqual(discardReducer(s, { type: 'restoreAll' }), [])
})

// ── Las filas que se pintan ─────────────────────────────────────────────────

const cand = (partnerId: string, name: string): DispatchCandidate => ({
  partnerId,
  name,
  distanceBucket: null,
  distanceKm: null,
  templateRubros: '',
  coveredRubros: [],
  uncoveredRubros: [],
  coversAllRubros: false,
  templatePreview: { text: '' },
})

const draft = (): DispatchDraft =>
  dispatchDraftSchema.parse(
    draftJson({
      candidates: [cand('a', 'Taller Álamo'), cand('b', 'Frenos Beto')],
      otherPartners: [cand('c', 'Gomería Central'), cand('d', 'Taller Delta')],
      excluded: [
        { partnerId: 'x', name: 'Taller Xenón', reason: 'opted_out' },
        { partnerId: 'y', name: null, reason: 'invalid_whatsapp' },
      ],
    }),
  )

test('sin búsqueda ni descartes: todos los sugeridos y los otros, ningún excluido', () => {
  const r = dispatchRows(draft(), { query: '', discarded: [] })
  assert.deepEqual(r.suggested.map((c) => c.partnerId), ['a', 'b'])
  assert.deepEqual(r.others.map((c) => c.partnerId), ['c', 'd'])
  assert.deepEqual(r.excludedMatches, [])
  assert.deepEqual(r.discardedRows, [])
})

test('un descartado sale de su lista y queda en discardedRows', () => {
  const r = dispatchRows(draft(), { query: '', discarded: ['b', 'c'] })
  assert.deepEqual(r.suggested.map((c) => c.partnerId), ['a'])
  assert.deepEqual(r.others.map((c) => c.partnerId), ['d'])
  assert.deepEqual(r.discardedRows.map((c) => c.partnerId), ['b', 'c'])
})

test('la búsqueda filtra sugeridos y otros, y trae los excluidos que coinciden', () => {
  const r = dispatchRows(draft(), { query: 'taller', discarded: [] })
  assert.deepEqual(r.suggested.map((c) => c.partnerId), ['a'])
  assert.deepEqual(r.others.map((c) => c.partnerId), ['d'])
  assert.deepEqual(r.excludedMatches.map((x) => x.partnerId), ['x'])
})

test('la búsqueda ignora tildes: «alamo» encuentra «Álamo»', () => {
  const r = dispatchRows(draft(), { query: 'alamo', discarded: [] })
  assert.deepEqual(r.suggested.map((c) => c.partnerId), ['a'])
  assert.deepEqual(r.others, [])
})

// ── La selección por default ────────────────────────────────────────────────

test('por default se tildan como mucho los 3 primeros sugeridos', () => {
  assert.equal(DEFAULT_PRESELECTED_DISPATCH, 3)
  const many = ['a', 'b', 'c', 'd', 'e'].map((id) => cand(id, id))
  assert.deepEqual(defaultDispatchSelection({ ready: true, freeSlots: 10, candidates: many }), ['a', 'b', 'c'])
})

test('la selección por default respeta los lugares libres y la readiness', () => {
  const many = ['a', 'b', 'c'].map((id) => cand(id, id))
  assert.deepEqual(defaultDispatchSelection({ ready: true, freeSlots: 2, candidates: many }), ['a', 'b'])
  assert.deepEqual(defaultDispatchSelection({ ready: true, freeSlots: 0, candidates: many }), [])
  assert.deepEqual(defaultDispatchSelection({ ready: false, freeSlots: 10, candidates: many }), [])
})
