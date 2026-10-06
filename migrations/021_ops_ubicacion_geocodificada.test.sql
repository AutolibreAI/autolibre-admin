-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 021 — coordenada geocodificada de un pedido.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/021_ops_ubicacion_geocodificada.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK. Crea su propio actor y su propio
-- pedido (`ops.create_quote_request`, 018/019). No llama a ningún geocoder:
-- la función sólo guarda lo que el panel ya geocodificó. Si la 021 no está
-- aplicada en la base, pegar su cuerpo después del BEGIN.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-021-' || actor_id || '@example.invalid', 'admin'::user_role, 'clerk'::auth_provider, 'test-021-' || actor_id
  FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;
CREATE TEMP TABLE t_qr (id uuid) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle);
$$;

SELECT pg_temp.check('01 una sola ops.set_quote_request_geocode',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ops' AND p.proname = 'set_quote_request_geocode') = 1);
SELECT pg_temp.check('02 SECURITY INVOKER + search_path fijo',
  (SELECT NOT p.prosecdef AND p.proconfig IS NOT NULL
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ops' AND p.proname = 'set_quote_request_geocode'));
SELECT pg_temp.check('03 sin FK a public',
  (SELECT count(*) = 0 FROM pg_constraint
    WHERE conrelid = 'ops.quote_request_geocode'::regclass AND contype = 'f'));
SELECT pg_temp.check('04 sin trigger (updated_at lo escribe la función)',
  (SELECT count(*) = 0 FROM pg_trigger
    WHERE tgrelid = 'ops.quote_request_geocode'::regclass AND NOT tgisinternal));

DO $$
DECLARE
  v_actor   uuid := (SELECT actor_id FROM t_fix);
  v_qr      uuid;
  v_created timestamptz;
  v_msg     text;
  v_logs    int;
BEGIN
  v_qr := (ops.create_quote_request(
    p_actor_id => v_actor, p_channel => 'whatsapp', p_contact_phone => '5491100000021',
    p_description => 'Test 021',
    p_location_address => 'Lourdes 2021', p_location_locality => 'Lanús', p_location_province => 'Buenos Aires')->>'id')::uuid;
  INSERT INTO t_qr VALUES (v_qr);

  -- 05 · alta
  PERFORM ops.set_quote_request_geocode(v_qr, v_actor, 'Lourdes 2021, Lanús, Buenos Aires, Argentina', -34.7, -58.39, true, 'nominatim');
  PERFORM pg_temp.check('05 alta',
    (SELECT count(*) = 1 AND bool_and(precise AND provider = 'nominatim' AND latitude = -34.7)
       FROM ops.quote_request_geocode WHERE quote_request_id = v_qr));
  SELECT created_at INTO v_created FROM ops.quote_request_geocode WHERE quote_request_id = v_qr;

  -- 06 · el log NO lleva coordenadas
  PERFORM pg_temp.check('06 log sin coordenadas',
    (SELECT count(*) = 1
            AND bool_and(before IS NULL AND after->>'query' LIKE 'Lourdes%'
                         AND NOT (after ? 'latitude') AND NOT (after ? 'longitude') AND actor_id = v_actor)
       FROM ops.action_log WHERE action = 'quote_request.geocode' AND target_id = v_qr));

  -- 07 · mismo query y mismo punto: no loguea de nuevo
  PERFORM ops.set_quote_request_geocode(v_qr, v_actor, 'Lourdes 2021, Lanús, Buenos Aires, Argentina', -34.7, -58.39, true, 'nominatim');
  SELECT count(*) INTO v_logs FROM ops.action_log WHERE action = 'quote_request.geocode' AND target_id = v_qr;
  PERFORM pg_temp.check('07 repetido no loguea', v_logs = 1, v_logs::text);

  -- 08 · reemplazo: misma fila (created_at intacto), datos nuevos. Adentro de
  -- una transacción `now()` es constante, así que `updated_at` no se puede
  -- comparar contra `created_at`: se mira que la fila sea la misma y cambie.
  PERFORM ops.set_quote_request_geocode(v_qr, v_actor, 'Lanús, Buenos Aires, Argentina', -34.71, -58.4, false, 'nominatim');
  PERFORM pg_temp.check('08 reemplazo: una fila, created_at intacto, datos nuevos',
    (SELECT count(*) = 1 AND bool_and(created_at = v_created AND NOT precise AND latitude = -34.71)
       FROM ops.quote_request_geocode WHERE quote_request_id = v_qr));
  -- El log se busca por contenido, no por orden: todas las entradas de la
  -- transacción tienen el mismo `created_at`.
  PERFORM pg_temp.check('09 before del reemplazo',
    EXISTS (SELECT 1 FROM ops.action_log
             WHERE action = 'quote_request.geocode' AND target_id = v_qr
               AND before->>'query' LIKE 'Lourdes%'
               AND after->>'query' = 'Lanús, Buenos Aires, Argentina'));

  -- 10 · par incompleto
  BEGIN
    PERFORM ops.set_quote_request_geocode(v_qr, v_actor, 'x', -34.7, NULL, true, 'nominatim');
    v_msg := 'no tiró';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  PERFORM pg_temp.check('10 INCOMPLETE_COORDINATES', v_msg LIKE 'INCOMPLETE_COORDINATES%', v_msg);

  -- 11 · fuera de rango
  BEGIN
    PERFORM ops.set_quote_request_geocode(v_qr, v_actor, 'x', -134.7, -58.4, true, 'nominatim');
    v_msg := 'no tiró';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  PERFORM pg_temp.check('11 COORDINATES_OUT_OF_RANGE', v_msg LIKE 'COORDINATES_OUT_OF_RANGE%', v_msg);

  -- 12 · query vacío
  BEGIN
    PERFORM ops.set_quote_request_geocode(v_qr, v_actor, '  ', -34.7, -58.4, true, 'nominatim');
    v_msg := 'no tiró';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  PERFORM pg_temp.check('12 GEOCODE_QUERY_REQUIRED', v_msg LIKE 'GEOCODE_QUERY_REQUIRED%', v_msg);

  -- 13 · proveedor fuera del catálogo
  BEGIN
    PERFORM ops.set_quote_request_geocode(v_qr, v_actor, 'x', -34.7, -58.4, true, 'mapbox');
    v_msg := 'no tiró';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  PERFORM pg_temp.check('13 INVALID_GEOCODE_PROVIDER', v_msg LIKE 'INVALID_GEOCODE_PROVIDER%', v_msg);

  -- 14 · pedido inexistente
  BEGIN
    PERFORM ops.set_quote_request_geocode(gen_random_uuid(), v_actor, 'x', -34.7, -58.4, true, 'nominatim');
    v_msg := 'no tiró';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  PERFORM pg_temp.check('14 QUOTE_REQUEST_NOT_FOUND', v_msg LIKE 'QUOTE_REQUEST_NOT_FOUND%', v_msg);

  -- 15 · actor inexistente
  BEGIN
    PERFORM ops.set_quote_request_geocode(v_qr, gen_random_uuid(), 'x', -34.7, -58.4, true, 'nominatim');
    v_msg := 'no tiró';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  PERFORM pg_temp.check('15 ACTOR_NOT_FOUND', v_msg LIKE 'ACTOR_NOT_FOUND%', v_msg);

  -- 16 · borrar con coordenadas NULL, y loguea el borrado
  PERFORM ops.set_quote_request_geocode(v_qr, v_actor, NULL, NULL, NULL);
  PERFORM pg_temp.check('16 borrado',
    NOT EXISTS (SELECT 1 FROM ops.quote_request_geocode WHERE quote_request_id = v_qr));
  PERFORM pg_temp.check('17 log del borrado',
    EXISTS (SELECT 1 FROM ops.action_log
             WHERE action = 'quote_request.geocode' AND target_id = v_qr
               AND after IS NULL AND before->>'query' = 'Lanús, Buenos Aires, Argentina'));

  -- 18 · borrar lo que no existe: no loguea
  SELECT count(*) INTO v_logs FROM ops.action_log WHERE action = 'quote_request.geocode' AND target_id = v_qr;
  PERFORM ops.set_quote_request_geocode(v_qr, v_actor, NULL, NULL, NULL);
  PERFORM pg_temp.check('18 borrar vacío no loguea',
    (SELECT count(*) FROM ops.action_log WHERE action = 'quote_request.geocode' AND target_id = v_qr) = v_logs);
END;
$$;

-- 19 · integración: el SQL exacto de `quote-geocode.repo.ts`, con PREPARE sin tipos.
-- `EXECUTE` no acepta subconsultas como argumento: los ids salen de funciones.
CREATE OR REPLACE FUNCTION pg_temp.fix_qr() RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM t_qr $$;
CREATE OR REPLACE FUNCTION pg_temp.fix_actor() RETURNS uuid LANGUAGE sql AS $$ SELECT actor_id FROM t_fix $$;

PREPARE p021_set AS
  SELECT ops.set_quote_request_geocode(
    p_quote_request_id => $1,
    p_actor_id         => $2,
    p_query            => $3,
    p_latitude         => $4,
    p_longitude        => $5,
    p_precise          => $6,
    p_provider         => $7
  ) AS g;

CREATE TEMP TABLE t_p021 ON COMMIT DROP AS
EXECUTE p021_set(
  pg_temp.fix_qr(),
  pg_temp.fix_actor(),
  'Lanús, Buenos Aires, Argentina', '-34.7', '-58.39', 'false', 'google');
SELECT pg_temp.check('19 integración con PREPARE sin tipos',
  (SELECT g->>'provider' = 'google' FROM t_p021));
DEALLOCATE p021_set;

SELECT caso, ok, detalle FROM t_result ORDER BY caso;
SELECT count(*) FILTER (WHERE ok) AS ok, count(*) AS total FROM t_result;

ROLLBACK;
