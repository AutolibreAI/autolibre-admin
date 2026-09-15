-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 011.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/011_ops_avanzar_pedido.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea sus propios pedidos y su propio
-- actor. Mismo patrón que 008/009/010.
--
-- Dos pedidos de fixture: `qr1` se usa para la progresión completa (received →
-- … → closed → reabierto), `qr2` queda INTACTO hasta el caso 09 — hace falta
-- una fila que nunca pasó por `answered` para probar que `PROPOSALS_COUNT_
-- REQUIRED` sólo dispara la PRIMERA vez.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS qr1_id,
       gen_random_uuid() AS qr2_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-011-' || actor_id || '@example.invalid', 'admin',
       'clerk', 'test-011-' || actor_id
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission, status)
SELECT qr1_id, 'web'::quote_request_channel, '+54 11 5555 0001', 'AB123CD', 'Cambio de embrague',
       '{}'::jsonb, 'received'::quote_request_status
  FROM t_fix
UNION ALL
SELECT qr2_id, 'whatsapp'::quote_request_channel, '+54 11 5555 0002', 'XY987ZW', 'Service de los 10.000',
       '{}'::jsonb, 'received'::quote_request_status
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
   WHERE n.nspname = 'ops' AND p.proname = 'advance_quote_request';
  PERFORM pg_temp.check('01 existe UNA sola advance_quote_request', v_n = 1, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'advance_quote_request' AND p.prosecdef;
  PERFORM pg_temp.check('02 SECURITY INVOKER, no DEFINER', v_n = 0, v_n::text);

  PERFORM pg_temp.check('03 search_path fijo (guardrail 3)',
    EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'ops' AND p.proname = 'advance_quote_request'
         AND array_to_string(p.proconfig, ' ') LIKE 'search_path=%'
    ),
    (SELECT array_to_string(proconfig, ' ') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'ops' AND p.proname = 'advance_quote_request'));
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Comportamiento
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_qr1   uuid;
  v_qr2   uuid;
  v_actor uuid;
  v_row   quote_requests%ROWTYPE;
  v_log   ops.action_log%ROWTYPE;
  v_msg   text;
