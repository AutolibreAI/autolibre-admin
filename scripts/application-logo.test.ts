import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applicationLogoUrl } from '../src/lib/application-logo.ts'
test('normaliza el logo adjunto y mantiene solicitudes anteriores sin imagen', () => {
  assert.equal(
    applicationLogoUrl(' https://cdn.example.com/logo.webp '),
    'https://cdn.example.com/logo.webp',
  )
  for (const value of [
    undefined,
    null,
    '',
    123,
    {},
    'javascript:alert(1)',
    'data:image/png;base64,abc',
    'https://user:password@example.com',
  ])
    assert.equal(applicationLogoUrl(value), null)
})
