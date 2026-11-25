-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 040 (objetivo de las notificaciones).
-- BEGIN … ROLLBACK. Pensada para la réplica PGlite: crea a mano una regla y una
-- corrida mínimas (sin pasar por los SP de la 014).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;
CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$ INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle); $$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END; $$;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id, gen_random_uuid() AS schedule_id, gen_random_uuid() AS run_id,
       gen_random_uuid() AS run2_id, gen_random_uuid() AS broadcast_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-040-' || actor_id || '@example.invalid', 'admin'::user_role, 'clerk'::auth_provider, 'test-040-' || actor_id
  FROM t_fix;
INSERT INTO ops.notification_schedule (id) SELECT schedule_id FROM t_fix;
INSERT INTO ops.notification_schedule_run (id, schedule_id, occurrence_at) SELECT run_id, schedule_id, now() FROM t_fix;
INSERT INTO ops.notification_schedule_run (id, schedule_id, occurrence_at) SELECT run2_id, schedule_id, now() - interval '1 day' FROM t_fix;

DO $$
DECLARE
  f t_fix%ROWTYPE;
  v_e text; v_a text; v_s text; v_n int;
BEGIN
  SELECT * INTO f FROM t_fix;

  v_e := pg_temp.err(format('SELECT ops.set_notification_target(%L, %L, %L, %L)', 'otro', f.broadcast_id, 'vehicle', f.actor_id));
  PERFORM pg_temp.check('01 tipo inválido', v_e LIKE 'INVALID_TARGET_KIND%', v_e);

  v_e := pg_temp.err(format('SELECT ops.set_notification_target(%L, %L, %L, %L)', 'envio', f.broadcast_id, 'DROP TABLE', f.actor_id));
  PERFORM pg_temp.check('02 acción con forma inválida', v_e LIKE 'INVALID_TARGET_ACTION%', v_e);

  v_e := pg_temp.err(format('SELECT ops.set_notification_target(%L, %L, %L, %L)', 'programado', gen_random_uuid(), 'vehicle', f.actor_id));
  PERFORM pg_temp.check('03 regla inexistente', v_e LIKE 'SCHEDULE_NOT_FOUND%', v_e);

  PERFORM ops.set_notification_target('programado', f.schedule_id, 'insurance', f.actor_id);
  SELECT action, source INTO v_a, v_s FROM ops.notification_target_for(f.run_id);
  PERFORM pg_temp.check('04 la corrida hereda el objetivo de la regla', v_a = 'insurance' AND v_s = 'programado', v_a || '/' || v_s);

  SELECT action INTO v_a FROM ops.notification_target_for(f.run2_id);
  PERFORM pg_temp.check('05 todas las corridas heredan', v_a = 'insurance', v_a);

  PERFORM ops.set_notification_target('envio', f.run_id, 'vehicle', f.actor_id);
  SELECT action, source INTO v_a, v_s FROM ops.notification_target_for(f.run_id);
  PERFORM pg_temp.check('06 el del envío gana al de la regla', v_a = 'vehicle' AND v_s = 'envio', v_a || '/' || v_s);

  PERFORM ops.set_notification_target('envio', f.broadcast_id, 'quote_request', f.actor_id);
  SELECT action INTO v_a FROM ops.notification_target_for(f.broadcast_id);
  PERFORM pg_temp.check('07 envío puntual', v_a = 'quote_request', v_a);

  PERFORM ops.set_notification_target('envio', f.broadcast_id, 'quote_request', f.actor_id);
  SELECT count(*) INTO v_n FROM ops.action_log WHERE target_id = f.broadcast_id;
  PERFORM pg_temp.check('08 repetir no loguea', v_n = 1, v_n::text);

  PERFORM ops.set_notification_target('envio', f.broadcast_id, NULL, f.actor_id);
  SELECT count(*) INTO v_n FROM ops.notification_target_for(f.broadcast_id);
  PERFORM pg_temp.check('09 NULL borra', v_n = 0, v_n::text);
END $$;

SELECT caso, CASE WHEN ok THEN 'PASA' ELSE 'FALLA' END AS estado, detalle FROM t_result ORDER BY caso;
SELECT count(*) FILTER (WHERE ok) AS pasaron, count(*) FILTER (WHERE NOT ok) AS fallaron, count(*) AS total FROM t_result;

ROLLBACK;
