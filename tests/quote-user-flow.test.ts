// node --test tests/   (Node 24 corre TypeScript sin compilar)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  actorLabel,
  buenosAiresDay,
  canDeclareOutcomeOnBehalf,
  canSelectProposalOnBehalf,
  declareOutcomeBody,
  declareQuoteUserOutcomeOnBehalfSchema,
  hasIncompleteUserFlow,
  parseQuoteUserFlowError,
  performedOnBounds,
  provenanceSource,
  quoteUserFlowErrorMessage,
  readableDeclareOutcomeError,
  readableSelectProposalError,
  selectQuoteProposalOnBehalfSchema,
} from '../src/lib/quote-user-flow.ts'

const ID = '00000000-0000-4000-8000-000000000001'
const PROPOSAL = '00000000-0000-4000-8000-000000000002'
const USER = '00000000-0000-4000-8000-000000000003'

const facts = (over: Partial<Parameters<typeof canSelectProposalOnBehalf>[0]> = {}) => ({
  userId: USER,
  status: 'answered',
  answeredAt: '2026-11-01T12:00:00.000Z',
  closeReasonCode: null,
  ...over,
})

const err = (status: number, code = '', message = '', cannotRoute = false) =>
  new Error(quoteUserFlowErrorMessage({ status, code, message, cannotRoute }))

// ── Cuándo se ofrece cada acción ────────────────────────────────────────────

test('elegir: sólo con cuenta y sin cerrar', () => {
  assert.equal(canSelectProposalOnBehalf(facts()), true)
  assert.equal(canSelectProposalOnBehalf(facts({ userId: null })), false)
  assert.equal(canSelectProposalOnBehalf(facts({ status: 'closed', closeReasonCode: 'resolved' })), false)
})

test('declarar: con cuenta, respondido y no cancelado por la persona; cerrado por el operador SÍ', () => {
  assert.equal(canDeclareOutcomeOnBehalf(facts()), true)
  assert.equal(canDeclareOutcomeOnBehalf(facts({ status: 'closed', closeReasonCode: 'resolved' })), true)
  assert.equal(canDeclareOutcomeOnBehalf(facts({ userId: null })), false)
  assert.equal(canDeclareOutcomeOnBehalf(facts({ answeredAt: null })), false)
  assert.equal(canDeclareOutcomeOnBehalf(facts({ status: 'closed', closeReasonCode: 'cancelled_by_user' })), false)
})

test('flujo incompleto = declarable y sin user_outcome', () => {
  assert.equal(hasIncompleteUserFlow({ ...facts(), userOutcome: null }), true)
  assert.equal(hasIncompleteUserFlow({ ...facts(), userOutcome: 'pending' }), false)
  assert.equal(hasIncompleteUserFlow({ ...facts({ userId: null }), userOutcome: null }), false)
})

// ── Payloads ────────────────────────────────────────────────────────────────

test('elegir: exige uuids y no acepta campos de más', () => {
  assert.equal(selectQuoteProposalOnBehalfSchema.safeParse({ quoteRequestId: ID, proposalId: PROPOSAL }).success, true)
  assert.equal(selectQuoteProposalOnBehalfSchema.safeParse({ quoteRequestId: ID, proposalId: 'x' }).success, false)
  assert.equal(
    selectQuoteProposalOnBehalfSchema.safeParse({ quoteRequestId: ID, proposalId: PROPOSAL, actorId: USER }).success,
    false,
  )
})

test('declarar: «Fue» exige fecha; los otros la prohíben', () => {
  const ok = (v: object) => declareQuoteUserOutcomeOnBehalfSchema.safeParse({ quoteRequestId: ID, ...v }).success
  assert.equal(ok({ outcome: 'hired', performedOn: '2026-11-02' }), true)
  assert.equal(ok({ outcome: 'hired' }), false)
  assert.equal(ok({ outcome: 'not_hired' }), true)
  assert.equal(ok({ outcome: 'pending' }), true)
  assert.equal(ok({ outcome: 'not_hired', performedOn: '2026-11-02' }), false)
  assert.equal(ok({ outcome: 'hired', performedOn: '02/11/2026' }), false)
  assert.equal(ok({ outcome: 'cancelled' }), false)
})

test('el cuerpo HTTP no lleva el id ni una fecha fuera de «Fue»', () => {
  assert.deepEqual(declareOutcomeBody({ quoteRequestId: ID, outcome: 'hired', performedOn: '2026-11-02' }), {
    outcome: 'hired',
    performedOn: '2026-11-02',
  })
  assert.deepEqual(declareOutcomeBody({ quoteRequestId: ID, outcome: 'pending' }), { outcome: 'pending' })
})

