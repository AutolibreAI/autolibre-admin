// ═══════════════════════════════════════════════════════════════════════════
// Runner de migraciones del schema `ops`.
//
// ALCANCE, Y ES ESTRECHO A PROPÓSITO: esto migra SOLO `ops`, el schema que el
// panel posee. `public` es del backend y lo migra Drizzle desde
// autolibre-backend-hex. Este script no lo toca y no debería aprender a hacerlo.
//
// POR QUÉ EXISTE: sin un runner, crear `ops` significa pegar DDL a mano en
// DBeaver — que es exactamente el problema que este repo existe para eliminar.
// Un schema propio sin migraciones versionadas no es independencia, es el mismo
// trabajo manual con un nombre nuevo.
//
//   node --env-file-if-exists=.env scripts/migrate.mjs            aplica pendientes
//   node --env-file-if-exists=.env scripts/migrate.mjs --status   qué hay aplicado
//   node --env-file-if-exists=.env scripts/migrate.mjs --dry-run  qué aplicaría
//   node --env-file-if-exists=.env scripts/migrate.mjs --on-deploy  ídem, pero
//                                                     sólo si el entorno lo habilita
//
// (o `pnpm db:migrate`, `pnpm db:migrate:status`, `pnpm db:migrate:dry`;
//  `--on-deploy` lo usa `pnpm vercel-build`, no se corre a mano)
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(HERE, '..', 'migrations')

const args = new Set(process.argv.slice(2))
const DRY_RUN = args.has('--dry-run')
const STATUS = args.has('--status')
const ON_DEPLOY = args.has('--on-deploy')

const connectionString = process.env.POSTGRES_DATABASE_URL

/**
 * ¿Este build tiene permiso para migrar?
 *
 * POR QUÉ EXISTE ESTA COMPUERTA: Vercel no tiene hook de post-deploy, así que
 * el único lugar donde el panel puede aplicar sus migraciones es el BUILD. Y el
 * build no corre sólo en producción — corre en cada preview, en cada push a
 * cada rama. Sin compuerta, una rama sin mergear le aplica sus migraciones a la
 * base de producción, en silencio y antes de que nadie las revise.
 *
 * El default es `production`: se migra únicamente cuando Vercel dice que este
 * build es el de producción.
 *
 *   OPS_MIGRATE_ON_DEPLOY=production  (default) sólo en el deploy de producción
 *   OPS_MIGRATE_ON_DEPLOY=always      siempre — para una preview con base propia
 *   OPS_MIGRATE_ON_DEPLOY=never       nunca — las migraciones se aplican a mano
 *
 * Devuelve `true` si hay que migrar. Corta el build (exit 1) si el entorno no
 * alcanza para decidir: ver el caso de `VERCEL_ENV` ausente, abajo.
 */
