-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 018 — editar un pedido y cargarlo sin patente.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/018_ops_editar_pedido.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea su propio actor, su propio
-- usuario "con cuenta" y sus propios pedidos. Necesita `quote_requests` (a
-- diferencia de la 017): corre sólo en una base donde el flujo del backend
-- esté desplegado.
--
-- Suma las pruebas de `ops.create_quote_request` que vivían en la 012: la 018
-- le cambió la firma (DROP + CREATE), así que esa suite quedó apuntando a una
-- función que ya no existe. Mismo movimiento que 008 → 009 y 013 → 016.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS account_id,
       gen_random_uuid() AS device_id,
       gen_random_uuid() AS account_qr_id,
       gen_random_uuid() AS closed_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-018-' || actor_id || '@example.invalid', 'admin'::user_role, 'clerk'::auth_provider, 'test-018-' || actor_id
  FROM t_fix
UNION ALL
SELECT account_id, 'test-018-' || account_id || '@example.invalid', 'user'::user_role, 'clerk'::auth_provider, 'test-018-' || account_id
  FROM t_fix;

-- Un pedido de la web con la ubicación del GPS: la que NO se edita.
INSERT INTO quote_requests (
  id, channel, contact_phone, plate, description, raw_submission,
  location_source, location_address, location_locality, location_province,
  location_latitude, location_longitude
)
SELECT device_id, 'web', '5491100000000', 'AB123CD', 'Test 018 device',
       '{"description": "Test 018 device"}'::jsonb,
       'device', 'Av. Corrientes 1234', 'CABA', 'Buenos Aires', -34.6037, -58.3816
  FROM t_fix;

-- Un pedido de la app, CON cuenta: la patente es obligatoria (chk_quote_requests_user_has_plate).
INSERT INTO quote_requests (id, channel, user_id, contact_phone, plate, description, raw_submission)
SELECT account_qr_id, 'app', account_id, '5491100000001', 'ZZ999YY', 'Test 018 cuenta', '{}'::jsonb
  FROM t_fix;

-- Uno cerrado: editar datos no es mover el estado, así que también se puede.
INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission,
                            status, closed_at, close_reason_code)
