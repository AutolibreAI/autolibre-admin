-- ═══════════════════════════════════════════════════════════════════════════
-- 025 — Cuántos presupuestos dio cada proveedor, desde el principio.
--
-- Para qué: el cobro a proveedores arranca en noviembre de 2026 y el equipo
-- comercial (Tobías) llama a los talleres para ofrecerles un plan pago. El
-- argumento es un número: "cotizaste en N pedidos nuestros". Lo leen el panel
-- y los ejecutivos por el conector MCP, así que vive en la base, en UNA
-- definición: si el panel tuviera su copia del SQL, los dos números se
-- separarían sin que nada lo delate.
--
-- ── LA HISTORIA ESTÁ PARTIDA EN DOS TABLAS, Y NO SE MIGRA ─────────────────
--
--   * Hasta el 2026-10-27: `ops.quote_request_response` (015) — lo que contestó
--     cada taller, con o sin precio.
--   * Desde el 2026-10-27: `public.quote_request_proposals` (0120–0122 del
--     backend) — lo que se le publica a la persona en la app.
--
-- Copiar lo viejo a la tabla nueva está descartado: la app la lee (la persona
-- vería propuestas que nunca recibió), sus invariantes no lo admiten
-- (`send_id`, `position` 1..3, precio) y ninguna escritura SQL a esa tabla es
-- válida (`.claude/rules/quote-proposals.md`). Copiar lo nuevo a `ops` crea dos
-- verdades que se separan con cada envío, corrección o retiro. Se UNE al leer.
--
-- ── QUÉ CUENTA ────────────────────────────────────────────────────────────
--
--   * Una fila de cualquiera de las dos tablas = "este taller cotizó para un
--     pedido nuestro". NO es "le mandamos el pedido": esa derivación no se
--     registra en ningún lado (1 nota "Derivado a" en 115 pedidos al
--     2026-11-02).
--   * Sin pedidos cerrados como `duplicate`: el equipo marca así los
--     duplicados Y sus pedidos de prueba. Mismo corte que
--     `notDuplicatePredicate` de `quote-requests.repo.ts`.
--   * Un presupuesto cargado en las dos tablas (mismo pedido, mismo taller)
--     cuenta UNA vez, el de la nueva. "Mismo taller" es el mismo `partner_id`;
--     para un taller de afuera (sin `partner_id`), el mismo nombre normalizado
--     — con `IS NOT DISTINCT FROM` dos nulos serían "iguales" y cualquier
--     taller de afuera taparía a otro.
--   * Las retiradas de la tabla nueva se cuentan APARTE (`withdrawn`): el
--     taller cotizó igual. El descarte de duplicados mira las retiradas
--     también, así un presupuesto viejo re-cargado y retirado no cuenta dos
--     veces ni desaparece.
--   * `requests` = pedidos distintos. Es el número que no se infla: la tabla
--     vieja puede tener dos filas del mismo taller en un pedido.
--   * Un taller de afuera se agrupa por nombre normalizado; dos partners con el
--     mismo nombre NO se juntan (se agrupa por `partner_id`).
--   * La fecha del último es en hora de Buenos Aires, fija: con `::date` a
--     secas dependería de la zona de la sesión, y el MCP y el panel no la
--     comparten.
--
-- ── POR QUÉ UNA FUNCIÓN `plpgsql` Y NO UNA VISTA ──────────────────────────
--
-- Una vista que lee `public` deja una dependencia registrada en `pg_depend`:
-- el backend no podría cambiar el tipo ni borrar una columna de
-- `quote_request_proposals` sin que su migración de Drizzle falle por un
-- objeto que no conoce. Y la vista no se podría crear en una base sin la 0120,
-- así que el `vercel-build` se caería ahí.
--
-- `plpgsql` resuelve las sentencias recién al EJECUTARLAS (lo mismo que hizo
-- posible la 011 cuando `quote_requests` no existía en producción): no deja
-- dependencia y se aplica en cualquier base. El costo, igual que el SQL en un
-- repo (`ops-metrics.md`): si el backend renombra una columna, esto se rompe
-- al llamarlo, no al migrar. Por eso NO puede ser `LANGUAGE sql`, que sí se
-- valida contra las tablas al crearse.
--
-- Sin las tablas que lee, la función no devuelve un número a medias: tira
-- `QUOTE_VOLUME_UNAVAILABLE` con lo que falta.
--
-- ── GUARDRAILS ────────────────────────────────────────────────────────────
--
-- Es la primera función de `ops` de SÓLO LECTURA sobre `public`. De los 8
-- guardrails de las escrituras (`ops-write-actions.md`) aplican tres: vive en
-- `migrations/`, SECURITY INVOKER (el default; quien la llama necesita SELECT
-- sobre las tablas) y `search_path` fijo. Sin actor, sin log, sin lock: no
-- escribe nada. Agrega y devuelve, no decide (`ai-costs.md`, ley 4): qué
-- talleres llamar, qué plan ofrecer o si los Aliados cuentan lo decide quien
-- la lee.
--
-- ── EL CONECTOR MCP ───────────────────────────────────────────────────────
--
-- Al 2026-11-02 el rol del conector no tiene USAGE sobre `ops` ("permission
-- denied for schema ops"). Este archivo NO le da permisos: el nombre del rol
-- no está en ningún repo y darle acceso es una decisión aparte. A mano:
--
--   GRANT USAGE ON SCHEMA ops TO <rol_del_conector>;
--   GRANT EXECUTE ON FUNCTION ops.partner_quote_volume() TO <rol_del_conector>;
--   GRANT SELECT ON ops.quote_request_response TO <rol_del_conector>;
--
-- (SECURITY INVOKER: además de ejecutar, el rol tiene que poder leer
-- `ops.quote_request_response`; `public` ya lo lee.)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION ops.partner_quote_volume()
RETURNS TABLE (
  partner_id     uuid,
  partner_name   text,
  tier           text,
  status         text,
  is_external    boolean,
  requests       int,
  quotes         int,
  withdrawn      int,
  from_ops       int,
  from_app       int,
  first_quoted_on date,
  last_quoted_on  date
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, ops
AS $$
#variable_conflict use_column
DECLARE
  v_missing text[];
BEGIN
  -- Lo que se lee, chequeado antes de leerlo. Sin esto la llamada daría el
  -- error crudo de Postgres sobre una relación o columna inexistente.
  SELECT array_agg(need) INTO v_missing
    FROM (VALUES
      ('public.quote_requests',          NULL::text),
      ('public.quote_requests',          'close_reason_code'),
      ('public.quote_request_proposals', NULL),
      ('public.quote_request_proposals', 'withdrawn_at'),
      ('public.quote_request_proposals', 'provider_name'),
      ('public.partners',                NULL),
      ('ops.quote_request_response',     NULL)
    ) AS t(rel, col)
    CROSS JOIN LATERAL (SELECT coalesce(rel || '.' || col, rel) AS need) n
   WHERE to_regclass(rel) IS NULL
      OR (col IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = split_part(rel, '.', 1)
               AND c.table_name   = split_part(rel, '.', 2)
               AND c.column_name  = col));

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'QUOTE_VOLUME_UNAVAILABLE: %', array_to_string(v_missing, ', ')
      USING HINT = 'Faltan migraciones del backend (0093/0120–0122) o la 015 de ops.';
  END IF;

  RETURN QUERY
  WITH real_requests AS (
    SELECT q.id
      FROM public.quote_requests q
     WHERE q.close_reason_code IS DISTINCT FROM 'duplicate'
  ),
  from_app AS (
    SELECT p.quote_request_id, p.partner_id, p.provider_name, p.created_at,
           p.withdrawn_at IS NOT NULL AS is_withdrawn
      FROM public.quote_request_proposals p
      JOIN real_requests rr ON rr.id = p.quote_request_id
  ),
  from_ops AS (
    SELECT r.quote_request_id, r.partner_id, r.provider_name, r.created_at,
           false AS is_withdrawn
      FROM ops.quote_request_response r
      JOIN real_requests rr ON rr.id = r.quote_request_id
     WHERE NOT EXISTS (
       SELECT 1 FROM from_app a
        WHERE a.quote_request_id = r.quote_request_id
          AND (   (r.partner_id IS NOT NULL AND a.partner_id = r.partner_id)
               OR (r.partner_id IS NULL AND a.partner_id IS NULL
                   AND lower(btrim(a.provider_name)) = lower(btrim(r.provider_name)))))
  ),
  all_quotes AS (
    SELECT f.*, 'app'::text AS src FROM from_app f
    UNION ALL
    SELECT o.*, 'ops'::text FROM from_ops o
  ),
  grouped AS (
    SELECT aq.partner_id                                         AS g_partner_id,
           CASE WHEN aq.partner_id IS NULL
                THEN lower(btrim(aq.provider_name)) END           AS g_external_key,
           min(btrim(aq.provider_name))                           AS g_provider_name,
           count(DISTINCT aq.quote_request_id)                    AS g_requests,
           count(*) FILTER (WHERE NOT aq.is_withdrawn)            AS g_quotes,
           count(*) FILTER (WHERE aq.is_withdrawn)                AS g_withdrawn,
           count(*) FILTER (WHERE aq.src = 'ops')                 AS g_from_ops,
           count(*) FILTER (WHERE aq.src = 'app')                 AS g_from_app,
           min(aq.created_at)                                     AS g_first,
           max(aq.created_at)                                     AS g_last
      FROM all_quotes aq
     GROUP BY 1, 2
  )
  SELECT g.g_partner_id,
         coalesce(pa.name, g.g_provider_name),
         pa.tier::text,
         pa.status::text,
         g.g_partner_id IS NULL,
         g.g_requests::int,
         g.g_quotes::int,
         g.g_withdrawn::int,
         g.g_from_ops::int,
         g.g_from_app::int,
         (g.g_first AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
         (g.g_last  AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
    FROM grouped g
    LEFT JOIN public.partners pa ON pa.id = g.g_partner_id
   ORDER BY g.g_requests DESC, g.g_quotes DESC, coalesce(pa.name, g.g_provider_name);
END;
$$;

COMMENT ON FUNCTION ops.partner_quote_volume() IS
  'Presupuestos por proveedor desde el principio: une ops.quote_request_response (hasta 2026-10-27) '
  'y public.quote_request_proposals (desde 2026-10-27), sin pedidos duplicate/prueba y sin contar dos '
  'veces el mismo presupuesto. requests = pedidos distintos; quotes = presupuestos vigentes; '
  'withdrawn = retirados (el taller cotizó igual). NO mide derivaciones (no se registran). '
  'Uso: select * from ops.partner_quote_volume() where tier = ''standard'' and status = ''active''.';

-- ═══════════════════════════════════════════════════════════════════════════
-- ops.partner_proposal_usage_monthly() — el uso del plan, por taller y por mes.
--
-- Otra pregunta que la de arriba: no "cuánto cotizó desde siempre" (vender el
-- plan) sino "cuánto consumió de su tope este mes" (cobrar el plan). Por eso:
--
--   * SÓLO `public.quote_request_proposals`: lo cargado en `ops` antes del
--     2026-10-27 no se publicó en la app y no cuenta contra ningún tope.
--   * Desde `p_from` (default 2026-10-27 00:00 de Buenos Aires = el
--     `PROPOSAL_COUNT_START` de `~/lib/partner-plans`; se tocan juntos).
--   * Mes calendario del ENVÍO (`created_at`) en hora de Buenos Aires, `YYYY-MM`.
--   * `sent` = activas; `withdrawn` = retiradas (suman al tope: el lugar se
--     usó); `selected` = es `quote_requests.selected_proposal_id` (subconjunto,
--     no suma aparte).
--   * Mismo corte de pedidos de prueba (`duplicate`) y mismo agrupado de los
--     talleres de afuera que `ops.partner_quote_volume()`.
--
-- El plan y el tope NO están acá: `partners.plan` no existe. Comparar contra
-- el tope es de quien la lee (ley 4: agrega y devuelve, no decide).
-- Mismo motivo para `plpgsql`, mismos guardrails y mismos GRANT a mano que la
-- función de arriba (más `GRANT EXECUTE` sobre ésta).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION ops.partner_proposal_usage_monthly(
  p_from timestamptz DEFAULT '2026-10-27T03:00:00Z'
)
RETURNS TABLE (
  partner_id   uuid,
  partner_name text,
  tier         text,
  status       text,
  is_external  boolean,
  month        text,
  sent         int,
  withdrawn    int,
  selected     int
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, ops
AS $$
#variable_conflict use_column
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(need) INTO v_missing
    FROM (VALUES
      ('public.quote_requests',          NULL::text),
      ('public.quote_requests',          'close_reason_code'),
      ('public.quote_requests',          'selected_proposal_id'),
      ('public.quote_request_proposals', NULL),
      ('public.quote_request_proposals', 'withdrawn_at'),
      ('public.quote_request_proposals', 'provider_name'),
      ('public.partners',                NULL)
    ) AS t(rel, col)
    CROSS JOIN LATERAL (SELECT coalesce(rel || '.' || col, rel) AS need) n
   WHERE to_regclass(rel) IS NULL
      OR (col IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = split_part(rel, '.', 1)
               AND c.table_name   = split_part(rel, '.', 2)
               AND c.column_name  = col));

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'QUOTE_VOLUME_UNAVAILABLE: %', array_to_string(v_missing, ', ')
      USING HINT = 'Faltan migraciones del backend (0093/0120–0122).';
  END IF;

  RETURN QUERY
  WITH proposals AS (
    SELECT p.partner_id                                            AS g_partner_id,
           CASE WHEN p.partner_id IS NULL
                THEN lower(btrim(p.provider_name)) END              AS g_external_key,
           btrim(p.provider_name)                                   AS g_provider_name,
           to_char(p.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM') AS g_month,
           p.withdrawn_at IS NOT NULL                               AS g_withdrawn,
           q.selected_proposal_id IS NOT DISTINCT FROM p.id         AS g_selected
      FROM public.quote_request_proposals p
      JOIN public.quote_requests q ON q.id = p.quote_request_id
     WHERE q.close_reason_code IS DISTINCT FROM 'duplicate'
       AND p.created_at >= p_from
  ),
  grouped AS (
    SELECT pr.g_partner_id, pr.g_external_key, pr.g_month,
           min(pr.g_provider_name)                        AS g_name,
           count(*) FILTER (WHERE NOT pr.g_withdrawn)     AS g_sent,
           count(*) FILTER (WHERE pr.g_withdrawn)         AS g_withdrawn_n,
           count(*) FILTER (WHERE pr.g_selected)          AS g_selected_n
      FROM proposals pr
     GROUP BY 1, 2, 3
  )
  SELECT g.g_partner_id,
         coalesce(pa.name, g.g_name),
         pa.tier::text,
         pa.status::text,
         g.g_partner_id IS NULL,
         g.g_month,
         g.g_sent::int,
         g.g_withdrawn_n::int,
         g.g_selected_n::int
    FROM grouped g
    LEFT JOIN public.partners pa ON pa.id = g.g_partner_id
   ORDER BY g.g_month DESC, (g.g_sent + g.g_withdrawn_n) DESC, coalesce(pa.name, g.g_name);
END;
$$;

COMMENT ON FUNCTION ops.partner_proposal_usage_monthly(timestamptz) IS
  'Uso del plan por proveedor y mes (hora de Buenos Aires): sólo public.quote_request_proposals, desde '
  'p_from (default 2026-10-27), sin pedidos duplicate/prueba. sent = activas; withdrawn = retiradas '
  '(suman al tope); selected = elegidas por la persona (subconjunto). Usadas = sent + withdrawn. '
  'El plan y el tope no están: partners.plan no existe todavía. '
  'Uso: select * from ops.partner_proposal_usage_monthly() where month = ''2026-11''.';
