import { test } from 'node:test'
import assert from 'node:assert/strict'

const A = await import('../src/lib/account-type.ts')

test('tipo de cuenta: admin gana, partner por membresía, dueño por uso', () => {
  assert.equal(A.accountType({ role: 'admin', isPartner: true, ownerUse: true }), 'admin')
  assert.equal(A.accountType({ role: 'user', isPartner: true, ownerUse: false }), 'partner')
  assert.equal(A.accountType({ role: 'partner', isPartner: true, ownerUse: true }), 'partner_dueno')
  // El rol solo no hace partner: sin membresía es Usuario.
  assert.equal(A.accountType({ role: 'partner', isPartner: false, ownerUse: false }), 'usuario')
  assert.equal(A.accountType({ role: 'user', isPartner: false, ownerUse: false }), 'usuario')
})

test('cuentan como usuario: Usuario y Partner + dueño, nunca un partner puro ni un admin', () => {
  assert.deepEqual(
    A.ACCOUNT_TYPES.filter(A.countsAsUser),
    ['usuario', 'partner_dueno'],
  )
})

test('últimos 10 dígitos', () => {
  assert.equal(A.lastTenDigits('+54 9 11 2222-3333'), '1122223333')
  assert.equal(A.lastTenDigits('2222-3333'), null)
  assert.equal(A.lastTenDigits(null), null)
})
