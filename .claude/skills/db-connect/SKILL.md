---
name: db-connect
description: Connect to this project's PostgreSQL database to inspect tables, run read-only queries, and check stored procedures/functions. Use when asked to query the DB, look up data, verify schema, debug a stored procedure, or explore database state.
---

# db-connect

Run queries against the project's PostgreSQL database using the same
connection config the app uses: a single `POSTGRES_DATABASE_URL` connection
string from the project-root `.env`, passed straight to a `pg.Pool` — same
approach as `src/shared/infrastructure/database/postgres/drizzle.provider.ts`.

> Requires `POSTGRES_DATABASE_URL` in `.env`. Uses `pg` and `dotenv`, both
> already dependencies of this project (no `pg-promise`, no separate
> `DB_USER`/`DB_HOST`/... vars, no `ca-certificate.crt` — this project doesn't
> use any of those).

## How to run a query

Always run from the **project root** (so `.env` resolves correctly):

```bash
node .claude/skills/db-connect/query.mjs "select version()"
```

Other input modes:

```bash
# From a here-string / stdin (good for multi-line SQL)
echo "select * from vehicles limit 5" | node .claude/skills/db-connect/query.mjs

# From a .sql file
node .claude/skills/db-connect/query.mjs --file scratch/q.sql
```

Output is JSON (array of rows) printed to stdout.

## Safety

- **Read-only by default.** The runner refuses any statement matching
  `insert/update/delete/drop/truncate/alter/create/grant/revoke/merge`.
- To intentionally run a write/DDL statement, add `--allow-write` — but
  confirm with the user before doing so, since this hits the real database.

```bash
node .claude/skills/db-connect/query.mjs --allow-write "update vehicles set ..."
```

## Discovering the schema

Tables live in `public` (Drizzle schema files don't declare a custom
`pgSchema`). Drizzle's own migration bookkeeping lives in a separate
`drizzle` schema — ignore that one, it's not app data.

`autolibre-ddl-ddd.md` (project root) is the source of truth for the data
model — check it first (see `.claude/rules/database-schema.md`) instead of
introspecting live when you just need to know what a table looks like.
Use these queries when you need to check the **actual** state of the DB
(e.g. confirm a migration ran, inspect real data):

```sql
-- list tables
select tablename from pg_catalog.pg_tables where schemaname = 'public' order by 1;

-- list functions/procedures
select proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' order by 1;

-- columns of a table
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'vehicles' order by ordinal_position;
```
