// ═══════════════════════════════════════════════════════════════════════════
// Fase 0 de `.claude/plans/partners-derivacion.md` — cargar coordenadas de
// partners geocodificando su `address`.
//
// UN SCRIPT ONE-OFF, DELIBERADO, CORRIDO A MANO — NO UNA DEPENDENCIA DEL PANEL.
// `src/server/**` no lo conoce ni lo importa: el panel sólo LEE
// `partners.latitude/longitude`, de dónde salieron es irrelevante para él.
//
//   node scripts/geocode-partners.mjs --actor <uuid-de-un-admin> --yes
//
// Sin `--yes` corre en modo DRY RUN: geocodifica y muestra qué escribiría,
// sin tocar la base. `--actor` es OBLIGATORIO para escribir — es el
// `p_actor_id` que `ops.set_partner_location` deja en `ops.action_log`; sin
// él no hay forma de auditar quién cargó cada coordenada.
//
// ── Por qué NO escribe directo con un UPDATE ────────────────────────────────
//
// Pasa por `ops.set_partner_location` (migración 007, aplicada en
// producción), los mismos 8 guardrails que cualquier otra escritura del
// panel: `p_actor_id` real, auditoría en `ops.action_log`, y el SP rechaza
// coordenadas incompletas o fuera de rango — un geocoder que devuelva basura
// no entra.
//
// ── La decisión que importa: SÓLO escribe precisión de CALLE ───────────────
//
// Un geocoder puede devolver un centroide de LOCALIDAD cuando no encuentra la
// altura exacta (`Complejo Remeros Plaza - Nordelta`, sin número). Cargar ese
// punto como si fuera la puerta del taller hace que la pantalla de candidatos
// ordene por distancia con números INVENTADOS — el mismo error que
// `scanner-compatibility.md` documenta cuando cuenta fallas como éxitos: un
// número plausible y equivocado no se cacha nunca.
//
// Mejor 35 partners con coordenada buena y 11 sin coordenada (visible como
// "sin ubicación" en el panel) que 46 con una coordenada de la que no se
// puede confiar. Por eso el corte de precisión no es un detalle — es la parte
// que importa de este script.
//
// ── Geocoder ─────────────────────────────────────────────────────────────
//
// `GOOGLE_GEOCODING_API_KEY` en el entorno usa Google Geocoding API (mejor
// calidad en el conurbano bonaerense, costo despreciable para ~43
// direcciones). Sin esa variable cae a Nominatim (OpenStreetMap), gratis,
// respetando su límite de 1 req/s — la corrida completa tarda ~45s por eso.
//
// La API key es un PENDIENTE PARA QUIEN EJECUTE: no está en este repo y no se
// puede resolver desde acá.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs'
import 'dotenv/config'
import pg from 'pg'

const argv = process.argv.slice(2)
const YES = argv.includes('--yes')
const actorIdx = argv.indexOf('--actor')
const ACTOR_ID = actorIdx >= 0 ? argv[actorIdx + 1] : null

if (YES && !ACTOR_ID) {
  console.error('Falta --actor <uuid>. Es obligatorio para escribir (queda en ops.action_log).')
  process.exit(1)
}

if (!process.env.POSTGRES_DATABASE_URL) {
  console.error('Falta POSTGRES_DATABASE_URL en .env.')
  process.exit(1)
}

const GOOGLE_KEY = process.env.GOOGLE_GEOCODING_API_KEY?.trim()

// ── Conexión — mismo patrón que .claude/skills/db-connect/query.mjs ────────

function targetsLocalhost(url) {
  try {
    const { hostname } = new URL(url)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  } catch {
    return false
  }
}

function resolveSsl(url) {
  if (targetsLocalhost(url)) return undefined
  const raw = process.env.POSTGRES_CA_CERT?.trim()
  if (!raw) return { rejectUnauthorized: true }
  const ca = raw.includes('-----BEGIN CERTIFICATE-----') ? raw.replace(/\\n/g, '\n') : Buffer.from(raw, 'base64').toString('utf8')
  return { ca, rejectUnauthorized: true }
}

function withoutUrlSslParams(url) {
  try {
    const parsed = new URL(url)
    for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) parsed.searchParams.delete(key)
    return parsed.toString()
  } catch {
    return url
  }
}

const connectionString = process.env.POSTGRES_DATABASE_URL
const pool = new pg.Pool({
  connectionString: withoutUrlSslParams(connectionString),
  ssl: resolveSsl(connectionString),
})

// ── Geocoders ────────────────────────────────────────────────────────────

