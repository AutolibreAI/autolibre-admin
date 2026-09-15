-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 013.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/013_ops_rubro_de_pedido.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea su propio actor y su propio
-- pedido de presupuesto de fixture — mismo patrón que 010/011/012.
--
-- Usa los slugs reales `motor` / `service-y-lubricentro` (motor) y
-- `transmision` / `embrague` (para el caso cross-categoría), relevados contra
-- la base antes de escribir este archivo — no inventados.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS other_actor_id,
       gen_random_uuid() AS qr_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-013-' || actor_id || '@example.invalid', 'admin',
       'clerk', 'test-013-' || actor_id
  FROM t_fix
UNION ALL
SELECT other_actor_id, 'test-013-b-' || other_actor_id || '@example.invalid', 'admin',
       'clerk', 'test-013-b-' || other_actor_id
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission)
SELECT qr_id, 'whatsapp', '5491100000000', 'AB123CD', 'Test 013: ruido al frenar', '{}'::jsonb
  FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle);
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Guardrails de forma
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'set_quote_request_rubro';
  PERFORM pg_temp.check('01 existe UNA sola set_quote_request_rubro', v_n = 1, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'set_quote_request_rubro' AND p.prosecdef;
  PERFORM pg_temp.check('02 SECURITY INVOKER, no DEFINER', v_n = 0, v_n::text);

  PERFORM pg_temp.check('03 search_path fijo (guardrail 3)',
    EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'ops' AND p.proname = 'set_quote_request_rubro'
         AND array_to_string(p.proconfig, ' ') LIKE 'search_path=%'
    ),
    (SELECT array_to_string(proconfig, ' ') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'ops' AND p.proname = 'set_quote_request_rubro'));
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Comportamiento
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor       uuid;
  v_other_actor uuid;
  v_qr          uuid;
  v_row         ops.quote_request_rubro%ROWTYPE;
  v_log         ops.action_log%ROWTYPE;
  v_msg         text;
  v_out         jsonb;
  v_created_at  timestamptz;
