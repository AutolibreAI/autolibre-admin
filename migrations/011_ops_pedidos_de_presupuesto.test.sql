-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 011.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/011_ops_pedidos_de_presupuesto.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea su propio actor y sus propios
-- pedidos. Mismo patrón que la 007/008/009/010.
--
-- Crea pedidos propios en vez de usar filas reales por el mismo motivo que la
-- 008: cada SP toma la fila con `FOR UPDATE`, y un pedido real quedaría
-- bloqueado para la app —que también lo escribe al cancelar— mientras la
-- transacción está abierta.
--
-- `now()` es constante dentro de la transacción, así que el guardrail de
-- `updated_at` se verifica sobre el CUERPO de las funciones (caso 07), no
-- comparando timestamps.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS received_id,
       gen_random_uuid() AS contacted_id,
       gen_random_uuid() AS answered_id,
       gen_random_uuid() AS cancelled_id,
       gen_random_uuid() AS closed_id,
       gen_random_uuid() AS noted_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-011-' || actor_id || '@example.invalid', 'admin',
       'clerk', 'test-011-' || actor_id
  FROM t_fix;

-- El recibido trae la ubicación EXACTA del teléfono: es el que prueba que las
-- coordenadas no se copian a `ops.action_log`.
INSERT INTO quote_requests (
  id, channel, contact_phone, plate, description, raw_submission,
  location_source, location_address, location_locality, location_province,
  location_latitude, location_longitude, location_accuracy_meters
)
SELECT received_id, 'app', '5491100000000', 'AB123CD', 'Test 011 recibido',
       '{"location": {"latitude": -34.6037, "longitude": -58.3816}}'::jsonb,
       'device', 'Av. Corrientes 1234', 'CABA', 'Buenos Aires',
       -34.6037, -58.3816, 12.5
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission,
                            status, contacted_at)
SELECT contacted_id, 'web', '5491100000000', 'AB123CD', 'Test 011 contactado', '{}'::jsonb,
       'contacted', now() - interval '1 day'
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission,
                            status, contacted_at, answered_at, proposals_count)
SELECT answered_id, 'web', '5491100000000', 'AB123CD', 'Test 011 respondido', '{}'::jsonb,
       'answered', now() - interval '2 days', now() - interval '1 day', 2
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission,
                            status, closed_at, close_reason_code, cancellation_reason)
SELECT cancelled_id, 'app', '5491100000000', 'AB123CD', 'Test 011 cancelado', '{}'::jsonb,
       'closed', now() - interval '1 day', 'cancelled_by_user', 'no_longer_needed'
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission,
                            status, closed_at, close_reason_code)
SELECT closed_id, 'web', '5491100000000', 'AB123CD', 'Test 011 cerrado', '{}'::jsonb,
       'closed', now() - interval '1 day', 'resolved'
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission,
                            internal_notes)
