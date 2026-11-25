-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 041 (seguimiento de pedidos). BEGIN … ROLLBACK.
-- Pensada para la réplica PGlite (los pedidos sólo llenan `id`).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;
CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$ INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle); $$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END; $$;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id, gen_random_uuid() AS q1, gen_random_uuid() AS q2;
INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-041-' || actor_id || '@example.invalid', 'admin'::user_role, 'clerk'::auth_provider, 'test-041-' || actor_id
  FROM t_fix;
INSERT INTO quote_requests (id) SELECT q1 FROM t_fix UNION ALL SELECT q2 FROM t_fix;

DO $$
DECLARE f t_fix%ROWTYPE; v_n int; v_e text; v_at timestamptz;
BEGIN
  SELECT * INTO f FROM t_fix;

  v_e := pg_temp.err(format('SELECT ops.set_quote_followup_sent(ARRAY[]::uuid[], true, %L)', f.actor_id));
  PERFORM pg_temp.check('01 lista vacía', v_e LIKE 'FOLLOWUP_JOBS_REQUIRED%', v_e);

  v_e := pg_temp.err(format('SELECT ops.set_quote_followup_sent(ARRAY[%L::uuid], true, %L)', gen_random_uuid(), f.actor_id));
  PERFORM pg_temp.check('02 pedido inexistente', v_e LIKE 'QUOTE_REQUEST_NOT_FOUND%', v_e);

  v_n := ops.set_quote_followup_sent(ARRAY[f.q1, f.q2], true, f.actor_id);
  PERFORM pg_temp.check('03 marca los dos', v_n = 2, v_n::text);

  SELECT sent_at INTO v_at FROM ops.quote_followup_send WHERE quote_request_id = f.q1;
  v_n := ops.set_quote_followup_sent(ARRAY[f.q1], true, f.actor_id);
  PERFORM pg_temp.check('04 re-marcar no cambia nada', v_n = 0
    AND (SELECT sent_at FROM ops.quote_followup_send WHERE quote_request_id = f.q1) = v_at, v_n::text);

  SELECT count(*) INTO v_n FROM ops.action_log WHERE action = 'quote_followup.sent' AND target_id IN (f.q1, f.q2);
  PERFORM pg_temp.check('05 un log por pedido', v_n = 2, v_n::text);

  v_n := ops.set_quote_followup_sent(ARRAY[f.q2], false, f.actor_id);
  PERFORM pg_temp.check('06 desmarca', v_n = 1 AND NOT EXISTS (SELECT 1 FROM ops.quote_followup_send WHERE quote_request_id = f.q2), v_n::text);

  v_e := pg_temp.err(format('SELECT ops.set_quote_followup_sent(ARRAY[%L::uuid], true, NULL)', f.q1));
  PERFORM pg_temp.check('07 sin actor', v_e LIKE 'ACTOR_REQUIRED%', v_e);
END $$;

SELECT caso, CASE WHEN ok THEN 'PASA' ELSE 'FALLA' END AS estado, detalle FROM t_result ORDER BY caso;
SELECT count(*) FILTER (WHERE ok) AS pasaron, count(*) FILTER (WHERE NOT ok) AS fallaron, count(*) AS total FROM t_result;

ROLLBACK;
