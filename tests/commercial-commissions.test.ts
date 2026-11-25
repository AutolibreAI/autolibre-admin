// node --test tests/   (Node 24 corre TypeScript sin compilar)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commissionRow, groupCommissions, type CommissionPartnerFacts } from '../src/lib/commercial-commissions.ts'

const base = (over: Partial<CommissionPartnerFacts> = {}): CommissionPartnerFacts => ({
  partnerId: 'p1',
  partnerName: 'Taller',
  member: { id: 'm1', name: 'Tobías', active: true },
  firstPaid: null,
  firstJob: null,
  payment: null,
  ...over,
})

test('alta en plan gratis: el fee del primer trabajo', () => {
  const r = commissionRow(base({ firstJob: { publicNumber: 1259, day: '2026-11-10', amount: 20000, feeStatus: 'pendiente' } }))
  assert.equal(r.kind, 'fee_primer_trabajo')
  assert.equal(r.amount, 20000)
  assert.equal(r.reference, 'AL-1259')
  assert.equal(r.status, 'pendiente')
})

test('alta con plan pago: la primera cuota; si el trabajo fue antes, manda el fee', () => {
  const paid = { planName: 'Plus', planCode: 'plus', price: 10000, day: '2026-11-05' }
  assert.equal(commissionRow(base({ firstPaid: paid })).kind, 'primera_cuota')
  assert.equal(
    commissionRow(base({ firstPaid: paid, firstJob: { publicNumber: 1, day: '2026-11-01', amount: 20000, feeStatus: 'pendiente' } })).kind,
    'fee_primer_trabajo',
  )
  assert.equal(
    commissionRow(base({ firstPaid: paid, firstJob: { publicNumber: 1, day: '2026-11-20', amount: 20000, feeStatus: 'pendiente' } })).kind,
    'primera_cuota',
  )
})

test('sin nada no devenga; lo pagado manda y agrupa', () => {
  assert.equal(commissionRow(base()).status, 'sin_devengar')
  const rows = [
    commissionRow(base({ firstPaid: { planName: 'Plus', planCode: 'plus', price: 10000, day: '2026-11-05' } })),
    commissionRow(
      base({
        partnerId: 'p2',
        firstPaid: { planName: 'Plus Max', planCode: 'plus_max', price: 20000, day: '2026-11-05' },
        payment: { memberId: 'm1', memberName: 'Tobías', kind: 'primera_cuota', amount: 15000, reference: 'Plus Max', paidOn: '2026-11-20', note: null, paidByName: null },
      }),
    ),
  ]
  const [g] = groupCommissions(rows)
  assert.equal(g!.pendingTotal, 10000)
  assert.equal(g!.paidTotal, 15000)
})
