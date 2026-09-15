-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 012.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/012_ops_crear_pedido.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea su propio actor. No hace falta
-- fixture de `quote_requests` — esta migración CREA filas, no las edita.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-012-' || actor_id || '@example.invalid', 'admin',
       'clerk', 'test-012-' || actor_id
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
   WHERE n.nspname = 'ops' AND p.proname = 'create_quote_request';
  PERFORM pg_temp.check('01 existe UNA sola create_quote_request', v_n = 1, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'create_quote_request' AND p.prosecdef;
  PERFORM pg_temp.check('02 SECURITY INVOKER, no DEFINER', v_n = 0, v_n::text);

  PERFORM pg_temp.check('03 search_path fijo (guardrail 3)',
    EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'ops' AND p.proname = 'create_quote_request'
         AND array_to_string(p.proconfig, ' ') LIKE 'search_path=%'
    ),
    (SELECT array_to_string(proconfig, ' ') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'ops' AND p.proname = 'create_quote_request'));
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Comportamiento
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor uuid;
  v_id    uuid;
  v_row   quote_requests%ROWTYPE;
  v_log   ops.action_log%ROWTYPE;
  v_msg   text;
  v_out   jsonb;
BEGIN
  SELECT actor_id INTO v_actor FROM t_fix;

  -- 04-11. Camino feliz: todos los campos.
  v_out := ops.create_quote_request(
    v_actor, 'whatsapp', '+54 11 5555 0009', '  ab123cd  ',
    'Ruido en la suspensión', 'Juana Pérez', 'juana@example.invalid', 45000.50,
    'Cargado por teléfono'
  );
  v_id := (v_out->>'id')::uuid;
  SELECT * INTO v_row FROM quote_requests WHERE id = v_id;

  PERFORM pg_temp.check('04 channel = whatsapp', v_row.channel::text = 'whatsapp', v_row.channel::text);
  PERFORM pg_temp.check('05 plate normalizada (upper+trim)', v_row.plate = 'AB123CD', v_row.plate);
  PERFORM pg_temp.check('06 contact_phone', v_row.contact_phone = '+54 11 5555 0009', v_row.contact_phone);
  PERFORM pg_temp.check('07 contact_name', v_row.contact_name = 'Juana Pérez', coalesce(v_row.contact_name, '(null)'));
  PERFORM pg_temp.check('08 contact_email', v_row.contact_email = 'juana@example.invalid',
    coalesce(v_row.contact_email, '(null)'));
  PERFORM pg_temp.check('09 description', v_row.description = 'Ruido en la suspensión', v_row.description);
  PERFORM pg_temp.check('10 declared_amount', v_row.declared_amount = 45000.50, v_row.declared_amount::text);
  PERFORM pg_temp.check('11 status default = received', v_row.status::text = 'received', v_row.status::text);
  PERFORM pg_temp.check('12 public_number asignado', v_row.public_number IS NOT NULL, 'null');
  PERFORM pg_temp.check('13 raw_submission marca origen manual',
    v_row.raw_submission->>'source' = 'admin_manual_entry',
    coalesce(v_row.raw_submission->>'source', '(null)'));
  PERFORM pg_temp.check('14 raw_submission.enteredBy = actor',
    v_row.raw_submission->>'enteredBy' = v_actor::text,
    coalesce(v_row.raw_submission->>'enteredBy', '(null)'));

  -- 15-17. Opcionales ausentes → NULL, no ''.
  v_out := ops.create_quote_request(
    v_actor, 'app', '+54 11 5555 0010', 'ZZ999YY', 'Cambio de aceite'
  );
  SELECT * INTO v_row FROM quote_requests WHERE id = (v_out->>'id')::uuid;
  PERFORM pg_temp.check('15 contact_name ausente → NULL', v_row.contact_name IS NULL, 'no null');
  PERFORM pg_temp.check('16 contact_email ausente → NULL', v_row.contact_email IS NULL, 'no null');
  PERFORM pg_temp.check('17 declared_amount ausente → NULL', v_row.declared_amount IS NULL, 'no null');

  -- 18-20. Los tres NOT NULL vacíos rechazan con su sentinela.
  BEGIN
    PERFORM ops.create_quote_request(v_actor, 'web', '   ', 'AB123CD', 'x');
    PERFORM pg_temp.check('18 contact_phone vacío rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('18 contact_phone vacío rechazado', v_msg LIKE 'CONTACT_PHONE_REQUIRED%', v_msg);
  END;
  BEGIN
    PERFORM ops.create_quote_request(v_actor, 'web', '+54 11 1', '  ', 'x');
    PERFORM pg_temp.check('19 plate vacía rechazada', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('19 plate vacía rechazada', v_msg LIKE 'PLATE_REQUIRED%', v_msg);
  END;
  BEGIN
    PERFORM ops.create_quote_request(v_actor, 'web', '+54 11 1', 'AB123CD', '   ');
    PERFORM pg_temp.check('20 description vacía rechazada', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('20 description vacía rechazada', v_msg LIKE 'DESCRIPTION_REQUIRED%', v_msg);
  END;

  -- 21. Canal inválido → sentinela propia.
  BEGIN
    PERFORM ops.create_quote_request(v_actor, 'telefono', '+54 11 1', 'AB123CD', 'x');
    PERFORM pg_temp.check('21 canal inválido rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('21 canal inválido rechazado', v_msg LIKE 'INVALID_CHANNEL%', v_msg);
  END;

  -- 22-23. Actor inexistente / NULL.
  BEGIN
    PERFORM ops.create_quote_request(gen_random_uuid(), 'web', '+54 11 1', 'AB123CD', 'x');
    PERFORM pg_temp.check('22 actor inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('22 actor inexistente', v_msg LIKE 'ACTOR_NOT_FOUND%', v_msg);
  END;
  BEGIN
    PERFORM ops.create_quote_request(NULL, 'web', '+54 11 1', 'AB123CD', 'x');
    PERFORM pg_temp.check('23 actor NULL', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('23 actor NULL', v_msg LIKE 'ACTOR_REQUIRED%', v_msg);
  END;

  -- 24-27. Auditoría: la llamada del caso 04 quedó en el log con before NULL.
  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_id AND action = 'quote_request.create'
   LIMIT 1;
  PERFORM pg_temp.check('24 log: before es NULL (no había fila previa)', v_log.before IS NULL, 'no null');
  PERFORM pg_temp.check('25 log: after trae el pedido nuevo',
    v_log.after->>'description' = 'Ruido en la suspensión',
    coalesce(v_log.after->>'description', '(null)'));
  PERFORM pg_temp.check('26 log: actor de la sesión', v_log.actor_id = v_actor, v_log.actor_id::text);
  PERFORM pg_temp.check('27 log: target_table', v_log.target_table = 'public.quote_requests', v_log.target_table);

  -- 28. Guardrail 8: el SP no escribe updated_at a mano.
  PERFORM pg_temp.check('28 el SP no escribe updated_at a mano',
    pg_get_functiondef('ops.create_quote_request(uuid,text,text,text,text,text,text,numeric,text)'::regprocedure)
      !~* 'updated_at[[:space:]]*=',
    'lo pone el DEFAULT de la columna');
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL exacto que va a mandar el repo (parámetros nombrados).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor uuid;
  v_out   jsonb;
BEGIN
  SELECT actor_id INTO v_actor FROM t_fix;

  SELECT ops.create_quote_request(
    p_actor_id        := v_actor,
    p_channel         := 'whatsapp',
    p_contact_phone   := '+54 11 5555 0011',
    p_plate           := 'CD456EF',
    p_description     := 'Frenos chillan',
    p_contact_name    := NULL,
    p_contact_email   := NULL,
    p_declared_amount := NULL,
    p_note            := NULL
  ) INTO v_out;

  PERFORM pg_temp.check('29 integración: parámetros nombrados',
    v_out->>'plate' = 'CD456EF' AND v_out->>'status' = 'received',
    v_out::text);
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
