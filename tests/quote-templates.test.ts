// node --test tests/   (Node 24 corre TypeScript sin compilar)
//
// `~/lib/quote-templates` importa con el alias `~/` (como todo el panel). Node
// no lo conoce: un hook de resolución lo traduce a `src/…ts` antes de importar.
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

const T = await import('../src/lib/quote-templates.ts')
type Detail = import('../src/lib/quote-requests.ts').QuoteRequestDetail
type Entry = import('../src/lib/quote-templates.ts').QuoteMessageEntry

/** Un pedido mínimo: sólo los campos que lee el render, el resto vacío. */
function detail(over: Partial<Detail> = {}): Detail {
  return {
    publicNumber: 1234,
    contactName: 'Laura',
    contactPhone: '5491122223333',
    contactEmail: 'laura@example.invalid',
    plate: 'AB123CD',
    vehicleId: null,
    catalogLabel: null,
    catalogShortLabel: null,
    vehicleText: 'Peugeot 208 1.6 2019',
    description: 'Ruido al frenar',
    locationAddress: 'Av. Maipú 1234',
    locationLocality: 'Olivos',
    locationProvince: 'Buenos Aires',
    timingAndParts: { available: true, timing: null, preferredDate: null, partsSupply: null },
    templateFacts: { serviceNames: [], motor: null, problemPhotoCount: 0 },
    ...over,
  } as unknown as Detail
}

function entry(over: Partial<Entry> = {}): Entry {
  return {
    name: 'Taller Norte',
    address: 'Av. Siempre Viva 742',
    phone: '1123456789',
    hours: null,
    partnerSlug: null,
    amountMin: 85000,
    amountMax: 85000,
    currency: 'ARS',
    items: [],
    validUntil: null,
    expired: null,
    detail: 'Cambio de pastillas',
    recommendationReason: null,
    rating: null,
    ...over,
  }
}

const tpl = (id: string) => T.QUOTE_TEMPLATES.find((t) => t.id === id)!

// ── La regla de la línea ─────────────────────────────────────────────────────

test('una variable vacía se lleva la línea entera y no deja huecos dobles', () => {
  const out = T.applyTemplate('A\n* Cuándo: {{cuando}}\n\n{{x}}\n\nB', { cuando: '', x: '' })
  assert.equal(out, 'A\n\nB')
})

test('una variable desconocida queda entre llaves', () => {
  assert.equal(T.applyTemplate('Hola {{otra}}', {}), 'Hola {{otra}}')
})

// ── Caso 1: pedido de WhatsApp sin timing ni repuestos ───────────────────────

