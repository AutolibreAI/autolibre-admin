-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 033 (la audiencia en SQL + activated_at).
--
--   node tmp/run-033.mjs          (réplica PGlite: rojo sin la 033, verde con ella)
--
-- BEGIN … ROLLBACK, con su propio actor y sus propios usuarios de fixture.
--
-- ⚠ Está pensada para la RÉPLICA (`tmp/replica-033.sql`), no para DEV: los
-- fixtures insertan en `vehicles`, `insurances`, `driving_sessions`… sólo las
-- columnas que el catálogo LEE, y en una base real esas tablas tienen NOT NULL
-- y FK de más (spec del catálogo, `files`, patente…). La comparación contra una
-- base real es `tmp/probe-audiencia-paridad.mjs`, que no inserta nada.
--
-- Las audiencias se miran SÓLO sobre los cuatro usuarios de fixture (`t_u`):
-- `resolve_audience` devuelve toda la base, y la suite no puede depender de lo
-- que haya en ella.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, coalesce(p_ok, false), p_detalle);
$$;

CREATE OR REPLACE FUNCTION pg_temp.expect_error(p_caso text, p_sql text, p_prefix text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  PERFORM pg_temp.check(p_caso, false, 'no tiró error');
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_temp.check(p_caso, SQLERRM LIKE p_prefix || '%', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.expect_ok(p_caso text, p_sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  PERFORM pg_temp.check(p_caso, true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_temp.check(p_caso, false, SQLERRM);
END;
$$;

-- ── Fixtures ────────────────────────────────────────────────────────────────

CREATE TEMP TABLE t_u (label text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;
INSERT INTO t_u VALUES
  ('actor', gen_random_uuid()),
  ('none',  gen_random_uuid()),
  ('rich',  gen_random_uuid()),
  ('two',   gen_random_uuid()),
  ('int',   gen_random_uuid());

CREATE OR REPLACE FUNCTION pg_temp.uid(p_label text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM t_u WHERE label = p_label;
$$;

-- `test033.invalid` pasa a ser dominio interno, sólo adentro de la transacción.
INSERT INTO ops.excluded_email_domains (domain, note) VALUES ('test033.invalid', 'suite 033');

INSERT INTO users (id, email, role, auth_provider, external_auth_id, created_at)
SELECT id,
       CASE label WHEN 'int' THEN 'interno-' || id || '@test033.invalid'
                  ELSE 'test-033-' || label || '-' || id || '@example.invalid' END,
       CASE label WHEN 'actor' THEN 'admin'::user_role WHEN 'int' THEN 'admin'::user_role
                  ELSE 'user'::user_role END,
       CASE label WHEN 'int' THEN 'native'::auth_provider ELSE 'clerk'::auth_provider END,
       'test-033-' || id,
       CASE label WHEN 'rich' THEN now() - interval '400 days'
                  WHEN 'two'  THEN now() - interval '10 days'
                  WHEN 'int'  THEN now() - interval '1 day'
                  ELSE now() END
  FROM t_u;

CREATE TEMP TABLE t_v (label text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;
INSERT INTO t_v VALUES ('r1', gen_random_uuid()), ('t1', gen_random_uuid()),
                       ('t2', gen_random_uuid()), ('t3', gen_random_uuid());
CREATE OR REPLACE FUNCTION pg_temp.vid(p_label text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM t_v WHERE label = p_label;
$$;

-- rich: un auto con todo; two: dos autos activos (uno pelado) + uno archivado.
INSERT INTO vehicles (id, user_id, archived, odometer_value, created_at) VALUES
  (pg_temp.vid('r1'), pg_temp.uid('rich'), false, 1000, now() - interval '300 days'),
  (pg_temp.vid('t1'), pg_temp.uid('two'),  false, 500,  now() - interval '9 days'),
  (pg_temp.vid('t2'), pg_temp.uid('two'),  false, 0,    now() - interval '9 days'),
  (pg_temp.vid('t3'), pg_temp.uid('two'),  true,  0,    now() - interval '9 days');

INSERT INTO insurances (user_id, vehicle_id, expiration_date) VALUES
  (pg_temp.uid('rich'), pg_temp.vid('r1'), current_date + 10),
  (pg_temp.uid('two'),  pg_temp.vid('t1'), current_date + 30);

-- rich: VTV SUBIDA y vencida; two: sólo la del proveedor (no cuenta como subida).
INSERT INTO vehicle_inspections (user_id, vehicle_id, expiration_date, file_id, source) VALUES
  (pg_temp.uid('rich'), pg_temp.vid('r1'), current_date - 5, gen_random_uuid(), 'manual'),
  (pg_temp.uid('two'),  pg_temp.vid('t1'), current_date + 30, NULL, 'provider');

-- two: cédula sin vencimiento → `min()` da NULL → "no tiene".
INSERT INTO registration_cards (user_id, vehicle_id, expiration_date) VALUES
  (pg_temp.uid('rich'), pg_temp.vid('r1'), current_date + 200),
  (pg_temp.uid('two'),  pg_temp.vid('t1'), NULL);

INSERT INTO driver_licenses (user_id, expiration_date) VALUES
  (pg_temp.uid('rich'), current_date + 100);

-- rich: escaneo que sirvió hace 40 días; two: uno sin datos hace 8 días.
INSERT INTO driving_sessions (user_id, vehicle_id, status, total_readings, created_at) VALUES
  (pg_temp.uid('rich'), pg_temp.vid('r1'), 'completed', 50, now() - interval '40 days'),
  (pg_temp.uid('two'),  pg_temp.vid('t2'), 'completed', 0,  now() - interval '8 days');

-- rich: chat con mensaje hace 5 días; two: chat VACÍO hace 2 días.
WITH c AS (
  INSERT INTO conversations (user_id, created_at)
  VALUES (pg_temp.uid('rich'), now() - interval '5 days') RETURNING id
)
INSERT INTO conversation_messages (conversation_id) SELECT id FROM c;
INSERT INTO conversations (user_id, created_at) VALUES (pg_temp.uid('two'), now() - interval '2 days');

INSERT INTO fines (user_id, vehicle_id, status) VALUES
  (pg_temp.uid('rich'), pg_temp.vid('r1'), 'pending'),
  (pg_temp.uid('two'),  pg_temp.vid('t1'), 'paid');

INSERT INTO expo_push_tokens (user_id) VALUES (pg_temp.uid('rich')), (pg_temp.uid('rich'));
INSERT INTO notifications (user_id, source_type) VALUES
  (pg_temp.uid('rich'), 'broadcast'), (pg_temp.uid('two'), 'insurance');
INSERT INTO maintenance_occurrences (user_id, performed_at) VALUES
  (pg_temp.uid('rich'), NULL), (pg_temp.uid('rich'), current_date - 3);

-- Las etiquetas (ordenadas) de los usuarios de fixture que matchean. El actor
-- queda afuera: es admin y ensuciaría `isAdmin`.
CREATE OR REPLACE FUNCTION pg_temp.aud(p_conditions jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(t.label, ',' ORDER BY t.label), '')
    FROM ops.resolve_audience(p_conditions) r(id)
    JOIN t_u t ON t.id = r.id
   WHERE t.label <> 'actor';
$$;

CREATE OR REPLACE FUNCTION pg_temp.expect_aud(p_caso text, p_conditions jsonb, p_expected text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  v := pg_temp.aud(p_conditions);
  PERFORM pg_temp.check(p_caso, v = p_expected, 'esperado [' || p_expected || '] dio [' || v || ']');
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_temp.check(p_caso, false, SQLERRM);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 01–09 Guardrails de forma
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fn text;
  v_n  int;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'resolve_audience', '_audience_condition_sql', '_audience_field_expr',
    '_audience_field_ops', '_validate_notification_conditions',
    'set_notification_schedule_active'
  ]
  LOOP
    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = v_fn;
    PERFORM pg_temp.check('01 existe UNA sola ops.' || v_fn, v_n = 1, v_n::text);

    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = v_fn AND p.prosecdef;
    PERFORM pg_temp.check('02 ' || v_fn || ': SECURITY INVOKER', v_n = 0, v_n::text);

    PERFORM pg_temp.check('03 ' || v_fn || ': search_path fijo',
      EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'ops' AND p.proname = v_fn
           AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
      ));
  END LOOP;

  PERFORM pg_temp.check('04 resolve_audience es STABLE',
    (SELECT p.provolatile = 's' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'ops' AND p.proname = 'resolve_audience'));

  PERFORM pg_temp.check('05 resolve_audience devuelve SETOF uuid',
    (SELECT p.proretset AND p.prorettype = 'uuid'::regtype
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'ops' AND p.proname = 'resolve_audience'));

  -- La firma de la 014 no cambió: CREATE OR REPLACE, no una sobrecarga nueva.
  PERFORM pg_temp.check('06 set_notification_schedule_active conserva la firma de la 014',
    to_regprocedure('ops.set_notification_schedule_active(uuid,boolean,uuid,text)') IS NOT NULL);
  PERFORM pg_temp.check('07 _validate_notification_conditions conserva la firma de la 014',
    to_regprocedure('ops._validate_notification_conditions(jsonb)') IS NOT NULL);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10–14 El catálogo está completo: los 29 campos de ~/lib/audience
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TEMP TABLE t_fields (field text PRIMARY KEY, kind text NOT NULL) ON COMMIT DROP;
INSERT INTO t_fields VALUES
  ('vehicles','count'), ('scansOk','count'), ('scansTotal','count'), ('chats','count'),
  ('maintenanceUpcoming','count'), ('insurances','count'), ('inspections','count'),
  ('registrationCards','count'), ('driverLicenses','count'),
  ('vtvExpiry','expiry'), ('insuranceExpiry','expiry'), ('licenseExpiry','expiry'),
  ('registrationExpiry','expiry'),
  ('pendingFines','count'),
  ('vehicleWithoutInsurance','flag'), ('vehicleWithoutVtv','flag'),
  ('vehicleWithoutRegistration','flag'), ('vehicleWithPendingFines','flag'),
  ('vehicleNeverScanned','flag'), ('vehicleWithoutOdometer','flag'),
  ('signup','days'), ('lastActivity','days'), ('lastScan','days'), ('lastChat','days'),
  ('pushTokens','count'), ('announcementsReceived','count'),
  ('isAdmin','flag'), ('isInternal','flag'), ('isLegacyNative','flag');

DO $$
DECLARE
  r     record;
  v_bad text;
  v_op  text;
BEGIN
  PERFORM pg_temp.check('10 el catálogo de la suite tiene 29 campos', (SELECT count(*) FROM t_fields) = 29);

  SELECT string_agg(field, ',') INTO v_bad FROM t_fields
   WHERE ops._audience_field_ops(field) IS NULL;
  PERFORM pg_temp.check('11 los 29 campos tienen operadores', v_bad IS NULL, v_bad);

  -- Los operadores son los de su kind (OPERATORS_BY_KIND), salvo signup (def.ops).
  SELECT string_agg(field, ',') INTO v_bad FROM t_fields
   WHERE field <> 'signup'
     AND ops._audience_field_ops(field) IS DISTINCT FROM CASE kind
       WHEN 'count'  THEN ARRAY['eq','gte','lte']
       WHEN 'days'   THEN ARRAY['moreThan','lessThan','never','ever']
       WHEN 'expiry' THEN ARRAY['expired','withinDays','valid','missing']
       WHEN 'flag'   THEN ARRAY['yes','no'] END;
  PERFORM pg_temp.check('12 operadores = OPERATORS_BY_KIND[kind]', v_bad IS NULL, v_bad);
  PERFORM pg_temp.check('13 signup: sólo moreThan / lessThan (def.ops)',
    ops._audience_field_ops('signup') = ARRAY['moreThan','lessThan']);

  -- Cada campo, con CADA uno de sus operadores, se resuelve sin error: ninguna
  -- expresión del CASE está rota.
  v_bad := NULL;
  FOR r IN SELECT field FROM t_fields LOOP
    FOREACH v_op IN ARRAY ops._audience_field_ops(r.field) LOOP
      BEGIN
        PERFORM count(*) FROM ops.resolve_audience(jsonb_build_array(
          CASE WHEN v_op IN ('eq','gte','lte','moreThan','lessThan','withinDays')
               THEN jsonb_build_object('field', r.field, 'op', v_op, 'value', 1)
               ELSE jsonb_build_object('field', r.field, 'op', v_op) END));
      EXCEPTION WHEN OTHERS THEN
        v_bad := coalesce(v_bad || '; ', '') || r.field || '.' || v_op || ': ' || SQLERRM;
      END;
    END LOOP;
  END LOOP;
  PERFORM pg_temp.check('14 los 29 campos × sus operadores se ejecutan', v_bad IS NULL, v_bad);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 20–59 Cada campo contra los fixtures (none, rich, two, int)
-- ═══════════════════════════════════════════════════════════════════════════

-- count
SELECT pg_temp.expect_aud('20 vehicles = 0 (archivado no cuenta)', '[{"field":"vehicles","op":"eq","value":0}]', 'int,none');
SELECT pg_temp.expect_aud('21 vehicles >= 2', '[{"field":"vehicles","op":"gte","value":2}]', 'two');
SELECT pg_temp.expect_aud('22 vehicles <= 1', '[{"field":"vehicles","op":"lte","value":1}]', 'int,none,rich');
SELECT pg_temp.expect_aud('23 scansOk >= 1 (sin datos no cuenta)', '[{"field":"scansOk","op":"gte","value":1}]', 'rich');
SELECT pg_temp.expect_aud('24 scansTotal >= 1', '[{"field":"scansTotal","op":"gte","value":1}]', 'rich,two');
SELECT pg_temp.expect_aud('25 chats >= 1 (vacío no cuenta)', '[{"field":"chats","op":"gte","value":1}]', 'rich');
SELECT pg_temp.expect_aud('26 maintenanceUpcoming = 1', '[{"field":"maintenanceUpcoming","op":"eq","value":1}]', 'rich');
SELECT pg_temp.expect_aud('27 insurances >= 1', '[{"field":"insurances","op":"gte","value":1}]', 'rich,two');
SELECT pg_temp.expect_aud('28 inspections >= 1 (incluye proveedor)', '[{"field":"inspections","op":"gte","value":1}]', 'rich,two');
SELECT pg_temp.expect_aud('29 registrationCards >= 1', '[{"field":"registrationCards","op":"gte","value":1}]', 'rich,two');
SELECT pg_temp.expect_aud('30 driverLicenses >= 1', '[{"field":"driverLicenses","op":"gte","value":1}]', 'rich');
SELECT pg_temp.expect_aud('31 pendingFines >= 1 (paga no cuenta)', '[{"field":"pendingFines","op":"gte","value":1}]', 'rich');
SELECT pg_temp.expect_aud('32 pushTokens = 2', '[{"field":"pushTokens","op":"eq","value":2}]', 'rich');
SELECT pg_temp.expect_aud('33 pushTokens = 0', '[{"field":"pushTokens","op":"eq","value":0}]', 'int,none,two');
SELECT pg_temp.expect_aud('34 announcementsReceived >= 1', '[{"field":"announcementsReceived","op":"gte","value":1}]', 'rich');

-- expiry
SELECT pg_temp.expect_aud('35 vtvExpiry expired', '[{"field":"vtvExpiry","op":"expired"}]', 'rich');
SELECT pg_temp.expect_aud('36 vtvExpiry valid', '[{"field":"vtvExpiry","op":"valid"}]', 'two');
SELECT pg_temp.expect_aud('37 vtvExpiry missing', '[{"field":"vtvExpiry","op":"missing"}]', 'int,none');
SELECT pg_temp.expect_aud('38 insuranceExpiry withinDays 30 (borde incluido)', '[{"field":"insuranceExpiry","op":"withinDays","value":30}]', 'rich,two');
SELECT pg_temp.expect_aud('39 insuranceExpiry withinDays 15', '[{"field":"insuranceExpiry","op":"withinDays","value":15}]', 'rich');
SELECT pg_temp.expect_aud('40 licenseExpiry missing', '[{"field":"licenseExpiry","op":"missing"}]', 'int,none,two');
SELECT pg_temp.expect_aud('41 registrationExpiry missing (cédula sin fecha)', '[{"field":"registrationExpiry","op":"missing"}]', 'int,none,two');

-- flag, grano vehículo ("alguno", nunca "todos")
SELECT pg_temp.expect_aud('42 vehicleWithoutInsurance yes', '[{"field":"vehicleWithoutInsurance","op":"yes"}]', 'two');
SELECT pg_temp.expect_aud('43 vehicleWithoutInsurance no (sin autos NO es "sí")', '[{"field":"vehicleWithoutInsurance","op":"no"}]', 'int,none,rich');
SELECT pg_temp.expect_aud('44 vehicleWithoutVtv yes (proveedor no cuenta)', '[{"field":"vehicleWithoutVtv","op":"yes"}]', 'two');
SELECT pg_temp.expect_aud('45 vehicleWithoutRegistration yes', '[{"field":"vehicleWithoutRegistration","op":"yes"}]', 'two');
SELECT pg_temp.expect_aud('46 vehicleWithPendingFines yes', '[{"field":"vehicleWithPendingFines","op":"yes"}]', 'rich');
SELECT pg_temp.expect_aud('47 vehicleNeverScanned yes (sin datos = nunca)', '[{"field":"vehicleNeverScanned","op":"yes"}]', 'two');
SELECT pg_temp.expect_aud('48 vehicleWithoutOdometer yes', '[{"field":"vehicleWithoutOdometer","op":"yes"}]', 'two');

-- flag, grano usuario
SELECT pg_temp.expect_aud('49 isAdmin yes', '[{"field":"isAdmin","op":"yes"}]', 'int');
SELECT pg_temp.expect_aud('50 isAdmin no', '[{"field":"isAdmin","op":"no"}]', 'none,rich,two');
SELECT pg_temp.expect_aud('51 isInternal yes', '[{"field":"isInternal","op":"yes"}]', 'int');
SELECT pg_temp.expect_aud('52 isLegacyNative yes', '[{"field":"isLegacyNative","op":"yes"}]', 'int');

-- days
SELECT pg_temp.expect_aud('53 signup moreThan 30', '[{"field":"signup","op":"moreThan","value":30}]', 'rich');
SELECT pg_temp.expect_aud('54 signup lessThan 30', '[{"field":"signup","op":"lessThan","value":30}]', 'int,none,two');
SELECT pg_temp.expect_aud('55 lastActivity never', '[{"field":"lastActivity","op":"never"}]', 'int,none');
SELECT pg_temp.expect_aud('56 lastActivity lessThan 7', '[{"field":"lastActivity","op":"lessThan","value":7}]', 'rich,two');
-- `null` nunca matchea: none e int (sin actividad) NO entran en "hace más de 3".
SELECT pg_temp.expect_aud('57 lastActivity moreThan 3: null no matchea', '[{"field":"lastActivity","op":"moreThan","value":3}]', 'rich');
SELECT pg_temp.expect_aud('58 lastScan moreThan 30: null no matchea', '[{"field":"lastScan","op":"moreThan","value":30}]', 'rich');
SELECT pg_temp.expect_aud('59 lastChat ever (vacío también)', '[{"field":"lastChat","op":"ever"}]', 'rich,two');

-- ═══════════════════════════════════════════════════════════════════════════
-- 60–64 Y, nunca O
-- ═══════════════════════════════════════════════════════════════════════════

SELECT pg_temp.expect_aud('60 Y: vehicles >= 1 y pendingFines = 0',
  '[{"field":"vehicles","op":"gte","value":1},{"field":"pendingFines","op":"eq","value":0}]', 'two');
SELECT pg_temp.expect_aud('61 Y: insuranceExpiry withinDays 30 y algún auto sin seguro',
  '[{"field":"insuranceExpiry","op":"withinDays","value":30},{"field":"vehicleWithoutInsurance","op":"yes"}]', 'two');
SELECT pg_temp.expect_aud('62 Y: isAdmin no y lastActivity never',
  '[{"field":"isAdmin","op":"no"},{"field":"lastActivity","op":"never"}]', 'none');
SELECT pg_temp.expect_aud('63 Y contradictorio: vacío',
  '[{"field":"isAdmin","op":"yes"},{"field":"isAdmin","op":"no"}]', '');
-- Ocho condiciones (el tope) con valores en slots salteados: el `$1[n]` de cada
-- una apunta a SU valor, no al de otra.
SELECT pg_temp.expect_aud('64 ocho condiciones, slots con y sin valor',
  '[{"field":"isAdmin","op":"no"},
    {"field":"vehicles","op":"eq","value":1},
    {"field":"vtvExpiry","op":"expired"},
    {"field":"pushTokens","op":"gte","value":2},
    {"field":"lastChat","op":"ever"},
    {"field":"signup","op":"moreThan","value":399},
    {"field":"pendingFines","op":"lte","value":1},
    {"field":"insuranceExpiry","op":"withinDays","value":10}]', 'rich');
SELECT pg_temp.expect_aud('65 campos extra en la condición se ignoran (como zod)',
  '[{"field":"vehicles","op":"gte","value":2,"label":"x"}]', 'two');

-- ═══════════════════════════════════════════════════════════════════════════
-- 70–89 Sentinelas
-- ═══════════════════════════════════════════════════════════════════════════

SELECT pg_temp.expect_error('70 INVALID_CONDITIONS (no es array)',
  $q$SELECT * FROM ops.resolve_audience('{"field":"vehicles","op":"eq","value":0}')$q$, 'INVALID_CONDITIONS');
SELECT pg_temp.expect_error('71 INVALID_CONDITIONS_COUNT (vacío no es "todos")',
  $q$SELECT * FROM ops.resolve_audience('[]')$q$, 'INVALID_CONDITIONS_COUNT');
SELECT pg_temp.expect_error('72 INVALID_CONDITIONS_COUNT (nueve)',
  $q$SELECT * FROM ops.resolve_audience((SELECT jsonb_agg('{"field":"isAdmin","op":"no"}'::jsonb) FROM generate_series(1,9)))$q$,
  'INVALID_CONDITIONS_COUNT');
SELECT pg_temp.expect_error('73 INVALID_CONDITIONS_SHAPE (sin op)',
  $q$SELECT * FROM ops.resolve_audience('[{"field":"vehicles"}]')$q$, 'INVALID_CONDITIONS_SHAPE');
SELECT pg_temp.expect_error('74 INVALID_AUDIENCE_FIELD (desconocido)',
  $q$SELECT * FROM ops.resolve_audience('[{"field":"foo","op":"eq","value":1}]')$q$, 'INVALID_AUDIENCE_FIELD');
SELECT pg_temp.expect_error('75 INVALID_AUDIENCE_FIELD (intento de inyección)',
  $q$SELECT * FROM ops.resolve_audience('[{"field":"vehicles) or (true","op":"yes"}]')$q$, 'INVALID_AUDIENCE_FIELD');
SELECT pg_temp.expect_error('76 INVALID_AUDIENCE_FIELD (no es string)',
  $q$SELECT * FROM ops.resolve_audience('[{"field":1,"op":"yes"}]')$q$, 'INVALID_AUDIENCE_FIELD');
SELECT pg_temp.expect_error('77 INVALID_AUDIENCE_OPERATOR (de otro kind)',
  $q$SELECT * FROM ops.resolve_audience('[{"field":"isAdmin","op":"withinDays","value":3}]')$q$, 'INVALID_AUDIENCE_OPERATOR');
SELECT pg_temp.expect_error('78 INVALID_AUDIENCE_OPERATOR (signup never: def.ops)',
  $q$SELECT * FROM ops.resolve_audience('[{"field":"signup","op":"never"}]')$q$, 'INVALID_AUDIENCE_OPERATOR');
SELECT pg_temp.expect_error('79 INVALID_AUDIENCE_OPERATOR (inexistente)',
  $q$SELECT * FROM ops.resolve_audience('[{"field":"vehicles","op":"gt","value":1}]')$q$, 'INVALID_AUDIENCE_OPERATOR');
SELECT pg_temp.expect_error('80 AUDIENCE_VALUE_REQUIRED',
  $q$SELECT * FROM ops.resolve_audience('[{"field":"vehicles","op":"eq"}]')$q$, 'AUDIENCE_VALUE_REQUIRED');
SELECT pg_temp.expect_error('81 AUDIENCE_VALUE_NOT_ALLOWED',
  $q$SELECT * FROM ops.resolve_audience('[{"field":"isAdmin","op":"yes","value":1}]')$q$, 'AUDIENCE_VALUE_NOT_ALLOWED');
SELECT pg_temp.expect_error('82 INVALID_AUDIENCE_VALUE (3651)',
  $q$SELECT * FROM ops.resolve_audience('[{"field":"vehicles","op":"eq","value":3651}]')$q$, 'INVALID_AUDIENCE_VALUE');
SELECT pg_temp.expect_error('83 INVALID_AUDIENCE_VALUE (-1)',
  $q$SELECT * FROM ops.resolve_audience('[{"field":"vehicles","op":"eq","value":-1}]')$q$, 'INVALID_AUDIENCE_VALUE');
SELECT pg_temp.expect_error('84 INVALID_AUDIENCE_VALUE (1.5)',
  $q$SELECT * FROM ops.resolve_audience('[{"field":"vehicles","op":"eq","value":1.5}]')$q$, 'INVALID_AUDIENCE_VALUE');
SELECT pg_temp.expect_error('85 INVALID_AUDIENCE_VALUE (string "5")',
  $q$SELECT * FROM ops.resolve_audience('[{"field":"vehicles","op":"eq","value":"5"}]')$q$, 'INVALID_AUDIENCE_VALUE');
SELECT pg_temp.expect_error('86 INVALID_AUDIENCE_VALUE (null)',
  $q$SELECT * FROM ops.resolve_audience('[{"field":"vehicles","op":"eq","value":null}]')$q$, 'INVALID_AUDIENCE_VALUE');
SELECT pg_temp.expect_error('87 INVALID_AUDIENCE_VALUE (texto con SQL)',
  $q$SELECT * FROM ops.resolve_audience('[{"field":"vehicles","op":"eq","value":"0 or true"}]')$q$, 'INVALID_AUDIENCE_VALUE');
SELECT pg_temp.expect_ok('88 value 0, 3650 y 5.0 se aceptan',
  $q$SELECT * FROM ops.resolve_audience('[{"field":"vehicles","op":"gte","value":0},{"field":"signup","op":"lessThan","value":3650},{"field":"pushTokens","op":"lte","value":5.0}]')$q$);

-- ═══════════════════════════════════════════════════════════════════════════
-- 90–109 La validación de reglas (014) ahora usa el catálogo
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TEMP TABLE t_rec ON COMMIT DROP AS
SELECT '{"kind": "everyNDays", "n": 2, "atHour": 19, "atMinute": 0}'::jsonb AS recurrence;

CREATE OR REPLACE FUNCTION pg_temp.create_with(p_conditions text, p_title text DEFAULT 't', p_body text DEFAULT 'b')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT ops.create_notification_schedule('regla 033', p_title, p_body, p_conditions::jsonb,
    (SELECT recurrence FROM t_rec), current_date, pg_temp.uid('actor'));
$$;

SELECT pg_temp.expect_ok('90 create: condición válida',
  $q$SELECT pg_temp.create_with('[{"field":"vehicles","op":"eq","value":0}]')$q$);
SELECT pg_temp.expect_ok('91 create: ocho condiciones válidas de los cuatro kinds',
  $q$SELECT pg_temp.create_with('[{"field":"isAdmin","op":"no"},{"field":"vehicles","op":"gte","value":1},{"field":"vtvExpiry","op":"withinDays","value":30},{"field":"lastScan","op":"never"},{"field":"signup","op":"lessThan","value":7},{"field":"isInternal","op":"no"},{"field":"vehicleWithoutVtv","op":"yes"},{"field":"insuranceExpiry","op":"missing"}]')$q$);
SELECT pg_temp.expect_error('92 create: campo desconocido',
  $q$SELECT pg_temp.create_with('[{"field":"foo","op":"eq","value":0}]')$q$, 'INVALID_AUDIENCE_FIELD');
SELECT pg_temp.expect_error('93 create: operador ajeno',
  $q$SELECT pg_temp.create_with('[{"field":"vehicles","op":"yes"}]')$q$, 'INVALID_AUDIENCE_OPERATOR');
SELECT pg_temp.expect_error('94 create: falta value',
  $q$SELECT pg_temp.create_with('[{"field":"lastScan","op":"moreThan"}]')$q$, 'AUDIENCE_VALUE_REQUIRED');
SELECT pg_temp.expect_error('95 create: value de más',
  $q$SELECT pg_temp.create_with('[{"field":"lastScan","op":"never","value":3}]')$q$, 'AUDIENCE_VALUE_NOT_ALLOWED');
SELECT pg_temp.expect_error('96 create: value fuera de rango',
  $q$SELECT pg_temp.create_with('[{"field":"vehicles","op":"eq","value":9999}]')$q$, 'INVALID_AUDIENCE_VALUE');
SELECT pg_temp.expect_error('97 create: la 2ª condición mala rebota aunque la 1ª esté bien',
  $q$SELECT pg_temp.create_with('[{"field":"isAdmin","op":"no"},{"field":"isAdmin","op":"maybe"}]')$q$, 'INVALID_AUDIENCE_OPERATOR');
-- Las sentinelas de forma de la 014 siguen saliendo primero.
SELECT pg_temp.expect_error('98 create: INVALID_CONDITIONS_SHAPE de la 014 intacta',
  $q$SELECT pg_temp.create_with('[{"op":"eq"}]')$q$, 'INVALID_CONDITIONS_SHAPE');
SELECT pg_temp.expect_error('99 create: INVALID_CONDITIONS_COUNT de la 014 intacta',
  $q$SELECT pg_temp.create_with('[]')$q$, 'INVALID_CONDITIONS_COUNT');

DO $$
DECLARE
  v_id uuid;
  v_out jsonb;
BEGIN
  v_id := (pg_temp.create_with('[{"field":"vehicles","op":"eq","value":0}]')->>'id')::uuid;

  v_out := ops.update_notification_schedule(v_id, 'editada', 't', 'b',
    '[{"field":"pushTokens","op":"gte","value":1}]'::jsonb, (SELECT recurrence FROM t_rec),
    current_date, pg_temp.uid('actor'));
  PERFORM pg_temp.check('100 update: condición válida se guarda',
    v_out->'conditions' = '[{"field":"pushTokens","op":"gte","value":1}]'::jsonb, v_out::text);

  BEGIN
    PERFORM ops.update_notification_schedule(v_id, 'editada', 't', 'b',
      '[{"field":"pushTokens","op":"never"}]'::jsonb, (SELECT recurrence FROM t_rec),
      current_date, pg_temp.uid('actor'));
    PERFORM pg_temp.check('101 update: operador ajeno rebota', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('101 update: operador ajeno rebota', SQLERRM LIKE 'INVALID_AUDIENCE_OPERATOR%', SQLERRM);
  END;

  PERFORM pg_temp.check('102 update fallido no tocó la fila',
    (SELECT conditions FROM ops.notification_schedule WHERE id = v_id)
      = '[{"field":"pushTokens","op":"gte","value":1}]'::jsonb);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 110–119 Título y cuerpo: 1..100 / 1..500 DESPUÉS de btrim (contrato con
-- `notification_dispatch_requests` del backend). La 014 ya lo cumplía; esto lo fija.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_out jsonb;
  v_id  uuid;
BEGIN
  v_out := pg_temp.create_with('[{"field":"isAdmin","op":"no"}]',
    '   ' || repeat('a', 100) || '   ', '  ' || repeat('b', 500) || '  ');
  PERFORM pg_temp.check('110 título de 100 y cuerpo de 500 con espacios alrededor: se aceptan',
    v_out IS NOT NULL, v_out->>'id');
  PERFORM pg_temp.check('111 se guardan recortados (100 / 500)',
    length(v_out->>'title') = 100 AND length(v_out->>'body') = 500,
    length(v_out->>'title') || '/' || length(v_out->>'body'));
  v_id := (v_out->>'id')::uuid;

  BEGIN
    PERFORM ops.update_notification_schedule(v_id, 'n', repeat('a', 101), 'b',
      '[{"field":"isAdmin","op":"no"}]'::jsonb, (SELECT recurrence FROM t_rec), current_date, pg_temp.uid('actor'));
    PERFORM pg_temp.check('112 update: título de 101 rebota', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('112 update: título de 101 rebota', SQLERRM LIKE 'INVALID_TITLE%', SQLERRM);
  END;

  BEGIN
    PERFORM ops.update_notification_schedule(v_id, 'n', 't', '   ',
      '[{"field":"isAdmin","op":"no"}]'::jsonb, (SELECT recurrence FROM t_rec), current_date, pg_temp.uid('actor'));
    PERFORM pg_temp.check('113 update: cuerpo de sólo espacios rebota', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('113 update: cuerpo de sólo espacios rebota', SQLERRM LIKE 'INVALID_BODY%', SQLERRM);
  END;
END $$;

SELECT pg_temp.expect_error('114 create: título de 101',
  $q$SELECT pg_temp.create_with('[{"field":"isAdmin","op":"no"}]', repeat('a', 101))$q$, 'INVALID_TITLE');
SELECT pg_temp.expect_error('115 create: título de sólo espacios',
  $q$SELECT pg_temp.create_with('[{"field":"isAdmin","op":"no"}]', '    ')$q$, 'INVALID_TITLE');
SELECT pg_temp.expect_error('116 create: cuerpo de 501',
  $q$SELECT pg_temp.create_with('[{"field":"isAdmin","op":"no"}]', 't', repeat('b', 501))$q$, 'INVALID_BODY');
SELECT pg_temp.expect_error('117 create: cuerpo vacío',
  $q$SELECT pg_temp.create_with('[{"field":"isAdmin","op":"no"}]', 't', '')$q$, 'INVALID_BODY');

-- ═══════════════════════════════════════════════════════════════════════════
-- 120–129 activated_at
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_id  uuid;
  v_out jsonb;
  v_at  timestamptz;
BEGIN
  PERFORM pg_temp.check('120 existe la columna activated_at (timestamptz, nullable)',
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'ops' AND table_name = 'notification_schedule'
               AND column_name = 'activated_at' AND data_type = 'timestamp with time zone'
               AND is_nullable = 'YES'));

  v_out := pg_temp.create_with('[{"field":"isAdmin","op":"no"}]');
  v_id := (v_out->>'id')::uuid;
  PERFORM pg_temp.check('121 nace pausada y sin activated_at',
    NOT (v_out->>'active')::boolean AND (v_out->'activated_at') = 'null'::jsonb, v_out::text);

  -- false → true estampa.
  v_out := ops.set_notification_schedule_active(v_id, true, pg_temp.uid('actor'));
  PERFORM pg_temp.check('122 false→true estampa activated_at = now()',
    (v_out->>'activated_at')::timestamptz = now(), v_out->>'activated_at');

  -- Adentro de la transacción `now()` es constante: para distinguir "no se
  -- movió" de "se volvió a estampar", se planta una fecha vieja a mano.
  UPDATE ops.notification_schedule SET activated_at = '2020-01-01T00:00:00Z' WHERE id = v_id;

  v_out := ops.set_notification_schedule_active(v_id, true, pg_temp.uid('actor'));
  PERFORM pg_temp.check('123 true→true no la mueve',
    (v_out->>'activated_at')::timestamptz = '2020-01-01T00:00:00Z', v_out->>'activated_at');

  v_out := ops.set_notification_schedule_active(v_id, false, pg_temp.uid('actor'));
  PERFORM pg_temp.check('124 true→false la conserva',
    NOT (v_out->>'active')::boolean
      AND (v_out->>'activated_at')::timestamptz = '2020-01-01T00:00:00Z', v_out::text);

  v_out := ops.set_notification_schedule_active(v_id, false, pg_temp.uid('actor'));
  PERFORM pg_temp.check('125 false→false la conserva',
    (v_out->>'activated_at')::timestamptz = '2020-01-01T00:00:00Z', v_out->>'activated_at');

  v_out := ops.set_notification_schedule_active(v_id, true, pg_temp.uid('actor'));
  PERFORM pg_temp.check('126 reactivar re-estampa',
    (v_out->>'activated_at')::timestamptz = now(), v_out->>'activated_at');

  -- El log guarda before/after con activated_at (búsqueda por contenido, nunca
  -- por `created_at`: adentro de la transacción es constante).
  PERFORM pg_temp.check('127 el log de la activación trae activated_at en after',
    EXISTS (SELECT 1 FROM ops.action_log
             WHERE target_id = v_id AND action = 'notification_schedule.activate'
               AND (before->>'activated_at')::timestamptz = '2020-01-01T00:00:00Z'
               AND (after->>'activated_at')::timestamptz = now()));

  -- La edición no toca activated_at.
  PERFORM ops.update_notification_schedule(v_id, 'otra', 't', 'b',
    '[{"field":"isAdmin","op":"no"}]'::jsonb, (SELECT recurrence FROM t_rec), current_date, pg_temp.uid('actor'));
  SELECT activated_at INTO v_at FROM ops.notification_schedule WHERE id = v_id;
  PERFORM pg_temp.check('128 editar no toca activated_at', v_at = now(), v_at::text);

  -- Activa sin activated_at: el CHECK lo frena.
  BEGIN
    UPDATE ops.notification_schedule SET activated_at = NULL WHERE id = v_id;
    PERFORM pg_temp.check('129 CHECK: activa sin activated_at', false, 'no tiró');
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.check('129 CHECK: activa sin activated_at', true);
  END;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════

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
