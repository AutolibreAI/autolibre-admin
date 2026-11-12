-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 028 — editar un pedido SIN tocar la ubicación.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/028_ops_editar_pedido_sin_ubicacion.test.sql
--
-- BEGIN … ROLLBACK, con su propio actor, su propio usuario "con cuenta" y sus
-- propios pedidos. Necesita `quote_requests`.
--
-- Las pruebas de EDICIÓN de la 018 se MUDARON acá (la 028 le cambió la firma
-- a `ops.update_quote_request`, DROP + CREATE): mismo movimiento que 008 → 009
-- y 013 → 016. La suite de la 018 se quedó con el alta.
--
-- Re-verifica TODAS las validaciones de la 018: un DROP + CREATE es justo
-- donde se cae un `IF` sin que nadie lo note (009).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS account_id,
       gen_random_uuid() AS typed_id,
       gen_random_uuid() AS device_id,
       gen_random_uuid() AS account_qr_id,
       gen_random_uuid() AS closed_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-028-' || actor_id || '@example.invalid', 'admin'::user_role, 'clerk'::auth_provider, 'test-028-' || actor_id
  FROM t_fix
UNION ALL
SELECT account_id, 'test-028-' || account_id || '@example.invalid', 'user'::user_role, 'clerk'::auth_provider, 'test-028-' || account_id
  FROM t_fix;

-- Un pedido con ubicación TIPEADA: la 018 la editaba, la 028 no la toca.
INSERT INTO quote_requests (
  id, channel, contact_phone, description, raw_submission,
  location_source, location_address, location_locality, location_province
)
SELECT typed_id, 'whatsapp', '5491155550001', 'service', '{"source":"test-028"}'::jsonb,
       'typed', 'Zona Norte, cerca de la estación', 'Tigre', 'Buenos Aires'
  FROM t_fix;

-- Un pedido con la ubicación del GPS.
INSERT INTO quote_requests (
  id, channel, contact_phone, plate, description, raw_submission,
  location_source, location_address, location_locality, location_province,
  location_latitude, location_longitude, location_accuracy_meters
)
SELECT device_id, 'web', '5491100000000', 'AB123CD', 'Test 028 device',
       '{"description": "Test 028 device"}'::jsonb,
       'device', 'Av. Corrientes 1234', 'CABA', 'Buenos Aires', -34.6037, -58.3816, 12
  FROM t_fix;

-- Con cuenta: la patente es obligatoria (chk_quote_requests_user_has_plate).
INSERT INTO quote_requests (id, channel, user_id, contact_phone, plate, description, raw_submission)
SELECT account_qr_id, 'app', account_id, '5491100000001', 'ZZ999YY', 'Test 028 cuenta', '{}'::jsonb
  FROM t_fix;

-- Cerrado: editar datos no es mover el estado.
INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission,
                            status, closed_at, close_reason_code)