test('WhatsApp sin cuándo ni repuestos: esas líneas desaparecen', () => {
  const d = detail({ timingAndParts: { available: true, timing: null, preferredDate: null, partsSupply: null } })
  const out = T.renderQuoteTemplate(tpl('cotizacion_red'), d)
  assert.doesNotMatch(out, /Para cuándo|Repuestos|\{\{/)
  assert.doesNotMatch(out, /\n\n\n/)
  assert.match(out, /AL-1234/)
})

// ── Caso 2: pedido de la app completo ────────────────────────────────────────

test('pedido de la app completo: todas las variables se completan', () => {
  const d = detail({
    vehicleId: 'v1',
    catalogLabel: 'NISSAN NOTE ADVANCE 1.6 2019',
    catalogShortLabel: 'NISSAN NOTE',
    timingAndParts: { available: true, timing: 'date', preferredDate: '2026-12-05', partsSupply: 'customer' },
    templateFacts: { serviceNames: ['Frenos', 'Alineación'], motor: '1.6 · Nafta · Manual 5 marchas', problemPhotoCount: 2 },
  })
  const out = T.renderQuoteTemplate(tpl('cotizacion_red'), d)
  assert.match(out, /Para cuándo: 05\/12/)
  assert.match(out, /Repuestos: Los lleva el cliente/)
  assert.match(out, /Servicios: Frenos, Alineación/)
  assert.match(out, /Motor: 1\.6 · Nafta · Manual 5 marchas/)
  assert.match(out, /Hay 2 fotos del problema/)
  assert.match(out, /Nissan Note Advance 1\.6 2019/)
  assert.doesNotMatch(out, /\{\{/)

  const persona = T.renderQuoteTemplate({ audience: 'persona', content: 'Hola {{nombre}}, {{cuando}} · {{repuestos}}' }, d)
  assert.equal(persona, 'Hola Laura, 05/12 · Los lleva el cliente')

  assert.equal(T.quoteTimingValue(detail({ timingAndParts: { available: true, timing: 'asap', preferredDate: null, partsSupply: 'workshop' } })), 'Lo antes posible')
  assert.equal(T.quotePartsValue(detail({ timingAndParts: { available: true, timing: 'this_week', preferredDate: null, partsSupply: 'workshop' } })), 'Los pone el taller')
})

// ── Caso 3: montos y reseñas ─────────────────────────────────────────────────

test('propuesta con sólo amount_min y con rango', () => {
  const solo = T.proposalTemplateValues(entry({ amountMin: 85000, amountMax: 85000 }), 1, 'AL-1')
  assert.match(solo.monto, /^\$\s?85\.000$/)
  const rango = T.proposalTemplateValues(entry({ amountMin: 80000, amountMax: 95000 }), 1, 'AL-1')
  assert.match(rango.monto, /^\$\s?80\.000 a \$\s?95\.000$/)
  const sinPrecio = T.proposalTemplateValues(entry({ amountMin: null, amountMax: null }), 1, 'AL-1')
  assert.equal(sinPrecio.monto, '')
})

test('taller con y sin reseñas', () => {
  assert.equal(T.formatPartnerRating({ average: 4.6, count: 12 }), '4,6 ★ (12 reseñas)')
  assert.equal(T.formatPartnerRating({ average: 5, count: 1 }), '5,0 ★ (1 reseña)')
  assert.equal(T.formatPartnerRating(null), '')

  const d = detail()
  const con = T.renderQuoteTemplate(tpl('presupuestos'), d, [entry({ rating: { average: 4.6, count: 12 } })])
  assert.match(con, /Calificación: 4,6 ★ \(12 reseñas\)/)
  const sin = T.renderQuoteTemplate(tpl('presupuestos'), d, [entry({ rating: null })])
  assert.doesNotMatch(sin, /Calificación/)
})

test('whatsapp_taller va como link wa.me normalizado; el teléfono crudo sólo si no se puede', () => {
  const ok = T.proposalTemplateValues(entry({ phone: '11 2345-6789' }), 1, 'AL-1')
  assert.match(ok.whatsapp_taller, /^https:\/\/wa\.me\/5491123456789\?text=/)
  assert.equal(ok.telefono_taller, '')
  const raro = T.proposalTemplateValues(entry({ phone: '1234' }), 1, 'AL-1')
  assert.equal(raro.whatsapp_taller, '')
  assert.equal(raro.telefono_taller, '1234')
})

test('valido_hasta e ítems', () => {
  const v = T.proposalTemplateValues(
    entry({
      validUntil: '2026-12-31',
      items: [
        { label: 'Pastillas', amount: 45000, optional: false },
        { label: 'Discos', amount: 60000, optional: true },
      ],
    }),
    2,
    'AL-1',
  )
  assert.equal(v.valido_hasta, '31/12/2026')
  assert.match(v.items, /• Pastillas: \$\s?45\.000\n➕ Opcionales:\n {3}• Discos: \$\s?60\.000/)
  assert.equal(v.numero, '2')
})

// ── Caso 5: privacidad ───────────────────────────────────────────────────────

test('las plantillas de taller no ofrecen ninguna variable de contacto de la persona', () => {
  const contacto = ['nombre', 'telefono', 'email', 'patente', 'zona', 'direccion', 'contacto']
  for (const v of T.TEMPLATE_VARIABLES.taller) assert.ok(!contacto.includes(v.key), `taller expone ${v.key}`)
})

test('una variable de persona en una plantilla de taller nunca se completa', () => {
  const out = T.renderQuoteTemplate({ audience: 'taller', content: 'Pedido {{codigo}} de {{nombre}} ({{patente}})' }, detail())
  assert.equal(out, 'Pedido AL-1234 de {{nombre}} ({{patente}})')
})

test('las dos plantillas de taller de semilla no traen el contacto de la persona', () => {
  const d = detail({ contactName: 'Laura Pérez', contactPhone: '5491122223333', contactEmail: 'laura@example.invalid' })
  for (const id of ['cotizacion_red', 'cotizacion_nuevo']) {
    const out = T.renderQuoteTemplate(tpl(id), d)
    for (const dato of ['Laura', '5491122223333', '22223333', 'laura@example.invalid', 'AB123CD', 'Maipú']) {
      assert.ok(!out.includes(dato), `${id} expone ${dato}`)
    }
  }
})

test('el formato de cada propuesta de semilla no cambia el mensaje de siempre', () => {
  const out = T.renderQuoteTemplate(tpl('presupuestos'), detail(), [
    entry({ recommendationReason: 'El más rápido', hours: 'Lun a vie 8 a 18' }),
  ])
  assert.match(out, /1\. Taller Norte\n⭐ Te lo recomendamos: El más rápido\n📍 Av\. Siempre Viva 742\n💬 WhatsApp: https:\/\/wa\.me\//)
  assert.match(out, /🕘 Lun a vie 8 a 18\n💵 \$\s?85\.000\nCambio de pastillas/)
})
