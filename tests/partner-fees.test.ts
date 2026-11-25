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

const F = await import('../src/lib/partner-fees.ts')
const { PARTNER_FEE_CONFIG } = await import('../src/lib/partner-fees-config.ts')
type Facts = import('../src/lib/partner-fees.ts').FeeJobFacts
type Partner = import('../src/lib/partner-fees.ts').FeePartnerFacts

const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'

function job(n: number, over: Partial<Facts> = {}): Facts {
  return {
    quoteRequestId: `q-${n}`,
    publicNumber: n,
    createdAt: '2026-11-01T12:00:00.000Z',
    jobDay: '2026-11-01',
    jobDaySource: 'closed_at',
    outcome: 'hired',
    userOutcome: null,
    outcomeNote: null,
    closedReason: null,
    internalNotes: null,
    vehicleLabel: 'Fiat Cronos',
    services: ['Service'],
    selectedPartnerId: null,
    selectedPartnerName: null,
    attribution: null,
    proposals: [],
    charge: null,
    paidPlanAtJob: false,
    ...over,
  }
}

const attr = (partnerId: string) => ({ partnerId, partnerName: 'X', note: null, byName: 'Nico', at: '2026-11-25T00:00:00Z' })

const partners = new Map<string, Partner>([
  [P1, { id: P1, name: 'Taller Uno', whatsapp: '1122223333', tier: null, planCode: 'free', planName: 'Gratis', sourcer: { memberId: 'm-tobi', name: 'Tobías', active: true } }],
  [P2, { id: P2, name: 'Taller Dos', whatsapp: null, tier: null, planCode: 'plus', planName: 'Plus', sourcer: null }],
])

test('disputa: un lado hired y el otro not_hired', () => {
  assert.equal(F.isDispute('hired', 'not_hired'), true)
  assert.equal(F.isDispute('not_hired', 'hired'), true)
  assert.equal(F.isDispute('hired', null), false)
  assert.equal(F.isDispute('no_response', 'hired'), false)
  const [j] = F.classifyFeeJobs([job(1, { userOutcome: 'not_hired', selectedPartnerId: P1 })], partners)
  assert.equal(j!.kind, 'disputa')
  assert.equal(j!.amount, 0)
})

test('sin proveedor = sin atribuir; la elegida manda sobre la atribución', () => {
  const [a, b] = F.classifyFeeJobs(
    [job(1), job(2, { selectedPartnerId: P1, attribution: attr(P2) })],
    partners,
  )
  assert.equal(a!.kind, 'sin_atribuir')
  assert.equal(b!.partnerId, P1)
  assert.equal(b!.partnerSource, 'selected')
  assert.equal(b!.attributionMismatch, true)
})

test('liquidable pendiente cobra el fee de la config; lo avisado conserva su monto', () => {
  const [a, b] = F.classifyFeeJobs(
    [
      job(1, { attribution: attr(P1) }),
      job(2, {
        attribution: attr(P1),
        charge: { partnerId: P1, status: 'avisado', amount: 15000, notifiedAt: 'x', paidOn: null, paymentMethod: null, note: null, voidReason: null, updatedByName: null, updatedAt: 'x' },
      }),
    ],
    partners,
  )
  assert.equal(a!.amount, PARTNER_FEE_CONFIG.FEE_POR_TRABAJO)
  assert.equal(a!.status, 'pendiente')
  assert.equal(b!.amount, 15000)
  assert.equal(b!.status, 'avisado')
})

test('fee del comercial: sólo el primer trabajo del taller, en plan gratis, con «Alta por»', () => {
  const jobs = F.classifyFeeJobs(
    [
      job(3, { attribution: attr(P1), jobDay: '2026-11-10' }),
      job(1, { attribution: attr(P1), jobDay: '2026-11-05' }),
      job(2, { attribution: attr(P2), jobDay: '2026-11-01' }),
    ],
    partners,
  )
  const byN = new Map(jobs.map((j) => [j.publicNumber, j]))
  assert.equal(byN.get(1)!.commercialFee?.name, 'Tobías')
  assert.equal(byN.get(3)!.commercialFee, null)
  assert.equal(byN.get(2)!.commercialFee, null) // sin «Alta por»
  const paid = F.classifyFeeJobs([job(1, { attribution: attr(P1), paidPlanAtJob: true })], partners)
  assert.equal(paid[0]!.commercialFee, null) // con plan pago el comercial cobró la primera cuota
})

