// One-off: regenera `src/server/pba-localities.json` desde Georef (datos.gob.ar).
//
//   node scripts/fetch-pba-localities.mjs
//
// Es el dato de referencia que usa `src/server/vehicle-location.ts` para pasar
// de LOCALIDAD (lo que trae `vehicle_plate_lookups`) a PARTIDO (lo que decide
// si un auto es de AMBA). Se usa `asentamientos` y no `localidades` porque es
// superconjunto: trae barrios y parajes que la otra no.
//
// No corre en runtime ni en el build: el JSON queda versionado en el repo, y
// este script existe para que regenerarlo no sea un trabajo a mano.
// → `.claude/rules/vehicle-location.md`

import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const URL_ASENTAMIENTOS =
  'https://apis.datos.gob.ar/georef/api/asentamientos?provincia=06&max=5000&campos=nombre,departamento.nombre'

const res = await fetch(URL_ASENTAMIENTOS)
if (!res.ok) throw new Error(`Georef respondió ${res.status}`)
const body = await res.json()
const rows = body.asentamientos
if (!Array.isArray(rows) || rows.length < 1000) {
  throw new Error(`Respuesta inesperada de Georef: ${rows?.length ?? 'sin'} asentamientos`)
}

// Pares [localidad, partido], deduplicados y ordenados para que el diff de una
// regeneración sea legible.
const pairs = [...new Set(rows.map((r) => `${r.nombre}\u0000${r.departamento.nombre}`))]
  .map((k) => k.split('\u0000'))
  .sort((a, b) => a[0].localeCompare(b[0], 'es') || a[1].localeCompare(b[1], 'es'))

const out = fileURLToPath(new URL('../src/server/pba-localities.json', import.meta.url))
await writeFile(
  out,
  JSON.stringify({
    source: 'Georef — apis.datos.gob.ar/georef/api/asentamientos?provincia=06',
    fetchedAt: new Date().toISOString().slice(0, 10),
    pairs,
  }) + '\n',
)
console.log(`${pairs.length} pares localidad → partido en ${out}`)