/** @returns {Promise<{lat:number,lng:number,precise:boolean,raw:string}|null>} */
async function geocodeGoogle(address) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.searchParams.set('address', address)
  url.searchParams.set('region', 'ar')
  url.searchParams.set('key', GOOGLE_KEY)

  const res = await fetch(url)
  const body = await res.json()
  if (body.status !== 'OK' || !body.results?.[0]) return null

  const result = body.results[0]
  const precise = result.geometry.location_type === 'ROOFTOP' || result.geometry.location_type === 'RANGE_INTERPOLATED'
  return {
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    precise,
    raw: `${result.geometry.location_type} — ${result.formatted_address}`,
  }
}

/** @returns {Promise<{lat:number,lng:number,precise:boolean,raw:string}|null>} */
async function geocodeNominatim(address) {
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', address)
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', '1')
  url.searchParams.set('addressdetails', '0')

  const res = await fetch(url, { headers: { 'User-Agent': 'autolibre-admin geocode-partners.mjs (one-off)' } })
  const body = await res.json()
  if (!body[0]) return null

  const hit = body[0]
  // Nominatim no tiene un flag de "precisión de calle" único; `house`/`building`
  // en `addresstype` (o `class=building`) es lo más parecido. Sin `addressdetails`
  // no viene `addresstype`, así que se pide aparte sólo si hace falta decidir.
  const precise = hit.class === 'building' || hit.type === 'house'
  return { lat: Number(hit.lat), lng: Number(hit.lon), precise, raw: `${hit.class}/${hit.type} — ${hit.display_name}` }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const check = await pool.query('select current_database(), current_user, inet_server_port()')
  const { current_database, current_user, inet_server_port } = check.rows[0]
  console.log(`Conectado a: database=${current_database} user=${current_user} puerto=${inet_server_port}`)
  console.log(`Modo: ${YES ? `ESCRITURA (actor ${ACTOR_ID})` : 'DRY RUN — no se escribe nada'}`)
  console.log(`Geocoder: ${GOOGLE_KEY ? 'Google Geocoding API' : 'Nominatim (1 req/s)'}\n`)

  const { rows: partners } = await pool.query(
    `select id, name, address
       from partners
      where status = 'active'
        and coalesce(btrim(address), '') <> ''
        and latitude is null
      order by name`,
  )

  console.log(`${partners.length} partners activos con dirección y sin coordenadas.\n`)

  const needsReview = []
  let written = 0

  for (const p of partners) {
    const query = /argentina/i.test(p.address) ? p.address : `${p.address}, Argentina`

    let hit
    try {
      hit = GOOGLE_KEY ? await geocodeGoogle(query) : await geocodeNominatim(query)
    } catch (err) {
      console.error(`✗ ${p.name}: error de geocoder — ${err.message}`)
      needsReview.push({ id: p.id, name: p.name, address: p.address, reason: 'geocoder_error' })
      continue
    }

    if (!GOOGLE_KEY) await sleep(1100) // límite de Nominatim: 1 req/s

    if (!hit) {
      console.log(`? ${p.name}: sin resultado (${query})`)
      needsReview.push({ id: p.id, name: p.name, address: p.address, reason: 'no_result' })
      continue
    }

    if (!hit.precise) {
      console.log(`~ ${p.name}: precisión insuficiente — ${hit.raw}`)
      needsReview.push({ id: p.id, name: p.name, address: p.address, reason: 'imprecise', geocoder_raw: hit.raw })
      continue
    }

    console.log(`✓ ${p.name}: ${hit.lat}, ${hit.lng} (${hit.raw})`)

    if (YES) {
      await pool.query('select ops.set_partner_location($1, $2, $3, $4, $5)', [
        p.id,
        hit.lat,
        hit.lng,
        ACTOR_ID,
        `Geocodificado desde "${p.address}" — ${hit.raw}`,
      ])
      written += 1
    }
  }

  console.log(`\n${written} coordenadas escritas.` + (YES ? '' : ' (dry run — nada se escribió)'))

  if (needsReview.length > 0) {
    const csvPath = 'geocode-partners-review.csv'
    const header = 'id,name,address,reason,geocoder_raw\n'
    const lines = needsReview.map(
      (r) =>
        `${r.id},"${r.name.replace(/"/g, '""')}","${r.address.replace(/"/g, '""')}",${r.reason},"${(r.geocoder_raw ?? '').replace(/"/g, '""')}"`,
    )
    fs.writeFileSync(csvPath, header + lines.join('\n') + '\n')
    console.log(`${needsReview.length} para revisar a mano en la ficha del partner → ${csvPath}`)
  }

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
