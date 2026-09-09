-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 010.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/010_ops_editar_solicitud.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea su propia solicitud y su propio
-- actor. Mismo patrón que la 007/008/009.
--
-- `now()` es constante dentro de la transacción, así que el guardrail de
-- `updated_at` se verifica sobre el CUERPO de la función (caso 20), no
-- comparando timestamps.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS app_id,
       gen_random_uuid() AS actor_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-010-' || actor_id || '@example.invalid', 'admin',
       'clerk', 'test-010-' || actor_id
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

-- ═══════════════════════════════════════════════════════════════════════════
-- Guardrails de forma
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'update_partner_application';
  PERFORM pg_temp.check('01 existe UNA sola update_partner_application', v_n = 1, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'update_partner_application' AND p.prosecdef;
  PERFORM pg_temp.check('02 SECURITY INVOKER, no DEFINER', v_n = 0, v_n::text);

  PERFORM pg_temp.check('03 search_path fijo (guardrail 3)',
    EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'ops' AND p.proname = 'update_partner_application'
         AND array_to_string(p.proconfig, ' ') LIKE 'search_path=%'
    ),
    (SELECT array_to_string(proconfig, ' ') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'ops' AND p.proname = 'update_partner_application'));
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Comportamiento
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_app   uuid;
  v_actor uuid;
  v_row   partner_applications%ROWTYPE;
  v_log   ops.action_log%ROWTYPE;
  v_msg   text;
  v_full  jsonb;
