// node --test tests/   (Node 24 corre TypeScript sin compilar)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toWhatsAppAR } from '../src/lib/whatsapp-ar.ts'

const OK: Array<[string, string]> = [
  ['+54 9 11 2512-0472', '5491125120472'],
  ['+54 11 2512-0472', '5491125120472'],
  ['011 15 2512-0472', '5491125120472'],
  ['11 2512 0472', '5491125120472'],
  ['1125120472', '5491125120472'],
  ['5491125120472', '5491125120472'],
  ['+54 9 341 555-1234', '5493415551234'],
  ['0341 15 555-1234', '5493415551234'],
  // Extra: 00 internacional, 15 con característica de 4 dígitos, 9 + 15 juntos.
  ['0054 9 11 2512-0472', '5491125120472'],
  ['02202 15 45-6789', '5492202456789'],
  ['+54 9 11 15 2512-0472', '5491125120472'],
]

for (const [input, digits] of OK) {
  test(`ok: ${input}`, () => {
    assert.deepEqual(toWhatsAppAR(input), { ok: true, digits })
  })
}

const FAIL = ['2512-0472', '', 'sin número', '15 2512-0472', '+54 9 11 2512-04721', '4512345678', '3412345678901']

for (const input of FAIL) {
  test(`no normalizable: ${JSON.stringify(input)}`, () => {
    const r = toWhatsAppAR(input)
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.reason.length > 0)
  })
}
