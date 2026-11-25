// node --test tests/   (Node 24 corre TypeScript sin compilar)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CSV_SEPARATOR, csvCell, toCsv } from '../src/lib/csv.ts'

test('separador punto y coma (Excel en es-AR)', () => {
  assert.equal(CSV_SEPARATOR, ';')
})

test('celdas vacías, números y texto simple', () => {
  assert.equal(csvCell(null), '')
  assert.equal(csvCell(undefined), '')
  assert.equal(csvCell(3), '3')
  assert.equal(csvCell('Juan'), 'Juan')
})

test('se entrecomilla lo que tiene separador, comillas o saltos de línea', () => {
  assert.equal(csvCell('a;b'), '"a;b"')
  assert.equal(csvCell('dijo "hola"'), '"dijo ""hola"""')
  assert.equal(csvCell('línea 1\nlínea 2'), '"línea 1\nlínea 2"')
  assert.equal(csvCell('a,b'), '"a,b"')
})

test('una celda que arranca como fórmula se neutraliza', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`)
  assert.equal(csvCell('+5491100000000'), "'+5491100000000")
  assert.equal(csvCell('-1'), "'-1")
  assert.equal(csvCell('@x'), "'@x")
  // Un número de verdad no es texto: no se toca.
  assert.equal(csvCell(-1), '-1')
})

test('el archivo: BOM, encabezado, CRLF y salto final', () => {
  const out = toCsv(
    ['Pedido', 'Nota'],
    [
      ['AL-1', 'ok'],
      ['AL-2', null],
    ],
  )
  assert.equal(out, '﻿Pedido;Nota\r\nAL-1;ok\r\nAL-2;\r\n')
})

test('sin filas queda sólo el encabezado', () => {
  assert.equal(toCsv(['A'], []), '﻿A\r\n')
})
