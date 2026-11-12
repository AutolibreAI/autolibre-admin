-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 032 — el vehículo escrito en
-- `public.quote_requests.vehicle_description`.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/032_ops_vehiculo_escrito_en_quote_requests.test.sql
--
-- BEGIN … ROLLBACK, con su propio actor y sus propios pedidos. Necesita la
-- 0160 del backend (la columna) y la 032 aplicada.
--
-- Las aserciones de alta y edición del vehículo escrito siguen viviendo en sus
-- suites (`018_….test.sql` el alta, `028_….test.sql` la edición), que se
-- actualizaron para leer la columna. Ésta cubre lo propio de la mudanza: que
-- la tabla de `ops` quedó sin escritor, que los SPs no la nombran y que el
-- alias `vehicle_text` sigue en lo que se devuelve y se loguea.
--
-- La COPIA no se re-prueba acá (corre una sola vez, al migrar). Para
-- verificarla a mano justo después de migrar, en la base migrada:
--
--   SELECT count(*) AS sin_copiar
--     FROM ops.quote_request_vehicle_text t
--     JOIN quote_requests q ON q.id = t.quote_request_id
--    WHERE q.vehicle_description IS NULL;
--
-- Tiene que dar 0. Después ya no: si un operador borra el vehículo de un
-- pedido, la fila vieja de `ops` queda (nadie la toca) y la columna en NULL.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS qr_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-032-' || actor_id || '@example.invalid', 'admin'::user_role, 'clerk'::auth_provider, 'test-032-' || actor_id
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, description, raw_submission)
SELECT qr_id, 'whatsapp', '5491155550032', 'Test 032', '{"source":"test-032"}'::jsonb
  FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle);
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Forma
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_n int;
BEGIN
  PERFORM pg_temp.check('01 existe la columna del backend (0160)',
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'quote_requests'
               AND column_name = 'vehicle_description'),
    'falta');

  PERFORM pg_temp.check('02 ops._set_quote_request_vehicle_text ya no existe (sin segunda puerta)',
    to_regprocedure('ops._set_quote_request_vehicle_text(uuid,uuid,text)') IS NULL, 'existe');

  PERFORM pg_temp.check('03 la tabla de ops NO se dropeó',
    to_regclass('ops.quote_request_vehicle_text') IS NOT NULL, 'no existe');

  PERFORM pg_temp.check('04 la tabla de ops dice que quedó sin uso',
    obj_description('ops.quote_request_vehicle_text'::regclass, 'pg_class') LIKE 'SIN USO%',
    coalesce(obj_description('ops.quote_request_vehicle_text'::regclass, 'pg_class'), '(null)'));

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname IN ('create_quote_request', 'update_quote_request');
  PERFORM pg_temp.check('05 una sola create y una sola update (CREATE OR REPLACE, sin sobrecarga)', v_n = 2, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops'
     AND p.proname IN ('create_quote_request', 'update_quote_request', '_quote_request_snapshot')
     AND (p.prosecdef OR coalesce(array_to_string(p.proconfig, ' '), '') NOT LIKE 'search_path=%');
  PERFORM pg_temp.check('06 INVOKER y search_path fijo (guardrails 2 y 3)', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops'
     AND CASE WHEN p.prokind = 'f' THEN pg_get_functiondef(p.oid) ~* 'quote_request_vehicle_text' ELSE false END;
  PERFORM pg_temp.check('07 ninguna función de ops nombra la tabla vieja', v_n = 0, v_n::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Comportamiento
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor uuid;
  v_id    uuid;
  v_new   uuid;
  v_out   jsonb;
  v_log   ops.action_log%ROWTYPE;
  v_n     int;
  v_desc  text;
  v_msg   text;
BEGIN
  SELECT actor_id, qr_id INTO v_actor, v_id FROM t_fix;

  -- 10-13. El alta escribe la columna, normalizada, y NO la tabla de ops.
  v_out := ops.create_quote_request(
    p_actor_id := v_actor, p_channel := 'whatsapp', p_contact_phone := '5491155550033',
    p_description := 'Frenos', p_vehicle_text := E'  Ford \t Ka   1.5\n2018 '
  );
  v_new := (v_out->>'id')::uuid;
  SELECT vehicle_description INTO v_desc FROM quote_requests WHERE id = v_new;
  PERFORM pg_temp.check('10 alta: vehicle_description normalizada (btrim + \s+ → espacio)',
    v_desc = 'Ford Ka 1.5 2018', coalesce(v_desc, '(null)'));
  PERFORM pg_temp.check('11 alta: sin fila en la tabla de ops',
    NOT EXISTS (SELECT 1 FROM ops.quote_request_vehicle_text WHERE quote_request_id = v_new), 'hay fila');
  PERFORM pg_temp.check('12 alta: devuelve vehicle_description y el alias vehicle_text',
    v_out->>'vehicle_description' = 'Ford Ka 1.5 2018' AND v_out->>'vehicle_text' = 'Ford Ka 1.5 2018', v_out::text);
  SELECT * INTO v_log FROM ops.action_log WHERE target_id = v_new AND action = 'quote_request.create' LIMIT 1;
  PERFORM pg_temp.check('13 alta: el log trae el alias vehicle_text',
    v_log.after->>'vehicle_text' = 'Ford Ka 1.5 2018', coalesce(v_log.after::text, '(null)'));

  -- 20-24. La edición.
  PERFORM ops.update_quote_request(
    p_quote_request_id := v_id, p_actor_id := v_actor, p_contact_phone := '5491155550032',
    p_description := 'Test 032', p_vehicle_text := 'Renault Kangoo 1.6 2015'
  );
  SELECT vehicle_description INTO v_desc FROM quote_requests WHERE id = v_id;
  PERFORM pg_temp.check('20 edición: escribe la columna', v_desc = 'Renault Kangoo 1.6 2015', coalesce(v_desc, '(null)'));
  PERFORM pg_temp.check('21 edición: sin fila en la tabla de ops',
    NOT EXISTS (SELECT 1 FROM ops.quote_request_vehicle_text WHERE quote_request_id = v_id), 'hay fila');

  -- La única entrada: es la primera edición de este pedido.
  SELECT * INTO v_log FROM ops.action_log WHERE target_id = v_id AND action = 'quote_request.update' LIMIT 1;
  PERFORM pg_temp.check('22 edición: before NULL / after con el texto, en las dos claves',
    v_log.before->'vehicle_description' = 'null'::jsonb AND v_log.before->'vehicle_text' = 'null'::jsonb
      AND v_log.after->>'vehicle_description' = 'Renault Kangoo 1.6 2015'
      AND v_log.after->>'vehicle_text' = 'Renault Kangoo 1.6 2015',
    coalesce(v_log.before::text, '(null)') || ' → ' || coalesce(v_log.after::text, '(null)'));

  SELECT count(*) INTO v_n FROM ops.action_log WHERE target_id = v_id AND action = 'quote_request.update';
  PERFORM ops.update_quote_request(
    p_quote_request_id := v_id, p_actor_id := v_actor, p_contact_phone := '5491155550032',
    p_description := 'Test 032', p_vehicle_text := ' Renault  Kangoo 1.6 2015 '
  );
  PERFORM pg_temp.check('23 edición: el mismo texto (normalizado) no es un cambio → sin log',
    (SELECT count(*) FROM ops.action_log WHERE target_id = v_id AND action = 'quote_request.update') = v_n,
    v_n::text);

  PERFORM ops.update_quote_request(
    p_quote_request_id := v_id, p_actor_id := v_actor, p_contact_phone := '5491155550032',
    p_description := 'Test 032', p_vehicle_text := '   '
  );
  SELECT vehicle_description INTO v_desc FROM quote_requests WHERE id = v_id;
  PERFORM pg_temp.check('24 edición: en blanco → NULL (chk_quote_requests_vehicle_description_not_blank)',
    v_desc IS NULL, coalesce(v_desc, '(null)'));

  -- 25. Más de 200 → la sentinela de siempre, no un 23514 del CHECK del backend.
  BEGIN
    PERFORM ops.update_quote_request(
      p_quote_request_id := v_id, p_actor_id := v_actor, p_contact_phone := '5491155550032',
      p_description := 'Test 032', p_vehicle_text := repeat('a', 201)
    );
    PERFORM pg_temp.check('25 más de 200 → VEHICLE_TEXT_TOO_LONG', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('25 más de 200 → VEHICLE_TEXT_TOO_LONG', v_msg LIKE 'VEHICLE_TEXT_TOO_LONG%', v_msg);
  END;

  -- 26. Justo 200 entra (el CHECK del backend es <= 200).
  PERFORM ops.update_quote_request(
    p_quote_request_id := v_id, p_actor_id := v_actor, p_contact_phone := '5491155550032',
    p_description := 'Test 032', p_vehicle_text := repeat('b', 200)
  );
  SELECT vehicle_description INTO v_desc FROM quote_requests WHERE id = v_id;
  PERFORM pg_temp.check('26 justo 200 caracteres entra', char_length(v_desc) = 200, coalesce(char_length(v_desc)::text, '(null)'));
END $$;

SELECT caso,
       CASE WHEN ok THEN 'PASA' ELSE 'FALLA' END AS estado,
       detalle
  FROM t_result
 ORDER BY caso;

ROLLBACK;