function deployGateOpen() {
  const mode = (process.env.OPS_MIGRATE_ON_DEPLOY ?? 'production').trim().toLowerCase()

  if (mode === 'never') {
    console.log('\n  Migraciones salteadas: OPS_MIGRATE_ON_DEPLOY=never.\n')
    return false
  }

  if (mode === 'always') return true

  if (mode !== 'production') {
    console.error(
      `\n  OPS_MIGRATE_ON_DEPLOY="${mode}" no es un valor válido.\n` +
        '  Los únicos son: production | always | never.\n',
    )
    process.exit(1)
  }

  // Los dos marcadores, por la misma razón que `vite.config.ts` chequea los dos:
  // `VERCEL` depende del toggle de system env vars, `NOW_BUILDER` lo pone el
  // contenedor de build y no depende de nada.
  const onBuilder = Boolean(process.env.VERCEL ?? process.env.NOW_BUILDER)
  if (!onBuilder) {
    console.log(
      '\n  Migraciones salteadas: esto no es un build de Vercel.\n' +
        '  En una máquina las migraciones se aplican a mano, con `pnpm db:migrate`.\n',
    )
    return false
  }

  const vercelEnv = process.env.VERCEL_ENV

  if (vercelEnv === 'production') return true

  if (vercelEnv) {
    console.log(
      `\n  Migraciones salteadas: VERCEL_ENV=${vercelEnv}, no es el deploy de producción.\n`,
    )
    return false
  }

  /**
   * Builder de Vercel SIN `VERCEL_ENV`: pasa cuando el proyecto tiene apagado
   * "Automatically expose System Environment Variables".
   *
   * Acá no se puede distinguir producción de preview, y las dos salidas
   * silenciosas son malas: migrar producción desde una preview, o saltear la
   * migración en producción y enterarse en el primer request con
   * `relation "ops.v_ai_usage_costed" does not exist` — un deploy verde que
   * revienta recién cuando alguien abre la pantalla.
   *
   * Así que corta el build. Es ruidoso a propósito y se arregla una sola vez.
   */
  console.error(
    '\n  Build de Vercel sin VERCEL_ENV: no se puede distinguir producción de preview.\n\n' +
      '  Se corta a propósito — adivinar acá significa o migrar producción desde\n' +
      '  una rama sin mergear, o deployar producción sin su migración y descubrirlo\n' +
      '  en el primer request.\n\n' +
      '  Arreglo (cualquiera de los dos):\n' +
      '   · Vercel → Settings → Environment Variables → activar\n' +
      '     "Automatically expose System Environment Variables".\n' +
      '   · O fijar OPS_MIGRATE_ON_DEPLOY (always | never) en el entorno que\n' +
      '     corresponda.\n',
  )
  process.exit(1)
}

/**
 * TLS igual que en `src/server/db.ts`: el CA viaja como CONTENIDO en
 * `POSTGRES_CA_CERT`, no como `sslrootcert=` en la URL.
 *
 * Este runner corre en una laptop, donde `./ca-certificate.crt` SÍ existe — pero
 * si la URL de `.env` la comparte con el panel (y la comparte), tiene que
 * funcionar con la URL ya limpia de parámetros SSL. Sin esto, sacarle el
 * `sslmode` a la URL para arreglar el deploy rompe `pnpm db:migrate`, que es el
 * peor momento para descubrirlo.
 */
function resolveSsl() {
  // Contra localhost el CA se ignora: el Postgres de desarrollo no habla TLS y
  // `pg` moriría con `The server does not support SSL connections`.
  if (targetsLocalhost(connectionString)) return undefined

  const raw = process.env.POSTGRES_CA_CERT?.trim()

  // Remoto sin CA propio → TLS contra el trust store del sistema, NUNCA texto
  // plano. Neon usa CA público (no necesita la variable); DigitalOcean firma con
  // CA propia (sí la necesita). La ausencia de CA no autoriza a no cifrar.
  if (!raw) return { rejectUnauthorized: true }
  const ca = raw.includes('-----BEGIN CERTIFICATE-----')
    ? raw.replace(/\\n/g, '\n')
    : Buffer.from(raw, 'base64').toString('utf8')
  return { ca, rejectUnauthorized: true }
}

/** Solo un Postgres en la misma máquina puede hablar sin cifrar. */
function targetsLocalhost(url) {
  try {
    const { hostname } = new URL(url)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  } catch {
    return false
  }
}

/** Saca los parámetros SSL de libpq: los resuelve `resolveSsl()`, no la URL. */
function withoutUrlSslParams(url) {
  try {
    const parsed = new URL(url)
    for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) {
      parsed.searchParams.delete(key)
    }
    return parsed.toString()
  } catch {
    return url
  }
}