test('las exclusiones de la config están apagadas por default y funcionan al prenderlas', () => {
  const facts = [
    job(1, { attribution: attr(P1), jobDay: '2026-10-01', paidPlanAtJob: true }),
    job(2, { attribution: attr(P2), jobDay: '2026-11-02', services: ['Grúa'] }),
  ]
  assert.deepEqual(F.classifyFeeJobs(facts, partners).map((j) => j.exclusion), [null, null])
  const on = { ...PARTNER_FEE_CONFIG, FECHA_INICIO: '2026-10-15', PRIMER_CLIENTE_GRATIS: true, EXCLUIR_PLAN_PAGO: true }
  const [a, b] = F.classifyFeeJobs(facts, partners, on)
  assert.equal(a!.exclusion, 'antes_de_inicio')
  assert.equal(a!.amount, 0)
  assert.equal(b!.exclusion, null) // primer trabajo, pero en grúa: se cobra
  const [c] = F.classifyFeeJobs([job(3, { attribution: attr(P2) })], partners, on)
  assert.equal(c!.exclusion, 'primer_cliente')
})

test('agrupado, resumen y CSV cuadran', () => {
  const charge = (status: 'avisado' | 'cobrado', paidOn: string | null) => ({
    partnerId: P1, status, amount: 20000, notifiedAt: 'x', paidOn, paymentMethod: status === 'cobrado' ? 'efectivo' : null,
    note: null, voidReason: null, updatedByName: null, updatedAt: 'x',
  })
  const jobs = F.classifyFeeJobs(
    [
      job(1, { attribution: attr(P1) }),
      job(2, { attribution: attr(P1), charge: charge('avisado', null) }),
      job(3, { attribution: attr(P1), charge: charge('cobrado', '2026-11-20') }),
      job(4, { attribution: attr(P1), charge: charge('cobrado', '2026-11-20') }),
      job(5),
      job(6, { userOutcome: 'not_hired' }),
    ],
    partners,
  )
  const [g] = F.groupOpenByPartner(jobs, partners)
  assert.equal(g!.pendingTotal, 20000)
  assert.equal(g!.notifiedTotal, 20000)
  const s = F.feeSummary(jobs, '2026-11')
  assert.deepEqual(
    [s.pendingTotal, s.notifiedTotal, s.paidThisMonthTotal, s.unattributed, s.disputes],
    [20000, 20000, 40000, 1, 1],
  )
  const rows = F.feePaymentsCsvRows(jobs, partners)
  assert.deepEqual(rows, [['20/11/26', 'Taller Uno', 'AL-3, AL-4', 2, 40000, 'Efectivo']])
})

test('el mensaje no trae datos del cliente y suma bien', () => {
  const msg = F.chargeMessage('Taller Uno', [
    { publicNumber: 1201, jobDay: '2026-11-03', vehicleLabel: 'Fiat Cronos', amount: 20000 },
    { publicNumber: 1202, jobDay: '2026-11-04', vehicleLabel: null, amount: 20000 },
  ])
  assert.match(msg, /AL-1201 · 03\/11\/26 · Fiat Cronos/)
  assert.match(msg, /Total: \$ 40\.000/)
  assert.match(msg, /Forma de pago: \[completar/)
})

test('schema del cobro: cobrado exige fecha y medio; anulado, motivo', () => {
  const base = { quoteRequestIds: [P1], partnerId: P2 }
  assert.equal(F.setPartnerFeeStatusSchema.safeParse({ ...base, status: 'cobrado' }).success, false)
  assert.equal(F.setPartnerFeeStatusSchema.safeParse({ ...base, status: 'anulado' }).success, false)
  assert.equal(
    F.setPartnerFeeStatusSchema.safeParse({ ...base, status: 'cobrado', paidOn: '2026-11-20', paymentMethod: 'efectivo' }).success,
    true,
  )
})
