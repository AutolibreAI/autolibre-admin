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
  PERFORM pg_temp.check('02 existe UNA sola update_quote_request', v_n = 1, v_n::text);

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
  SELECT vehicle_text INTO v_vt FROM ops.quote_request_vehicle_text WHERE quote_request_id = v_id;

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
  PERFORM pg_temp.check('26 sin vehículo escrito → sin fila en ops',
    NOT EXISTS (SELECT 1 FROM ops.quote_request_vehicle_text WHERE quote_request_id = v_row.id), 'hay fila');
  PERFORM pg_temp.check('27 contact_name/email/amount ausentes → NULL',
    v_row.contact_name IS NULL AND v_row.contact_email IS NULL AND v_row.declared_amount IS NULL, 'algún no null');

  v_out := ops.create_quote_request(
    p_actor_id := v_actor, p_channel := 'web', p_contact_phone := '1', p_description := 'x',
    p_plate := '   ', p_vehicle_text := '  '
  );
  SELECT * INTO v_row FROM quote_requests WHERE id = (v_out->>'id')::uuid;
  PERFORM pg_temp.check('28 patente y vehículo en blanco → NULL, no string vacío',
    v_row.plate IS NULL
      AND NOT EXISTS (SELECT 1 FROM ops.quote_request_vehicle_text WHERE quote_request_id = v_row.id),
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
-- Edición
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor    uuid;
  v_id       uuid;
  v_device   uuid;
  v_account  uuid;
  v_closed   uuid;
  v_row      quote_requests%ROWTYPE;
  v_log      ops.action_log%ROWTYPE;
  v_msg      text;
  v_out      jsonb;
  v_n        int;
  v_created  timestamptz;
  v_raw      jsonb;
BEGIN
  SELECT actor_id, device_id, account_qr_id, closed_id INTO v_actor, v_device, v_account, v_closed FROM t_fix;

  -- Un pedido por WhatsApp como llega de verdad: teléfono y "service", nada más.
  v_out := ops.create_quote_request(
    p_actor_id := v_actor, p_channel := 'whatsapp', p_contact_phone := '5491155550001',
    p_description := 'service'
  );
  v_id := (v_out->>'id')::uuid;
  SELECT raw_submission INTO v_raw FROM quote_requests WHERE id = v_id;

  -- 40-50. La persona va soltando los datos: se completan todos en una edición.
  v_out := ops.update_quote_request(
    p_quote_request_id  := v_id,
    p_actor_id          := v_actor,
    p_contact_phone     := '5491155550001',
    p_description       := 'Service de los 60.000 km',
    p_contact_name      := 'Carlos',
    p_contact_email     := 'carlos@example.invalid',
    p_plate             := 'ae 456 fg',
    p_vehicle_text      := 'Toyota Etios 1.5 2020',
    p_declared_amount   := 180000,
    p_location_address  := 'Zona Norte, cerca de la estación',
    p_location_locality := 'Tigre',
    p_location_province := 'Buenos Aires',
    p_note              := NULL
  );
  SELECT * INTO v_row FROM quote_requests WHERE id = v_id;

  PERFORM pg_temp.check('40 description editada', v_row.description = 'Service de los 60.000 km', v_row.description);
  PERFORM pg_temp.check('41 contact_name cargado', v_row.contact_name = 'Carlos', coalesce(v_row.contact_name, '(null)'));
  PERFORM pg_temp.check('42 contact_email cargado', v_row.contact_email = 'carlos@example.invalid',
    coalesce(v_row.contact_email, '(null)'));
  PERFORM pg_temp.check('43 patente cargada y normalizada', v_row.plate = 'AE456FG', coalesce(v_row.plate, '(null)'));
  PERFORM pg_temp.check('44 monto cargado', v_row.declared_amount = 180000, coalesce(v_row.declared_amount::text, '(null)'));
  PERFORM pg_temp.check('45 ubicación tipeada: source = typed',
    v_row.location_source::text = 'typed', coalesce(v_row.location_source::text, '(null)'));
  PERFORM pg_temp.check('46 ubicación tipeada: textos',
    v_row.location_address = 'Zona Norte, cerca de la estación' AND v_row.location_locality = 'Tigre'
      AND v_row.location_province = 'Buenos Aires', v_row.location_address);
  PERFORM pg_temp.check('47 ubicación tipeada: sin coordenadas',
    v_row.location_latitude IS NULL AND v_row.location_longitude IS NULL, 'con coordenadas');
  PERFORM pg_temp.check('48 vehículo escrito cargado',
    (SELECT vehicle_text FROM ops.quote_request_vehicle_text WHERE quote_request_id = v_id) = 'Toyota Etios 1.5 2020',
    'no');
  PERFORM pg_temp.check('49 raw_submission intacto (lo que llegó no se reescribe)',
    v_row.raw_submission = v_raw, v_row.raw_submission::text);
  PERFORM pg_temp.check('50 status intacto', v_row.status::text = 'received', v_row.status::text);

  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_id AND action = 'quote_request.update' ORDER BY created_at DESC LIMIT 1;
  PERFORM pg_temp.check('51 log: before con la descripción vieja y sin vehículo',
    v_log.before->>'description' = 'service' AND v_log.before->'vehicle_text' = 'null'::jsonb,
    coalesce(v_log.before::text, '(null)'));
  PERFORM pg_temp.check('52 log: after con la descripción y el vehículo nuevos',
    v_log.after->>'description' = 'Service de los 60.000 km'
      AND v_log.after->>'vehicle_text' = 'Toyota Etios 1.5 2020',
    coalesce(v_log.after::text, '(null)'));
  PERFORM pg_temp.check('53 log: actor de la sesión', v_log.actor_id = v_actor, coalesce(v_log.actor_id::text, '(null)'));

  -- 54. Guardar sin tocar nada no escribe una entrada nueva.
  SELECT count(*) INTO v_n FROM ops.action_log WHERE target_id = v_id AND action = 'quote_request.update';
  PERFORM ops.update_quote_request(
    p_quote_request_id := v_id, p_actor_id := v_actor, p_contact_phone := '5491155550001',
    p_description := 'Service de los 60.000 km', p_contact_name := 'Carlos',
    p_contact_email := 'carlos@example.invalid', p_plate := 'AE456FG',
    p_vehicle_text := 'Toyota Etios 1.5 2020', p_declared_amount := 180000.00,
    p_location_address := 'Zona Norte, cerca de la estación', p_location_locality := 'Tigre',
    p_location_province := 'Buenos Aires'
  );
  PERFORM pg_temp.check('54 sin cambios: no hay entrada nueva en el log',
    (SELECT count(*) FROM ops.action_log WHERE target_id = v_id AND action = 'quote_request.update') = v_n,
    v_n::text);

  -- 55. Cambiar SÓLO el vehículo escrito también es un cambio y se loguea.
  SELECT created_at INTO v_created FROM ops.quote_request_vehicle_text WHERE quote_request_id = v_id;
  PERFORM ops.update_quote_request(
    p_quote_request_id := v_id, p_actor_id := v_actor, p_contact_phone := '5491155550001',
    p_description := 'Service de los 60.000 km', p_contact_name := 'Carlos',
    p_contact_email := 'carlos@example.invalid', p_plate := 'AE456FG',
    p_vehicle_text := 'Toyota Etios XLS 1.5 2020', p_declared_amount := 180000,
    p_location_address := 'Zona Norte, cerca de la estación', p_location_locality := 'Tigre',
    p_location_province := 'Buenos Aires'
  );
  PERFORM pg_temp.check('55 cambiar sólo el vehículo escrito se loguea',
    (SELECT count(*) FROM ops.action_log WHERE target_id = v_id AND action = 'quote_request.update') = v_n + 1,
    v_n::text);
  PERFORM pg_temp.check('56 editar el vehículo escrito conserva created_at',
    (SELECT created_at FROM ops.quote_request_vehicle_text WHERE quote_request_id = v_id) = v_created, 'cambió');

  -- 57-59. Reemplazo completo: los opcionales en blanco se BORRAN.
  PERFORM ops.update_quote_request(
    p_quote_request_id := v_id, p_actor_id := v_actor, p_contact_phone := '5491155550001',
    p_description := 'Service', p_contact_name := '', p_contact_email := NULL, p_plate := '',
    p_vehicle_text := '  ', p_declared_amount := NULL,
    p_location_address := '', p_location_locality := '', p_location_province := ''
  );
  SELECT * INTO v_row FROM quote_requests WHERE id = v_id;
  PERFORM pg_temp.check('57 blanco borra: nombre, email, patente, monto',
    v_row.contact_name IS NULL AND v_row.contact_email IS NULL AND v_row.plate IS NULL
      AND v_row.declared_amount IS NULL, 'algún no null');
  PERFORM pg_temp.check('58 blanco borra: vehículo escrito (sin fila)',
    NOT EXISTS (SELECT 1 FROM ops.quote_request_vehicle_text WHERE quote_request_id = v_id), 'hay fila');
  PERFORM pg_temp.check('59 blanco borra: la ubicación entera, con su source',
    v_row.location_source IS NULL AND v_row.location_address IS NULL AND v_row.location_locality IS NULL
      AND v_row.location_province IS NULL, coalesce(v_row.location_source::text, '(null)'));

  -- 60-62. La ubicación del GPS no se edita…
  BEGIN
    PERFORM ops.update_quote_request(
      p_quote_request_id := v_device, p_actor_id := v_actor, p_contact_phone := '5491100000000',
      p_description := 'Test 018 device', p_plate := 'AB123CD',
      p_location_address := 'Otra dirección', p_location_locality := 'CABA', p_location_province := 'Buenos Aires'
    );
    PERFORM pg_temp.check('60 ubicación del GPS: cambiarla rechaza', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('60 ubicación del GPS: cambiarla rechaza', v_msg LIKE 'LOCATION_FROM_DEVICE%', v_msg);
  END;
  -- …pero el resto del pedido sí, mandando la ubicación tal cual está.
  PERFORM ops.update_quote_request(
    p_quote_request_id := v_device, p_actor_id := v_actor, p_contact_phone := '5491100000000',
    p_description := 'Test 018 device, editado', p_plate := 'AB123CD',
    p_location_address := 'Av. Corrientes 1234', p_location_locality := 'CABA', p_location_province := 'Buenos Aires'
  );
  SELECT * INTO v_row FROM quote_requests WHERE id = v_device;
  PERFORM pg_temp.check('61 pedido con GPS: el resto se edita',
    v_row.description = 'Test 018 device, editado', v_row.description);
  PERFORM pg_temp.check('62 pedido con GPS: coordenadas y source intactos',
    v_row.location_source::text = 'device' AND v_row.location_latitude = -34.6037
      AND v_row.location_longitude = -58.3816, coalesce(v_row.location_latitude::text, '(null)'));
  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_device AND action = 'quote_request.update' ORDER BY created_at DESC LIMIT 1;
  PERFORM pg_temp.check('63 log sin coordenadas (redact de la 011)',
    NOT (v_log.before ? 'location_latitude') AND NOT (v_log.after ? 'location_latitude')
      AND NOT (v_log.after ? 'raw_submission'),
    coalesce(v_log.after::text, '(null)'));

  -- 64. Ubicación tipeada sin dirección: la base no la puede representar.
  BEGIN
    PERFORM ops.update_quote_request(
      p_quote_request_id := v_id, p_actor_id := v_actor, p_contact_phone := '1', p_description := 'x',
      p_location_locality := 'Tigre'
    );
    PERFORM pg_temp.check('64 localidad sin dirección', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('64 localidad sin dirección', v_msg LIKE 'LOCATION_ADDRESS_REQUIRED%', v_msg);
  END;

  -- 65. Con cuenta, la patente no se puede borrar.
  BEGIN
    PERFORM ops.update_quote_request(
      p_quote_request_id := v_account, p_actor_id := v_actor, p_contact_phone := '5491100000001',
      p_description := 'Test 018 cuenta', p_plate := ''
    );
    PERFORM pg_temp.check('65 con cuenta, patente obligatoria', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('65 con cuenta, patente obligatoria', v_msg LIKE 'PLATE_REQUIRED_FOR_ACCOUNT%', v_msg);
  END;

  -- 66-67. Los NOT NULL en blanco.
  BEGIN
    PERFORM ops.update_quote_request(p_quote_request_id := v_id, p_actor_id := v_actor,
                                     p_contact_phone := ' ', p_description := 'x');
    PERFORM pg_temp.check('66 teléfono en blanco', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('66 teléfono en blanco', v_msg LIKE 'CONTACT_PHONE_REQUIRED%', v_msg);
  END;
  BEGIN
    PERFORM ops.update_quote_request(p_quote_request_id := v_id, p_actor_id := v_actor,
                                     p_contact_phone := '1', p_description := ' ');
    PERFORM pg_temp.check('67 descripción en blanco', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('67 descripción en blanco', v_msg LIKE 'DESCRIPTION_REQUIRED%', v_msg);
  END;

  -- 68. Pedido inexistente.
  BEGIN
    PERFORM ops.update_quote_request(p_quote_request_id := gen_random_uuid(), p_actor_id := v_actor,
                                     p_contact_phone := '1', p_description := 'x');
    PERFORM pg_temp.check('68 pedido inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('68 pedido inexistente', v_msg LIKE 'QUOTE_REQUEST_NOT_FOUND%', v_msg);
  END;

  -- 69. Actor NULL.
  BEGIN
    PERFORM ops.update_quote_request(p_quote_request_id := v_id, p_actor_id := NULL,
                                     p_contact_phone := '1', p_description := 'x');
    PERFORM pg_temp.check('69 actor NULL', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('69 actor NULL', v_msg LIKE 'ACTOR_REQUIRED%', v_msg);
  END;

  -- 70. Un pedido cerrado también se edita: los datos no son el estado.
  PERFORM ops.update_quote_request(
    p_quote_request_id := v_closed, p_actor_id := v_actor, p_contact_phone := '5491100000002',
    p_description := 'Test 018 cerrado, corregido', p_plate := 'CD456EF'
  );
  SELECT * INTO v_row FROM quote_requests WHERE id = v_closed;
  PERFORM pg_temp.check('70 pedido cerrado: se edita y sigue cerrado',
    v_row.description = 'Test 018 cerrado, corregido' AND v_row.status::text = 'closed', v_row.status::text);

  -- 71. Guardrail 8: ninguna de las dos escribe quote_requests.updated_at a mano.
  PERFORM pg_temp.check('71 el SP de edición no escribe updated_at de quote_requests',
    pg_get_functiondef('ops.update_quote_request(uuid,uuid,text,text,text,text,text,text,numeric,text,text,text,text)'::regprocedure)
      !~* 'updated_at[[:space:]]*=',
    'lo pone trg_quote_requests_updated_at');
END $$;

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

PREPARE p018_update AS
  SELECT ops.update_quote_request(
    p_quote_request_id  => $1,
    p_actor_id          => $2,
    p_contact_phone     => $3,
    p_description       => $4,
    p_contact_name      => $5,
    p_contact_email     => $6,
    p_plate             => $7,
    p_vehicle_text      => $8,
    p_declared_amount   => $9,
    p_location_address  => $10,
    p_location_locality => $11,
    p_location_province => $12,
    p_note              => $13
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

CREATE OR REPLACE FUNCTION pg_temp.int_id() RETURNS uuid LANGUAGE sql AS $$ SELECT (q->>'id')::uuid FROM t_int LIMIT 1 $$;

CREATE TEMP TABLE t_int2 ON COMMIT DROP AS
EXECUTE p018_update(pg_temp.int_id(), pg_temp.fix_actor(), '5491155550099', 'Frenos chillan adelante',
                    'Ana', '', 'AF 111 GG', 'Fiat Cronos 1.3 2021', 95000,
                    'Palermo', 'CABA', NULL, NULL);

DO $$
DECLARE v_q jsonb;
BEGIN
  SELECT q INTO v_q FROM t_int2 LIMIT 1;
  PERFORM pg_temp.check('81 integración: edición por parámetros nombrados',
    v_q->>'plate' = 'AF111GG' AND v_q->>'contact_name' = 'Ana' AND v_q->>'contact_email' IS NULL
      AND v_q->>'vehicle_text' = 'Fiat Cronos 1.3 2021' AND v_q->>'location_source' = 'typed',
    v_q::text);
END $$;

-- Un prepared statement es de la SESIÓN: el ROLLBACK no se lo lleva.
DEALLOCATE p018_create;
DEALLOCATE p018_update;

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
