-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 030.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/030_ops_comercial_ficha_y_charlas.test.sql
--
-- BEGIN … ROLLBACK, con su propio actor, comercial y partner — mismo patrón
-- que la 024. Re-verifica las validaciones de la 024 que la 030 reescribió
-- (`_normalize_partner_prospect` se reemplazó entera).
--
-- El MAPEO de estados viejos y el backfill de la etiqueta corren al aplicar
-- la migración, sobre filas que ya existían: no se pueden probar desde acá.
-- Los prueba el runner de PGlite insertando filas viejas ANTES de aplicarla
-- (ver `.claude/rules/partner-prospects.md`, "Cómo se verificó").
--
-- Los casos con pedido usan un `quote_requests` que ya exista; en una base
-- sin pedidos se saltean y lo dicen.
--
-- La integración (casos 90+) copia LITERAL el SQL de
-- `src/server/partner-prospects.repo.ts`, con `PREPARE` sin tipos.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS partner_id,
       gen_random_uuid() AS partner2_id,
       (SELECT id FROM quote_requests ORDER BY created_at LIMIT 1) AS quote_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-030-' || actor_id || '@example.invalid', 'admin'::user_role,
       'clerk', 'test-030-' || actor_id
  FROM t_fix;

-- Creado a las 01:00 UTC del 5/11: en Buenos Aires todavía es el 4/11.
INSERT INTO partners (id, name, coverage_zone, status, whatsapp, created_at)
SELECT partner_id, 'Taller de prueba 030', 'Zona Sur', 'active'::partner_status, '11 4000 0030',
       '2026-11-05T01:00:00Z'::timestamptz
  FROM t_fix
UNION ALL
SELECT partner2_id, 'Otro taller 030', 'Zona Sur', 'active'::partner_status, NULL, '2026-10-10T15:00:00Z'::timestamptz
  FROM t_fix;

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