BEGIN
  SELECT qr1_id, qr2_id, actor_id INTO v_qr1, v_qr2, v_actor FROM t_fix;

  -- 04. received → contacted: sella contacted_at.
  PERFORM ops.advance_quote_request(v_qr1, 'contacted', v_actor);
  SELECT * INTO v_row FROM quote_requests WHERE id = v_qr1;
  PERFORM pg_temp.check('04 status = contacted', v_row.status = 'contacted', v_row.status::text);
  PERFORM pg_temp.check('05 contacted_at sellado', v_row.contacted_at IS NOT NULL, 'null');

  -- 06. contacted → answered SIN proposals_count → rechazado.
  BEGIN
    PERFORM ops.advance_quote_request(v_qr1, 'answered', v_actor);
    PERFORM pg_temp.check('06 answered sin proposals_count rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('06 answered sin proposals_count rechazado',
      v_msg LIKE 'PROPOSALS_COUNT_REQUIRED%', v_msg);
  END;

  -- 07. contacted → answered CON proposals_count → ok, sella answered_at.
  PERFORM ops.advance_quote_request(v_qr1, 'answered', v_actor, 3);
  SELECT * INTO v_row FROM quote_requests WHERE id = v_qr1;
  PERFORM pg_temp.check('07 status = answered', v_row.status = 'answered', v_row.status::text);
  PERFORM pg_temp.check('08 answered_at sellado', v_row.answered_at IS NOT NULL, 'null');
  PERFORM pg_temp.check('09 proposals_count guardado', v_row.proposals_count = 3, v_row.proposals_count::text);
  PERFORM pg_temp.check('10 answered_at >= contacted_at', v_row.answered_at >= v_row.contacted_at,
    v_row.answered_at::text || ' / ' || v_row.contacted_at::text);

  -- 11. closed SIN close_reason_code → rechazado.
  BEGIN
    PERFORM ops.advance_quote_request(v_qr1, 'closed', v_actor);
    PERFORM pg_temp.check('11 closed sin motivo rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('11 closed sin motivo rechazado', v_msg LIKE 'CLOSE_REASON_REQUIRED%', v_msg);
  END;

  -- 12. closed con 'cancelled_by_user' → rechazado (eso lo declara la persona).
  BEGIN
    PERFORM ops.advance_quote_request(v_qr1, 'closed', v_actor, NULL, 'cancelled_by_user');
    PERFORM pg_temp.check('12 cancelled_by_user rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('12 cancelled_by_user rechazado',
      v_msg LIKE 'CANNOT_CLOSE_AS_CANCELLED_BY_USER%', v_msg);
  END;

  -- 13. closed con motivo inválido → sentinela propia, no el error crudo de Postgres.
  BEGIN
    PERFORM ops.advance_quote_request(v_qr1, 'closed', v_actor, NULL, 'motivo_inventado');
    PERFORM pg_temp.check('13 motivo inválido rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('13 motivo inválido rechazado', v_msg LIKE 'INVALID_CLOSE_REASON%', v_msg);
  END;

  -- 14. closed con motivo válido → ok. proposals_count se conserva (coalesce).
  PERFORM ops.advance_quote_request(v_qr1, 'closed', v_actor, NULL, 'resolved', 'Se resolvió por WhatsApp');
  SELECT * INTO v_row FROM quote_requests WHERE id = v_qr1;
  PERFORM pg_temp.check('14 status = closed', v_row.status = 'closed', v_row.status::text);
  PERFORM pg_temp.check('15 closed_at sellado', v_row.closed_at IS NOT NULL, 'null');
  PERFORM pg_temp.check('16 close_reason_code = resolved', v_row.close_reason_code = 'resolved',
    coalesce(v_row.close_reason_code::text, '(null)'));
  PERFORM pg_temp.check('17 closed_reason guardado', v_row.closed_reason = 'Se resolvió por WhatsApp',
    coalesce(v_row.closed_reason, '(null)'));
  PERFORM pg_temp.check('18 proposals_count se conserva al cerrar', v_row.proposals_count = 3,
    v_row.proposals_count::text);

  -- 19. Reabrir (closed → contacted): las tres del cierre vuelven a NULL,
  -- contacted_at/answered_at quedan sellados tal cual estaban.
  PERFORM ops.advance_quote_request(v_qr1, 'contacted', v_actor);
  SELECT * INTO v_row FROM quote_requests WHERE id = v_qr1;
  PERFORM pg_temp.check('19 status = contacted (reabierto)', v_row.status = 'contacted', v_row.status::text);
  PERFORM pg_temp.check('20 closed_at limpiado al reabrir', v_row.closed_at IS NULL, 'no null');
  PERFORM pg_temp.check('21 close_reason_code limpiado al reabrir', v_row.close_reason_code IS NULL, 'no null');
  PERFORM pg_temp.check('22 closed_reason limpiado al reabrir', v_row.closed_reason IS NULL, 'no null');
  PERFORM pg_temp.check('23 answered_at se conserva al reabrir (sellado)', v_row.answered_at IS NOT NULL, 'null');
  PERFORM pg_temp.check('24 proposals_count se conserva al reabrir', v_row.proposals_count = 3,
    v_row.proposals_count::text);

  -- 25-26. Salto directo received → answered (sin pasar por contacted): las dos
  -- marcas se sellan con el MISMO now() de la transacción y el CHECK >= pasa.
  PERFORM ops.advance_quote_request(v_qr2, 'answered', v_actor, 1);
  SELECT * INTO v_row FROM quote_requests WHERE id = v_qr2;
  PERFORM pg_temp.check('25 salto directo: contacted_at también quedó sellado',
    v_row.contacted_at IS NOT NULL, 'null');
  PERFORM pg_temp.check('26 salto directo: answered_at >= contacted_at',
    v_row.answered_at >= v_row.contacted_at, 'check violado');

  -- 27. status inválido → sentinela.
  BEGIN
    PERFORM ops.advance_quote_request(v_qr2, 'inventado', v_actor);
    PERFORM pg_temp.check('27 status inválido rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('27 status inválido rechazado', v_msg LIKE 'INVALID_STATUS%', v_msg);
  END;

  -- 28. Pedido inexistente.
  BEGIN
    PERFORM ops.advance_quote_request(gen_random_uuid(), 'contacted', v_actor);
    PERFORM pg_temp.check('28 pedido inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('28 pedido inexistente', v_msg LIKE 'QUOTE_REQUEST_NOT_FOUND%', v_msg);
  END;

  -- 29-30. Actor inexistente / NULL.
  BEGIN
    PERFORM ops.advance_quote_request(v_qr2, 'contacted', gen_random_uuid());
    PERFORM pg_temp.check('29 actor inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('29 actor inexistente', v_msg LIKE 'ACTOR_NOT_FOUND%', v_msg);
  END;
  BEGIN
    PERFORM ops.advance_quote_request(v_qr2, 'contacted', NULL);
    PERFORM pg_temp.check('30 actor NULL', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('30 actor NULL', v_msg LIKE 'ACTOR_REQUIRED%', v_msg);
  END;

  -- 31-34. Auditoría: la llamada del caso 04 (received → contacted) quedó
  -- en el log con before/after. Se filtra por el before de ESA llamada — es
  -- la única con status 'received' para v_qr1, porque `now()` es constante y
  -- un ORDER BY por tiempo no desempata entre llamadas de la misma transacción.
  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_qr1 AND action = 'quote_request.advance'
     AND before->>'status' = 'received'
   LIMIT 1;
  PERFORM pg_temp.check('31 log: status viejo en before',
    v_log.before->>'status' = 'received', coalesce(v_log.before->>'status', '(null)'));
  PERFORM pg_temp.check('32 log: status nuevo en after',
    v_log.after->>'status' = 'contacted', coalesce(v_log.after->>'status', '(null)'));
  PERFORM pg_temp.check('33 log: actor de la sesión', v_log.actor_id = v_actor, v_log.actor_id::text);
  PERFORM pg_temp.check('34 log: target_table', v_log.target_table = 'public.quote_requests', v_log.target_table);

  -- 35. Guardrail 8: el SP no escribe updated_at a mano.
  PERFORM pg_temp.check('35 el SP no escribe updated_at a mano',
    pg_get_functiondef('ops.advance_quote_request(uuid,text,uuid,int,text,text,text)'::regprocedure)
      !~* 'updated_at[[:space:]]*=',
    'lo pone trg_quote_requests_updated_at');
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL exacto que va a mandar el repo (parámetros nombrados).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_qr2 uuid;
  v_actor uuid;
  v_out jsonb;
BEGIN
  SELECT qr2_id, actor_id INTO v_qr2, v_actor FROM t_fix;

  SELECT ops.advance_quote_request(
    p_quote_request_id := v_qr2,
    p_status            := 'closed',
    p_actor_id          := v_actor,
    p_close_reason_code := 'duplicate',
    p_note              := 'Duplicado del AL-anterior'
  ) INTO v_out;

  PERFORM pg_temp.check('36 integración: parámetros nombrados',
    v_out->>'status' = 'closed' AND v_out->>'close_reason_code' = 'duplicate',
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
