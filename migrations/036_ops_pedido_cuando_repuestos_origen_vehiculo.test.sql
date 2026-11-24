-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 036 (para cuándo, repuestos, origen y el vehículo
-- identificado de un pedido).
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/036_ops_pedido_cuando_repuestos_origen_vehiculo.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea su propio actor y sus pedidos.
-- Nunca `ORDER BY created_at` sobre los logs: adentro de la transacción
-- `now()` es constante.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS q1,
       gen_random_uuid() AS q2,
       gen_random_uuid() AS q3;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-036-' || actor_id || '@example.invalid', 'admin'::user_role,
       'clerk'::auth_provider, 'test-036-' || actor_id
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, description, raw_submission, vehicle_description)
SELECT q1, 'whatsapp'::quote_request_channel, '5491111111111', 'Service 036', '{}'::jsonb, NULL FROM t_fix
UNION ALL
SELECT q2, 'whatsapp'::quote_request_channel, '5491122222222', 'Frenos 036', '{}'::jsonb, 'Peugeot 208 (a mano)' FROM t_fix
UNION ALL
SELECT q3, 'web'::quote_request_channel, '5491133333333', 'Otro 036', '{}'::jsonb, NULL FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle);
$$;

CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END;
$$;

-- ═══ Forma ══════════════════════════════════════════════════════════════════

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops'
     AND p.proname IN ('set_quote_request_timing_and_parts', 'set_quote_request_vehicle_description',
                       'set_quote_request_origin');
  PERFORM pg_temp.check('01 tres SP, sin sobrecargas', v_n = 3, v_n::text);

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops'
     AND p.proname IN ('set_quote_request_timing_and_parts', 'set_quote_request_vehicle_description',
                       'set_quote_request_origin')
     AND (p.prosecdef OR p.proconfig IS NULL OR NOT EXISTS (
           SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'));
  PERFORM pg_temp.check('02 SECURITY INVOKER y search_path fijo', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'ops.quote_request_origin'::regclass AND contype = 'f';
  PERFORM pg_temp.check('03 ninguna FK cruza a public', v_n = 0, v_n::text);
END $$;

-- ═══ Para cuándo y repuestos ════════════════════════════════════════════════

DO $$
DECLARE f t_fix; v_r jsonb; v_q record; v_n int; v_leak boolean;
BEGIN
  SELECT * INTO f FROM t_fix;

  v_r := ops.set_quote_request_timing_and_parts(f.q1, f.actor_id, 'asap', NULL, 'workshop');
  SELECT timing::text t, preferred_date d, parts_supply::text p INTO v_q FROM quote_requests WHERE id = f.q1;
  PERFORM pg_temp.check('10 asap + workshop', v_q.t = 'asap' AND v_q.d IS NULL AND v_q.p = 'workshop', v_r::text);

  v_r := ops.set_quote_request_timing_and_parts(f.q1, f.actor_id, 'date', '2026-12-05', 'customer');
  SELECT timing::text t, preferred_date d, parts_supply::text p INTO v_q FROM quote_requests WHERE id = f.q1;
  PERFORM pg_temp.check('11 date con fecha', v_q.t = 'date' AND v_q.d = date '2026-12-05' AND v_q.p = 'customer', v_r::text);

  SELECT count(*) INTO v_n FROM ops.action_log
   WHERE target_id = f.q1 AND action = 'quote_request.set_timing_and_parts';
  PERFORM pg_temp.check('12 una entrada de log por cambio', v_n = 2, v_n::text);

  PERFORM ops.set_quote_request_timing_and_parts(f.q1, f.actor_id, 'date', '2026-12-05', 'customer');
  SELECT count(*) INTO v_n FROM ops.action_log
   WHERE target_id = f.q1 AND action = 'quote_request.set_timing_and_parts';
  PERFORM pg_temp.check('13 sin cambios no loguea', v_n = 2, v_n::text);

  PERFORM ops.set_quote_request_timing_and_parts(f.q1, f.actor_id, '', '', NULL);
  SELECT timing::text t, preferred_date d, parts_supply::text p INTO v_q FROM quote_requests WHERE id = f.q1;
  PERFORM pg_temp.check('14 vacío borra los tres', v_q.t IS NULL AND v_q.d IS NULL AND v_q.p IS NULL);

  SELECT bool_or(before ? 'raw_submission' OR after ? 'location_latitude') INTO v_leak FROM ops.action_log
   WHERE target_id = f.q1 AND action = 'quote_request.set_timing_and_parts';
  PERFORM pg_temp.check('15 el log va redactado', v_leak = false, v_leak::text);
END $$;

DO $$
DECLARE f t_fix; e text;
BEGIN
  SELECT * INTO f FROM t_fix;
  e := pg_temp.err(format('SELECT ops.set_quote_request_timing_and_parts(%L, %L, %L, NULL, NULL)', f.q1, f.actor_id, 'mañana'));
  PERFORM pg_temp.check('20 INVALID_TIMING', e LIKE 'INVALID_TIMING%', e);
  e := pg_temp.err(format('SELECT ops.set_quote_request_timing_and_parts(%L, %L, NULL, NULL, %L)', f.q1, f.actor_id, 'yo'));
  PERFORM pg_temp.check('21 INVALID_PARTS_SUPPLY', e LIKE 'INVALID_PARTS_SUPPLY%', e);
  e := pg_temp.err(format('SELECT ops.set_quote_request_timing_and_parts(%L, %L, %L, NULL, NULL)', f.q1, f.actor_id, 'date'));
  PERFORM pg_temp.check('22 PREFERRED_DATE_REQUIRED', e LIKE 'PREFERRED_DATE_REQUIRED%', e);
  e := pg_temp.err(format('SELECT ops.set_quote_request_timing_and_parts(%L, %L, %L, %L, NULL)', f.q1, f.actor_id, 'asap', '2026-12-05'));
  PERFORM pg_temp.check('23 PREFERRED_DATE_ONLY_WITH_DATE', e LIKE 'PREFERRED_DATE_ONLY_WITH_DATE%', e);
  e := pg_temp.err(format('SELECT ops.set_quote_request_timing_and_parts(%L, %L, %L, %L, NULL)', f.q1, f.actor_id, 'date', '2026-02-31'));
  PERFORM pg_temp.check('24 INVALID_PREFERRED_DATE', e LIKE 'INVALID_PREFERRED_DATE%', e);
  e := pg_temp.err(format('SELECT ops.set_quote_request_timing_and_parts(%L, %L, NULL, NULL, NULL)', gen_random_uuid(), f.actor_id));
  PERFORM pg_temp.check('25 QUOTE_REQUEST_NOT_FOUND', e LIKE 'QUOTE_REQUEST_NOT_FOUND%', e);
  e := pg_temp.err(format('SELECT ops.set_quote_request_timing_and_parts(%L, %L, NULL, NULL, NULL)', f.q1, gen_random_uuid()));
  PERFORM pg_temp.check('26 ACTOR_NOT_FOUND', e LIKE 'ACTOR_NOT_FOUND%', e);
  e := pg_temp.err(format('SELECT ops.set_quote_request_timing_and_parts(%L, NULL, NULL, NULL, NULL)', f.q1));
  PERFORM pg_temp.check('27 ACTOR_REQUIRED', e LIKE 'ACTOR_REQUIRED%', e);
END $$;

-- ═══ El vehículo, sin pisar lo escrito a mano ═══════════════════════════════

DO $$
DECLARE f t_fix; v_r jsonb; v_v text; e text; v_n int;
BEGIN
  SELECT * INTO f FROM t_fix;

  v_r := ops.set_quote_request_vehicle_description(f.q1, f.actor_id, '  Ford   EcoSport SE 1.6 2016 ', NULL);
  SELECT vehicle_description INTO v_v FROM quote_requests WHERE id = f.q1;
  PERFORM pg_temp.check('30 vacío: se completa, normalizado', v_v = 'Ford EcoSport SE 1.6 2016' AND (v_r->>'changed')::boolean, v_v);

  v_r := ops.set_quote_request_vehicle_description(f.q1, f.actor_id, 'Ford EcoSport SE 1.6 2016', NULL);
  PERFORM pg_temp.check('31 mismo texto: no-op aunque expected no coincida', NOT (v_r->>'changed')::boolean, v_r::text);

  e := pg_temp.err(format('SELECT ops.set_quote_request_vehicle_description(%L, %L, %L, NULL)', f.q2, f.actor_id, 'Peugeot 208 1.6 2019'));
  SELECT vehicle_description INTO v_v FROM quote_requests WHERE id = f.q2;
  PERFORM pg_temp.check('32 escrito a mano y expected NULL: VEHICLE_DESCRIPTION_CHANGED, no pisa',
                        e LIKE 'VEHICLE_DESCRIPTION_CHANGED%' AND v_v = 'Peugeot 208 (a mano)', e);

  v_r := ops.set_quote_request_vehicle_description(f.q2, f.actor_id, 'Peugeot 208 1.6 2019', 'Peugeot 208 (a mano)');
  SELECT vehicle_description INTO v_v FROM quote_requests WHERE id = f.q2;
  PERFORM pg_temp.check('33 «Usar este vehículo» con lo que vio: reemplaza', v_v = 'Peugeot 208 1.6 2019', v_v);

  e := pg_temp.err(format('SELECT ops.set_quote_request_vehicle_description(%L, %L, %L, NULL)', f.q3, f.actor_id, '   '));
  PERFORM pg_temp.check('34 VEHICLE_TEXT_REQUIRED', e LIKE 'VEHICLE_TEXT_REQUIRED%', e);

  e := pg_temp.err(format('SELECT ops.set_quote_request_vehicle_description(%L, %L, %L, NULL)', f.q3, f.actor_id, repeat('x', 201)));
  PERFORM pg_temp.check('35 VEHICLE_TEXT_TOO_LONG', e LIKE 'VEHICLE_TEXT_TOO_LONG%', e);

  SELECT count(*) INTO v_n FROM ops.action_log
   WHERE target_id IN (f.q1, f.q2) AND action = 'quote_request.set_vehicle_description';
  PERFORM pg_temp.check('36 log sólo de los dos cambios', v_n = 2, v_n::text);
END $$;

-- ═══ Origen ═════════════════════════════════════════════════════════════════

DO $$
DECLARE f t_fix; v_o text; v_n int; e text;
BEGIN
  SELECT * INTO f FROM t_fix;

  PERFORM ops.set_quote_request_origin(f.q3, f.actor_id, 'meta_ads');
  SELECT origin INTO v_o FROM ops.quote_request_origin WHERE quote_request_id = f.q3;
  PERFORM pg_temp.check('40 alta de origen', v_o = 'meta_ads', v_o);

  PERFORM ops.set_quote_request_origin(f.q3, f.actor_id, 'meta_ads');
  PERFORM ops.set_quote_request_origin(f.q3, f.actor_id, 'flyer');
  SELECT origin INTO v_o FROM ops.quote_request_origin WHERE quote_request_id = f.q3;
  SELECT count(*) INTO v_n FROM ops.action_log WHERE target_id = f.q3 AND action = 'quote_request.set_origin';
  PERFORM pg_temp.check('41 cambio sí, repetido no loguea', v_o = 'flyer' AND v_n = 2, v_n::text);

  PERFORM ops.set_quote_request_origin(f.q3, f.actor_id, NULL);
  SELECT count(*) INTO v_n FROM ops.quote_request_origin WHERE quote_request_id = f.q3;
  PERFORM pg_temp.check('42 NULL borra', v_n = 0, v_n::text);

  e := pg_temp.err(format('SELECT ops.set_quote_request_origin(%L, %L, %L)', f.q3, f.actor_id, 'tiktok'));
  PERFORM pg_temp.check('43 INVALID_ORIGIN', e LIKE 'INVALID_ORIGIN%', e);
  e := pg_temp.err(format('SELECT ops.set_quote_request_origin(%L, %L, %L)', gen_random_uuid(), f.actor_id, 'flyer'));
  PERFORM pg_temp.check('44 pedido inexistente', e LIKE 'QUOTE_REQUEST_NOT_FOUND%', e);
END $$;

-- ═══ Integración: el SQL exacto de quote-requests.repo.ts, sin tipos ═══════

PREPARE p036_timing AS
SELECT ops.set_quote_request_timing_and_parts(
  p_quote_request_id => $1,
  p_actor_id         => $2,
  p_timing           => $3,
  p_preferred_date   => $4,
  p_parts_supply     => $5
) AS r;

PREPARE p036_vehicle AS
SELECT ops.set_quote_request_vehicle_description(
  p_quote_request_id => $1,
  p_actor_id         => $2,
  p_vehicle_text     => $3,
  p_expected         => $4
) AS r;

PREPARE p036_origin AS
SELECT ops.set_quote_request_origin(
  p_quote_request_id => $1,
  p_actor_id         => $2,
  p_origin           => $3
) AS r;

CREATE OR REPLACE FUNCTION pg_temp.fix(p_col text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  EXECUTE format($q$SELECT %I FROM t_fix$q$, p_col) INTO v;
  RETURN v;
END $$;

CREATE TEMP TABLE t_i1 ON COMMIT DROP AS EXECUTE p036_timing(pg_temp.fix('q3'), pg_temp.fix('actor_id'), 'this_week', NULL, 'workshop');
CREATE TEMP TABLE t_i2 ON COMMIT DROP AS EXECUTE p036_vehicle(pg_temp.fix('q3'), pg_temp.fix('actor_id'), 'Fiat Cronos 1.3 2022', NULL);
CREATE TEMP TABLE t_i3 ON COMMIT DROP AS EXECUTE p036_origin(pg_temp.fix('q3'), pg_temp.fix('actor_id'), 'word_of_mouth');

DO $$
DECLARE a jsonb; b jsonb; c jsonb;
BEGIN
  SELECT r INTO a FROM t_i1;
  SELECT r INTO b FROM t_i2;
  SELECT r INTO c FROM t_i3;
  PERFORM pg_temp.check('60 integración: timing sin tipos', a->>'timing' = 'this_week', a::text);
  PERFORM pg_temp.check('61 integración: vehículo sin tipos', (b->>'changed')::boolean, b::text);
  PERFORM pg_temp.check('62 integración: origen sin tipos', c->>'origin' = 'word_of_mouth', c::text);
END $$;

DEALLOCATE p036_timing;
DEALLOCATE p036_vehicle;
DEALLOCATE p036_origin;

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