BEGIN
  SELECT actor_id, other_actor_id, qr_id INTO v_actor, v_other_actor, v_qr FROM t_fix;

  -- 04-07. Camino feliz: sólo rubro (sin servicio puntual).
  v_out := ops.set_quote_request_rubro(v_qr, 'motor', v_actor, NULL, 'Primera clasificación');
  SELECT * INTO v_row FROM ops.quote_request_rubro WHERE quote_request_id = v_qr;
  PERFORM pg_temp.check('04 category_slug = motor', v_row.category_slug = 'motor', v_row.category_slug);
  PERFORM pg_temp.check('05 service_slug ausente → NULL', v_row.service_slug IS NULL, coalesce(v_row.service_slug, '(no null)'));
  PERFORM pg_temp.check('06 actor_id de la sesión', v_row.actor_id = v_actor, v_row.actor_id::text);
  PERFORM pg_temp.check('07 devuelto == guardado',
    v_out->>'category_slug' = 'motor', v_out::text);

  v_created_at := v_row.created_at;

  -- 08-10. Rubro inválido rechazado.
  BEGIN
    PERFORM ops.set_quote_request_rubro(v_qr, 'no-existe', v_actor);
    PERFORM pg_temp.check('08 rubro inválido rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('08 rubro inválido rechazado', v_msg LIKE 'INVALID_CATEGORY_SLUG%', v_msg);
  END;

  -- 09-10. Servicio de OTRO rubro (transmision/embrague) rechazado bajo motor.
  BEGIN
    PERFORM ops.set_quote_request_rubro(v_qr, 'motor', v_actor, 'embrague');
    PERFORM pg_temp.check('09 servicio de otro rubro rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('09 servicio de otro rubro rechazado', v_msg LIKE 'INVALID_SERVICE_SLUG%', v_msg);
  END;

  -- 10. Pedido inexistente rechazado.
  BEGIN
    PERFORM ops.set_quote_request_rubro(gen_random_uuid(), 'motor', v_actor);
    PERFORM pg_temp.check('10 pedido inexistente rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('10 pedido inexistente rechazado', v_msg LIKE 'QUOTE_REQUEST_NOT_FOUND%', v_msg);
  END;

  -- 11-12. Actor inexistente / NULL.
  BEGIN
    PERFORM ops.set_quote_request_rubro(v_qr, 'motor', gen_random_uuid());
    PERFORM pg_temp.check('11 actor inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('11 actor inexistente', v_msg LIKE 'ACTOR_NOT_FOUND%', v_msg);
  END;
  BEGIN
    PERFORM ops.set_quote_request_rubro(v_qr, 'motor', NULL);
    PERFORM pg_temp.check('12 actor NULL', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('12 actor NULL', v_msg LIKE 'ACTOR_REQUIRED%', v_msg);
  END;

  -- 13-17. Re-clasificar (UPDATE, no otra fila): cambia servicio y actor,
  -- pero `created_at` NO se pisa.
  PERFORM pg_sleep(0.01); -- separa now() del INSERT inicial, sin depender del reloj del test runner
  v_out := ops.set_quote_request_rubro(v_qr, 'motor', v_other_actor, 'service-y-lubricentro', 'Recategorizado');
  SELECT * INTO v_row FROM ops.quote_request_rubro WHERE quote_request_id = v_qr;
  PERFORM pg_temp.check('13 sigue habiendo UNA sola fila',
    (SELECT count(*) FROM ops.quote_request_rubro WHERE quote_request_id = v_qr) = 1, 'más de una');
  PERFORM pg_temp.check('14 service_slug actualizado', v_row.service_slug = 'service-y-lubricentro',
    coalesce(v_row.service_slug, '(null)'));
  PERFORM pg_temp.check('15 actor_id actualizado', v_row.actor_id = v_other_actor, v_row.actor_id::text);
  PERFORM pg_temp.check('16 created_at NO se pisa', v_row.created_at = v_created_at, v_row.created_at::text);
  PERFORM pg_temp.check('17 updated_at sí avanza', v_row.updated_at > v_created_at, v_row.updated_at::text);

  -- 18-21. Auditoría de la primera clasificación (before NULL) y la segunda
  -- (before = la primera fila).
  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_qr AND action = 'quote_request.set_rubro'
   ORDER BY created_at ASC LIMIT 1;
  PERFORM pg_temp.check('18 log #1: before es NULL', v_log.before IS NULL, 'no null');
  PERFORM pg_temp.check('19 log #1: target_table', v_log.target_table = 'ops.quote_request_rubro', v_log.target_table);

  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_qr AND action = 'quote_request.set_rubro'
   ORDER BY created_at DESC LIMIT 1;
  PERFORM pg_temp.check('20 log #2: before trae el rubro anterior',
    v_log.before->>'category_slug' = 'motor' AND v_log.before->>'service_slug' IS NULL,
    v_log.before::text);
  PERFORM pg_temp.check('21 log #2: after trae el rubro nuevo',
    v_log.after->>'service_slug' = 'service-y-lubricentro', v_log.after::text);

  -- 22. Guardrail 6: sin FK cruzada — un pedido borrado no arrastra la fila.
  DELETE FROM quote_requests WHERE id = v_qr;
  PERFORM pg_temp.check('22 sin FK a quote_requests: la fila de ops sobrevive al DELETE',
    EXISTS (SELECT 1 FROM ops.quote_request_rubro WHERE quote_request_id = v_qr), 'desapareció');
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL exacto que va a mandar el repo (parámetros nombrados).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor uuid;
  v_qr2   uuid := gen_random_uuid();
  v_out   jsonb;
BEGIN
  SELECT actor_id INTO v_actor FROM t_fix;

  INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission)
  VALUES (v_qr2, 'web', '5491100000001', 'ZZ999YY', 'Test 013 integración', '{}'::jsonb);

  SELECT ops.set_quote_request_rubro(
    p_quote_request_id => v_qr2,
    p_category_slug    => 'motor',
    p_actor_id         => v_actor,
    p_service_slug     => NULL,
    p_note             => NULL
  ) INTO v_out;

  PERFORM pg_temp.check('23 integración: parámetros nombrados',
    v_out->>'category_slug' = 'motor', v_out::text);
END $$;

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
