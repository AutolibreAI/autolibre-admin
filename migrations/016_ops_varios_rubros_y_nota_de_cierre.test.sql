-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 016.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/016_ops_varios_rubros_y_nota_de_cierre.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea su propio actor y sus propios
-- pedidos. Mismo patrón que 007–015.
--
-- Corrida en DOS partes: primero SIN la migración (en rojo, contra la base
-- tal cual quedó después de la 015 — `ops.set_quote_request_rubro` singular y
-- `ops.close_quote_request` de 7 parámetros todavía existen) para confirmar
-- que efectivamente falla por lo que tiene que fallar, y recién después con
-- la 016 aplicada.
--
-- Usa `motor` y `transmision` — slugs reales de `service_categories`,
-- relevados contra la base antes de escribir este archivo (mismos que la 013).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS other_actor_id,
       -- Para los rubros.
       gen_random_uuid() AS qr_rubro_id,
       gen_random_uuid() AS qr_dedupe_id,
       -- Para re-verificar close_quote_request, un pedido por estado —mismo
       -- patrón que la 011.
       gen_random_uuid() AS answered_id,
       gen_random_uuid() AS cancelled_id,
       gen_random_uuid() AS noted_id,
       -- Para la integración con el SQL exacto del repo.
       gen_random_uuid() AS repo_rubro_id,
       gen_random_uuid() AS repo_close_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-016-' || actor_id || '@example.invalid', 'admin', 'clerk', 'test-016-' || actor_id
  FROM t_fix
UNION ALL
SELECT other_actor_id, 'test-016-b-' || other_actor_id || '@example.invalid', 'admin', 'clerk', 'test-016-b-' || other_actor_id
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission)
SELECT qr_rubro_id, 'whatsapp', '5491100000000', 'AB123CD', 'Test 016: ruido al frenar', '{}'::jsonb
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission)
SELECT qr_dedupe_id, 'whatsapp', '5491100000003', 'XX111ZZ', 'Test 016: dedupe', '{}'::jsonb
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission,
                            status, contacted_at, answered_at, proposals_count)
SELECT answered_id, 'web', '5491100000000', 'AB123CD', 'Test 016 respondido', '{}'::jsonb,
       'answered', now() - interval '2 days', now() - interval '1 day', 2
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission,
                            status, closed_at, close_reason_code, cancellation_reason)
SELECT cancelled_id, 'app', '5491100000000', 'AB123CD', 'Test 016 cancelado', '{}'::jsonb,
       'closed', now() - interval '1 day', 'cancelled_by_user', 'no_longer_needed'
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission, internal_notes)
SELECT noted_id, 'web', '5491100000000', 'AB123CD', 'Test 016 con notas', '{}'::jsonb, 'Nota vieja'
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission)
SELECT repo_rubro_id, 'whatsapp', '5491100000001', 'ZZ999YY', 'Test 016 integración rubros', '{}'::jsonb
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission,
                            status, contacted_at, answered_at, proposals_count)