/**
 * Lee y ordena los archivos.
 *
 * El orden es por nombre, así que el prefijo numérico ES el orden de ejecución.
 * Se usa padding de 3 dígitos porque un `10_x.sql` ordenaría antes que `9_x.sql`
 * en comparación de strings, y ese bug aparece recién en la décima migración —
 * cuando ya nadie se acuerda de esta decisión.
 *
 * ── `*.test.sql` NO es una migración ──────────────────────────────────────
 *
 * Las suites de prueba de los stored procedures viven al lado de la migración
 * que prueban, porque es donde se van a buscar. Pero son otra cosa: empiezan en
 * `BEGIN` y terminan en `ROLLBACK`, y aplicarlas no deja nada.
 *
 * Sin este filtro, `008_x.test.sql` parsea la MISMA versión `008` que
 * `008_x.sql` y el runner las trata como dos migraciones con el mismo número:
 * la segunda choca por checksum contra la primera ya aplicada. El error habla
 * de "drift", que manda a investigar una migración corrupta que no existe.
 */
function readMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return []

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.test.sql'))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
      const version = file.match(/^(\d+)/)?.[1]
      if (!version) {
        throw new Error(
          `La migración "${file}" no arranca con un número. El nombre define el orden de ejecución.`,
        )
      }
      return {
        version,
        file,
        sql,
        /**
         * El checksum se calcula sobre el contenido NORMALIZADO a LF.
         *
         * Sobre los bytes crudos es dependiente de la plataforma, y eso rompe
         * de verdad: con `core.autocrlf=true` (el default de Git en Windows)
         * los `.sql` se registran en LF y se hacen checkout en CRLF. Una
         * migración aplicada desde Linux —el build de Vercel, por ejemplo—
         * guarda el hash de la versión LF, y la misma migración leída después
         * desde Windows hashea distinto sin que UNA SOLA LÍNEA de SQL haya
         * cambiado.
         *
         * Verificado el 2026-09-04 contra producción: las 7 migraciones
         * aplicadas daban drift desde Windows, y las 7 coincidían exactamente
         * con el hash de su versión LF. El mensaje que sale de ahí —"la base ya
         * no coincide con el archivo"— manda a investigar una corrupción que no
         * existe, y peor, entrena a ignorar la advertencia que sí importa.
         *
         * Normalizar sólo cambia el FINGERPRINT. El SQL que se ejecuta sigue
         * siendo `sql`, tal cual está en disco.
         */
        checksum: crypto
          .createHash('sha256')
          .update(sql.replace(/\r\n/g, '\n'))
          .digest('hex'),
      }
    })
}

/**
 * Crea lo mínimo para poder llevar la cuenta.
 *
 * Este bloque es el único DDL que vive en JavaScript y no en un `.sql`, y es
 * inevitable: la tabla que registra las migraciones no puede registrarse a sí
 * misma. Todo lo demás va en `migrations/`.
 */
async function bootstrap(client) {
  await client.query('CREATE SCHEMA IF NOT EXISTS ops')
  await client.query(`
    CREATE TABLE IF NOT EXISTS ops.schema_migrations (
      version     text PRIMARY KEY,
      name        text        NOT NULL,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer
    )
  `)
}