SELECT closed_id, 'web', '5491100000002', 'CD456EF', 'Test 028 cerrado', '{}'::jsonb,
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
   WHERE n.nspname = 'ops' AND p.proname = 'update_quote_request';
  PERFORM pg_temp.check('01 existe UNA sola update_quote_request (sin la sobrecarga de la 018)', v_n = 1, v_n::text);

  PERFORM pg_temp.check('02 la firma es la nueva, sin parámetros de ubicación',
    to_regprocedure('ops.update_quote_request(uuid,uuid,text,text,text,text,text,text,numeric,text)') IS NOT NULL,
    'no existe');

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'update_quote_request'
     AND array_to_string(p.proargnames, ',') LIKE '%location%';
  PERFORM pg_temp.check('03 ningún parámetro p_location_*', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'update_quote_request' AND p.prosecdef;
  PERFORM pg_temp.check('04 SECURITY INVOKER, no DEFINER', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'update_quote_request'
     AND coalesce(array_to_string(p.proconfig, ' '), '') NOT LIKE 'search_path=%';
  PERFORM pg_temp.check('05 search_path fijo (guardrail 3)', v_n = 0, v_n::text);

  PERFORM pg_temp.check('06 el cuerpo no nombra ninguna columna location_*',
    pg_get_functiondef('ops.update_quote_request(uuid,uuid,text,text,text,text,text,text,numeric,text)'::regprocedure)
      !~* 'location_(source|address|locality|province|latitude|longitude|accuracy)',
    'nombra location_*');

  PERFORM pg_temp.check('07 no escribe updated_at de quote_requests (guardrail 8)',
    pg_get_functiondef('ops.update_quote_request(uuid,uuid,text,text,text,text,text,text,numeric,text)'::regprocedure)
      !~* 'updated_at[[:space:]]*=',
    'lo pone trg_quote_requests_updated_at');
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Edición (las de la 018, menos la ubicación)
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
  v_n        int;
  v_raw      jsonb;
BEGIN
  SELECT actor_id, typed_id, device_id, account_qr_id, closed_id
    INTO v_actor, v_id, v_device, v_account, v_closed FROM t_fix;
  SELECT raw_submission INTO v_raw FROM quote_requests WHERE id = v_id;

  -- 10-20. Completar todo en una edición.
  PERFORM ops.update_quote_request(
    p_quote_request_id := v_id,
    p_actor_id         := v_actor,
    p_contact_phone    := '5491155550001',
    p_description      := 'Service de los 60.000 km',
    p_contact_name     := 'Carlos',
    p_contact_email    := 'carlos@example.invalid',
    p_plate            := 'ae 456 fg',
    p_vehicle_text     := 'Toyota Etios 1.5 2020',
    p_declared_amount  := 180000,
    p_note             := NULL
  );
  SELECT * INTO v_row FROM quote_requests WHERE id = v_id;

  PERFORM pg_temp.check('10 description editada', v_row.description = 'Service de los 60.000 km', v_row.description);
  PERFORM pg_temp.check('11 contact_name cargado', v_row.contact_name = 'Carlos', coalesce(v_row.contact_name, '(null)'));
  PERFORM pg_temp.check('12 contact_email cargado', v_row.contact_email = 'carlos@example.invalid',
    coalesce(v_row.contact_email, '(null)'));
  PERFORM pg_temp.check('13 patente cargada y normalizada', v_row.plate = 'AE456FG', coalesce(v_row.plate, '(null)'));
  PERFORM pg_temp.check('14 monto cargado', v_row.declared_amount = 180000, coalesce(v_row.declared_amount::text, '(null)'));
  -- Desde la 032 el vehículo escrito es `quote_requests.vehicle_description`.
  PERFORM pg_temp.check('15 vehículo escrito cargado',
    v_row.vehicle_description = 'Toyota Etios 1.5 2020', coalesce(v_row.vehicle_description, '(null)'));
  PERFORM pg_temp.check('16 raw_submission intacto', v_row.raw_submission = v_raw, v_row.raw_submission::text);
  PERFORM pg_temp.check('17 status intacto', v_row.status::text = 'received', v_row.status::text);
  PERFORM pg_temp.check('18 ubicación tipeada INTACTA (source y textos)',
    v_row.location_source::text = 'typed' AND v_row.location_address = 'Zona Norte, cerca de la estación'
      AND v_row.location_locality = 'Tigre' AND v_row.location_province = 'Buenos Aires',
    coalesce(v_row.location_address, '(null)'));

  SELECT * INTO v_log FROM ops.action_log WHERE target_id = v_id AND action = 'quote_request.update' LIMIT 1;
  PERFORM pg_temp.check('19 log: before/after con la descripción vieja y la nueva',
    v_log.before->>'description' = 'service' AND v_log.after->>'description' = 'Service de los 60.000 km'
      AND v_log.after->>'vehicle_text' = 'Toyota Etios 1.5 2020',
    coalesce(v_log.after::text, '(null)'));
  PERFORM pg_temp.check('20 log: actor de la sesión', v_log.actor_id = v_actor, coalesce(v_log.actor_id::text, '(null)'));

  -- 21. Guardar sin tocar nada no escribe una entrada nueva.
  SELECT count(*) INTO v_n FROM ops.action_log WHERE target_id = v_id AND action = 'quote_request.update';
  PERFORM ops.update_quote_request(
    p_quote_request_id := v_id, p_actor_id := v_actor, p_contact_phone := '5491155550001',
    p_description := 'Service de los 60.000 km', p_contact_name := 'Carlos',
    p_contact_email := 'carlos@example.invalid', p_plate := 'AE456FG',
    p_vehicle_text := 'Toyota Etios 1.5 2020', p_declared_amount := 180000.00
  );
  PERFORM pg_temp.check('21 sin cambios: no hay entrada nueva en el log',
    (SELECT count(*) FROM ops.action_log WHERE target_id = v_id AND action = 'quote_request.update') = v_n,
    v_n::text);

  -- 22. EL caso de la 028: alguien corrige la ubicación por otro camino
  -- (HTTP / la app) entre que se abrió el formulario y se guardó. La edición
  -- de datos NO la pisa.
  UPDATE quote_requests
     SET location_address = 'Av. Cabildo 2000', location_locality = 'Belgrano', location_province = 'CABA'
   WHERE id = v_id;
  PERFORM ops.update_quote_request(
    p_quote_request_id := v_id, p_actor_id := v_actor, p_contact_phone := '5491155550001',
    p_description := 'Service de los 60.000 km, con frenos', p_contact_name := 'Carlos',
    p_contact_email := 'carlos@example.invalid', p_plate := 'AE456FG',
    p_vehicle_text := 'Toyota Etios 1.5 2020', p_declared_amount := 180000
  );
  SELECT * INTO v_row FROM quote_requests WHERE id = v_id;
  PERFORM pg_temp.check('22 una corrección de ubicación hecha en el medio NO se pisa',
    v_row.location_address = 'Av. Cabildo 2000' AND v_row.location_locality = 'Belgrano'
      AND v_row.location_province = 'CABA' AND v_row.description = 'Service de los 60.000 km, con frenos',
    coalesce(v_row.location_address, '(null)'));

  -- 23-24. Cambiar SÓLO el vehículo escrito se loguea y queda en la columna.
  -- (Hasta la 032 el 24 verificaba que la fila de `ops` conservara su
  -- created_at; con la columna en `quote_requests` ese dato ya no existe.)
  SELECT count(*) INTO v_n FROM ops.action_log WHERE target_id = v_id AND action = 'quote_request.update';
  PERFORM ops.update_quote_request(
    p_quote_request_id := v_id, p_actor_id := v_actor, p_contact_phone := '5491155550001',
    p_description := 'Service de los 60.000 km, con frenos', p_contact_name := 'Carlos',
    p_contact_email := 'carlos@example.invalid', p_plate := 'AE456FG',
    p_vehicle_text := 'Toyota Etios XLS 1.5 2020', p_declared_amount := 180000
  );
  PERFORM pg_temp.check('23 cambiar sólo el vehículo escrito se loguea',
    (SELECT count(*) FROM ops.action_log WHERE target_id = v_id AND action = 'quote_request.update') = v_n + 1,
    v_n::text);
  PERFORM pg_temp.check('24 el vehículo escrito editado queda en vehicle_description',
    (SELECT vehicle_description FROM quote_requests WHERE id = v_id) = 'Toyota Etios XLS 1.5 2020', 'no');

  -- 25-27. Reemplazo completo: los opcionales en blanco se BORRAN… pero la
  -- ubicación no es uno de ellos.
  PERFORM ops.update_quote_request(
    p_quote_request_id := v_id, p_actor_id := v_actor, p_contact_phone := '5491155550001',
    p_description := 'Service', p_contact_name := '', p_contact_email := NULL, p_plate := '',
    p_vehicle_text := '  ', p_declared_amount := NULL
  );
  SELECT * INTO v_row FROM quote_requests WHERE id = v_id;
  PERFORM pg_temp.check('25 blanco borra: nombre, email, patente, monto',
    v_row.contact_name IS NULL AND v_row.contact_email IS NULL AND v_row.plate IS NULL
      AND v_row.declared_amount IS NULL, 'algún no null');
  PERFORM pg_temp.check('26 blanco borra: vehículo escrito (vehicle_description NULL)',
    v_row.vehicle_description IS NULL, coalesce(v_row.vehicle_description, '(null)'));
  PERFORM pg_temp.check('27 la ubicación sigue ahí (ya no es un campo de esta edición)',
    v_row.location_source::text = 'typed' AND v_row.location_address = 'Av. Cabildo 2000',
    coalesce(v_row.location_source::text, '(null)'));

  -- 28-30. Un pedido con GPS: se edita el resto, la ubicación ni se mira.
  PERFORM ops.update_quote_request(
    p_quote_request_id := v_device, p_actor_id := v_actor, p_contact_phone := '5491100000000',
    p_description := 'Test 028 device, editado', p_plate := 'AB123CD'
  );
  SELECT * INTO v_row FROM quote_requests WHERE id = v_device;
  PERFORM pg_temp.check('28 pedido con GPS: el resto se edita',
    v_row.description = 'Test 028 device, editado', v_row.description);
  PERFORM pg_temp.check('29 pedido con GPS: coordenadas, precisión, source y textos intactos',
    v_row.location_source::text = 'device' AND v_row.location_latitude = -34.6037
      AND v_row.location_longitude = -58.3816 AND v_row.location_accuracy_meters = 12
      AND v_row.location_address = 'Av. Corrientes 1234' AND v_row.location_locality = 'CABA',
    coalesce(v_row.location_latitude::text, '(null)'));
  SELECT * INTO v_log FROM ops.action_log WHERE target_id = v_device AND action = 'quote_request.update' LIMIT 1;
  PERFORM pg_temp.check('30 log sin coordenadas ni raw_submission (redact de la 011)',
    NOT (v_log.before ? 'location_latitude') AND NOT (v_log.after ? 'location_latitude')
      AND NOT (v_log.after ? 'raw_submission'),
    coalesce(v_log.after::text, '(null)'));

  -- 31. Con cuenta, la patente no se puede borrar.
  BEGIN
    PERFORM ops.update_quote_request(
      p_quote_request_id := v_account, p_actor_id := v_actor, p_contact_phone := '5491100000001',
      p_description := 'Test 028 cuenta', p_plate := ''
    );
    PERFORM pg_temp.check('31 con cuenta, patente obligatoria', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('31 con cuenta, patente obligatoria', v_msg LIKE 'PLATE_REQUIRED_FOR_ACCOUNT%', v_msg);
  END;

  -- 32-37. Rechazos con sentinela.
  BEGIN
    PERFORM ops.update_quote_request(p_quote_request_id := v_id, p_actor_id := v_actor,
                                     p_contact_phone := ' ', p_description := 'x');
    PERFORM pg_temp.check('32 teléfono en blanco', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('32 teléfono en blanco', v_msg LIKE 'CONTACT_PHONE_REQUIRED%', v_msg);
  END;
  BEGIN
    PERFORM ops.update_quote_request(p_quote_request_id := v_id, p_actor_id := v_actor,
                                     p_contact_phone := '1', p_description := ' ');
    PERFORM pg_temp.check('33 descripción en blanco', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('33 descripción en blanco', v_msg LIKE 'DESCRIPTION_REQUIRED%', v_msg);
  END;
  BEGIN
    PERFORM ops.update_quote_request(p_quote_request_id := v_id, p_actor_id := v_actor,
                                     p_contact_phone := '1', p_description := 'x', p_plate := 'ABC12345');
    PERFORM pg_temp.check('34 patente de más de 7', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('34 patente de más de 7', v_msg LIKE 'INVALID_PLATE%', v_msg);
  END;
  BEGIN
    PERFORM ops.update_quote_request(p_quote_request_id := v_id, p_actor_id := v_actor,
                                     p_contact_phone := '1', p_description := 'x', p_vehicle_text := repeat('a', 201));
    PERFORM pg_temp.check('35 vehículo escrito de más de 200', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('35 vehículo escrito de más de 200', v_msg LIKE 'VEHICLE_TEXT_TOO_LONG%', v_msg);
  END;
  BEGIN
    PERFORM ops.update_quote_request(p_quote_request_id := v_id, p_actor_id := v_actor,
                                     p_contact_phone := '1', p_description := 'x', p_declared_amount := -1);
    PERFORM pg_temp.check('36 monto negativo', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('36 monto negativo', v_msg LIKE 'INVALID_DECLARED_AMOUNT%', v_msg);
  END;
  BEGIN
    PERFORM ops.update_quote_request(p_quote_request_id := v_id, p_actor_id := v_actor,
                                     p_contact_phone := '1', p_description := 'x', p_declared_amount := 10000000000);
    PERFORM pg_temp.check('37 monto fuera de numeric(12,2)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('37 monto fuera de numeric(12,2)', v_msg LIKE 'DECLARED_AMOUNT_TOO_LARGE%', v_msg);
  END;

  -- 38-40. Pedido inexistente, actor NULL, actor inexistente.
  BEGIN
    PERFORM ops.update_quote_request(p_quote_request_id := gen_random_uuid(), p_actor_id := v_actor,
                                     p_contact_phone := '1', p_description := 'x');
    PERFORM pg_temp.check('38 pedido inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('38 pedido inexistente', v_msg LIKE 'QUOTE_REQUEST_NOT_FOUND%', v_msg);
  END;
  BEGIN
    PERFORM ops.update_quote_request(p_quote_request_id := v_id, p_actor_id := NULL,
                                     p_contact_phone := '1', p_description := 'x');
    PERFORM pg_temp.check('39 actor NULL', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('39 actor NULL', v_msg LIKE 'ACTOR_REQUIRED%', v_msg);
  END;
  BEGIN
    PERFORM ops.update_quote_request(p_quote_request_id := v_id, p_actor_id := gen_random_uuid(),
                                     p_contact_phone := '1', p_description := 'x');
    PERFORM pg_temp.check('40 actor inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('40 actor inexistente', v_msg LIKE 'ACTOR_NOT_FOUND%', v_msg);
  END;

  -- 41. Un pedido cerrado también se edita: los datos no son el estado.
  PERFORM ops.update_quote_request(
    p_quote_request_id := v_closed, p_actor_id := v_actor, p_contact_phone := '5491100000002',
    p_description := 'Test 028 cerrado, corregido', p_plate := 'CD456EF'
  );
  SELECT * INTO v_row FROM quote_requests WHERE id = v_closed;
  PERFORM pg_temp.check('41 pedido cerrado: se edita y sigue cerrado',
    v_row.description = 'Test 028 cerrado, corregido' AND v_row.status::text = 'closed', v_row.status::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL EXACTO que manda `updateQuoteRequest` en
-- `quote-requests.repo.ts` (rama con la 028), con `PREPARE` sin tipos. Si se
-- toca uno, se toca el otro.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pg_temp.fix_actor() RETURNS uuid LANGUAGE sql AS $$ SELECT actor_id FROM t_fix $$;
CREATE OR REPLACE FUNCTION pg_temp.fix_device() RETURNS uuid LANGUAGE sql AS $$ SELECT device_id FROM t_fix $$;

PREPARE p028_update AS
  SELECT ops.update_quote_request(
    p_quote_request_id => $1,
    p_actor_id         => $2,
    p_contact_phone    => $3,
    p_description      => $4,
    p_contact_name     => $5,
    p_contact_email    => $6,
    p_plate            => $7,
    p_vehicle_text     => $8,
    p_declared_amount  => $9,
    p_note             => $10
  ) AS q;

-- `INSERT … EXECUTE` no existe; `CREATE TABLE … AS EXECUTE` sí (011).
CREATE TEMP TABLE t_int ON COMMIT DROP AS
EXECUTE p028_update(pg_temp.fix_device(), pg_temp.fix_actor(), '5491100000000', 'Frenos chillan adelante',
                    'Ana', '', 'AF 111 GG', 'Fiat Cronos 1.3 2021', 95000, NULL);

DO $$
DECLARE v_q jsonb;
BEGIN
  SELECT q INTO v_q FROM t_int LIMIT 1;
  PERFORM pg_temp.check('50 integración: edición por parámetros nombrados',
    v_q->>'plate' = 'AF111GG' AND v_q->>'contact_name' = 'Ana' AND v_q->>'contact_email' IS NULL
      AND v_q->>'vehicle_text' = 'Fiat Cronos 1.3 2021',
    v_q::text);
  PERFORM pg_temp.check('51 integración: la ubicación del GPS quedó como estaba',
    v_q->>'location_source' = 'device' AND v_q->>'location_address' = 'Av. Corrientes 1234'
      AND NOT (v_q ? 'location_latitude'),
    v_q::text);
END $$;

-- Un prepared statement es de la SESIÓN: el ROLLBACK no se lo lleva.
DEALLOCATE p028_update;

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