SELECT repo_close_id, 'web', '5491100000002', 'YY888XX', 'Test 016 integración cierre', '{}'::jsonb,
       'answered', now() - interval '2 days', now() - interval '1 day', 1
  FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, coalesce(p_ok, false), p_detalle);
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Guardrails de forma
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'set_quote_request_rubros';
  PERFORM pg_temp.check('01 existe UNA sola ops.set_quote_request_rubros', v_n = 1, v_n::text);

  -- La 013 se retiró: no puede quedar una sobrecarga vieja conviviendo.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'set_quote_request_rubro';
  PERFORM pg_temp.check('02 set_quote_request_rubro (singular, 013) ya no existe', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'close_quote_request';
  PERFORM pg_temp.check('03 existe UNA sola ops.close_quote_request', v_n = 1, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname IN ('set_quote_request_rubros', 'close_quote_request') AND p.prosecdef;
  PERFORM pg_temp.check('04 SECURITY INVOKER, no DEFINER', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname IN ('set_quote_request_rubros', 'close_quote_request')
     AND coalesce(array_to_string(p.proconfig, ' '), '') NOT LIKE 'search_path=%';
  PERFORM pg_temp.check('05 search_path fijo en las dos (guardrail 3)', v_n = 0, v_n::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ops.set_quote_request_rubros
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fix   t_fix%ROWTYPE;
  v_out   jsonb;
  v_slugs text[];
  v_log   ops.action_log%ROWTYPE;
  v_msg   text;
BEGIN
  SELECT * INTO v_fix FROM t_fix;

  -- 10-12. Camino feliz: un solo rubro.
  v_out := ops.set_quote_request_rubros(v_fix.qr_rubro_id, v_fix.actor_id, ARRAY['motor'], 'Primera clasificación');
  SELECT array_agg(category_slug ORDER BY category_slug) INTO v_slugs
    FROM ops.quote_request_rubro WHERE quote_request_id = v_fix.qr_rubro_id;
  PERFORM pg_temp.check('10 queda UNA fila: motor', v_slugs = ARRAY['motor'], array_to_string(v_slugs, ','));
  PERFORM pg_temp.check('11 devuelve el conjunto guardado',
    v_out->'category_slugs' = to_jsonb(ARRAY['motor']), v_out::text);
  PERFORM pg_temp.check('12 actor_id de la sesión',
    (SELECT actor_id FROM ops.quote_request_rubro WHERE quote_request_id = v_fix.qr_rubro_id AND category_slug = 'motor')
      = v_fix.actor_id, 'no coincide');

  -- 13-14. Reclasificar a VARIOS rubros reemplaza el conjunto entero.
  v_out := ops.set_quote_request_rubros(v_fix.qr_rubro_id, v_fix.other_actor_id, ARRAY['motor', 'transmision']);
  SELECT array_agg(category_slug ORDER BY category_slug) INTO v_slugs
    FROM ops.quote_request_rubro WHERE quote_request_id = v_fix.qr_rubro_id;
  PERFORM pg_temp.check('13 ahora son DOS filas: motor, transmision',
    v_slugs = ARRAY['motor', 'transmision'], array_to_string(v_slugs, ','));
  PERFORM pg_temp.check('14 el actor de las dos filas es el nuevo',
    (SELECT count(*) FROM ops.quote_request_rubro
      WHERE quote_request_id = v_fix.qr_rubro_id AND actor_id = v_fix.other_actor_id) = 2, 'no coincide');

  -- 15. `[]` vacía: sin clasificar, borra todo.
  v_out := ops.set_quote_request_rubros(v_fix.qr_rubro_id, v_fix.actor_id, ARRAY[]::text[]);
  PERFORM pg_temp.check('15 [] borra todo',
    (SELECT count(*) FROM ops.quote_request_rubro WHERE quote_request_id = v_fix.qr_rubro_id) = 0,
    (SELECT count(*)::text FROM ops.quote_request_rubro WHERE quote_request_id = v_fix.qr_rubro_id));

  -- 16-17. Rubro inválido rechazado, y NO cambia nada (todavía vacío del paso 15).
  BEGIN
    PERFORM ops.set_quote_request_rubros(v_fix.qr_rubro_id, v_fix.actor_id, ARRAY['motor', 'no-existe']);
    PERFORM pg_temp.check('16 rubro inválido rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('16 rubro inválido rechazado', v_msg LIKE 'INVALID_CATEGORY_SLUG%', v_msg);
  END;
  PERFORM pg_temp.check('17 nada se aplicó parcialmente',
    (SELECT count(*) FROM ops.quote_request_rubro WHERE quote_request_id = v_fix.qr_rubro_id) = 0, 'quedó algo');

  -- 18. Pedido inexistente.
  BEGIN
    PERFORM ops.set_quote_request_rubros(gen_random_uuid(), v_fix.actor_id, ARRAY['motor']);
    PERFORM pg_temp.check('18 pedido inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('18 pedido inexistente', v_msg LIKE 'QUOTE_REQUEST_NOT_FOUND%', v_msg);
  END;

  -- 19-20. Actor inexistente / NULL.
  BEGIN
    PERFORM ops.set_quote_request_rubros(v_fix.qr_rubro_id, gen_random_uuid(), ARRAY['motor']);
    PERFORM pg_temp.check('19 actor inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('19 actor inexistente', v_msg LIKE 'ACTOR_NOT_FOUND%', v_msg);
  END;
  BEGIN
    PERFORM ops.set_quote_request_rubros(v_fix.qr_rubro_id, NULL, ARRAY['motor']);
    PERFORM pg_temp.check('20 actor NULL', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('20 actor NULL', v_msg LIKE 'ACTOR_REQUIRED%', v_msg);
  END;

  -- 21-23. Auditoría: log #1 (before []) y log de la reclasificación (before
  -- motor, after motor+transmision) y el de vaciado (before motor+transmision,
  -- after []).
  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_fix.qr_rubro_id AND action = 'quote_request.set_rubros'
   ORDER BY created_at ASC LIMIT 1;
  PERFORM pg_temp.check('21 log #1: before vacío', v_log.before->'category_slugs' = '[]'::jsonb, v_log.before::text);

  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_fix.qr_rubro_id AND action = 'quote_request.set_rubros'
   ORDER BY created_at ASC OFFSET 1 LIMIT 1;
  PERFORM pg_temp.check('22 log #2: before=[motor], after=[motor,transmision]',
    v_log.before->'category_slugs' = to_jsonb(ARRAY['motor'])
      AND v_log.after->'category_slugs' = to_jsonb(ARRAY['motor', 'transmision']),
    v_log.after::text);

  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_fix.qr_rubro_id AND action = 'quote_request.set_rubros'
   ORDER BY created_at DESC LIMIT 1;
  PERFORM pg_temp.check('23 log #3: after vacío (el borrado del paso 15)',
    v_log.after->'category_slugs' = '[]'::jsonb, v_log.after::text);

  -- 24. Guardrail 6: sin FK cruzada. Se re-clasifica y se borra el pedido.
  PERFORM ops.set_quote_request_rubros(v_fix.qr_rubro_id, v_fix.actor_id, ARRAY['motor']);
  DELETE FROM quote_requests WHERE id = v_fix.qr_rubro_id;
  PERFORM pg_temp.check('24 sin FK a quote_requests: la fila de ops sobrevive al DELETE',
    EXISTS (SELECT 1 FROM ops.quote_request_rubro WHERE quote_request_id = v_fix.qr_rubro_id), 'desapareció');

  -- 25. Un slug repetido en el array no revienta con unique_violation — se
  -- deduplica antes de insertar. Pedido propio, aislado de los logs de arriba.
  v_out := ops.set_quote_request_rubros(v_fix.qr_dedupe_id, v_fix.actor_id, ARRAY['motor', 'motor']);
  SELECT array_agg(category_slug ORDER BY category_slug) INTO v_slugs
    FROM ops.quote_request_rubro WHERE quote_request_id = v_fix.qr_dedupe_id;
  PERFORM pg_temp.check('25 slug repetido se deduplica', v_slugs = ARRAY['motor'], array_to_string(v_slugs, ','));
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ops.close_quote_request — re-verificación de la 011 + el `p_internal_note`
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fix t_fix%ROWTYPE;
  v_row quote_requests%ROWTYPE;
  v_log ops.action_log%ROWTYPE;
  v_msg text;
BEGIN
  SELECT * INTO v_fix FROM t_fix;

  -- 30-33. Las mismas cuatro validaciones que ya probaba la 011: nada de esto
  -- se puede haber perdido en el DROP + CREATE.
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
    PERFORM pg_temp.check('31 cancelled_by_user es de la app', v_msg LIKE 'CLOSE_REASON_RESERVED_FOR_APP%', v_msg);
  END;

  BEGIN
    PERFORM ops.close_quote_request(v_fix.answered_id, 'se_cerro', v_fix.actor_id);
    PERFORM pg_temp.check('32 código de cierre fuera del enum', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('32 código de cierre fuera del enum', v_msg LIKE 'INVALID_CLOSE_REASON_CODE%', v_msg);
  END;

  BEGIN
    PERFORM ops.close_quote_request(v_fix.answered_id, 'resolved', v_fix.actor_id, NULL, 'quizas');
    PERFORM pg_temp.check('33 outcome fuera del enum', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('33 outcome fuera del enum', v_msg LIKE 'INVALID_OUTCOME%', v_msg);
  END;

  BEGIN
    PERFORM ops.close_quote_request(v_fix.cancelled_id, 'resolved', v_fix.actor_id);
    PERFORM pg_temp.check('34 no toca un cancelado por el usuario', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('34 no toca un cancelado por el usuario', v_msg LIKE 'INVALID_QUOTE_REQUEST_TRANSITION%', v_msg);
  END;

  BEGIN
    PERFORM ops.close_quote_request(gen_random_uuid(), 'resolved', v_fix.actor_id);
    PERFORM pg_temp.check('35 pedido inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('35 pedido inexistente', v_msg LIKE 'QUOTE_REQUEST_NOT_FOUND%', v_msg);
  END;

  -- 36-38. Camino feliz SIN nota nueva: el cierre no le agrega nada al hilo.
  PERFORM ops.close_quote_request(
    v_fix.answered_id, 'resolved', v_fix.actor_id,
    'Contrató al taller de Morón', 'hired', 'Le salió $180.000'
  );
  SELECT * INTO v_row FROM quote_requests WHERE id = v_fix.answered_id;
  PERFORM pg_temp.check('36 answered → closed con motivo y resultado',
    v_row.status = 'closed' AND v_row.close_reason_code = 'resolved'
      AND v_row.closed_reason = 'Contrató al taller de Morón' AND v_row.outcome = 'hired',
    v_row.status::text);
  PERFORM pg_temp.check('37 no pisa lo anterior al cierre',
    v_row.answered_at IS NOT NULL AND v_row.proposals_count = 2, coalesce(v_row.proposals_count::text, '(null)'));
  PERFORM pg_temp.check('38 sin p_internal_note, el hilo queda como estaba (NULL)',
    v_row.internal_notes IS NULL, coalesce(v_row.internal_notes, '(no null)'));

  -- 39-41. Camino feliz CON nota nueva: se agrega al hilo, fechada, EN LA
  -- MISMA operación que cierra — es lo nuevo de esta migración.
  PERFORM ops.close_quote_request(
    v_fix.noted_id, 'duplicate', v_fix.actor_id,
    p_internal_note => 'Llamó dos veces por error', p_note => 'Cierre con nota'
  );
  SELECT * INTO v_row FROM quote_requests WHERE id = v_fix.noted_id;
  PERFORM pg_temp.check('39 received → closed, con la nota agregada al hilo',
    v_row.status = 'closed' AND v_row.close_reason_code = 'duplicate'
      AND v_row.internal_notes LIKE '%Nota vieja%'
      AND v_row.internal_notes LIKE '%— Llamó dos veces por error',
    coalesce(v_row.internal_notes, '(null)'));
  PERFORM pg_temp.check('40 la línea nueva lleva el sello fechado de Buenos Aires',
    v_row.internal_notes ~ '\d{4}-\d{2}-\d{2} \d{2}:\d{2} — Llamó dos veces por error$',
    coalesce(v_row.internal_notes, '(null)'));

  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_fix.noted_id AND action = 'quote_request.close';
  PERFORM pg_temp.check('41 log del cierre: after ya trae la nota agregada',
    v_log.after->>'internal_notes' LIKE '%Llamó dos veces por error', coalesce(v_log.after->>'internal_notes', '(sin log)'));
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL exacto que van a mandar los repos (parámetros nombrados)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor uuid;
  v_out   jsonb;
BEGIN
  SELECT actor_id INTO v_actor FROM t_fix;

  SELECT ops.set_quote_request_rubros(
    p_quote_request_id => (SELECT repo_rubro_id FROM t_fix),
    p_actor_id         => v_actor,
    p_category_slugs   => ARRAY['motor', 'transmision'],
    p_note             => NULL
  ) INTO v_out;

  PERFORM pg_temp.check('50 integración rubros: parámetros nombrados',
    v_out->'category_slugs' = to_jsonb(ARRAY['motor', 'transmision']), v_out::text);

  SELECT ops.close_quote_request(
    p_quote_request_id  => (SELECT repo_close_id FROM t_fix),
    p_close_reason_code => 'no_workshops_found',
    p_actor_id          => v_actor,
    p_closed_reason     => 'Nadie en la zona',
    p_outcome           => NULL,
    p_outcome_note      => NULL,
    p_internal_note     => 'Nota desde el repo',
    p_note              => 'Cierre desde el repo'
  ) INTO v_out;

  PERFORM pg_temp.check('51 integración cierre: parámetros nombrados, con nota atómica',
    v_out->>'status' = 'closed' AND v_out->>'internal_notes' LIKE '%Nota desde el repo', v_out::text);
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
