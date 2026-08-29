// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY MODULE
//
// The marker import is erased at build time, but the Start import-protection
// plugin uses it to poison this module for the client graph. `vite.config.ts`
// additionally blocks the whole `src/server/**` tree from the client
// environment, so a stray import fails the build instead of shipping the
// connection string to a browser.
// ─────────────────────────────────────────────────────────────────────────────
import '@tanstack/react-start/server-only'

import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg'

/**
 * Postgres access for the admin panel.
 *
 * DECISION (taken, not a default): the panel talks to Postgres directly and
 * leans on stored procedures, rather than going through the hex API. This
 * deliberately departs from autolibre-mobile's "new adapters target the hex
 * backend by default" rule, because the admin's work IS the SQL that already
 * exists — `approve_partner_application()`, the `v_partner_application_queue`
 * view, and the runbook in the backend's `scripts/sql/`. Re-expressing those as
 * REST endpoints would add a hop without adding a rule.
 *
 * What this does NOT license: putting domain decisions in SQL. The backend's
 * condition on `approve_partner_application()` still holds — it moves state and
 * copies data, it does not decide. Anything that decides belongs in a use case.
 */

const connectionString = process.env.POSTGRES_DATABASE_URL

/**
 * Missing config fails on FIRST USE, never at module load.
 *
 * The obvious version of this check is a bare `throw` in module scope, and it
 * was wrong in a way that only showed up on Vercel: the serverless entry
 * imports every route handler up front (`loadEntries` → `Promise.all`), so a
 * module-scope throw takes down the whole cold start. Every route 500s —
 * `/login`, `/api/health`, the error page — which removes the only surfaces
 * that could have told you which env var was missing and where.
 *
 * Failing here instead keeps the process alive: routes that never touch
 * Postgres keep serving, `/api/health` still reports the deploy target, and the
 * error lands on the request that actually needed a database, with a stack that
 * points at the query.
 *
 * `new Pool()` below stays eager on purpose — pg does not dial anything at
 * construction, so an unconfigured pool costs nothing until someone queries it.
 */
function assertConfigured(): void {
  if (!connectionString) {
    throw new Error(
      'Falta POSTGRES_DATABASE_URL — el panel no puede consultar la base sin eso. ' +
        'En local va en .env; en Vercel es una env var del proyecto, y hay que ' +
        'redeployar después de cargarla (Vercel no la inyecta en deployments existentes).',
    )
  }
}

/**
 * TLS is configured in code, NEVER through `sslrootcert=` in the URL.
 *
 * `sslmode=verify-full&sslrootcert=./ca-certificate.crt` works on a laptop and
 * dies on the deploy with `ENOENT: no such file or directory, open
 * './ca-certificate.crt'`. Two independent reasons, and fixing only one still
 * leaves it broken:
 *
 *  1. `pg-connection-string` resolves `sslrootcert` with a real
 *     `fs.readFileSync()` (index.js:99) while PARSING the URL — that is, inside
 *     `new Pool()`, before anything dials Postgres. The path is a plain string
 *     in an env var, so no bundler traces it: the file is in the repo, it is
 *     not in the serverless bundle.
 *  2. Even bundled, `./` resolves against `process.cwd()`, which on Vercel is
 *     the function root (`/var/task`), not the repo root.
 *
 * So the certificate travels as content, not as a path: `POSTGRES_CA_CERT`
 * holds the PEM itself (or its base64, for env UIs that mangle newlines).
 * DigitalOcean's managed Postgres is signed by its own CA, so without this the
 * only working alternative is `rejectUnauthorized: false` — which is not
 * "verify-full minus a file", it is no verification at all.
 */
function resolveSsl(): PoolConfig['ssl'] {
  const raw = process.env.POSTGRES_CA_CERT?.trim()
  if (!raw) return undefined

  const ca = raw.includes('-----BEGIN CERTIFICATE-----')
    ? // Some env UIs (and every `.env` parser) collapse real newlines into the
      // literal two characters `\` + `n`. OpenSSL rejects that PEM without
      // saying why, so normalise before handing it over.
      raw.replace(/\\n/g, '\n')
    : Buffer.from(raw, 'base64').toString('utf8')

  // `rejectUnauthorized: true` plus node's default `checkServerIdentity` IS
  // libpq's `verify-full`: chain against this CA *and* match the hostname.
  return { ca, rejectUnauthorized: true }
}

/**
 * Strip the libpq SSL params out of the URL before `pg` ever parses them.
 *
 * Defensive on purpose: the env var is edited by humans in a Vercel form, and a
 * leftover `sslrootcert=` brings back the `readFileSync` at pool construction —
 * a crash at module load, exactly the cold-start failure `assertConfigured()`
 * exists to avoid. Killing the params here makes the URL carry credentials and
 * host only; TLS is `resolveSsl()`'s job, and only its job.
 */
function withoutUrlSslParams(url: string | undefined): string | undefined {
  if (!url) return url
  try {
    const parsed = new URL(url)
    for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) {
      parsed.searchParams.delete(key)
    }
    return parsed.toString()
  } catch {
    // Not a parseable URL — let `pg` produce its own error at query time
    // instead of masking it with a URL parsing error here.
    return url
  }
}

/**
 * One pool per process. Parked on `globalThis` because Vite re-executes SSR
 * modules on change in dev; without this, every HMR cycle would leak a pool and
 * eventually exhaust Postgres' connection limit.
 */
const globalForDb = globalThis as unknown as { __autolibrePool?: Pool }

export const pool: Pool =
  globalForDb.__autolibrePool ??
  (globalForDb.__autolibrePool = new Pool({
    connectionString: withoutUrlSslParams(connectionString),
    ssl: resolveSsl(),
    // Small on purpose: an admin panel has a handful of concurrent operators,
    // and the same database serves the mobile API.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  }))

/**
 * Typed query helper.
 *
 * The generic is the caller's claim about the row shape — Postgres cannot
 * verify it, so treat every `sql<T>` call as an assertion that has to be read
 * against the actual SELECT list. Never widen it to `any`.
 */
export async function sql<T extends QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<Array<T>> {
  assertConfigured()
  const result = await pool.query<T>(text, params as Array<unknown>)
  return result.rows
}

/** Single-row variant. Returns `null` rather than throwing on an empty result. */
export async function sqlOne<T extends QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<T | null> {
  const rows = await sql<T>(text, params)
  return rows[0] ?? null
}

/**
 * Run several statements as one unit.
 *
 * This is not optional for the approval flow: `approve_partner_application()`
 * creates the partner and a second statement loads its rubros. If the second
 * fails on its own, the partner exists with zero services — active, listed
 * without filters, and invisible under every chip in the app. That is the exact
 * silent failure the DBeaver runbook has to catch after the fact (its query 6).
 * A transaction makes it unrepresentable.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertConfigured()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => {
      // Rollback can fail if the connection already died. Surface the original
      // error, not this one — it is the cause, and the one worth reading.
    })
    throw cause
  } finally {
    client.release()
  }
}
