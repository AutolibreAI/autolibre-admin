/**
 * Armar un CSV para bajar — el primer EXPORT del panel (2026-11-25, «Resolución
 * de pedidos»). El otro CSV del repo va al revés: es el importador de contactos
 * (`parseProspectCsv` en `~/lib/partner-prospects`), que ya acepta `,` o `;`.
 *
 * Tres decisiones, y las tres son por cómo lo abre el equipo:
 *
 * - **Separador `;`**: Excel con configuración regional es-AR usa `;` como
 *   separador de listas; con `,` abre todo en una sola columna. Google Sheets
 *   detecta los dos.
 * - **BOM UTF-8 adelante**: sin él, Excel lee el archivo como ANSI y rompe los
 *   acentos («Resoluci├│n»).
 * - **Fórmulas neutralizadas**: un texto que arranca con `= + - @` (o tab/CR)
 *   Excel lo EJECUTA como fórmula, y acá viajan textos que tipeó otra persona
 *   (nombre, nota). Se antepone `'`. Sólo a los strings: un número real no es
 *   una fórmula.
 *
 * Client-safe y SIN imports: lo prueba `node --test` directo (`tests/csv.test.ts`).
 */

export const CSV_SEPARATOR = ';'

export type CsvCell = string | number | null | undefined

const FORMULA_START = /^[=+\-@\t\r]/
const NEEDS_QUOTES = /[";,\r\n]/

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return String(value)
  const text = FORMULA_START.test(value) ? `'${value}` : value
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** El archivo entero: BOM, encabezado, una línea por fila, CRLF y salto final. */
export function toCsv(header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<CsvCell>>): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(CSV_SEPARATOR))
  return `﻿${lines.join('\r\n')}\r\n`
}