async function main() {
  // La compuerta va ANTES del chequeo de la URL: una preview sin
  // POSTGRES_DATABASE_URL no tiene por qué romper su build por una migración
  // que igual no le tocaba correr.
  if (ON_DEPLOY && !deployGateOpen()) return

  if (!connectionString) {
    console.error(
      '\n  Falta POSTGRES_DATABASE_URL.\n' +
        '  En local va en .env (el script lo lee con --env-file-if-exists).\n' +
        '  En Vercel es una env var del proyecto, y tiene que estar disponible en\n' +
        '  BUILD además de en runtime — si no, este script no ve la base.\n',
    )
    process.exit(1)
  }

  const client = new pg.Client({
    connectionString: withoutUrlSslParams(connectionString),
    ssl: resolveSsl(),
  })
  await client.connect()

  try {
    /**
     * Lock de sesión antes de tocar nada.
     *
     * Dos `pnpm db:migrate` simultáneos (un deploy y alguien en su máquina)
     * leerían los mismos pendientes y los aplicarían dos veces. La segunda
     * corrida no falla prolijamente: revienta a mitad de camino con un
     * "already exists" y deja el registro inconsistente con la realidad.
     */
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [
      'autolibre-admin:ops:migrations',
    ])

    await bootstrap(client)

    const { rows: applied } = await client.query(
      'SELECT version, name, checksum, applied_at FROM ops.schema_migrations ORDER BY version',
    )
    const appliedByVersion = new Map(applied.map((r) => [r.version, r]))
    const migrations = readMigrations()

    /**
     * Editar una migración YA APLICADA es el footgun clásico: el archivo del
     * repo deja de describir lo que la base tiene, en silencio y para siempre.
     * El checksum lo convierte en un error ruidoso.
     *
     * El arreglo correcto nunca es "borrar la fila para que vuelva a correr":
     * es una migración NUEVA que lleve el schema del estado actual al deseado.
     */
    const drifted = migrations.filter((m) => {
      const prev = appliedByVersion.get(m.version)
      return prev && prev.checksum !== m.checksum
    })

    if (drifted.length > 0) {
      console.error('\n  Migraciones ya aplicadas que cambiaron en disco:\n')
      for (const m of drifted) console.error(`   ✗ ${m.file}`)
      console.error(
        '\n  La base ya no coincide con el archivo. No revirtas esto borrando\n' +
          '  la fila de ops.schema_migrations — escribí una migración nueva que\n' +
          '  lleve el schema del estado actual al que querés.\n',
      )
      process.exit(1)
    }

    const pending = migrations.filter((m) => !appliedByVersion.has(m.version))

    if (STATUS) {
      console.log(`\n  ops.schema_migrations — ${applied.length} aplicadas\n`)
      for (const r of applied) {
        console.log(`   ✓ ${r.version}  ${r.name}`)
      }
      if (pending.length === 0) {
        console.log(applied.length ? '\n  Sin pendientes.\n' : '\n  Nada aplicado todavía.\n')
      } else {
        console.log(`\n  ${pending.length} pendiente(s):\n`)
        for (const m of pending) console.log(`   · ${m.file}`)
        console.log('')
      }
      return
    }

    if (pending.length === 0) {
      console.log('\n  Sin migraciones pendientes.\n')
      return
    }

    if (DRY_RUN) {
      console.log(`\n  ${pending.length} pendiente(s) — dry run, no se aplica nada:\n`)
      for (const m of pending) console.log(`   · ${m.file}`)
      console.log('')
      return
    }

    console.log(`\n  Aplicando ${pending.length} migración(es) sobre el schema ops\n`)

    for (const m of pending) {
      const started = Date.now()
      /**
       * Una transacción POR migración, no una sola para todas.
       *
       * Así, si la tercera falla, las dos primeras quedan aplicadas y
       * registradas: la próxima corrida arranca desde la que falló en vez de
       * repetir todo. En Postgres el DDL es transaccional, así que una
       * migración a medio aplicar no existe — o entra entera o no entra.
       */
      await client.query('BEGIN')
      try {
        await client.query(m.sql)
        await client.query(
          `INSERT INTO ops.schema_migrations (version, name, checksum, duration_ms)
           VALUES ($1, $2, $3, $4)`,
          [m.version, m.file, m.checksum, Date.now() - started],
        )
        await client.query('COMMIT')
        console.log(`   ✓ ${m.file}  (${Date.now() - started} ms)`)
      } catch (cause) {
        await client.query('ROLLBACK').catch(() => {
          // Si la conexión ya murió el ROLLBACK falla. El error que importa es
          // el original, no este.
        })
        console.error(`   ✗ ${m.file}\n`)
        console.error(`     ${cause.message}\n`)
        if (cause.position) console.error(`     posición ${cause.position} del archivo\n`)
        process.exit(1)
      }
    }

    console.log('\n  Listo.\n')
  } finally {
    await client
      .query('SELECT pg_advisory_unlock(hashtext($1))', ['autolibre-admin:ops:migrations'])
      .catch(() => {
        // El lock es de sesión: se suelta solo al cerrar la conexión.
      })
    await client.end()
  }
}

main().catch((error) => {
  console.error(`\n  ${error.message}\n`)
  process.exit(1)
})
