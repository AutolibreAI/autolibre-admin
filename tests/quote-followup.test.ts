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

const F = await import('../src/lib/quote-followup.ts')
type Order = import('../src/lib/quote-followup.ts').FollowupOrder

const order = (n: number, over: Partial<Order> = {}): Order => ({
  id: `q${n}`, n, fecha: '2026-11-20', status: 'answered', outcome: null, cierre: null, answeredAt: '2026-11-20T00:00:00Z',
  nombre: 'LAURA perez', tel: '11 2222-3333', plate: 'AB123CD', auto: 'FIAT CRONOS 2020', servicios: null,
  descr: 'Cambio de pastillas', proposals: [], elegido: null, sentAt: null, sentByName: null, ...over,
})

test('agrupa por teléfono normalizado y clasifica', () => {
  const cs = F.buildFollowupContacts(
    [
      order(1, { proposals: [{ id: 'p1', partnerId: 'x', name: 'Taller Uno' }] }),
      order(2, { tel: '+54 9 11 2222-3333', fecha: '2026-11-22' }),
      order(3, { tel: '1144445555', outcome: 'no_response' }),
      order(4, { tel: '1155556666', descr: 'Perfecto estado' }),
    ],
    '2026-11-25',
  )
  assert.equal(cs.length, 2)
  const laura = cs.find((c) => c.key === '5491122223333')!
  assert.equal(laura.pedidos.length, 2)
  assert.equal(laura.group, 'prop')
  assert.equal(cs.find((c) => c.key === '5491144445555')!.group, 'f0')
})

test('mensajes según el caso', () => {
  const reciente = F.buildFollowupMessage(
    { nombre: 'LAURA', group: 'prop', pedidos: [order(1, { fecha: '2026-11-24', proposals: [{ id: 'p', partnerId: null, name: 'Taller Uno' }] })] },
    '2026-11-25',
  )
  assert.match(reciente, /^Hola Laura, ¿cómo estás\? Soy Nicolás, de AutoLibre\./)
  assert.match(reciente, /¿Pudiste ver la propuesta de Taller Uno\?/)
  const viejo = F.buildFollowupMessage(
    { nombre: null, group: 'prop', pedidos: [order(1, { fecha: '2026-11-01', proposals: [{ id: 'p', partnerId: null, name: 'Taller Uno' }] })] },
    '2026-11-25',
  )
  assert.match(viejo, /Te había llegado una propuesta de Taller Uno/)
  const sinTaller = F.buildFollowupMessage({ nombre: null, group: 'sin', pedidos: [order(1, { cierre: 'no_workshops_found' })] }, '2026-11-25')
  assert.match(sinTaller, /no conseguimos mecánicos de tu zona/)
})

test('enviado: todos los pedidos; pedido nuevo si falta uno', () => {
  const [c] = F.buildFollowupContacts([order(1, { sentAt: '2026-11-20T10:00:00Z' }), order(2, { fecha: '2026-11-23' })], '2026-11-25')
  assert.equal(c!.sent, false)
  assert.equal(c!.newOrder, true)
  const [d] = F.buildFollowupContacts([order(1, { sentAt: '2026-11-20T10:00:00Z' })], '2026-11-25')
  assert.equal(d!.sent, true)
})
