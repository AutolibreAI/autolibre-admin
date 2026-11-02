-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 026 — permisos del conector MCP.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/026_ops_permisos_conector_mcp.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK. Necesita la 025 aplicada. Si la 026
-- no está aplicada, pegar su cuerpo después del BEGIN.
--
-- Donde el rol existe (producción) verifica que tenga exactamente lo que
-- necesita y que NO pueda escribir la tabla de `ops`. Donde no existe
-- (desarrollo) la migración se aplica igual: el caso pasa y lo dice.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, coalesce(p_ok, false), p_detalle);
$$;

SELECT pg_temp.check('01 las dos funciones de la 025 existen',
  to_regprocedure('ops.partner_quote_volume()') IS NOT NULL
  AND to_regprocedure('ops.partner_proposal_usage_monthly(timestamptz)') IS NOT NULL);

SELECT pg_temp.check('02 autolibre_mcp_ro: USAGE ops, SELECT tabla vieja, EXECUTE x2, sin INSERT (si el rol existe)',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autolibre_mcp_ro') THEN true
       ELSE has_schema_privilege('autolibre_mcp_ro', 'ops', 'USAGE')
        AND has_table_privilege('autolibre_mcp_ro', 'ops.quote_request_response', 'SELECT')
        AND NOT has_table_privilege('autolibre_mcp_ro', 'ops.quote_request_response', 'INSERT')
        AND has_function_privilege('autolibre_mcp_ro', 'ops.partner_quote_volume()', 'EXECUTE')
        AND has_function_privilege('autolibre_mcp_ro', 'ops.partner_proposal_usage_monthly(timestamptz)', 'EXECUTE')
  END,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autolibre_mcp_ro')
       THEN 'rol presente' ELSE 'rol ausente en esta base: no hay permisos que verificar' END);

SELECT caso,
       CASE WHEN ok THEN 'PASA' ELSE 'FALLA' END AS estado,
       detalle
  FROM t_result
 ORDER BY caso;

SELECT count(*) FILTER (WHERE ok)     AS pasaron,
       count(*) FILTER (WHERE NOT ok) AS fallaron,
       count(*)                        AS total
  FROM t_result;

ROLLBACK;