SELECT closed_id, 'web', '5491100000002', 'CD456EF', 'Test 018 cerrado', '{}'::jsonb,
       'closed', now() - interval '1 day', 'resolved'
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
  PERFORM pg_temp.check('01 existe UNA sola create_quote_request (sin la sobrecarga de la 012)', v_n = 1, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'update_quote_request';
  PERFORM pg_temp.check('02 existe UNA sola update_quote_request (con la 028, la de la 028)', v_n = 1, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops'
     AND p.proname IN ('create_quote_request', 'update_quote_request', '_set_quote_request_vehicle_text')
     AND p.prosecdef;
  PERFORM pg_temp.check('03 SECURITY INVOKER, no DEFINER', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops'
     AND p.proname IN ('create_quote_request', 'update_quote_request', '_set_quote_request_vehicle_text',
                       '_normalize_quote_plate', '_normalize_quote_vehicle_text',
                       '_check_quote_declared_amount', '_quote_request_snapshot')
     AND coalesce(array_to_string(p.proconfig, ' '), '') NOT LIKE 'search_path=%';
  PERFORM pg_temp.check('04 search_path fijo en las siete (guardrail 3)', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_constraint
   WHERE conrelid = 'ops.quote_request_vehicle_text'::regclass AND contype = 'f';
  PERFORM pg_temp.check('05 la tabla de ops no tiene FK a public (guardrail 6)', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_trigger
   WHERE tgrelid = 'ops.quote_request_vehicle_text'::regclass AND NOT tgisinternal;
  PERFORM pg_temp.check('06 sin trigger en la tabla de ops: updated_at lo escribe la función', v_n = 0, v_n::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Alta (heredado de la 012 + lo nuevo)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor uuid;
  v_id    uuid;
  v_row   quote_requests%ROWTYPE;
  v_log   ops.action_log%ROWTYPE;
  v_msg   text;
  v_out   jsonb;
  v_vt    text;
BEGIN
  SELECT actor_id INTO v_actor FROM t_fix;

  -- 10-24. Camino feliz: todos los campos.
  v_out := ops.create_quote_request(
    p_actor_id        := v_actor,
    p_channel         := 'whatsapp',
    p_contact_phone   := '+54 11 5555 0009',
    p_description     := 'Ruido en la suspensión',
    p_plate           := '  ab 123-cd  ',
    p_vehicle_text    := '  Peugeot   208 1.6  2019 ',
    p_contact_name    := 'Juana Pérez',
    p_contact_email   := 'juana@example.invalid',
    p_declared_amount := 45000.50,
    p_note            := 'Cargado por teléfono'
  );
  v_id := (v_out->>'id')::uuid;
  SELECT * INTO v_row FROM quote_requests WHERE id = v_id;
  -- Desde la 032 el vehículo escrito es `quote_requests.vehicle_description`.
  SELECT vehicle_description INTO v_vt FROM quote_requests WHERE id = v_id;

  PERFORM pg_temp.check('10 channel = whatsapp', v_row.channel::text = 'whatsapp', v_row.channel::text);
  PERFORM pg_temp.check('11 plate normalizada (upper, sin separadores)', v_row.plate = 'AB123CD', v_row.plate);
  PERFORM pg_temp.check('12 contact_phone', v_row.contact_phone = '+54 11 5555 0009', v_row.contact_phone);
  PERFORM pg_temp.check('13 contact_name', v_row.contact_name = 'Juana Pérez', coalesce(v_row.contact_name, '(null)'));
  PERFORM pg_temp.check('14 contact_email', v_row.contact_email = 'juana@example.invalid',
    coalesce(v_row.contact_email, '(null)'));
  PERFORM pg_temp.check('15 description', v_row.description = 'Ruido en la suspensión', v_row.description);
  PERFORM pg_temp.check('16 declared_amount', v_row.declared_amount = 45000.50, v_row.declared_amount::text);
  PERFORM pg_temp.check('17 status default = received', v_row.status::text = 'received', v_row.status::text);
  PERFORM pg_temp.check('18 raw_submission marca origen manual',
    v_row.raw_submission->>'source' = 'admin_manual_entry',
    coalesce(v_row.raw_submission->>'source', '(null)'));
  PERFORM pg_temp.check('19 vehículo escrito guardado, espacios colapsados',
    v_vt = 'Peugeot 208 1.6 2019', coalesce(v_vt, '(null)'));
  PERFORM pg_temp.check('20 lo devuelto trae id, public_number y vehicle_text',
    v_out ? 'id' AND v_out ? 'public_number' AND v_out->>'vehicle_text' = 'Peugeot 208 1.6 2019', v_out::text);

  SELECT * INTO v_log FROM ops.action_log WHERE target_id = v_id AND action = 'quote_request.create' LIMIT 1;
  PERFORM pg_temp.check('21 log: before NULL (no había fila)', v_log.before IS NULL, 'no null');
  PERFORM pg_temp.check('22 log: after trae el vehículo escrito',
    v_log.after->>'vehicle_text' = 'Peugeot 208 1.6 2019', coalesce(v_log.after::text, '(null)'));
  PERFORM pg_temp.check('23 log: after SIN raw_submission (redact de la 011)',
    NOT (v_log.after ? 'raw_submission'), v_log.after::text);
  PERFORM pg_temp.check('24 log: actor de la sesión', v_log.actor_id = v_actor, v_log.actor_id::text);

  -- 25-28. Sin patente y sin vehículo: lo que antes era imposible.
  v_out := ops.create_quote_request(
    p_actor_id := v_actor, p_channel := 'whatsapp', p_contact_phone := '+54 11 5555 0010',
    p_description := 'Service'
  );
  SELECT * INTO v_row FROM quote_requests WHERE id = (v_out->>'id')::uuid;
  PERFORM pg_temp.check('25 sin patente → plate NULL', v_row.plate IS NULL, coalesce(v_row.plate, '(null)'));
  PERFORM pg_temp.check('26 sin vehículo escrito → vehicle_description NULL',
    v_row.vehicle_description IS NULL, coalesce(v_row.vehicle_description, '(null)'));
  PERFORM pg_temp.check('27 contact_name/email/amount ausentes → NULL',
    v_row.contact_name IS NULL AND v_row.contact_email IS NULL AND v_row.declared_amount IS NULL, 'algún no null');

  v_out := ops.create_quote_request(
    p_actor_id := v_actor, p_channel := 'web', p_contact_phone := '1', p_description := 'x',
    p_plate := '   ', p_vehicle_text := '  '
  );
  SELECT * INTO v_row FROM quote_requests WHERE id = (v_out->>'id')::uuid;
  PERFORM pg_temp.check('28 patente y vehículo en blanco → NULL, no string vacío',
    v_row.plate IS NULL AND v_row.vehicle_description IS NULL,
    coalesce(v_row.plate, '(null)'));

  -- 29-35. Rechazos con sentinela.
  BEGIN
    PERFORM ops.create_quote_request(p_actor_id := v_actor, p_channel := 'web', p_contact_phone := '   ',
                                     p_description := 'x');
    PERFORM pg_temp.check('29 contact_phone vacío', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('29 contact_phone vacío', v_msg LIKE 'CONTACT_PHONE_REQUIRED%', v_msg);
  END;
  BEGIN
    PERFORM ops.create_quote_request(p_actor_id := v_actor, p_channel := 'web', p_contact_phone := '1',
                                     p_description := '   ');
    PERFORM pg_temp.check('30 description vacía', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('30 description vacía', v_msg LIKE 'DESCRIPTION_REQUIRED%', v_msg);
  END;
  BEGIN
    PERFORM ops.create_quote_request(p_actor_id := v_actor, p_channel := 'telefono', p_contact_phone := '1',
                                     p_description := 'x');
    PERFORM pg_temp.check('31 canal inválido', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('31 canal inválido', v_msg LIKE 'INVALID_CHANNEL%', v_msg);
  END;
  BEGIN
    PERFORM ops.create_quote_request(p_actor_id := v_actor, p_channel := 'web', p_contact_phone := '1',
                                     p_description := 'x', p_plate := 'ABC12345');
    PERFORM pg_temp.check('32 patente de más de 7 → sentinela, no 22001 crudo', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('32 patente de más de 7 → sentinela, no 22001 crudo', v_msg LIKE 'INVALID_PLATE%', v_msg);
  END;
  BEGIN
    PERFORM ops.create_quote_request(p_actor_id := v_actor, p_channel := 'web', p_contact_phone := '1',
                                     p_description := 'x', p_vehicle_text := repeat('a', 201));
    PERFORM pg_temp.check('33 vehículo escrito de más de 200', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('33 vehículo escrito de más de 200', v_msg LIKE 'VEHICLE_TEXT_TOO_LONG%', v_msg);
  END;
  BEGIN
    PERFORM ops.create_quote_request(p_actor_id := v_actor, p_channel := 'web', p_contact_phone := '1',
                                     p_description := 'x', p_declared_amount := -1);
    PERFORM pg_temp.check('34 monto negativo', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('34 monto negativo', v_msg LIKE 'INVALID_DECLARED_AMOUNT%', v_msg);
  END;
  BEGIN
    PERFORM ops.create_quote_request(p_actor_id := gen_random_uuid(), p_channel := 'web', p_contact_phone := '1',
                                     p_description := 'x');
    PERFORM pg_temp.check('35 actor inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('35 actor inexistente', v_msg LIKE 'ACTOR_NOT_FOUND%', v_msg);
  END;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Edición: se MUDÓ a 028_ops_editar_pedido_sin_ubicacion.test.sql.
--
-- La 028 le cambió la firma a ops.update_quote_request (sin los parámetros de
-- ubicación: la ubicación se corrige por PUT /admin/quote-requests/:id/location).
-- Mismo movimiento que 008 → 009 y 013 → 016: las mismas aserciones en dos
-- suites obligan a mantener las dos, y la vieja apunta a una firma que ya no
-- existe en una base con la 028.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL EXACTO que manda `quote-requests.repo.ts`, con `PREPARE`
-- sin tipos (como los manda `pg`: cada `$n` llega con tipo desconocido y es
-- Postgres el que lo resuelve contra la firma). Si se toca uno, se toca el otro.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pg_temp.fix_actor() RETURNS uuid LANGUAGE sql AS $$ SELECT actor_id FROM t_fix $$;

PREPARE p018_create AS
  SELECT ops.create_quote_request(
    p_actor_id        => $1,
    p_channel         => $2,
    p_contact_phone   => $3,
    p_description     => $4,
    p_plate           => $5,
    p_vehicle_text    => $6,
    p_contact_name    => $7,
    p_contact_email   => $8,
    p_declared_amount => $9,
    p_note            => $10
  ) AS q;

-- `INSERT … EXECUTE` no existe; `CREATE TABLE … AS EXECUTE` sí (mismo patrón que la 011).
CREATE TEMP TABLE t_int ON COMMIT DROP AS
EXECUTE p018_create(pg_temp.fix_actor(), 'whatsapp', '5491155550099', 'Frenos chillan',
                    NULL, 'Fiat Cronos 2021', NULL, NULL, NULL, NULL);

DO $$
DECLARE v_q jsonb;
BEGIN
  SELECT q INTO v_q FROM t_int LIMIT 1;
  PERFORM pg_temp.check('80 integración: alta sin patente, con vehículo escrito',
    v_q->>'plate' IS NULL AND v_q->>'vehicle_text' = 'Fiat Cronos 2021' AND v_q->>'status' = 'received',
    v_q::text);
END $$;

-- Un prepared statement es de la SESIÓN: el ROLLBACK no se lo lleva.
DEALLOCATE p018_create;

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