-- Un contacto nuevo para cada bloque.
CREATE OR REPLACE FUNCTION pg_temp.new_prospect(p_name text, p_extra jsonb DEFAULT '{}')
RETURNS uuid LANGUAGE sql AS $$
  SELECT (ops.create_partner_prospect(
    (SELECT actor_id FROM t_fix),
    jsonb_build_object('name', p_name, 'origin_slug', 'otro') || p_extra
  )->>'id')::uuid;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Guardrails de forma
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fn text;
  v_n  int;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['add_partner_prospect_interaction', 'update_partner_prospect',
                              'create_partner_prospect', '_normalize_partner_prospect'] LOOP
    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = v_fn;
    PERFORM pg_temp.check('01 ' || v_fn || ': existe UNA sola firma', v_n = 1, v_n::text);

    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = v_fn AND p.prosecdef;
    PERFORM pg_temp.check('02 ' || v_fn || ': SECURITY INVOKER', v_n = 0, v_n::text);

    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = v_fn
       AND array_to_string(p.proconfig, ',') LIKE 'search_path=%';
    PERFORM pg_temp.check('03 ' || v_fn || ': search_path fijo', v_n = 1, v_n::text);
  END LOOP;

  -- Las charlas son append-only: ninguna función las edita ni las borra.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname LIKE '%prospect_interaction%' AND p.proname <> 'add_partner_prospect_interaction';
  PERFORM pg_temp.check('04 charlas: sólo existe el alta', v_n = 0, v_n::text);

  -- La única FK de la tabla de charlas es al contacto (ops → ops).
  SELECT count(*) INTO v_n
    FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.conrelid = 'ops.partner_prospect_interaction'::regclass
     AND c.confrelid <> 'ops.partner_prospect'::regclass;
  PERFORM pg_temp.check('05 charlas: sin FK a public (guardrail 6)', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'ops.partner_prospect_interaction'::regclass AND NOT tgisinternal;
  PERFORM pg_temp.check('06 charlas: sin trigger', v_n = 0, v_n::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- La ficha
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  f   t_fix%ROWTYPE;
  v_r jsonb;
  v_id uuid;
BEGIN
  SELECT * INTO f FROM t_fix;

  v_r := ops.create_partner_prospect(f.actor_id, '{"name":"Ficha 030","origin_slug":"otro"}');
  PERFORM pg_temp.check('10 alta: estado inicial to_contact', v_r->>'status' = 'to_contact', v_r->>'status');
  PERFORM pg_temp.check('11 alta: checks de verificación en false',
    (v_r->>'verify_test_response')::boolean = false AND (v_r->>'verify_identity')::boolean = false
    AND (v_r->>'verify_payment')::boolean = false AND (v_r->>'verify_reputation')::boolean = false, v_r::text);
  PERFORM pg_temp.check('12 alta: lo que no se sabe es NULL',
    v_r->'knew_autolibre' = 'null'::jsonb AND v_r->'has_capacity' = 'null'::jsonb
    AND v_r->'front' = 'null'::jsonb, v_r::text);
  v_id := (v_r->>'id')::uuid;

  v_r := ops.update_partner_prospect(v_id, f.actor_id, jsonb_build_object(
    'front', 'ruta-2', 'knew_autolibre', true, 'has_capacity', false,
    'client_acquisition', '  boca en boca  ', 'preferred_channel', 'whatsapp',
    'management_system', 'Excel', 'network', '', 'verify_identity', true,
    'verify_payment', NULL, 'next_step', 'Mandar info'));
  PERFORM pg_temp.check('13 ficha: frente y datos del proveedor',
    v_r->>'front' = 'ruta-2' AND (v_r->>'knew_autolibre')::boolean AND NOT (v_r->>'has_capacity')::boolean
    AND v_r->>'client_acquisition' = 'boca en boca' AND v_r->>'preferred_channel' = 'whatsapp'
    AND v_r->>'management_system' = 'Excel' AND v_r->'network' = 'null'::jsonb, v_r::text);
  PERFORM pg_temp.check('14 ficha: un check null queda en false',
    (v_r->>'verify_identity')::boolean AND NOT (v_r->>'verify_payment')::boolean, v_r::text);
  PERFORM pg_temp.check('15 ficha: próximo paso', v_r->>'next_step' = 'Mandar info', v_r->>'next_step');

  v_r := ops.update_partner_prospect(v_id, f.actor_id, '{"knew_autolibre":null}');
  PERFORM pg_temp.check('16 ficha: un sí/no vuelve a "no se sabe"', v_r->'knew_autolibre' = 'null'::jsonb, v_r::text);

  -- Descarte.
  v_r := ops.update_partner_prospect(v_id, f.actor_id, '{"status":"discarded","discard_reason":"Ya tiene clientes"}');
  PERFORM pg_temp.check('17 descartado con motivo',
    v_r->>'status' = 'discarded' AND v_r->>'discard_reason' = 'Ya tiene clientes', v_r::text);
  v_r := ops.update_partner_prospect(v_id, f.actor_id, '{"status":"contacted"}');
  PERFORM pg_temp.check('18 salir de descartado limpia el motivo',
    v_r->>'status' = 'contacted' AND v_r->'discard_reason' = 'null'::jsonb, v_r::text);
  v_r := ops.update_partner_prospect(v_id, f.actor_id, '{"discard_reason":"no va"}');
  PERFORM pg_temp.check('19 un motivo sin descartar no queda', v_r->'discard_reason' = 'null'::jsonb, v_r::text);
END $$;

SELECT pg_temp.expect_error('20 descartar sin motivo',
  format($q$SELECT ops.update_partner_prospect(%L, %L, '{"status":"discarded"}')$q$,
         pg_temp.new_prospect('Sin motivo 030'), (SELECT actor_id FROM t_fix)),
  'DISCARD_REASON_REQUIRED');
SELECT pg_temp.expect_error('21 descartar con motivo en blanco',
  format($q$SELECT ops.update_partner_prospect(%L, %L, '{"status":"discarded","discard_reason":"  "}')$q$,
         pg_temp.new_prospect('Motivo blanco 030'), (SELECT actor_id FROM t_fix)),
  'DISCARD_REASON_REQUIRED');
SELECT pg_temp.expect_error('22 frente inválido',
  format($q$SELECT ops.update_partner_prospect(%L, %L, '{"front":"ruta-3"}')$q$,
         pg_temp.new_prospect('Frente malo 030'), (SELECT actor_id FROM t_fix)),
  'INVALID_FRONT');
SELECT pg_temp.expect_error('23 canal preferido inválido',
  format($q$SELECT ops.update_partner_prospect(%L, %L, '{"preferred_channel":"mail"}')$q$,
         pg_temp.new_prospect('Canal malo 030'), (SELECT actor_id FROM t_fix)),
  'INVALID_PREFERRED_CHANNEL');
SELECT pg_temp.expect_error('24 un sí/no que no es booleano',
  format($q$SELECT ops.update_partner_prospect(%L, %L, '{"has_capacity":"si"}')$q$,
         pg_temp.new_prospect('Bool malo 030'), (SELECT actor_id FROM t_fix)),
  'INVALID_BOOLEAN');
SELECT pg_temp.expect_error('25 estado viejo de la 024 ya no vale',
  format($q$SELECT ops.update_partner_prospect(%L, %L, '{"status":"pending"}')$q$,
         pg_temp.new_prospect('Estado viejo 030'), (SELECT actor_id FROM t_fix)),
  'INVALID_PROSPECT_STATUS');
SELECT pg_temp.expect_error('26 pedido inexistente',
  format($q$SELECT ops.update_partner_prospect(%L, %L, %L)$q$,
         pg_temp.new_prospect('Pedido malo 030'), (SELECT actor_id FROM t_fix),
         jsonb_build_object('front', 'por-pedido', 'front_quote_request_id', gen_random_uuid())),
  'QUOTE_REQUEST_NOT_FOUND');

-- Frente por pedido.
DO $$
DECLARE
  f   t_fix%ROWTYPE;
  v_r jsonb;
  v_id uuid;
BEGIN
  SELECT * INTO f FROM t_fix;
  IF f.quote_id IS NULL THEN
    PERFORM pg_temp.check('27 por pedido: salteado (no hay pedidos en esta base)', true);
    PERFORM pg_temp.check('28 por pedido: salteado (no hay pedidos en esta base)', true);
    RETURN;
  END IF;
  v_id := pg_temp.new_prospect('Por pedido 030');
  v_r := ops.update_partner_prospect(v_id, f.actor_id,
    jsonb_build_object('front', 'por-pedido', 'front_quote_request_id', f.quote_id));
  PERFORM pg_temp.check('27 por pedido: guarda el pedido',
    (v_r->>'front_quote_request_id')::uuid = f.quote_id, v_r::text);
  v_r := ops.update_partner_prospect(v_id, f.actor_id, '{"front":"corredor-norte"}');
  PERFORM pg_temp.check('28 otro frente suelta el pedido',
    v_r->>'front' = 'corredor-norte' AND v_r->'front_quote_request_id' = 'null'::jsonb, v_r::text);
END $$;

-- La fecha de alta sigue al vínculo.
DO $$
DECLARE
  f   t_fix%ROWTYPE;
  v_r jsonb;
  v_id uuid;
BEGIN
  SELECT * INTO f FROM t_fix;
  v_id := pg_temp.new_prospect('Alta 030');
  v_r := ops.update_partner_prospect(v_id, f.actor_id, jsonb_build_object('partner_id', f.partner_id, 'status', 'registered'));
  PERFORM pg_temp.check('30 vincular fija la fecha de alta en hora de Buenos Aires',
    v_r->>'partner_registered_on' = '2026-11-04', v_r->>'partner_registered_on');
  v_r := ops.update_partner_prospect(v_id, f.actor_id, '{"partner_registered_on":"2026-11-02"}');
  PERFORM pg_temp.check('31 la fecha de alta se corrige a mano',
    v_r->>'partner_registered_on' = '2026-11-02', v_r->>'partner_registered_on');
  v_r := ops.update_partner_prospect(v_id, f.actor_id, '{"notes":"nada que ver"}');
  PERFORM pg_temp.check('32 otro cambio no la pisa',
    v_r->>'partner_registered_on' = '2026-11-02', v_r->>'partner_registered_on');
  v_r := ops.update_partner_prospect(v_id, f.actor_id, jsonb_build_object('partner_id', f.partner2_id));
  PERFORM pg_temp.check('33 cambiar de proveedor toma la del nuevo',
    v_r->>'partner_registered_on' = '2026-10-10', v_r->>'partner_registered_on');
  v_r := ops.update_partner_prospect(v_id, f.actor_id, '{"partner_id":null}');
  PERFORM pg_temp.check('34 desvincular borra la fecha de alta', v_r->'partner_registered_on' = 'null'::jsonb, v_r::text);
  v_r := ops.update_partner_prospect(v_id, f.actor_id, '{"partner_registered_on":"2026-11-01"}');
  PERFORM pg_temp.check('35 sin proveedor no hay fecha de alta', v_r->'partner_registered_on' = 'null'::jsonb, v_r::text);
END $$;

-- Re-verificación de la 024 (la normalización se reescribió entera).
SELECT pg_temp.expect_error('40 024: nombre vacío',
  format($q$SELECT ops.create_partner_prospect(%L, '{"name":"  ","origin_slug":"otro"}')$q$, (SELECT actor_id FROM t_fix)),
  'NAME_REQUIRED');
SELECT pg_temp.expect_error('41 024: clave desconocida',
  format($q$SELECT ops.create_partner_prospect(%L, '{"name":"X","origin_slug":"otro","frente":"ruta-2"}')$q$, (SELECT actor_id FROM t_fix)),
  'UNKNOWN_FIELD');
SELECT pg_temp.expect_error('42 024: origen inválido',
  format($q$SELECT ops.create_partner_prospect(%L, '{"name":"X","origin_slug":"nada"}')$q$, (SELECT actor_id FROM t_fix)),
  'INVALID_ORIGIN');
SELECT pg_temp.expect_error('43 024: rubro inválido',
  format($q$SELECT ops.create_partner_prospect(%L, '{"name":"X","origin_slug":"otro","category_slugs":["no-existe"]}')$q$, (SELECT actor_id FROM t_fix)),
  'INVALID_CATEGORY_SLUG');
SELECT pg_temp.expect_error('44 024: plan inválido',
  format($q$SELECT ops.create_partner_prospect(%L, '{"name":"X","origin_slug":"otro","plan":"gold"}')$q$, (SELECT actor_id FROM t_fix)),
  'INVALID_PLAN');
SELECT pg_temp.expect_error('45 024: fecha inválida',
  format($q$SELECT ops.create_partner_prospect(%L, '{"name":"X","origin_slug":"otro","next_follow_up_on":"31/10"}')$q$, (SELECT actor_id FROM t_fix)),
  'INVALID_DATE');
SELECT pg_temp.expect_error('46 024: partner inexistente',
  format($q$SELECT ops.create_partner_prospect(%L, %L)$q$, (SELECT actor_id FROM t_fix),
         jsonb_build_object('name', 'X', 'origin_slug', 'otro', 'partner_id', gen_random_uuid())),
  'PARTNER_NOT_FOUND');

DO $$
DECLARE
  f   t_fix%ROWTYPE;
  v_r jsonb;
  v_n int;
BEGIN
  SELECT * INTO f FROM t_fix;
  v_r := ops.create_partner_prospect(f.actor_id, '{"name":"Teléfono 030","phone":"11 4999 0030","origin_slug":"otro"}');
  PERFORM pg_temp.check('47 024: teléfono normalizado', v_r->>'phone_digits' = '5491149990030', v_r::text);
  BEGIN
    PERFORM ops.create_partner_prospect(f.actor_id, '{"name":"Dup 030","phone":"+54 9 11 4999 0030","origin_slug":"otro"}');
    PERFORM pg_temp.check('48 024: duplicado por teléfono', false, 'no tiró error');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('48 024: duplicado por teléfono', SQLERRM LIKE 'DUPLICATE_PHONE%', SQLERRM);
  END;
  -- Un autoguardado sin cambios no loguea.
  PERFORM ops.update_partner_prospect((v_r->>'id')::uuid, f.actor_id, '{"name":"Teléfono 030"}');
  SELECT count(*) INTO v_n FROM ops.action_log
   WHERE target_id = (v_r->>'id')::uuid AND action = 'partner_prospect.update';
  PERFORM pg_temp.check('49 024: guardar sin cambios no loguea', v_n = 0, v_n::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Las charlas
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  f    t_fix%ROWTYPE;
  v_id uuid;
  v_r  jsonb;
  v_n  int;
  v_l  ops.action_log%ROWTYPE;
BEGIN
  SELECT * INTO f FROM t_fix;
  v_id := pg_temp.new_prospect('Charlas 030');

  v_r := ops.add_partner_prospect_interaction(v_id, f.actor_id, jsonb_build_object(
    'channel', 'call', 'answered', true, 'talked_to_decider', false,
    'told_how_orders', true, 'told_asistir24', true,
    'offered_model', 'fee_per_job', 'offered_amount', ' 8% del trabajo ',
    'reaction', 'positive', 'questions_answers', '"¿Cuánto cobran?" — le dije 8%.',
    'objection', 'price', 'jobs_per_month_to_pay', '4', 'pitch_notes', 'arrancar por Asistir',
    'status_after', 'interested', 'next_step', 'Mandar el link de alta',
    'next_follow_up_on', '2026-11-20'));
  PERFORM pg_temp.check('50 charla: se guarda con sus campos',
    v_r->'interaction'->>'channel' = 'call' AND (v_r->'interaction'->>'answered')::boolean
    AND NOT (v_r->'interaction'->>'talked_to_decider')::boolean
    AND (v_r->'interaction'->>'told_how_orders')::boolean AND NOT (v_r->'interaction'->>'told_profile')::boolean
    AND v_r->'interaction'->>'offered_amount' = '8% del trabajo'
    AND (v_r->'interaction'->>'jobs_per_month_to_pay')::int = 4
    AND (v_r->'interaction'->>'actor_id')::uuid = f.actor_id, v_r->>'interaction');
  PERFORM pg_temp.check('51 charla: mueve el contacto (estado, paso, seguimiento)',
    v_r->'prospect'->>'status' = 'interested' AND v_r->'prospect'->>'next_step' = 'Mandar el link de alta'
    AND v_r->'prospect'->>'next_follow_up_on' = '2026-11-20', v_r->>'prospect');
  PERFORM pg_temp.check('52 charla: último contacto = hoy en Buenos Aires',
    v_r->'prospect'->>'last_contact_on' = ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)::text,
    v_r->'prospect'->>'last_contact_on');

  SELECT * INTO v_l FROM ops.action_log
   WHERE target_id = (v_r->'interaction'->>'id')::uuid AND action = 'partner_prospect_interaction.create';
  PERFORM pg_temp.check('53 log de la charla, con el actor',
    v_l.actor_id = f.actor_id AND v_l.before IS NULL AND v_l.after->>'channel' = 'call', v_l::text);
  SELECT count(*) INTO v_n FROM ops.action_log
   WHERE target_id = v_id AND action = 'partner_prospect.update';
  PERFORM pg_temp.check('54 el cambio del contacto tiene su propio log', v_n = 1, v_n::text);

  -- Una charla de la semana pasada: entra al historial, no pisa nada.
  v_r := ops.add_partner_prospect_interaction(v_id, f.actor_id, jsonb_build_object(
    'channel', 'whatsapp', 'occurred_at', (now() - interval '7 days')::text,
    'status_after', 'contacted', 'next_step', 'Esperar respuesta'));
  PERFORM pg_temp.check('55 una charla vieja no pisa el estado ni el paso',
    v_r->'prospect'->>'status' = 'interested' AND v_r->'prospect'->>'next_step' = 'Mandar el link de alta',
    v_r->>'prospect');
  PERFORM pg_temp.check('56 una charla vieja no hace retroceder el último contacto',
    v_r->'prospect'->>'last_contact_on' = ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)::text,
    v_r->'prospect'->>'last_contact_on');
  SELECT count(*) INTO v_n FROM ops.partner_prospect_interaction WHERE prospect_id = v_id;
  PERFORM pg_temp.check('57 el historial tiene las dos', v_n = 2, v_n::text);

  -- Descartar desde una charla, y la objeción "otra".
  v_r := ops.add_partner_prospect_interaction(v_id, f.actor_id, jsonb_build_object(
    'channel', 'visit', 'status_after', 'discarded', 'discard_reason', 'Cerró el taller',
    'objection', 'other', 'objection_other', 'Se jubila', 'next_step', 'Nada'));
  PERFORM pg_temp.check('58 charla que descarta: motivo en el contacto',
    v_r->'prospect'->>'status' = 'discarded' AND v_r->'prospect'->>'discard_reason' = 'Cerró el taller'
    AND v_r->'prospect'->'next_follow_up_on' = 'null'::jsonb, v_r->>'prospect');
  PERFORM pg_temp.check('59 objeción "otra" con su texto',
    v_r->'interaction'->>'objection_other' = 'Se jubila', v_r->>'interaction');

  v_r := ops.add_partner_prospect_interaction(v_id, f.actor_id, jsonb_build_object(
    'channel', 'call', 'objection', 'price', 'objection_other', 'esto se tira',
    'status_after', 'contacted', 'discard_reason', 'y esto también', 'next_step', 'Volver a llamar'));
  PERFORM pg_temp.check('60 sin "otra" el texto no queda; sin descartar el motivo tampoco',
    v_r->'interaction'->'objection_other' = 'null'::jsonb AND v_r->'interaction'->'discard_reason' = 'null'::jsonb
    AND v_r->'prospect'->'discard_reason' = 'null'::jsonb, v_r->>'interaction');
END $$;

SELECT pg_temp.expect_error('61 charla sin canal',
  format($q$SELECT ops.add_partner_prospect_interaction(%L, %L, '{"status_after":"contacted","next_step":"x"}')$q$,
         pg_temp.new_prospect('C1 030'), (SELECT actor_id FROM t_fix)),
  'INVALID_CHANNEL');
SELECT pg_temp.expect_error('62 charla sin estado',
  format($q$SELECT ops.add_partner_prospect_interaction(%L, %L, '{"channel":"call","next_step":"x"}')$q$,
         pg_temp.new_prospect('C2 030'), (SELECT actor_id FROM t_fix)),
  'INVALID_PROSPECT_STATUS');
SELECT pg_temp.expect_error('63 charla sin próximo paso',
  format($q$SELECT ops.add_partner_prospect_interaction(%L, %L, '{"channel":"call","status_after":"contacted","next_step":"  "}')$q$,
         pg_temp.new_prospect('C3 030'), (SELECT actor_id FROM t_fix)),
  'NEXT_STEP_REQUIRED');
SELECT pg_temp.expect_error('64 charla que descarta sin motivo',
  format($q$SELECT ops.add_partner_prospect_interaction(%L, %L, '{"channel":"call","status_after":"discarded","next_step":"x"}')$q$,
         pg_temp.new_prospect('C4 030'), (SELECT actor_id FROM t_fix)),
  'DISCARD_REASON_REQUIRED');
SELECT pg_temp.expect_error('65 objeción "otra" sin texto',
  format($q$SELECT ops.add_partner_prospect_interaction(%L, %L, '{"channel":"call","status_after":"contacted","next_step":"x","objection":"other"}')$q$,
         pg_temp.new_prospect('C5 030'), (SELECT actor_id FROM t_fix)),
  'OBJECTION_OTHER_REQUIRED');
SELECT pg_temp.expect_error('66 objeción inválida',
  format($q$SELECT ops.add_partner_prospect_interaction(%L, %L, '{"channel":"call","status_after":"contacted","next_step":"x","objection":"caro"}')$q$,
         pg_temp.new_prospect('C6 030'), (SELECT actor_id FROM t_fix)),
  'INVALID_OBJECTION');
SELECT pg_temp.expect_error('67 trabajos por mes no numérico',
  format($q$SELECT ops.add_partner_prospect_interaction(%L, %L, '{"channel":"call","status_after":"contacted","next_step":"x","jobs_per_month_to_pay":"muchos"}')$q$,
         pg_temp.new_prospect('C7 030'), (SELECT actor_id FROM t_fix)),
  'INVALID_JOBS_PER_MONTH');
SELECT pg_temp.expect_error('68 trabajos por mes negativo',
  format($q$SELECT ops.add_partner_prospect_interaction(%L, %L, '{"channel":"call","status_after":"contacted","next_step":"x","jobs_per_month_to_pay":-1}')$q$,
         pg_temp.new_prospect('C8 030'), (SELECT actor_id FROM t_fix)),
  'INVALID_JOBS_PER_MONTH');
SELECT pg_temp.expect_error('69 charla en el futuro',
  format($q$SELECT ops.add_partner_prospect_interaction(%L, %L, %L)$q$,
         pg_temp.new_prospect('C9 030'), (SELECT actor_id FROM t_fix),
         jsonb_build_object('channel', 'call', 'status_after', 'contacted', 'next_step', 'x',
                            'occurred_at', (now() + interval '1 day')::text)),
  'INTERACTION_IN_FUTURE');
SELECT pg_temp.expect_error('70 charla con clave desconocida',
  format($q$SELECT ops.add_partner_prospect_interaction(%L, %L, '{"channel":"call","status_after":"contacted","next_step":"x","canal":"call"}')$q$,
         pg_temp.new_prospect('C10 030'), (SELECT actor_id FROM t_fix)),
  'UNKNOWN_FIELD');
SELECT pg_temp.expect_error('71 charla de un contacto inexistente',
  format($q$SELECT ops.add_partner_prospect_interaction(%L, %L, '{"channel":"call","status_after":"contacted","next_step":"x"}')$q$,
         gen_random_uuid(), (SELECT actor_id FROM t_fix)),
  'PROSPECT_NOT_FOUND');
SELECT pg_temp.expect_error('72 charla sin actor',
  format($q$SELECT ops.add_partner_prospect_interaction(%L, NULL, '{"channel":"call","status_after":"contacted","next_step":"x"}')$q$,
         pg_temp.new_prospect('C11 030')),
  'ACTOR_REQUIRED');
SELECT pg_temp.expect_error('73 charla con un sí/no que no es booleano',
  format($q$SELECT ops.add_partner_prospect_interaction(%L, %L, '{"channel":"call","status_after":"contacted","next_step":"x","answered":"si"}')$q$,
         pg_temp.new_prospect('C12 030'), (SELECT actor_id FROM t_fix)),
  'INVALID_BOOLEAN');
SELECT pg_temp.expect_error('74 modelo ofrecido inválido',
  format($q$SELECT ops.add_partner_prospect_interaction(%L, %L, '{"channel":"call","status_after":"contacted","next_step":"x","offered_model":"gratis"}')$q$,
         pg_temp.new_prospect('C13 030'), (SELECT actor_id FROM t_fix)),
  'INVALID_OFFERED_MODEL');

-- Un error no deja la charla a medias.
DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM ops.partner_prospect_interaction i
    JOIN ops.partner_prospect p ON p.id = i.prospect_id
   WHERE p.name ~ '^C[0-9]+ 030$';
  PERFORM pg_temp.check('75 ninguna charla fallida quedó guardada', v_n = 0, v_n::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL exacto del repo, con PREPARE sin tipos
-- ═══════════════════════════════════════════════════════════════════════════

PREPARE t030_interaction AS
  SELECT ops.add_partner_prospect_interaction(p_prospect_id => $1, p_actor_id => $2, p_data => $3::jsonb) AS r;
PREPARE t030_update AS SELECT ops.update_partner_prospect(p_id => $1, p_actor_id => $2, p_patch => $3::jsonb) AS r;

DO $$
DECLARE
  f    t_fix%ROWTYPE;
  v_id uuid;
  v_r  jsonb;
BEGIN
  SELECT * INTO f FROM t_fix;
  v_id := pg_temp.new_prospect('Integración 030');
  EXECUTE format('CREATE TEMP TABLE t_i1 ON COMMIT DROP AS EXECUTE t030_interaction(%L, %L, %L)',
                 v_id, f.actor_id, '{"channel":"whatsapp","status_after":"contacted","next_step":"Volver a llamar"}');
  SELECT r INTO v_r FROM t_i1;
  PERFORM pg_temp.check('90 integración: charla', v_r->'prospect'->>'status' = 'contacted', v_r::text);

  EXECUTE format('CREATE TEMP TABLE t_i2 ON COMMIT DROP AS EXECUTE t030_update(%L, %L, %L)',
                 v_id, f.actor_id, '{"front":"corredor-norte","verify_payment":true}');
  SELECT r INTO v_r FROM t_i2;
  PERFORM pg_temp.check('91 integración: parche de la ficha',
    v_r->>'front' = 'corredor-norte' AND (v_r->>'verify_payment')::boolean, v_r::text);
END $$;

DEALLOCATE t030_interaction;
DEALLOCATE t030_update;

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