BEGIN
  SELECT app_id, actor_id INTO v_app, v_actor FROM t_fix;

  -- El patch "completo" que manda el formulario del panel.
  v_full := jsonb_build_object(
    'business_name', 'Taller Nuevo',
    'email', 'nuevo@example.invalid',
    'whatsapp', '+54 11 9999',
    'address', 'Av. Nueva 2000',
    'brand_specialized', true,
    'contact_channel', 'whatsapp',
    'how_found', 'Google',
    'how_found_other', '',
    'service_other', 'Tapizados',
    'next_step', 'Llamar el lunes',
    'follow_up_date', '2026-10-01',
    'agreement_type', '',
    'agreement_detail', '',
    'internal_notes', 'Prometedor',
    'review_note', '',
    'declared_services', jsonb_build_array('frenos', '  embrague  ', ''),
    'declared_brands', jsonb_build_array('Toyota', 'VW'),
    'declared_fuel_types', jsonb_build_array('Diesel'),
    'vehicle_types', jsonb_build_array('Pickups', 'SUVs')
  );

  PERFORM ops.update_partner_application(v_app, v_actor, v_full);
  SELECT * INTO v_row FROM partner_applications WHERE id = v_app;

  PERFORM pg_temp.check('04 business_name',   v_row.business_name = 'Taller Nuevo', v_row.business_name);
  PERFORM pg_temp.check('05 email',           v_row.email = 'nuevo@example.invalid', v_row.email);
  PERFORM pg_temp.check('06 whatsapp',        v_row.whatsapp = '+54 11 9999', v_row.whatsapp);
  PERFORM pg_temp.check('07 address',         v_row.address = 'Av. Nueva 2000', v_row.address);
  PERFORM pg_temp.check('08 brand_specialized', v_row.brand_specialized = true, v_row.brand_specialized::text);
  PERFORM pg_temp.check('09 contact_channel', v_row.contact_channel = 'whatsapp', coalesce(v_row.contact_channel, '(null)'));
  PERFORM pg_temp.check('10 service_other',   v_row.service_other = 'Tapizados', coalesce(v_row.service_other, '(null)'));
  PERFORM pg_temp.check('11 next_step',       v_row.next_step = 'Llamar el lunes', coalesce(v_row.next_step, '(null)'));
  PERFORM pg_temp.check('12 follow_up_date',  v_row.follow_up_date = DATE '2026-10-01', v_row.follow_up_date::text);
  PERFORM pg_temp.check('13 nullable vacío → NULL', v_row.how_found_other IS NULL AND v_row.review_note IS NULL,
                        coalesce(v_row.how_found_other, '(null)') || ' / ' || coalesce(v_row.review_note, '(null)'));

  -- 14. Arrays: se guardan, y el elemento vacío / con espacios se normaliza.
  PERFORM pg_temp.check('14 declared_services normalizado',
    v_row.declared_services = ARRAY['frenos', 'embrague'],
    array_to_string(v_row.declared_services, ','));
  PERFORM pg_temp.check('15 declared_brands', v_row.declared_brands = ARRAY['Toyota', 'VW'],
    array_to_string(v_row.declared_brands, ','));
  PERFORM pg_temp.check('16 vehicle_types', v_row.vehicle_types = ARRAY['Pickups', 'SUVs'],
    array_to_string(v_row.vehicle_types, ','));

  -- 17. Una clave de array AUSENTE deja la columna como estaba.
  PERFORM ops.update_partner_application(v_app, v_actor, jsonb_build_object(
    'business_name', 'x', 'email', 'x@x.invalid', 'whatsapp', 'x', 'address', 'x'
  ));
  SELECT * INTO v_row FROM partner_applications WHERE id = v_app;
  PERFORM pg_temp.check('17 array ausente no se vacía',
    v_row.declared_services = ARRAY['frenos', 'embrague'],
    array_to_string(v_row.declared_services, ','));

  -- 18. Un array [] vacío SÍ vacía la columna (edición legítima).
  PERFORM ops.update_partner_application(v_app, v_actor, jsonb_build_object(
    'business_name', 'x', 'email', 'x@x.invalid', 'whatsapp', 'x', 'address', 'x',
    'declared_brands', '[]'::jsonb
  ));
  SELECT * INTO v_row FROM partner_applications WHERE id = v_app;
  PERFORM pg_temp.check('18 array [] vacía la columna',
    v_row.declared_brands = '{}'::text[], array_to_string(v_row.declared_brands, ','));

  -- 19-22. Los cuatro NOT NULL vacíos rechazan con su sentinela.
  BEGIN
    PERFORM ops.update_partner_application(v_app, v_actor, jsonb_build_object(
      'business_name', '   ', 'email', 'x@x.invalid', 'whatsapp', 'x', 'address', 'x'));
    PERFORM pg_temp.check('19 business_name vacío rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('19 business_name vacío rechazado', v_msg LIKE 'BUSINESS_NAME_REQUIRED%', v_msg);
  END;
  BEGIN
    PERFORM ops.update_partner_application(v_app, v_actor, jsonb_build_object(
      'business_name', 'x', 'email', '', 'whatsapp', 'x', 'address', 'x'));
    PERFORM pg_temp.check('20 email vacío rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('20 email vacío rechazado', v_msg LIKE 'EMAIL_REQUIRED%', v_msg);
  END;

  -- 23. Fecha inválida → sentinela.
  BEGIN
    PERFORM ops.update_partner_application(v_app, v_actor, jsonb_build_object(
      'business_name', 'x', 'email', 'x@x.invalid', 'whatsapp', 'x', 'address', 'x',
      'follow_up_date', '31/12/2026'));
    PERFORM pg_temp.check('23 fecha inválida rechazada', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('23 fecha inválida rechazada', v_msg LIKE 'INVALID_FOLLOW_UP_DATE%', v_msg);
  END;

  -- 24. Fecha vacía → NULL.
  PERFORM ops.update_partner_application(v_app, v_actor, jsonb_build_object(
    'business_name', 'x', 'email', 'x@x.invalid', 'whatsapp', 'x', 'address', 'x',
    'follow_up_date', ''));
  SELECT * INTO v_row FROM partner_applications WHERE id = v_app;
  PERFORM pg_temp.check('24 fecha vacía → NULL', v_row.follow_up_date IS NULL,
                        coalesce(v_row.follow_up_date::text, '(null)'));

  -- 25-27. Actor y solicitud.
  BEGIN
    PERFORM ops.update_partner_application(gen_random_uuid(), v_actor, jsonb_build_object(
      'business_name', 'x', 'email', 'x@x.invalid', 'whatsapp', 'x', 'address', 'x'));
    PERFORM pg_temp.check('25 solicitud inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('25 solicitud inexistente', v_msg LIKE 'APPLICATION_NOT_FOUND%', v_msg);
  END;
  BEGIN
    PERFORM ops.update_partner_application(v_app, gen_random_uuid(), jsonb_build_object(
      'business_name', 'x', 'email', 'x@x.invalid', 'whatsapp', 'x', 'address', 'x'));
    PERFORM pg_temp.check('26 actor inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('26 actor inexistente', v_msg LIKE 'ACTOR_NOT_FOUND%', v_msg);
  END;
  BEGIN
    PERFORM ops.update_partner_application(v_app, NULL, jsonb_build_object(
      'business_name', 'x', 'email', 'x@x.invalid', 'whatsapp', 'x', 'address', 'x'));
    PERFORM pg_temp.check('27 actor NULL', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('27 actor NULL', v_msg LIKE 'ACTOR_REQUIRED%', v_msg);
  END;

  -- 28-31. Auditoría: la PRIMERA llamada quedó en el log con before/after.
  -- Se filtra por el before de esa llamada — es la única con 'Taller Original',
  -- porque `now()` es constante y un ORDER BY por tiempo no desempata.
  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_app AND action = 'application.edit'
     AND before->>'business_name' = 'Taller Original'
   LIMIT 1;
  PERFORM pg_temp.check('28 log: nombre viejo en before',
    v_log.before->>'business_name' = 'Taller Original', coalesce(v_log.before->>'business_name', '(null)'));
  PERFORM pg_temp.check('29 log: nombre nuevo en after',
    v_log.after->>'business_name' = 'Taller Nuevo', coalesce(v_log.after->>'business_name', '(null)'));
  PERFORM pg_temp.check('30 log: actor de la sesión', v_log.actor_id = v_actor, v_log.actor_id::text);
  PERFORM pg_temp.check('31 log: target_table', v_log.target_table = 'public.partner_applications', v_log.target_table);

  -- 32. Guardrail 8: el SP no escribe updated_at a mano.
  PERFORM pg_temp.check('32 el SP no escribe updated_at a mano',
    pg_get_functiondef('ops.update_partner_application(uuid,uuid,jsonb,text)'::regprocedure)
      !~* 'updated_at[[:space:]]*=',
    'lo pone trg_partner_applications_updated_at');
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL EXACTO que manda `partners.repo.ts`.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_app   uuid;
  v_actor uuid;
  v_out   jsonb;
BEGIN
  SELECT app_id, actor_id INTO v_app, v_actor FROM t_fix;

  SELECT ops.update_partner_application(
    v_app,
    v_actor,
    jsonb_build_object(
      'business_name', 'Desde el repo', 'email', 'repo@example.invalid',
      'whatsapp', '+54 11 1', 'address', 'Repo 1', 'brand_specialized', false,
      'contact_channel', '', 'how_found', '', 'how_found_other', '',
      'service_other', '', 'next_step', '', 'agreement_type', '',
      'agreement_detail', '', 'internal_notes', '', 'review_note', '',
      'follow_up_date', '',
      'declared_services', '[]'::jsonb, 'declared_brands', '[]'::jsonb,
      'declared_fuel_types', '[]'::jsonb, 'vehicle_types', '[]'::jsonb
    ),
    NULL
  ) INTO v_out;

  PERFORM pg_temp.check('33 integración: devuelve la fila nueva',
    v_out->>'business_name' = 'Desde el repo' AND v_out->>'email' = 'repo@example.invalid',
    v_out::text);
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
