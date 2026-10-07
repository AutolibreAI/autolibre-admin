-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 020 (AUT-120: whatsapp_message en update_partner_application).
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/020_ops_whatsapp_message.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK, mismo patrón que la 010. No repite
-- los guardrails de forma ni los casos de negocio ya cubiertos por el test de
-- la 010 (NOT NULL, fecha, actor, auditoría) — sólo lo nuevo: whatsapp_message.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS app_id,
       gen_random_uuid() AS actor_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-020-' || actor_id || '@example.invalid', 'admin',
       'clerk', 'test-020-' || actor_id
  FROM t_fix;

INSERT INTO partner_applications (
  id, business_name, whatsapp, email, address, raw_submission,
  declared_services, declared_brands, declared_fuel_types, vehicle_types,
  brand_specialized, status
)
SELECT app_id, 'Taller Original', '+54 11 0000', 'orig@example.invalid',
       'Calle Original 1', '{}'::jsonb,
       ARRAY['motor'], ARRAY['Ford'], ARRAY['Nafta'], ARRAY['Autos'],
       false, 'contacted'
  FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle);
$$;

DO $$
DECLARE
  v_app   uuid;
  v_actor uuid;
  v_row   partner_applications%ROWTYPE;
  v_msg   text;
BEGIN
  SELECT app_id, actor_id INTO v_app, v_actor FROM t_fix;

  -- 01. whatsapp_message se guarda igual que el resto de los campos nullable.
  PERFORM ops.update_partner_application(v_app, v_actor, jsonb_build_object(
    'business_name', 'Taller Original', 'email', 'orig@example.invalid',
    'whatsapp', '+54 11 0000', 'address', 'Calle Original 1',
    'whatsapp_message', 'Hola Taller Original, te contacto desde AutoLibre.'
  ));
  SELECT * INTO v_row FROM partner_applications WHERE id = v_app;
  PERFORM pg_temp.check('01 whatsapp_message se guarda',
    v_row.whatsapp_message = 'Hola Taller Original, te contacto desde AutoLibre.',
    coalesce(v_row.whatsapp_message, '(null)'));

  -- 02. '' vacía la columna, mismo criterio que service_other/how_found.
  PERFORM ops.update_partner_application(v_app, v_actor, jsonb_build_object(
    'business_name', 'Taller Original', 'email', 'orig@example.invalid',
    'whatsapp', '+54 11 0000', 'address', 'Calle Original 1',
    'whatsapp_message', ''
  ));
  SELECT * INTO v_row FROM partner_applications WHERE id = v_app;
  PERFORM pg_temp.check('02 whatsapp_message vacío → NULL',
    v_row.whatsapp_message IS NULL, coalesce(v_row.whatsapp_message, '(null)'));

  -- 03. Clave ausente también vacía (el panel manda siempre el juego completo
  -- para los campos nullable de texto, a diferencia de los 4 arrays).
  PERFORM ops.update_partner_application(v_app, v_actor, jsonb_build_object(
    'business_name', 'Taller Original', 'email', 'orig@example.invalid',
    'whatsapp', '+54 11 0000', 'address', 'Calle Original 1',
    'whatsapp_message', 'Mensaje con espacios   '
  ));
  SELECT * INTO v_row FROM partner_applications WHERE id = v_app;
  PERFORM pg_temp.check('03 btrim recorta espacios de borde',
    v_row.whatsapp_message = 'Mensaje con espacios', coalesce(v_row.whatsapp_message, '(null)'));
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
