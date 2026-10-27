import { MAX_QUOTE_AMOUNT } from '~/lib/quote-responses'

/**
 * Montos y desglose por ítems tal como se TIPEAN en un formulario del panel.
 *
 * Salió de `QuoteResponses.tsx` cuando «Propuestas en la app» necesitó leer
 * los mismos campos con las mismas reglas: un presupuesto de `ops` y una
 * propuesta del backend se cargan con el mismo formulario mental, y si
 * `180.000` se leyera distinto en las dos tarjetas, una de las dos estaría mal.
 * Es código puro, sin React ni server: lo puede importar cualquier lado.
 */

/** Un ítem del desglose mientras se edita. */
export interface ItemDraft {
  /** Sólo para la `key` de React: los ítems no tienen id en la base. */
  key: string
  label: string
  amount: string
  optional: boolean
}

let itemSeq = 0
export const newItemKey = (): string => `item-${++itemSeq}`

/** Un número guardado, de vuelta al formato que lee `parseAmount` (coma decimal, sin miles). */
export const amountToInput = (n: number): string => String(n).replace('.', ',')

/**
 * Lee un monto tipeado en castellano rioplatense: `180.000` son ciento ochenta
 * mil, `180,50` son ciento ochenta con cincuenta. El punto es separador de
 * miles y la coma es decimal — al revés que el default de `Number()`, que
 * leería `180.000` como ciento ochenta.
 *
 * `0` es un valor VÁLIDO y significa "sin cargo"; el vacío es "no pasó
 * precio", y de eso se ocupa el llamador, no esta función.
 */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[\s.]/g, '').replace(',', '.')
  if (cleaned === '' || !/^\d+(\.\d+)?$/.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) && n >= 0 && n <= MAX_QUOTE_AMOUNT ? n : null
}

/**
 * Los ítems tipeados, ya leídos. `invalid` = alguno sin descripción o con un
 * precio que no es un número: no se puede guardar, y el formulario dice cuál.
 */
export function readItems(f: { items: ReadonlyArray<ItemDraft> }): {
  items: Array<{ label: string; amount: number; optional: boolean }>
  invalid: boolean
} {
  let invalid = false
  const items = f.items.map((it) => {
    const amount = parseAmount(it.amount.trim())
    if (it.label.trim() === '' || amount === null) invalid = true
    return { label: it.label.trim(), amount: amount ?? 0, optional: it.optional }
  })
  return { items, invalid }
}

/**
 * Las dos puntas del precio, o `undefined` en las dos si el taller no pasó
 * ninguno. `invalid` separa "no cargó precio" (válido) de "cargó algo que no
 * es un precio" (hay que avisar).
 */
export function readAmounts(f: { amountMin: string; amountMax: string }): {
  min?: number
  max?: number
  invalid: boolean
} {
  const rawMin = f.amountMin.trim()
  const rawMax = f.amountMax.trim()
  if (rawMin === '' && rawMax === '') return { invalid: false }
  // "Hasta" sin "desde" no es un rango ni un precio cerrado: falta la punta
  // que la base necesita para las dos columnas.
  if (rawMin === '') return { invalid: true }
  const min = parseAmount(rawMin)
  if (min === null) return { invalid: true }
  if (rawMax === '') return { min, max: min, invalid: false }
  const max = parseAmount(rawMax)
  if (max === null || min > max) return { invalid: true }
  return { min, max, invalid: false }
}
