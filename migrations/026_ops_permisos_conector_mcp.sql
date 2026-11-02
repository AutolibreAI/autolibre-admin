-- ═══════════════════════════════════════════════════════════════════════════
-- 026 — Permisos para el conector MCP de los ejecutivos (`autolibre_mcp_ro`).
-- Aprobado por el usuario el 2026-11-02.
--
-- Los ejecutivos leen por el conector MCP de AutoLibre las dos funciones de
-- la 025 (`ops.partner_quote_volume()` y
-- `ops.partner_proposal_usage_monthly()`), las mismas que lee el panel.
--
-- Por qué una migración aparte y no el final de la 025: la 025 ya estaba
-- aplicada en DEV cuando se escribió este bloque, y el runner no deja editar
-- una migración aplicada (checksum). Es lo que el propio runner indica.
--
-- Relevado el 2026-11-02 desde el propio conector: `current_user =
-- autolibre_mcp_ro`, base `autolibre`, YA lee `quote_request_proposals`,
-- `quote_requests` y `partners`, y NO tiene USAGE sobre `ops` ("permission
-- denied for schema ops"). Las dos funciones son SECURITY INVOKER: además de
-- ejecutarlas, tiene que poder leer `ops.quote_request_response`.
--
-- Lo mínimo, nada más:
--   * USAGE sobre `ops`, para poder nombrar las funciones. NO le da acceso a
--     ninguna otra tabla de `ops` (cada una necesita su SELECT). Sí puede
--     NOMBRAR las otras funciones de `ops`, incluidos los SP que escriben, pero
--     no puede escribir con ellos: corren con SUS permisos (sólo lectura, sin
--     UPDATE en `public`) y el conector rechaza todo lo que no sea un SELECT.
--   * SELECT sólo sobre `ops.quote_request_response`.
--   * EXECUTE explícito sobre las dos funciones (PUBLIC ya lo tiene por
--     default; queda escrito para que se lea).
--
-- Protegido con un IF: el rol existe en producción y no en desarrollo, y un
-- GRANT a un rol inexistente abortaría la migración en cualquier otra base.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autolibre_mcp_ro') THEN
    GRANT USAGE ON SCHEMA ops TO autolibre_mcp_ro;
    GRANT SELECT ON ops.quote_request_response TO autolibre_mcp_ro;
    GRANT EXECUTE ON FUNCTION ops.partner_quote_volume() TO autolibre_mcp_ro;
    GRANT EXECUTE ON FUNCTION ops.partner_proposal_usage_monthly(timestamptz) TO autolibre_mcp_ro;
  ELSE
    RAISE NOTICE 'autolibre_mcp_ro no existe en esta base: sin permisos para el conector MCP.';
  END IF;
END $$;
