-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 015.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/015_ops_respuestas_de_talleres.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea su propio actor, sus propios
-- pedidos y su propio partner de fixture — mismo patrón que 010/011/012/013.
--
-- El partner es PROPIO y no uno real por el motivo que ya anota la 008: un
-- `SELECT ... FOR UPDATE` sobre una fila real la bloquea mientras la
-- transacción está abierta.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS qr_id,
       gen_random_uuid() AS qr_closed_id,
       gen_random_uuid() AS qr_other_id,
       gen_random_uuid() AS partner_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-015-' || actor_id || '@example.invalid', 'admin',
       'clerk', 'test-015-' || actor_id
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission)
SELECT qr_id, 'whatsapp', '5491100000000', 'PNZ450', 'Test 015: revoluciones al acelerar', '{}'::jsonb
  FROM t_fix
UNION ALL
SELECT qr_other_id, 'web', '5491100000003', 'ZZ999YY', 'Test 015: otro pedido', '{}'::jsonb
  FROM t_fix;

-- Un pedido ya cerrado, para el caso que documenta que el SP NO exige que el
-- pedido esté abierto.
INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission,
                            status, contacted_at, closed_at, close_reason_code)
SELECT qr_closed_id, 'web', '5491100000002', 'CD456EF', 'Test 015: pedido cerrado', '{}'::jsonb,
       'closed', now(), now(), 'resolved'
  FROM t_fix;

