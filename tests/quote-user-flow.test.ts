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
  QUOTE_NOT_HIRED_NOTE_MAX,
  QUOTE_NOT_HIRED_REASONS,
  QUOTE_NOT_HIRED_REASON_LABELS,
  quoteNotHiredReasonLabel,
  hasIncompleteUserFlow,
  parseQuoteUserFlowError,
  performedOnBounds,
  provenanceSource,
  quoteUserFlowErrorMessage,
  readableDeclareOutcomeError,
  readableSelectProposalError,
  selectQuoteProposalOnBehalfSchema,
  userOutcomeReporter,
  userOutcomeReporterLabel,
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

test('elegir: sin cerrar, con cuenta o sin ella', () => {
  assert.equal(canSelectProposalOnBehalf(facts()), true)
  assert.equal(canSelectProposalOnBehalf(facts({ userId: null })), true)
  assert.equal(canSelectProposalOnBehalf(facts({ status: 'closed', closeReasonCode: 'resolved' })), false)
  assert.equal(canSelectProposalOnBehalf(facts({ userId: null, status: 'closed', closeReasonCode: 'resolved' })), false)
})

test('declarar: respondido y no cancelado por la persona, con cuenta o sin ella; cerrado por el operador SÍ', () => {
  assert.equal(canDeclareOutcomeOnBehalf(facts()), true)
  assert.equal(canDeclareOutcomeOnBehalf(facts({ status: 'closed', closeReasonCode: 'resolved' })), true)
  assert.equal(canDeclareOutcomeOnBehalf(facts({ userId: null })), true)
  assert.equal(canDeclareOutcomeOnBehalf(facts({ userId: null, status: 'closed', closeReasonCode: 'resolved' })), true)
  assert.equal(canDeclareOutcomeOnBehalf(facts({ answeredAt: null })), false)
  assert.equal(canDeclareOutcomeOnBehalf(facts({ userId: null, answeredAt: null })), false)
  assert.equal(canDeclareOutcomeOnBehalf(facts({ status: 'closed', closeReasonCode: 'cancelled_by_user' })), false)
})

