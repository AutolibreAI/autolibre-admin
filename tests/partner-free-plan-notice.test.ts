// node --test tests/   (Node 24 corre TypeScript sin compilar)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('~/')) {
    return next(new URL('../src/' + specifier.slice(2) + '.ts', ${JSON.stringify(import.meta.url)}).href, context)
  }
  return next(specifier, context)
}`
register(`data:text/javascript,${encodeURIComponent(hooks)}`)

const N = await import('../src/lib/partner-free-plan-notice.ts')
const { PARTNER_FEE_CONFIG } = await import('../src/lib/partner-fees-config.ts')
type Row = import('../src/lib/partner-free-plan-notice.ts').FreePlanNoticeRow

function row(over: Partial<Row> = {}): Row {
  return {
    partnerId: '11111111-1111-4111-8111-111111111111',
    name: 'Taller Núñez',
    zone: 'Zona Norte',
    whatsapp: '5491122223333',
    status: 'active',
    tier: 'standard',
    notice: null,
    ...over,
  }
}
const notice = { channel: 'whatsapp', note: null, notifiedAt: '2026-11-26T15:00:00.000Z', notifiedByLabel: 'Toby' }

test('el universo: activos; pausados sólo si se piden; archivados nunca', () => {
  assert.equal(N.inNoticeUniverse(row(), {}), true)
  assert.equal(N.inNoticeUniverse(row({ status: 'paused' }), {}), false)
  assert.equal(N.inNoticeUniverse(row({ status: 'paused' }), { freePlanNoticePaused: true }), true)
  assert.equal(N.inNoticeUniverse(row({ status: 'archived' }), { freePlanNoticePaused: true }), false)
})

test('filtros: estado, canal y texto sin acentos', () => {
  const a = row({ notice })
  const b = row({ partnerId: 'b', name: 'Gomería Sur' })
  assert.equal(N.matchesFreePlanNoticeFilters(a, { freePlanNoticeState: 'avisados' }), true)
  assert.equal(N.matchesFreePlanNoticeFilters(b, { freePlanNoticeState: 'avisados' }), false)
  assert.equal(N.matchesFreePlanNoticeFilters(b, { freePlanNoticeState: 'sin_avisar' }), true)
  assert.equal(N.matchesFreePlanNoticeFilters(a, { freePlanNoticeChannel: 'llamada' }), false)
  assert.equal(N.matchesFreePlanNoticeFilters(a, { freePlanNoticeChannel: 'whatsapp' }), true)
  assert.equal(N.matchesFreePlanNoticeFilters(a, { q: 'nunez' }), true)
  assert.equal(N.matchesFreePlanNoticeFilters(b, { q: 'gomeria' }), true)
  assert.equal(N.matchesFreePlanNoticeFilters(b, { q: 'nunez' }), false)
})

test('el contador es sobre el universo, no sobre lo filtrado', () => {
  const rows = [row({ notice }), row({ partnerId: 'b' }), row({ partnerId: 'c', status: 'paused', notice })]
  assert.deepEqual(N.freePlanNoticeProgress(rows, {}), { notified: 1, total: 2 })
  assert.deepEqual(N.freePlanNoticeProgress(rows, { freePlanNoticePaused: true }), { notified: 2, total: 3 })
})

test('el mensaje dice primer trabajo gratis y el monto de la config', () => {
  const m = N.freePlanNoticeMessage('Taller X')
  assert.match(m, /primer trabajo/)
  assert.match(m, /segundo/)
  const amount = new Intl.NumberFormat('es-AR').format(PARTNER_FEE_CONFIG.FEE_POR_TRABAJO)
  assert.ok(m.includes(amount), m)
  assert.ok(N.freePlanNoticeMessage('Taller X', 30000).includes('30.000'))
})

test('WhatsApp: canónico, normalizable y sin link', () => {
  assert.equal(N.freePlanNoticeWhatsAppDigits('5491122223333'), '5491122223333')
  assert.equal(N.freePlanNoticeWhatsAppDigits('011 15 2222-3333'), '5491122223333')
  assert.equal(N.freePlanNoticeWhatsAppDigits('2222-3333'), null)
  assert.equal(N.freePlanNoticeWhatsAppDigits(null), null)
  const url = N.freePlanNoticeWhatsAppUrl('5491122223333', 'Taller X')
  assert.ok(url?.startsWith('https://wa.me/5491122223333?text='))
})

test('schema de escritura: tildar exige canal; destildar no', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  assert.equal(N.setFreePlanNoticeSchema.safeParse({ partnerId: id, notified: true, expectedNotified: false }).success, false)
  assert.equal(
    N.setFreePlanNoticeSchema.safeParse({ partnerId: id, notified: true, channel: 'llamada', expectedNotified: false }).success,
    true,
  )
  assert.equal(N.setFreePlanNoticeSchema.safeParse({ partnerId: id, notified: false, expectedNotified: true }).success, true)
  assert.equal(
    N.setFreePlanNoticeSchema.safeParse({ partnerId: id, notified: true, channel: 'email', expectedNotified: false }).success,
    false,
  )
})

test('errores legibles', () => {
  assert.match(N.readableFreePlanNoticeError('FREE_PLAN_NOTICE_CHANGED: true'), /alguien cambió/)
  assert.match(N.readableFreePlanNoticeError('FREE_PLAN_NOTICE_UNAVAILABLE'), /042/)
})
