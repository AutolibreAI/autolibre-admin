-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 019 — cargar un pedido a mano con la zona.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/019_ops_crear_pedido_con_zona.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea su propio actor. Necesita
-- `quote_requests` y la 018 aplicada. Sólo prueba lo que la 019 agrega (la
-- zona) más que la firma quedó UNA sola; el resto del alta lo cubre la suite
-- de la 018, que sigue resolviendo porque los parámetros nuevos van al final.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS SELECT gen_random_uuid() AS actor_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-019-' || actor_id || '@example.invalid', 'admin'::user_role, 'clerk'::auth_provider, 'test-019-' || actor_id
  FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle);
$$;

-- 01 · una sola firma (trampa de la 009)
SELECT pg_temp.check('01 una sola ops.create_quote_request',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ops' AND p.proname = 'create_quote_request') = 1);

DO $$
DECLARE
  v_actor  uuid := (SELECT actor_id FROM t_fix);
  v_res    jsonb;
  v_id     uuid;
  v_msg    text;
BEGIN
  -- 02 · con zona completa: queda `typed`, sin coordenadas
  v_res := ops.create_quote_request(
    p_actor_id => v_actor, p_channel => 'whatsapp', p_contact_phone => '5491100000019',
    p_description => 'Test 019', p_location_address => '  Av. Cabildo 2000  ',
    p_location_locality => 'CABA', p_location_province => 'Buenos Aires');
  v_id := (v_res->>'id')::uuid;
  PERFORM pg_temp.check('02 zona tipeada guardada',
    (SELECT location_source::text = 'typed' AND location_address = 'Av. Cabildo 2000'
        AND location_locality = 'CABA' AND location_province = 'Buenos Aires'
        AND location_latitude IS NULL AND location_longitude IS NULL
       FROM quote_requests WHERE id = v_id));

  -- 03 · sin zona: todo NULL, y sin source (chk_quote_requests_location_requires_source)
  v_res := ops.create_quote_request(
    p_actor_id => v_actor, p_channel => 'whatsapp', p_contact_phone => '5491100000019',
    p_description => 'Test 019 sin zona');
  PERFORM pg_temp.check('03 sin zona queda vacío',
    (SELECT location_source IS NULL AND location_address IS NULL
       FROM quote_requests WHERE id = (v_res->>'id')::uuid));

  -- 04 · sólo la dirección, sin localidad ni provincia: vale
  v_res := ops.create_quote_request(
    p_actor_id => v_actor, p_channel => 'whatsapp', p_contact_phone => '5491100000019',
    p_description => 'Test 019 sólo zona', p_location_address => 'Zona Norte');
  PERFORM pg_temp.check('04 sólo dirección vale',
    (SELECT location_source::text = 'typed' AND location_locality IS NULL
       FROM quote_requests WHERE id = (v_res->>'id')::uuid));

  -- 05 · localidad sin dirección: rechazado con sentinela
  BEGIN
    PERFORM ops.create_quote_request(
      p_actor_id => v_actor, p_channel => 'whatsapp', p_contact_phone => '5491100000019',
      p_description => 'Test 019', p_location_locality => 'Tigre');
    PERFORM pg_temp.check('05 localidad sin dirección se rechaza', false, 'no falló');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('05 localidad sin dirección se rechaza', v_msg = 'LOCATION_ADDRESS_REQUIRED', v_msg);
  END;

  -- 06 · dirección de más de 300 caracteres
  BEGIN
    PERFORM ops.create_quote_request(
      p_actor_id => v_actor, p_channel => 'whatsapp', p_contact_phone => '5491100000019',
      p_description => 'Test 019', p_location_address => repeat('x', 301));
    PERFORM pg_temp.check('06 dirección larga se rechaza', false, 'no falló');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('06 dirección larga se rechaza', v_msg = 'LOCATION_ADDRESS_TOO_LONG', v_msg);
  END;

  -- 07 · la llamada de la 018 (sin zona, con p_note) sigue resolviendo
  v_res := ops.create_quote_request(
    p_actor_id => v_actor, p_channel => 'whatsapp', p_contact_phone => '5491100000019',
    p_description => 'Test 019 firma vieja', p_note => 'nota');
  PERFORM pg_temp.check('07 llamada de la 018 sigue andando', (v_res->>'id') IS NOT NULL);
END $$;

SELECT caso, CASE WHEN ok THEN 'OK' ELSE 'FALLA' END AS resultado, detalle FROM t_result ORDER BY caso;
SELECT count(*) FILTER (WHERE ok) AS ok, count(*) FILTER (WHERE NOT ok) AS falla FROM t_result;

ROLLBACK;