SELECT noted_id, 'web', '5491100000000', 'AB123CD', 'Test 011 con notas', '{}'::jsonb,
       'Nota vieja'
  FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, coalesce(p_ok, false), p_detalle);
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Guardrails de forma, sobre las cuatro funciones
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_name text;
  v_n    int;
  v_i    int := 0;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'mark_quote_request_contacted',
    'mark_quote_request_answered',
    'close_quote_request',
    'add_quote_request_internal_note'
  ] LOOP
    v_i := v_i + 1;
    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = v_name;
    PERFORM pg_temp.check('0' || v_i || ' existe UNA sola ops.' || v_name, v_n = 1, v_n::text);
  END LOOP;

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname ~ 'quote_request' AND p.prosecdef;
  PERFORM pg_temp.check('05 SECURITY INVOKER, no DEFINER (guardrail 2)', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname ~ 'quote_request'
     AND coalesce(array_to_string(p.proconfig, ' '), '') NOT LIKE 'search_path=%';
  PERFORM pg_temp.check('06 search_path fijo en todas (guardrail 3)', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname ~ 'quote_request'
     AND pg_get_functiondef(p.oid) ~* 'updated_at[[:space:]]*=';
  PERFORM pg_temp.check('07 ninguna escribe updated_at a mano (guardrail 8)', v_n = 0,
                        'lo pone trg_quote_requests_updated_at');
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- received → contacted
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fix t_fix%ROWTYPE;
  v_out jsonb;
  v_row quote_requests%ROWTYPE;
  v_log ops.action_log%ROWTYPE;
  v_msg text;
BEGIN
  SELECT * INTO v_fix FROM t_fix;

  v_out := ops.mark_quote_request_contacted(v_fix.received_id, v_fix.actor_id, 'Le escribí por WhatsApp');
  SELECT * INTO v_row FROM quote_requests WHERE id = v_fix.received_id;

  PERFORM pg_temp.check('10 received → contacted',
    v_row.status = 'contacted' AND v_row.contacted_at IS NOT NULL, v_row.status::text);
  PERFORM pg_temp.check('11 devuelve la fila nueva', v_out->>'status' = 'contacted', v_out->>'status');

  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_fix.received_id AND action = 'quote_request.mark_contacted';
  PERFORM pg_temp.check('12 log: before/after, actor, tabla y nota',
    v_log.before->>'status' = 'received'
      AND v_log.after->>'status' = 'contacted'
      AND v_log.actor_id = v_fix.actor_id
      AND v_log.target_table = 'public.quote_requests'
      AND v_log.note = 'Le escribí por WhatsApp',
    coalesce(v_log.before->>'status', '(sin log)') || ' → ' || coalesce(v_log.after->>'status', '(sin log)'));

  -- Ley 25.326: la posición exacta de la persona no se copia a la auditoría. Ni
  -- las columnas, ni el raw_submission que la repite. La localidad sí queda.
  PERFORM pg_temp.check('13 log: sin coordenadas ni raw_submission, con localidad',
    NOT (v_log.before ?| ARRAY['location_latitude', 'location_longitude', 'location_accuracy_meters', 'raw_submission'])
      AND NOT (v_log.after ?| ARRAY['location_latitude', 'location_longitude', 'location_accuracy_meters', 'raw_submission'])
      AND v_log.after->>'location_locality' = 'CABA',
    coalesce(v_log.after::text, '(sin log)'));
  PERFORM pg_temp.check('14 lo devuelto tampoco trae coordenadas',
    NOT (v_out ?| ARRAY['location_latitude', 'location_longitude', 'raw_submission']), v_out::text);

  -- Los CHECK no impiden retroceder: la guarda de estado es de la función.
  BEGIN
    PERFORM ops.mark_quote_request_contacted(v_fix.answered_id, v_fix.actor_id);
    PERFORM pg_temp.check('15 no retrocede un respondido', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('15 no retrocede un respondido',
      v_msg LIKE 'INVALID_QUOTE_REQUEST_TRANSITION%', v_msg);
  END;
  SELECT * INTO v_row FROM quote_requests WHERE id = v_fix.answered_id;
  PERFORM pg_temp.check('16 el respondido quedó intacto', v_row.status = 'answered', v_row.status::text);

  BEGIN
    PERFORM ops.mark_quote_request_contacted(gen_random_uuid(), v_fix.actor_id);
    PERFORM pg_temp.check('17 pedido inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('17 pedido inexistente', v_msg LIKE 'QUOTE_REQUEST_NOT_FOUND%', v_msg);
  END;

  BEGIN
    PERFORM ops.mark_quote_request_contacted(v_fix.noted_id, NULL);
    PERFORM pg_temp.check('18 actor NULL', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('18 actor NULL', v_msg LIKE 'ACTOR_REQUIRED%', v_msg);
  END;

  BEGIN
    PERFORM ops.mark_quote_request_contacted(v_fix.noted_id, gen_random_uuid());
    PERFORM pg_temp.check('19 actor inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('19 actor inexistente', v_msg LIKE 'ACTOR_NOT_FOUND%', v_msg);
  END;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- contacted → answered
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fix t_fix%ROWTYPE;
  v_row quote_requests%ROWTYPE;
  v_log ops.action_log%ROWTYPE;
  v_msg text;
BEGIN
  SELECT * INTO v_fix FROM t_fix;

  -- Los rechazos van ANTES del camino feliz: después el pedido ya no está en
  -- contacted, y un rechazo por estado taparía el rechazo por parámetro.
  BEGIN
    PERFORM ops.mark_quote_request_answered(v_fix.contacted_id, NULL, v_fix.actor_id);
    PERFORM pg_temp.check('20 sin cantidad de propuestas', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('20 sin cantidad de propuestas', v_msg LIKE 'PROPOSALS_COUNT_REQUIRED%', v_msg);
  END;

  BEGIN
    PERFORM ops.mark_quote_request_answered(v_fix.contacted_id, -1, v_fix.actor_id);
    PERFORM pg_temp.check('21 cantidad negativa', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('21 cantidad negativa', v_msg LIKE 'INVALID_PROPOSALS_COUNT%', v_msg);
  END;

  BEGIN
    PERFORM ops.mark_quote_request_answered(v_fix.noted_id, 1, v_fix.actor_id);
    PERFORM pg_temp.check('22 no responde uno sin contactar', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('22 no responde uno sin contactar',
      v_msg LIKE 'INVALID_QUOTE_REQUEST_TRANSITION%', v_msg);
  END;

  BEGIN
    PERFORM ops.mark_quote_request_answered(gen_random_uuid(), 1, v_fix.actor_id);
    PERFORM pg_temp.check('23 pedido inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('23 pedido inexistente', v_msg LIKE 'QUOTE_REQUEST_NOT_FOUND%', v_msg);
  END;

  -- Cero es una respuesta legítima: "llamamos y no conseguimos nada".
  PERFORM ops.mark_quote_request_answered(v_fix.contacted_id, 0, v_fix.actor_id);
  SELECT * INTO v_row FROM quote_requests WHERE id = v_fix.contacted_id;
  PERFORM pg_temp.check('24 contacted → answered con 0 propuestas',
    v_row.status = 'answered' AND v_row.answered_at IS NOT NULL AND v_row.proposals_count = 0,
    v_row.status::text || ' / ' || coalesce(v_row.proposals_count::text, '(null)'));

  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_fix.contacted_id AND action = 'quote_request.mark_answered';
  PERFORM pg_temp.check('25 log de la respuesta',
    v_log.before->>'status' = 'contacted' AND (v_log.after->>'proposals_count')::int = 0,
    coalesce(v_log.after::text, '(sin log)'));
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- abierto → closed
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fix t_fix%ROWTYPE;
  v_row quote_requests%ROWTYPE;
  v_log ops.action_log%ROWTYPE;
  v_msg text;
BEGIN
  SELECT * INTO v_fix FROM t_fix;

  BEGIN
    PERFORM ops.close_quote_request(v_fix.answered_id, NULL, v_fix.actor_id);
    PERFORM pg_temp.check('30 sin código de cierre', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('30 sin código de cierre', v_msg LIKE 'CLOSE_REASON_CODE_REQUIRED%', v_msg);
  END;

  BEGIN
    PERFORM ops.close_quote_request(v_fix.answered_id, 'cancelled_by_user', v_fix.actor_id);
    PERFORM pg_temp.check('31 cancelled_by_user es de la app', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('31 cancelled_by_user es de la app',
      v_msg LIKE 'CLOSE_REASON_RESERVED_FOR_APP%', v_msg);
  END;

  BEGIN
    PERFORM ops.close_quote_request(v_fix.answered_id, 'se_cerro', v_fix.actor_id);
    PERFORM pg_temp.check('32 código de cierre fuera del enum', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('32 código de cierre fuera del enum',
      v_msg LIKE 'INVALID_CLOSE_REASON_CODE%', v_msg);
  END;

  BEGIN
    PERFORM ops.close_quote_request(v_fix.answered_id, 'resolved', v_fix.actor_id, NULL, 'quizas');
    PERFORM pg_temp.check('33 outcome fuera del enum', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('33 outcome fuera del enum', v_msg LIKE 'INVALID_OUTCOME%', v_msg);
  END;

  -- Un pedido que el usuario canceló desde la app no se toca: ni el estado, ni
  -- su `closed_at`, ni el motivo.
  BEGIN
    PERFORM ops.close_quote_request(v_fix.cancelled_id, 'resolved', v_fix.actor_id);
    PERFORM pg_temp.check('34 no toca un cancelado por el usuario', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('34 no toca un cancelado por el usuario',
      v_msg LIKE 'INVALID_QUOTE_REQUEST_TRANSITION%', v_msg);
  END;
  SELECT * INTO v_row FROM quote_requests WHERE id = v_fix.cancelled_id;
  PERFORM pg_temp.check('35 el cancelado quedó intacto',
    v_row.close_reason_code = 'cancelled_by_user' AND v_row.cancellation_reason = 'no_longer_needed',
    coalesce(v_row.close_reason_code::text, '(null)'));

  BEGIN
    PERFORM ops.close_quote_request(gen_random_uuid(), 'resolved', v_fix.actor_id);
    PERFORM pg_temp.check('36 pedido inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('36 pedido inexistente', v_msg LIKE 'QUOTE_REQUEST_NOT_FOUND%', v_msg);
  END;

  -- Camino feliz con todo: la nota interna y el outcome se normalizan con btrim.
  PERFORM ops.close_quote_request(
    v_fix.answered_id, 'resolved', v_fix.actor_id,
    '  Contrató al taller de Morón  ', 'hired', 'Le salió $180.000', 'Cierre de prueba'
  );
  SELECT * INTO v_row FROM quote_requests WHERE id = v_fix.answered_id;
  PERFORM pg_temp.check('37 answered → closed con todo',
    v_row.status = 'closed' AND v_row.closed_at IS NOT NULL
      AND v_row.close_reason_code = 'resolved'
      AND v_row.closed_reason = 'Contrató al taller de Morón'
      AND v_row.outcome = 'hired'
      AND v_row.outcome_note = 'Le salió $180.000',
    v_row.status::text || ' / ' || coalesce(v_row.closed_reason, '(null)'));
  PERFORM pg_temp.check('38 no pisa lo anterior al cierre',
    v_row.answered_at IS NOT NULL AND v_row.proposals_count = 2,
    coalesce(v_row.proposals_count::text, '(null)'));

  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_fix.answered_id AND action = 'quote_request.close';
  PERFORM pg_temp.check('39 log del cierre',
    v_log.before->>'status' = 'answered' AND v_log.after->>'close_reason_code' = 'resolved'
      AND v_log.note = 'Cierre de prueba',
    coalesce(v_log.after::text, '(sin log)'));

  -- Un spam o un duplicado se cierra directo desde received. `''` en la nota
  -- interna y en el outcome es "sin dato", no un valor en blanco.
  PERFORM ops.close_quote_request(v_fix.noted_id, 'duplicate', v_fix.actor_id, '', '', '');
  SELECT * INTO v_row FROM quote_requests WHERE id = v_fix.noted_id;
  PERFORM pg_temp.check('40 received → closed, con vacíos normalizados a NULL',
    v_row.status = 'closed' AND v_row.close_reason_code = 'duplicate'
      AND v_row.closed_reason IS NULL AND v_row.outcome IS NULL AND v_row.outcome_note IS NULL,
    v_row.status::text || ' / ' || coalesce(v_row.closed_reason, '(null)'));
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Nota interna
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fix t_fix%ROWTYPE;
  v_row quote_requests%ROWTYPE;
  v_log ops.action_log%ROWTYPE;
  v_msg text;
  -- `YYYY-MM-DD HH24:MI — ` en hora de Buenos Aires.
  c_stamp constant text := '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} — ';
BEGIN
  SELECT * INTO v_fix FROM t_fix;

  -- Sin notas previas: una sola línea, sin salto de línea adelante.
  PERFORM ops.add_quote_request_internal_note(v_fix.received_id, '  Taller X: $180.000, turno el jueves  ', v_fix.actor_id);
  SELECT * INTO v_row FROM quote_requests WHERE id = v_fix.received_id;
  PERFORM pg_temp.check('50 primera nota: una línea fechada',
    v_row.internal_notes ~ ('^' || c_stamp || 'Taller X: \$180\.000, turno el jueves$'),
    coalesce(v_row.internal_notes, '(null)'));

  -- Agrega, nunca pisa.
  PERFORM ops.add_quote_request_internal_note(v_fix.received_id, 'Taller Y no contesta', v_fix.actor_id);
  SELECT * INTO v_row FROM quote_requests WHERE id = v_fix.received_id;
  PERFORM pg_temp.check('51 segunda nota: se agrega al final y conserva la anterior',
    v_row.internal_notes ~ ('^' || c_stamp || 'Taller X: [^\n]+\n' || c_stamp || 'Taller Y no contesta$'),
    coalesce(v_row.internal_notes, '(null)'));

  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_fix.received_id AND action = 'quote_request.add_internal_note'
     AND after->>'internal_notes' LIKE '%Taller Y%';
  PERFORM pg_temp.check('52 log de la nota',
    v_log.before->>'internal_notes' LIKE '%Taller X%' AND v_log.actor_id = v_fix.actor_id,
    coalesce(v_log.before->>'internal_notes', '(sin log)'));

  BEGIN
    PERFORM ops.add_quote_request_internal_note(v_fix.contacted_id, '   ', v_fix.actor_id);
    PERFORM pg_temp.check('53 nota en blanco', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('53 nota en blanco', v_msg LIKE 'INTERNAL_NOTE_REQUIRED%', v_msg);
  END;

  BEGIN
    PERFORM ops.add_quote_request_internal_note(v_fix.closed_id, 'Tarde', v_fix.actor_id);
    PERFORM pg_temp.check('54 no anota un cerrado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('54 no anota un cerrado',
      v_msg LIKE 'INVALID_QUOTE_REQUEST_TRANSITION%', v_msg);
  END;
  SELECT * INTO v_row FROM quote_requests WHERE id = v_fix.closed_id;
  PERFORM pg_temp.check('55 el cerrado quedó sin notas', v_row.internal_notes IS NULL,
    coalesce(v_row.internal_notes, '(null)'));

  BEGIN
    PERFORM ops.add_quote_request_internal_note(gen_random_uuid(), 'Nota', v_fix.actor_id);
    PERFORM pg_temp.check('56 pedido inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('56 pedido inexistente', v_msg LIKE 'QUOTE_REQUEST_NOT_FOUND%', v_msg);
  END;
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