// ── Fechas ──────────────────────────────────────────────────────────────────

test('el día es el de Buenos Aires, no el de UTC', () => {
  // 01:30 UTC del 3 = 22:30 del 2 en Buenos Aires.
  assert.equal(buenosAiresDay(new Date('2026-11-03T01:30:00.000Z')), '2026-11-02')
  assert.equal(buenosAiresDay(new Date('2026-11-03T12:00:00.000Z')), '2026-11-03')
})

test('min = día del pedido, max = hoy', () => {
  assert.deepEqual(performedOnBounds('2026-11-01T02:00:00.000Z', new Date('2026-11-25T15:00:00.000Z')), {
    min: '2026-10-31',
    max: '2026-11-25',
  })
})

// ── Procedencia ─────────────────────────────────────────────────────────────

test('sin fuente en la columna = anterior a la migración = la app', () => {
  assert.equal(provenanceSource(null), 'user')
  assert.equal(provenanceSource('operator'), 'operator')
})

test('el admin se nombra con lo que haya', () => {
  assert.equal(actorLabel({ id: USER, name: 'Ana', email: 'ana@x.com' }), 'Ana (ana@x.com)')
  assert.equal(actorLabel({ id: USER, name: null, email: 'ana@x.com' }), 'ana@x.com')
  assert.equal(actorLabel({ id: USER, name: null, email: null }), USER)
  assert.equal(actorLabel(null), 'un admin que ya no está')
})

// ── Errores ─────────────────────────────────────────────────────────────────

test('la sentinela ida y vuelta', () => {
  assert.deepEqual(parseQuoteUserFlowError(err(409, 'X', 'a: b')), { status: 409, code: 'X', message: 'a: b', cannotRoute: false })
  assert.equal(parseQuoteUserFlowError(new Error('otra cosa')), null)
})

test('elegir: cada código del contrato tiene su lectura', () => {
  assert.equal(readableSelectProposalError(err(404, 'NOT_FOUND'))?.action, 'reload')
  const gone = readableSelectProposalError(err(404, 'QUOTE_PROPOSAL_NOT_FOUND'))
  assert.equal(gone?.action, 'reload')
  assert.match(gone?.text ?? '', /ya no está activa/)
  const closed = readableSelectProposalError(err(400, 'INVALID_STATE_TRANSITION'))
  assert.equal(closed?.action, 'reload')
  assert.match(closed?.text ?? '', /cerrado/)
  const race = readableSelectProposalError(err(409, 'CONFLICT'))
  assert.equal(race?.action, 'reload')
  assert.match(race?.text ?? '', /al mismo tiempo/)
  assert.equal(readableSelectProposalError(err(400, 'VALIDATION_ERROR', 'proposalId must be a UUID'))?.action, 'fix')
  assert.match(readableSelectProposalError(err(404, '', 'Cannot PUT /x', true))?.text ?? '', /desplegado/)
  assert.equal(readableSelectProposalError(err(0, 'TIMEOUT'))?.action, 'retry')
  assert.equal(readableSelectProposalError(err(503))?.action, 'retry')
})

test('declarar: cada código del contrato tiene su lectura', () => {
  const blocked = readableDeclareOutcomeError(err(400, 'INVALID_STATE_TRANSITION'))
  assert.equal(blocked?.action, 'reload')
  assert.match(blocked?.text ?? '', /no admite/)
  const race = readableDeclareOutcomeError(err(409, 'CONFLICT'))
  assert.equal(race?.action, 'reload')
  assert.match(race?.text ?? '', /al mismo tiempo/)
  const bad = readableDeclareOutcomeError(err(400, 'VALIDATION_ERROR', 'performedOn cannot be in the future'))
  assert.equal(bad?.action, 'fix')
  assert.match(bad?.text ?? '', /performedOn cannot be in the future/)
  assert.equal(readableDeclareOutcomeError(err(404, 'NOT_FOUND'))?.action, 'reload')
  assert.equal(readableDeclareOutcomeError(err(401))?.action, 'fix')
})

test('un error que no es del flujo devuelve null (la UI cae al genérico de pedidos)', () => {
  assert.equal(readableSelectProposalError(new Error('QUOTE_REQUESTS_UNAVAILABLE:no_table')), null)
  assert.equal(readableDeclareOutcomeError(new Error('FORBIDDEN')), null)
  assert.match(readableDeclareOutcomeError(new Error('BACKEND_UNREACHABLE:http://x'))?.text ?? '', /AUTOLIBRE_BACKEND_URL/)
})
