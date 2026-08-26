// DB query runner for the db-connect skill.
// Reuses the same connection config as
// src/shared/infrastructure/database/postgres/drizzle.provider.ts
// (a single POSTGRES_DATABASE_URL connection string).
//
// Usage:
//   node .claude/skills/db-connect/query.mjs "select 1 as ok"
//   echo "select * from app.users limit 5" | node .claude/skills/db-connect/query.mjs
//   node .claude/skills/db-connect/query.mjs --file path/to/query.sql
//
// Safety: refuses write statements unless --allow-write is passed.

import fs from 'fs';
import 'dotenv/config';
import pg from 'pg';

const argv = process.argv.slice(2);

let allowWrite = false;
let sqlFromFile = null;
const positional = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--allow-write') allowWrite = true;
  else if (a === '--file') sqlFromFile = argv[++i];
  else positional.push(a);
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

let sql = '';
if (sqlFromFile) sql = fs.readFileSync(sqlFromFile, 'utf8');
else if (positional.length) sql = positional.join(' ');
else sql = readStdin();

sql = (sql || '').trim();
if (!sql) {
  console.error(
    'No SQL provided. Pass it as an argument, with --file, or via stdin.',
  );
  process.exit(1);
}

// Block obvious write/DDL statements unless explicitly allowed.
const writePattern =
  /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|merge)\b/i;
if (!allowWrite && writePattern.test(sql)) {
  console.error(
    'Refusing to run a statement that looks like a write/DDL. Re-run with --allow-write if intended.',
  );
  process.exit(1);
}

if (!process.env.POSTGRES_DATABASE_URL) {
  console.error('Missing env var: POSTGRES_DATABASE_URL (check .env)');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_DATABASE_URL,
});

try {
  const { rows } = await pool.query(sql);
  console.log(JSON.stringify(rows, null, 2));
} catch (err) {
  console.error('Query failed:', err.message || err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
