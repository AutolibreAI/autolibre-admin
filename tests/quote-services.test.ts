// node --test tests/   (Node 24 corre TypeScript sin compilar)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  QUOTE_SERVICES_ERROR,
  correctQuoteServicesSchema,
  familiesOfServices,
  parseQuoteServicesError,
  readableQuoteServicesError,
  sameServiceSet,
} from '../src/lib/quote-services.ts'

const ID = '00000000-0000-4000-8000-000000000001'

// ── La entrada del server function ──────────────────────────────────────────

test('acepta slugs de servicio en orden', () => {
  const r = correctQuoteServicesSchema.safeParse({ quoteRequestId: ID, serviceSlugs: ['frenos', 'aire-acondicionado'] })
  assert.equal(r.success, true)
  assert.deepEqual(r.success && r.data.serviceSlugs, ['frenos', 'aire-acondicionado'])
})

test('rechaza lista vacía, repetidos y slugs mal formados', () => {
  assert.equal(correctQuoteServicesSchema.safeParse({ quoteRequestId: ID, serviceSlugs: [] }).success, false)
  assert.equal(correctQuoteServicesSchema.safeParse({ quoteRequestId: ID, serviceSlugs: ['frenos', 'frenos'] }).success, false)
  assert.equal(correctQuoteServicesSchema.safeParse({ quoteRequestId: ID, serviceSlugs: ['Frenos'] }).success, false)
  assert.equal(correctQuoteServicesSchema.safeParse({ quoteRequestId: ID, serviceSlugs: ['frenos--x'] }).success, false)
  assert.equal(correctQuoteServicesSchema.safeParse({ quoteRequestId: 'AL-1001', serviceSlugs: ['frenos'] }).success, false)
})

// ── Familias derivadas (para la tabla vieja de `ops`) ───────────────────────

const catalog = [
  { slug: 'motor', name: 'Motor', services: [{ id: '1', slug: 'distribucion', name: 'Distribución' }] },
  {
    slug: 'tren-rodante',
    name: 'Tren rodante y frenos',
    services: [
      { id: '2', slug: 'frenos', name: 'Frenos' },
      { id: '3', slug: 'tren-delantero', name: 'Tren delantero' },
    ],
  },
  { slug: 'clima', name: 'Clima', services: [{ id: '4', slug: 'aire-acondicionado', name: 'Aire' }] },
]

test('las familias de los servicios salen sin repetir y en orden de catálogo', () => {
  assert.deepEqual(familiesOfServices(catalog, ['aire-acondicionado', 'frenos', 'tren-delantero']), ['tren-rodante', 'clima'])
})

test('un slug que no está en el catálogo no aporta familia', () => {
  assert.deepEqual(familiesOfServices(catalog, ['inexistente']), [])
})

// ── ¿Cambió la selección? ───────────────────────────────────────────────────

test('misma selección como conjunto, sin importar el orden', () => {
  assert.equal(sameServiceSet(['a', 'b'], ['b', 'a']), true)
  assert.equal(sameServiceSet(['a'], ['a', 'b']), false)
  assert.equal(sameServiceSet([], []), true)
})

// ── Errores del PUT ─────────────────────────────────────────────────────────

const err = (v: Record<string, unknown>) => new Error(`${QUOTE_SERVICES_ERROR}:${JSON.stringify(v)}`)

test('el error se parsea con los slugs rechazados', () => {
  const e = parseQuoteServicesError(err({ status: 400, code: 'VALIDATION_ERROR', message: 'x', serviceSlugs: ['frenos-de-disco'], cannotRoute: false }))
  assert.deepEqual(e, { status: 400, code: 'VALIDATION_ERROR', message: 'x', serviceSlugs: ['frenos-de-disco'], cannotRoute: false })
  assert.equal(parseQuoteServicesError(new Error('otra cosa')), null)
})

test('cada error dice qué pasó y si sirve reintentar', () => {
  const invalid = readableQuoteServicesError(err({ status: 400, code: 'VALIDATION_ERROR', message: 'x', serviceSlugs: ['frenos-de-disco'] }))
  assert.match(invalid.text, /frenos-de-disco/)
  assert.equal(invalid.retry, false)

  const closed = readableQuoteServicesError(err({ status: 400, code: 'INVALID_STATE_TRANSITION', message: 'closed' }))
  assert.match(closed.text, /cerrado/)
  assert.equal(closed.retry, false)

  const conflict = readableQuoteServicesError(err({ status: 409, code: 'CONFLICT', message: 'changed' }))
  assert.equal(conflict.retry, true)

  const timeout = readableQuoteServicesError(err({ status: 0, code: 'TIMEOUT', message: 'timeout' }))
  assert.equal(timeout.retry, true)

  const notDeployed = readableQuoteServicesError(err({ status: 404, code: '', message: 'Cannot PUT', cannotRoute: true }))
  assert.match(notDeployed.text, /desplegado/)

  const unreachable = readableQuoteServicesError(new Error('BACKEND_UNREACHABLE:http://x'))
  assert.match(unreachable.text, /backend/)
})