test('flujo incompleto = declarable y sin user_outcome', () => {
  assert.equal(hasIncompleteUserFlow({ ...facts(), userOutcome: null }), true)
  assert.equal(hasIncompleteUserFlow({ ...facts(), userOutcome: 'pending' }), false)
  assert.equal(hasIncompleteUserFlow({ ...facts({ userId: null }), userOutcome: null }), true)
  assert.equal(hasIncompleteUserFlow({ ...facts({ userId: null, answeredAt: null }), userOutcome: null }), false)
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

// ── Motivo de «No fue» ──────────────────────────────────────────────────────

test('motivos de «No fue»: el enum del backend, en el orden del contrato, con su rótulo', () => {
  assert.deepEqual(
    [...QUOTE_NOT_HIRED_REASONS],
    ['no_budget', 'no_time', 'did_it_themselves', 'hired_outside_network', 'no_longer_needed', 'took_too_long', 'other'],
  )
  assert.equal(QUOTE_NOT_HIRED_REASON_LABELS.no_budget, 'Falta de plata')
  assert.equal(QUOTE_NOT_HIRED_REASON_LABELS.hired_outside_network, 'Lo hizo fuera de la red')
  assert.equal(quoteNotHiredReasonLabel('other'), 'Otro')
  // Un valor que el panel no conoce se muestra crudo, nunca se pierde.
  assert.equal(quoteNotHiredReasonLabel('nuevo_motivo'), 'nuevo_motivo')
})

test('«No fue» admite motivo y observación, los dos opcionales (también con «Otro»)', () => {
  const ok = (v: object) => declareQuoteUserOutcomeOnBehalfSchema.safeParse({ quoteRequestId: ID, ...v }).success
  assert.equal(ok({ outcome: 'not_hired', notHiredReason: 'no_budget', notHiredNote: 'Le pareció caro' }), true)
  assert.equal(ok({ outcome: 'not_hired', notHiredReason: 'other' }), true)
  assert.equal(ok({ outcome: 'not_hired', notHiredReason: null, notHiredNote: null }), true)
  assert.equal(ok({ outcome: 'not_hired', notHiredReason: 'sin_ganas' }), false)
  assert.equal(ok({ outcome: 'not_hired', notHiredNote: 'x'.repeat(QUOTE_NOT_HIRED_NOTE_MAX) }), true)
  assert.equal(ok({ outcome: 'not_hired', notHiredNote: 'x'.repeat(QUOTE_NOT_HIRED_NOTE_MAX + 1) }), false)
  // El tope se mide sin los espacios de los bordes: el backend recorta antes de contar.
  assert.equal(ok({ outcome: 'not_hired', notHiredNote: `  ${'x'.repeat(QUOTE_NOT_HIRED_NOTE_MAX)}  ` }), true)
})

test('con «Fue» o «Todavía no», motivo y observación no nulos se rechazan (el backend da 400)', () => {
  const ok = (v: object) => declareQuoteUserOutcomeOnBehalfSchema.safeParse({ quoteRequestId: ID, ...v }).success
  assert.equal(ok({ outcome: 'pending', notHiredReason: 'no_budget' }), false)
  assert.equal(ok({ outcome: 'pending', notHiredNote: 'algo' }), false)
  assert.equal(ok({ outcome: 'hired', performedOn: '2026-11-02', notHiredReason: 'no_time' }), false)
  assert.equal(ok({ outcome: 'pending', notHiredReason: null, notHiredNote: null }), true)
})

test('el cuerpo de «No fue» lleva motivo y observación sólo si vinieron; la observación recortada y vacía → null', () => {
  assert.deepEqual(
    declareOutcomeBody({ quoteRequestId: ID, outcome: 'not_hired', notHiredReason: 'no_time', notHiredNote: '  Viaja  ' }),
    { outcome: 'not_hired', notHiredReason: 'no_time', notHiredNote: 'Viaja' },
  )
  assert.deepEqual(
    declareOutcomeBody({ quoteRequestId: ID, outcome: 'not_hired', notHiredReason: null, notHiredNote: '   ' }),
    { outcome: 'not_hired', notHiredReason: null, notHiredNote: null },
  )
  // Sin las claves (backend sin la migración): no viajan.
  assert.deepEqual(declareOutcomeBody({ quoteRequestId: ID, outcome: 'not_hired' }), { outcome: 'not_hired' })
  // Con otro resultado no viajan nunca, ni en null.
  assert.deepEqual(
    declareOutcomeBody({ quoteRequestId: ID, outcome: 'pending', notHiredReason: null, notHiredNote: null }),
    { outcome: 'pending' },
  )
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

test('sin fuente en la columna = anterior a la migración = la app (con cuenta)', () => {
  assert.equal(provenanceSource(null, true), 'user')
  assert.equal(provenanceSource('operator', true), 'operator')
  assert.equal(provenanceSource('user', true), 'user')
})

test('sin cuenta no hay app: la procedencia es siempre el equipo', () => {
  assert.equal(provenanceSource(null, false), 'operator')
  assert.equal(provenanceSource('operator', false), 'operator')
  // Un 'user' sin cuenta no lo escribe el contrato; si apareciera, tampoco se dice «la persona en la app».
  assert.equal(provenanceSource('user', false), 'operator')
})

test('el admin se nombra con lo que haya', () => {
  assert.equal(actorLabel({ id: USER, name: 'Ana', email: 'ana@x.com' }), 'Ana (ana@x.com)')
  assert.equal(actorLabel({ id: USER, name: null, email: 'ana@x.com' }), 'ana@x.com')
  assert.equal(actorLabel({ id: USER, name: null, email: null }), USER)
  assert.equal(actorLabel(null), 'un admin que ya no está')
})

test('quién informó el resultado: nadie si no hay resultado', () => {
  const r = userOutcomeReporter({ hasValue: false, hasAccount: true, provenanceAvailable: true, source: null, by: null })
  assert.deepEqual(r, { kind: 'none' })
  assert.equal(userOutcomeReporterLabel(r), '—')
})

test('quién informó: sin las columnas del backend no se sabe', () => {
  const r = userOutcomeReporter({ hasValue: true, hasAccount: true, provenanceAvailable: false, source: null, by: null })
  assert.deepEqual(r, { kind: 'unknown' })
  assert.match(userOutcomeReporterLabel(r), /falta la migración/)
})

test('quién informó: la persona en la app, o el equipo con su autor', () => {
  const ana = { id: USER, name: 'Ana', email: 'ana@x.com' }
  const app = userOutcomeReporter({ hasValue: true, hasAccount: true, provenanceAvailable: true, source: null, by: null })
  assert.deepEqual(app, { kind: 'user' })
  assert.equal(userOutcomeReporterLabel(app), 'La persona (app)')
  const op = userOutcomeReporter({ hasValue: true, hasAccount: true, provenanceAvailable: true, source: 'operator', by: ana })
  assert.deepEqual(op, { kind: 'operator', by: ana })
  assert.equal(userOutcomeReporterLabel(op), 'Equipo: Ana (ana@x.com)')
})

test('quién informó sin cuenta: siempre el equipo, nunca «la persona (app)»', () => {
  const legacy = userOutcomeReporter({ hasValue: true, hasAccount: false, provenanceAvailable: true, source: null, by: null })
  assert.deepEqual(legacy, { kind: 'operator', by: null })
  assert.equal(userOutcomeReporterLabel(legacy), 'Equipo')
  // Sin cuenta ni columnas: igual se sabe que fue el equipo.
  const noCols = userOutcomeReporter({ hasValue: true, hasAccount: false, provenanceAvailable: false, source: null, by: null })
  assert.deepEqual(noCols, { kind: 'operator', by: null })
})

// ── Errores ─────────────────────────────────────────────────────────────────

test('la sentinela ida y vuelta', () => {
  assert.deepEqual(parseQuoteUserFlowError(err(409, 'X', 'a: b')), { status: 409, code: 'X', message: 'a: b', cannotRoute: false })
  assert.equal(parseQuoteUserFlowError(new Error('otra cosa')), null)
})

test('elegir: cada código del contrato tiene su lectura', () => {
  const missing = readableSelectProposalError(err(404, 'NOT_FOUND'))
  assert.equal(missing?.action, 'reload')
  assert.match(missing?.text ?? '', /no existe/)
  assert.doesNotMatch(missing?.text ?? '', /cuenta/)
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
