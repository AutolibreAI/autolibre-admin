// node --test tests/   (Node 24 corre TypeScript sin compilar)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  awardCsvRows,
  awardRow,
  awardsVisible,
  groupAwards,
  setAwardSchema,
  type AwardPartnerFacts,
} from '../src/lib/commercial-commissions.ts'

const base = (over: Partial<AwardPartnerFacts> = {}): AwardPartnerFacts => ({
  partnerId: 'p1',
  partnerName: 'Taller',
  partnerCreatedOn: '2026-11-01',
  member: { id: 'm1', name: 'Tobías', active: true, earnsAward: true },
  firstJob: null,
  subscription: null,
  award: null,
  ...over,
})

test('sin primer trabajo: espera; con primer trabajo: pendiente con el monto de la config', () => {
  assert.equal(awardRow(base(), 15000).status, 'esperando')
  const r = awardRow(base({ firstJob: { publicNumber: 1259, day: '2026-11-10' } }), 15000)
  assert.equal(r.status, 'pendiente')
  assert.equal(r.amount, 15000)
  assert.equal(r.reference, 'AL-1259')
  assert.equal(awardRow(base({ firstJob: { publicNumber: 1, day: '2026-11-10' } }), null).amount, null)
})

test('lo pagado congela monto y estado', () => {
  const r = awardRow(
    base({
      firstJob: { publicNumber: 1, day: '2026-11-10' },
      award: { memberId: 'm1', memberName: 'Tobías', status: 'pagado', amount: 12000, reference: 'AL-1', paidOn: '2026-11-20', note: null, voidReason: null, updatedByName: null },
    }),
    15000,
  )
  assert.equal(r.status, 'pagado')
  assert.equal(r.amount, 12000)
  assert.deepEqual(awardCsvRows([r], (d) => d), [['2026-11-20', 'Tobías', 'Taller', 'AL-1', 12000, '']])
})

test('los fundadores no aparecen; las altas con suscripción van al histórico', () => {
  assert.equal(awardsVisible(awardRow(base({ member: { id: 'm2', name: 'Nicolás', active: true, earnsAward: false } }), 1)), false)
  assert.equal(awardRow(base({ subscription: { planName: 'Plus', day: '2026-11-05' } }), 1).legacySubscription, true)
})

test('agrupa por comercial con altas, esperando, pendientes y pagados', () => {
  const rows = [
    awardRow(base({ partnerId: 'a', firstJob: { publicNumber: 1, day: '2026-11-10' } }), 10000),
    awardRow(base({ partnerId: 'b' }), 10000),
  ]
  const [g] = groupAwards(rows)
  assert.deepEqual([g!.altas, g!.waiting, g!.pendingCount, g!.pendingTotal], [2, 1, 1, 10000])
})

test('schema: anular exige motivo', () => {
  assert.equal(setAwardSchema.safeParse({ status: 'anulado', partnerId: '11111111-1111-4111-8111-111111111111', voidReason: '' }).success, false)
  assert.equal(
    setAwardSchema.safeParse({ status: 'pagado', partnerId: '11111111-1111-4111-8111-111111111111', paidOn: '2026-11-20' }).success,
    true,
  )
})