INSERT INTO partners (id, name, coverage_zone, status)
SELECT partner_id, 'Taller de prueba 015', 'Zona Norte', 'paused'
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
DECLARE
  v_fn text;
  v_n  int;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['add_quote_request_response',
                              'update_quote_request_response',
                              'delete_quote_request_response',
                              'reorder_quote_request_responses'] LOOP
    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = v_fn;
    PERFORM pg_temp.check('01 ' || v_fn || ': existe UNA sola firma', v_n = 1, v_n::text);

    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = v_fn AND p.prosecdef;
    PERFORM pg_temp.check('02 ' || v_fn || ': SECURITY INVOKER, no DEFINER', v_n = 0, v_n::text);

    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = v_fn
       AND array_to_string(p.proconfig, ' ') LIKE 'search_path=%';
    PERFORM pg_temp.check('03 ' || v_fn || ': search_path fijo (guardrail 3)', v_n = 1, v_n::text);
  END LOOP;

  -- Guardrail 6: ninguna FK cruza a `public`.
  SELECT count(*) INTO v_n
    FROM pg_constraint c
   WHERE c.conrelid = 'ops.quote_request_response'::regclass AND c.contype = 'f';
  PERFORM pg_temp.check('04 sin FK a public (guardrail 6)', v_n = 0, v_n::text);

  -- Guardrail 8: acá el `updated_at` lo escriben las funciones, no un trigger.
  SELECT count(*) INTO v_n
    FROM pg_trigger t
   WHERE t.tgrelid = 'ops.quote_request_response'::regclass AND NOT t.tgisinternal;
  PERFORM pg_temp.check('05 sin trigger propio: updated_at lo escribe la función', v_n = 0, v_n::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Alta — los tres estados del precio
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor   uuid;
  v_qr      uuid;
  v_closed  uuid;
  v_partner uuid;
  v_out     jsonb;
  v_id      uuid;
  v_log     ops.action_log%ROWTYPE;
  v_msg     text;
  v_n       int;
BEGIN
  SELECT actor_id, qr_id, qr_closed_id, partner_id
    INTO v_actor, v_qr, v_closed, v_partner FROM t_fix;

  -- 10-17. Taller de AFUERA, SIN precio (el caso del mensaje real: diagnóstico).
  v_out := ops.add_quote_request_response(
    p_quote_request_id => v_qr,
    p_actor_id         => v_actor,
    p_detail           => '  Ofrecen diagnóstico sin cargo y lo pueden ver en el día.  ',
    p_provider_name    => '  Matic Pro — Cajas Automáticas  ',
    p_provider_address => '  Monseñor Larumbe 929, Martínez  ',
    p_provider_phone   => '  91126883183  ',
    p_note             => 'Cargado desde el panel'
  );
  v_id := (v_out->>'id')::uuid;

  PERFORM pg_temp.check('10 alta sin precio: amount_min NULL',
    v_out->>'amount_min' IS NULL, coalesce(v_out->>'amount_min', '(null)'));
  PERFORM pg_temp.check('11 alta sin precio: amount_max NULL',
    v_out->>'amount_max' IS NULL, coalesce(v_out->>'amount_max', '(null)'));
  PERFORM pg_temp.check('12 alta: provider_name trimeado',
    v_out->>'provider_name' = 'Matic Pro — Cajas Automáticas', v_out->>'provider_name');
  PERFORM pg_temp.check('13 alta: dirección del taller de afuera guardada',
    v_out->>'provider_address' = 'Monseñor Larumbe 929, Martínez', v_out->>'provider_address');
  PERFORM pg_temp.check('14 alta: teléfono guardado CRUDO (no se normaliza ni se adivina)',
    v_out->>'provider_phone' = '91126883183', v_out->>'provider_phone');
  PERFORM pg_temp.check('15 alta: detail trimeado',
    v_out->>'detail' = 'Ofrecen diagnóstico sin cargo y lo pueden ver en el día.', v_out->>'detail');
  PERFORM pg_temp.check('16 alta: currency default ARS aun sin precio',
    v_out->>'currency' = 'ARS', v_out->>'currency');
  PERFORM pg_temp.check('17 alta: primera respuesta → position 1',
    (v_out->>'position')::int = 1, v_out->>'position');

  -- 18-19. El log del alta.
  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_id AND action = 'quote_request_response.add';
  PERFORM pg_temp.check('18 log alta: before NULL, actor de la sesión, nota de auditoría',
    v_log.before IS NULL AND v_log.actor_id = v_actor AND v_log.note = 'Cargado desde el panel',
    coalesce(v_log.after::text, '(sin log)'));
  PERFORM pg_temp.check('19 log alta: target_table es la de ops',
    v_log.target_table = 'ops.quote_request_response', v_log.target_table);

  -- 20-22. PARTNER del directorio, precio CERO (sin cargo) — no es lo mismo
  --        que sin precio, y el backend ni siquiera lo admitiría.
  v_out := ops.add_quote_request_response(
    p_quote_request_id => v_qr,
    p_actor_id         => v_actor,
    p_detail           => 'Revisión sin cargo, con turno el miércoles.',
    p_partner_id       => v_partner,
    p_amount_min       => 0,
    p_amount_max       => 0
  );
  PERFORM pg_temp.check('20 alta: precio 0 aceptado (sin cargo ≠ sin precio)',
    (v_out->>'amount_min')::numeric = 0 AND v_out->>'amount_min' IS NOT NULL, v_out->>'amount_min');
  PERFORM pg_temp.check('21 alta: partner del directorio, provider_name NULL',
    (v_out->>'partner_id')::uuid = v_partner AND v_out->>'provider_name' IS NULL, v_out::text);
  PERFORM pg_temp.check('22 alta: segunda respuesta → position 2',
    (v_out->>'position')::int = 2, v_out->>'position');

  -- 23. Partner PAUSADO aceptado: se valida que exista, no que esté publicado.
  PERFORM pg_temp.check('23 partner pausado aceptado (representabilidad, no regla de negocio)',
    (SELECT status::text FROM partners WHERE id = v_partner) = 'paused', 'el fixture no está pausado');

  -- 24-26. Rango con precio, en USD, con vigencia.
  v_out := ops.add_quote_request_response(
    p_quote_request_id => v_qr,
    p_actor_id         => v_actor,
    p_detail           => 'Cambio de sensor con repuesto importado.',
    p_provider_name    => 'Otro taller',
    p_amount_min       => 450,
    p_amount_max       => 600,
    p_currency         => 'usd',
    p_valid_until      => to_char(now() + interval '10 days', 'YYYY-MM-DD'),
    p_internal_notes   => '  Lo atendió Juan  '
  );
  PERFORM pg_temp.check('24 alta: rango guardado',
    (v_out->>'amount_min')::numeric = 450 AND (v_out->>'amount_max')::numeric = 600, v_out::text);
  PERFORM pg_temp.check('25 alta: currency en minúscula se normaliza a USD',
    v_out->>'currency' = 'USD', v_out->>'currency');
  PERFORM pg_temp.check('26 alta: internal_notes trimeadas',
    v_out->>'internal_notes' = 'Lo atendió Juan', v_out->>'internal_notes');

  -- 27. Un pedido CERRADO acepta respuestas.
  v_out := ops.add_quote_request_response(
    p_quote_request_id => v_closed,
    p_actor_id         => v_actor,
    p_detail           => 'Contestó tarde.',
    p_provider_name    => 'Tardío'
  );
  PERFORM pg_temp.check('27 pedido cerrado acepta respuesta (no decide reglas de negocio)',
    (v_out->>'quote_request_id')::uuid = v_closed, v_out->>'quote_request_id');
  PERFORM pg_temp.check('28 position es POR PEDIDO: el cerrado arranca en 1',
    (v_out->>'position')::int = 1, v_out->>'position');

  -- 29. `proposals_count` del pedido NO se toca.
  SELECT proposals_count INTO v_n FROM quote_requests WHERE id = v_qr;
  PERFORM pg_temp.check('29 no escribe quote_requests.proposals_count',
    v_n IS NULL, coalesce(v_n::text, '(null)'));

  -- ── Sentinelas del alta ──────────────────────────────────────────────────

  BEGIN
    PERFORM ops.add_quote_request_response(v_qr, v_actor, 'Sin taller');
    PERFORM pg_temp.check('30 sin taller rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('30 sin taller rechazado', v_msg LIKE 'PROVIDER_REQUIRED%', v_msg);
  END;

  BEGIN
    PERFORM ops.add_quote_request_response(v_qr, v_actor, 'Dos talleres', v_partner, 'Y además éste');
    PERFORM pg_temp.check('31 partner + nombre libre rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('31 partner + nombre libre rechazado', v_msg LIKE 'PROVIDER_AMBIGUOUS%', v_msg);
  END;

  BEGIN
    PERFORM ops.add_quote_request_response(
      v_qr, v_actor, 'Contacto sobre un partner', v_partner, NULL, 'Calle Falsa 123');
    PERFORM pg_temp.check('32 dirección tipeada sobre un partner rechazada', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('32 dirección tipeada sobre un partner rechazada',
      v_msg LIKE 'PROVIDER_CONTACT_NOT_EDITABLE%', v_msg);
  END;

  BEGIN
    PERFORM ops.add_quote_request_response(v_qr, v_actor, 'Partner fantasma', gen_random_uuid());
    PERFORM pg_temp.check('33 partner inexistente rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('33 partner inexistente rechazado', v_msg LIKE 'PARTNER_NOT_FOUND%', v_msg);
  END;

  BEGIN
    PERFORM ops.add_quote_request_response(v_qr, v_actor, '   ', NULL, 'Taller');
    PERFORM pg_temp.check('34 detail en blanco rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('34 detail en blanco rechazado', v_msg LIKE 'DETAIL_REQUIRED%', v_msg);
  END;

  BEGIN
    PERFORM ops.add_quote_request_response(
      v_qr, v_actor, 'Media punta', NULL, 'Taller', NULL, NULL, 1000, NULL);
    PERFORM pg_temp.check('35 una sola punta del rango rechazada', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('35 una sola punta del rango rechazada', v_msg LIKE 'AMOUNT_INCOMPLETE%', v_msg);
  END;

  BEGIN
    PERFORM ops.add_quote_request_response(
      v_qr, v_actor, 'Negativo', NULL, 'Taller', NULL, NULL, -1, 100);
    PERFORM pg_temp.check('36 precio negativo rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('36 precio negativo rechazado', v_msg LIKE 'INVALID_AMOUNT%', v_msg);
  END;

  BEGIN
    PERFORM ops.add_quote_request_response(
      v_qr, v_actor, 'Al revés', NULL, 'Taller', NULL, NULL, 300, 200);
    PERFORM pg_temp.check('37 rango invertido rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('37 rango invertido rechazado', v_msg LIKE 'INVALID_AMOUNT_RANGE%', v_msg);
  END;

  BEGIN
    PERFORM ops.add_quote_request_response(
      v_qr, v_actor, 'Gigante', NULL, 'Taller', NULL, NULL, 1, 99999999999.99);
    PERFORM pg_temp.check('38 monto fuera de numeric(12,2) rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('38 monto fuera de numeric(12,2) rechazado', v_msg LIKE 'AMOUNT_TOO_LARGE%', v_msg);
  END;

  BEGIN
    PERFORM ops.add_quote_request_response(
      v_qr, v_actor, 'Moneda rara', NULL, 'Taller', NULL, NULL, 100, 200, 'EUR');
    PERFORM pg_temp.check('39 moneda fuera del catálogo rechazada', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('39 moneda fuera del catálogo rechazada', v_msg LIKE 'INVALID_CURRENCY%', v_msg);
  END;

  BEGIN
    PERFORM ops.add_quote_request_response(
      v_qr, v_actor, 'Fecha rota', NULL, 'Taller', NULL, NULL, NULL, NULL, 'ARS', '31/12/2026');
    PERFORM pg_temp.check('40 vigencia con formato malo rechazada', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('40 vigencia con formato malo rechazada', v_msg LIKE 'INVALID_VALID_UNTIL%', v_msg);
  END;

  BEGIN
    PERFORM ops.add_quote_request_response(
      v_qr, v_actor, 'Vencido al nacer', NULL, 'Taller', NULL, NULL, NULL, NULL, 'ARS', '2020-01-01');
    PERFORM pg_temp.check('41 vigencia en el pasado rechazada', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('41 vigencia en el pasado rechazada', v_msg LIKE 'VALID_UNTIL_IN_PAST%', v_msg);
  END;

  BEGIN
    PERFORM ops.add_quote_request_response(gen_random_uuid(), v_actor, 'Huérfano', NULL, 'Taller');
    PERFORM pg_temp.check('42 pedido inexistente rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('42 pedido inexistente rechazado', v_msg LIKE 'QUOTE_REQUEST_NOT_FOUND%', v_msg);
  END;

  BEGIN
    PERFORM ops.add_quote_request_response(v_qr, gen_random_uuid(), 'Actor fantasma', NULL, 'Taller');
    PERFORM pg_temp.check('43 actor inexistente rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('43 actor inexistente rechazado', v_msg LIKE 'ACTOR_NOT_FOUND%', v_msg);
  END;

  BEGIN
    PERFORM ops.add_quote_request_response(v_qr, NULL, 'Sin actor', NULL, 'Taller');
    PERFORM pg_temp.check('44 actor NULL rechazado (guardrail 4)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('44 actor NULL rechazado (guardrail 4)', v_msg LIKE 'ACTOR_REQUIRED%', v_msg);
  END;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Edición y baja
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor   uuid;
  v_qr      uuid;
  v_partner uuid;
  v_out     jsonb;
  v_id      uuid;
  v_created timestamptz;
  v_updated timestamptz;
  v_log     ops.action_log%ROWTYPE;
  v_msg     text;
BEGIN
  SELECT actor_id, qr_id, partner_id INTO v_actor, v_qr, v_partner FROM t_fix;

  v_out := ops.add_quote_request_response(
    p_quote_request_id => v_qr,
    p_actor_id         => v_actor,
    p_detail           => 'Para editar',
    p_provider_name    => 'Taller viejo',
    p_provider_phone   => '1122334455',
    p_amount_min       => 100,
    p_amount_max       => 200,
    p_internal_notes   => 'Nota vieja'
  );
  v_id      := (v_out->>'id')::uuid;
  v_created := (v_out->>'created_at')::timestamptz;
  v_updated := (v_out->>'updated_at')::timestamptz;

  -- 50-55. Edición: reemplazo COMPLETO, no parche.
  v_out := ops.update_quote_request_response(
    p_id         => v_id,
    p_actor_id   => v_actor,
    p_detail     => 'Corregido',
    p_partner_id => v_partner,
    p_note       => 'El precio había quedado mal'
  );
  PERFORM pg_temp.check('50 edición: pasa de taller libre a partner (nombre y contacto se borran)',
    (v_out->>'partner_id')::uuid = v_partner
      AND v_out->>'provider_name' IS NULL
      AND v_out->>'provider_phone' IS NULL,
    v_out::text);
  PERFORM pg_temp.check('51 edición: un opcional no mandado se BORRA (reemplazo completo)',
    v_out->>'internal_notes' IS NULL, coalesce(v_out->>'internal_notes', '(null)'));
  PERFORM pg_temp.check('52 edición: el precio se puede QUITAR (vuelve a NULL)',
    v_out->>'amount_min' IS NULL, coalesce(v_out->>'amount_min', '(null)'));
  PERFORM pg_temp.check('53 edición: created_at NO se pisa',
    (v_out->>'created_at')::timestamptz = v_created, v_out->>'created_at');
  PERFORM pg_temp.check('54 edición: updated_at avanza (lo escribe la función, no un trigger)',
    (v_out->>'updated_at')::timestamptz >= v_updated, v_out->>'updated_at');
  PERFORM pg_temp.check('55 edición: sigue colgando del mismo pedido y en su posición',
    (v_out->>'quote_request_id')::uuid = v_qr AND (v_out->>'position')::int > 0, v_out::text);

  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_id AND action = 'quote_request_response.update';
  PERFORM pg_temp.check('56 log edición: before con el precio viejo, after sin precio',
    (v_log.before->>'amount_min')::numeric = 100 AND v_log.after->>'amount_min' IS NULL,
    coalesce(v_log.before::text, '(sin log)'));

  -- 57-58. Las validaciones del alta valen igual en la edición (mismo helper).
  BEGIN
    PERFORM ops.update_quote_request_response(
      v_id, v_actor, 'Al revés', v_partner, NULL, NULL, NULL, 300, 200);
    PERFORM pg_temp.check('57 edición: rango invertido rechazado (helper compartido)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('57 edición: rango invertido rechazado (helper compartido)',
      v_msg LIKE 'INVALID_AMOUNT_RANGE%', v_msg);
  END;

  BEGIN
    PERFORM ops.update_quote_request_response(gen_random_uuid(), v_actor, 'Fantasma', v_partner);
    PERFORM pg_temp.check('58 edición: respuesta inexistente rechazada', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('58 edición: respuesta inexistente rechazada',
      v_msg LIKE 'QUOTE_RESPONSE_NOT_FOUND%', v_msg);
  END;

  -- 60-63. Baja.
  v_out := ops.delete_quote_request_response(v_id, v_actor, 'Cargada por duplicado');
  PERFORM pg_temp.check('60 baja: devuelve la fila borrada', (v_out->>'id')::uuid = v_id, v_out::text);
  PERFORM pg_temp.check('61 baja: la fila ya no está',
    NOT EXISTS (SELECT 1 FROM ops.quote_request_response WHERE id = v_id), 'sigue ahí');

  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_id AND action = 'quote_request_response.delete';
  PERFORM pg_temp.check('62 log baja: before con la fila entera, after NULL',
    v_log.after IS NULL AND v_log.before->>'detail' = 'Corregido' AND v_log.note = 'Cargada por duplicado',
    coalesce(v_log.before::text, '(sin log)'));

  BEGIN
    PERFORM ops.delete_quote_request_response(v_id, v_actor);
    PERFORM pg_temp.check('63 baja: borrar dos veces rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('63 baja: borrar dos veces rechazado', v_msg LIKE 'QUOTE_RESPONSE_NOT_FOUND%', v_msg);
  END;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Orden
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor uuid;
  v_qr    uuid;
  v_other uuid;
  v_ids   uuid[];
  v_out   jsonb;
  v_msg   text;
  v_first uuid;
BEGIN
  SELECT actor_id, qr_id, qr_other_id INTO v_actor, v_qr, v_other FROM t_fix;

  SELECT array_agg(id ORDER BY position, created_at) INTO v_ids
    FROM ops.quote_request_response WHERE quote_request_id = v_qr;

  -- 70. Invertir el orden completo.
  v_out := ops.reorder_quote_request_responses(
    v_qr, ARRAY(SELECT unnest(v_ids) ORDER BY 1 DESC), v_actor, 'El sin cargo va primero');

  SELECT id INTO v_first FROM ops.quote_request_response
   WHERE quote_request_id = v_qr ORDER BY position LIMIT 1;
  PERFORM pg_temp.check('70 reorden: el primero de la lista queda en position 1',
    v_first = (SELECT max(x) FROM unnest(v_ids) AS x), v_first::text);
  PERFORM pg_temp.check('71 reorden: las posiciones quedan 1..n sin huecos',
    (SELECT array_agg(position ORDER BY position) FROM ops.quote_request_response
      WHERE quote_request_id = v_qr)
      = ARRAY(SELECT generate_series(1, cardinality(v_ids))),
    (SELECT array_agg(position ORDER BY position)::text FROM ops.quote_request_response
      WHERE quote_request_id = v_qr));

  -- 72. UNA sola entrada de log para todo el reordenamiento.
  PERFORM pg_temp.check('72 reorden: una sola entrada en action_log, contra el PEDIDO',
    (SELECT count(*) FROM ops.action_log
      WHERE action = 'quote_request_response.reorder' AND target_id = v_qr) = 1,
    (SELECT count(*)::text FROM ops.action_log
      WHERE action = 'quote_request_response.reorder' AND target_id = v_qr));

  -- 73-76. Las cuatro formas de mandar mal la lista.
  BEGIN
    PERFORM ops.reorder_quote_request_responses(v_qr, ARRAY[v_ids[1]], v_actor);
    PERFORM pg_temp.check('73 reorden: lista incompleta rechazada', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('73 reorden: lista incompleta rechazada', v_msg LIKE 'REORDER_MISMATCH%', v_msg);
  END;

  BEGIN
    PERFORM ops.reorder_quote_request_responses(
      v_qr, v_ids || ARRAY[gen_random_uuid()], v_actor);
    PERFORM pg_temp.check('74 reorden: id ajeno rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('74 reorden: id ajeno rechazado', v_msg LIKE 'REORDER_MISMATCH%', v_msg);
  END;

  BEGIN
    PERFORM ops.reorder_quote_request_responses(v_qr, ARRAY[v_ids[1], v_ids[1]], v_actor);
    PERFORM pg_temp.check('75 reorden: ids duplicados rechazados', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('75 reorden: ids duplicados rechazados', v_msg LIKE 'REORDER_DUPLICATE_IDS%', v_msg);
  END;

  BEGIN
    PERFORM ops.reorder_quote_request_responses(v_other, ARRAY[]::uuid[], v_actor);
    PERFORM pg_temp.check('76 reorden: lista vacía rechazada', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('76 reorden: lista vacía rechazada', v_msg LIKE 'REORDER_EMPTY%', v_msg);
  END;

  -- 77. Un pedido sin respuestas.
  BEGIN
    PERFORM ops.reorder_quote_request_responses(v_other, ARRAY[v_ids[1]], v_actor);
    PERFORM pg_temp.check('77 reorden: pedido sin respuestas rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('77 reorden: pedido sin respuestas rechazado',
      v_msg LIKE 'QUOTE_REQUEST_NOT_FOUND%', v_msg);
  END;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL exacto que manda el repo, con `PREPARE` SIN TIPOS.
--
-- Igual que la 011 y por el mismo motivo: `pg` manda cada `$n` con tipo
-- desconocido y es Postgres el que lo resuelve contra la firma, que es justo
-- la parte que falla en runtime. Un prepared statement es de la SESIÓN, así
-- que el ROLLBACK no se lo lleva: de ahí el DEALLOCATE del final.
-- ═══════════════════════════════════════════════════════════════════════════

PREPARE t015_add AS
  SELECT ops.add_quote_request_response(
    p_quote_request_id => $1,
    p_actor_id         => $2,
    p_detail           => $3,
    p_partner_id       => $4,
    p_provider_name    => $5,
    p_provider_address => $6,
    p_provider_phone   => $7,
    p_amount_min       => $8,
    p_amount_max       => $9,
    p_currency         => $10,
    p_valid_until      => $11,
    p_internal_notes   => $12,
    p_note             => $13
  ) AS r;

PREPARE t015_update AS
  SELECT ops.update_quote_request_response(
    p_id               => $1,
    p_actor_id         => $2,
    p_detail           => $3,
    p_partner_id       => $4,
    p_provider_name    => $5,
    p_provider_address => $6,
    p_provider_phone   => $7,
    p_amount_min       => $8,
    p_amount_max       => $9,
    p_currency         => $10,
    p_valid_until      => $11,
    p_internal_notes   => $12,
    p_note             => $13
  ) AS r;

PREPARE t015_delete AS
  SELECT ops.delete_quote_request_response(p_id => $1, p_actor_id => $2, p_note => $3) AS r;

PREPARE t015_reorder AS
  SELECT ops.reorder_quote_request_responses(
    p_quote_request_id => $1, p_ids => $2, p_actor_id => $3, p_note => $4) AS r;

-- `EXECUTE` no acepta subconsultas como argumento: los ids salen de funciones
-- temporales, igual que el `pg_temp.fix_id` de la 011.
CREATE OR REPLACE FUNCTION pg_temp.fix_actor() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT actor_id FROM t_fix
$$;
CREATE OR REPLACE FUNCTION pg_temp.fix_other() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT qr_other_id FROM t_fix
$$;

DO $$
DECLARE
  v_r  jsonb;
  v_id uuid;
BEGIN
  EXECUTE 'EXECUTE t015_add($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)'
    INTO v_r
    USING pg_temp.fix_other(), pg_temp.fix_actor(), 'Integración',
          NULL::uuid, 'Taller integración', 'Calle 1', '1122334455',
          NULL::numeric, NULL::numeric, 'ARS', NULL::text, NULL::text, NULL::text;
  v_id := (v_r->>'id')::uuid;
  PERFORM pg_temp.check('80 integración alta: parámetros nombrados sin tipos',
    v_r->>'provider_name' = 'Taller integración' AND v_r->>'amount_min' IS NULL, v_r::text);

  EXECUTE 'EXECUTE t015_update($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)'
    INTO v_r
    USING v_id, pg_temp.fix_actor(), 'Integración corregida',
          NULL::uuid, 'Taller integración', 'Calle 1', '1122334455',
          1500::numeric, 1500::numeric, 'ARS', NULL::text, NULL::text, NULL::text;
  PERFORM pg_temp.check('81 integración edición: parámetros nombrados sin tipos',
    (v_r->>'amount_min')::numeric = 1500, v_r::text);

  EXECUTE 'EXECUTE t015_reorder($1,$2,$3,$4)'
    INTO v_r
    USING pg_temp.fix_other(), ARRAY[v_id], pg_temp.fix_actor(), NULL::text;
  PERFORM pg_temp.check('82 integración reorden: parámetros nombrados sin tipos',
    jsonb_array_length(v_r) = 1, v_r::text);

  EXECUTE 'EXECUTE t015_delete($1,$2,$3)'
    INTO v_r
    USING v_id, pg_temp.fix_actor(), NULL::text;
  PERFORM pg_temp.check('83 integración baja: parámetros nombrados sin tipos',
    (v_r->>'id')::uuid = v_id, v_r::text);
END $$;

DEALLOCATE t015_add;
DEALLOCATE t015_update;
DEALLOCATE t015_delete;
DEALLOCATE t015_reorder;

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
