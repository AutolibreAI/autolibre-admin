-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 031 (API Chasis).
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/031_ops_api_chasis.test.sql
--
-- BEGIN … ROLLBACK, con su propio actor — mismo patrón que la 024/030.
-- Necesita la 024 y la 030 (el contacto de proveedor que se crea desde una
-- agencia pasa por `ops.create_partner_prospect`). La integración (casos 90+)
-- copia LITERAL el SQL de `src/server/chasis-agencies.repo.ts`.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-031-' || actor_id || '@example.invalid', 'admin'::user_role,
       'clerk'::auth_provider, 'test-031-' || actor_id
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

CREATE OR REPLACE FUNCTION pg_temp.new_agency(p_name text, p_extra jsonb DEFAULT '{}')
RETURNS uuid LANGUAGE sql AS $$
  SELECT (ops.create_chasis_agency((SELECT actor_id FROM t_fix), jsonb_build_object('name', p_name) || p_extra)->>'id')::uuid;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Guardrails de forma
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fn text;
  v_n  int;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['create_chasis_agency', 'update_chasis_agency', 'add_chasis_agency_interaction',
                              'create_prospect_from_chasis_agency', '_normalize_chasis_agency'] LOOP
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = v_fn;
    PERFORM pg_temp.check('01 ' || v_fn || ': UNA sola firma', v_n = 1, v_n::text);
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = v_fn AND p.prosecdef;
    PERFORM pg_temp.check('02 ' || v_fn || ': SECURITY INVOKER', v_n = 0, v_n::text);
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = v_fn AND array_to_string(p.proconfig, ',') LIKE 'search_path=%';
    PERFORM pg_temp.check('03 ' || v_fn || ': search_path fijo', v_n = 1, v_n::text);
  END LOOP;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname LIKE '%chasis_agency_interaction%'
     AND p.proname <> 'add_chasis_agency_interaction';
  PERFORM pg_temp.check('04 charlas: sólo existe el alta', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n FROM pg_constraint c
   WHERE c.contype = 'f' AND c.conrelid IN ('ops.chasis_agency'::regclass, 'ops.chasis_agency_interaction'::regclass)
     AND c.confrelid NOT IN ('ops.chasis_agency'::regclass, 'ops.partner_prospect'::regclass);
  PERFORM pg_temp.check('05 sin FK a public (guardrail 6)', v_n = 0, v_n::text);

  PERFORM pg_temp.check('06 origen api-chasis sembrado',
    EXISTS (SELECT 1 FROM ops.partner_prospect_origin WHERE slug = 'api-chasis'));
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- La ficha
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  f    t_fix%ROWTYPE;
  v_r  jsonb;
  v_id uuid;
  v_n  int;
BEGIN
  SELECT * INTO f FROM t_fix;
  v_r := ops.create_chasis_agency(f.actor_id, jsonb_build_object(
    'name', '  Agencia Norte  ', 'phone', '11 4100-0031', 'locality', 'Pilar', 'owner_id', f.actor_id,
    'data_interests', '["vtv","fines","fines",""]'::jsonb, 'monthly_volume', '120',
    'integration_mode', 'api', 'has_workshop', true));
  v_id := (v_r->>'id')::uuid;
  PERFORM pg_temp.check('10 alta: nombre, teléfono normalizado, estado inicial',
    v_r->>'name' = 'Agencia Norte' AND v_r->>'phone_digits' = '5491141000031' AND v_r->>'status' = 'contacted', v_r::text);
  PERFORM pg_temp.check('11 alta: datos sin duplicados, ordenados', v_r->'data_interests' = '["fines","vtv"]'::jsonb, v_r->>'data_interests');
  PERFORM pg_temp.check('12 alta: volumen, modo, taller', (v_r->>'monthly_volume')::int = 120
    AND v_r->>'integration_mode' = 'api' AND (v_r->>'has_workshop')::boolean, v_r::text);
  PERFORM pg_temp.check('13 alta: referido sin cargar', NOT (v_r->>'referral_loaded')::boolean, v_r::text);
  SELECT count(*) INTO v_n FROM ops.action_log WHERE target_id = v_id AND action = 'chasis_agency.create';
  PERFORM pg_temp.check('14 alta: log', v_n = 1, v_n::text);

  v_r := ops.update_chasis_agency(v_id, f.actor_id, '{"data_interests_other":"cédula","status":"saw_sample"}');
  PERFORM pg_temp.check('15 "otros" sin tildar "otros" no queda', v_r->'data_interests_other' = 'null'::jsonb, v_r::text);
  v_r := ops.update_chasis_agency(v_id, f.actor_id, '{"data_interests":["other","debt"],"data_interests_other":"cédula"}');
  PERFORM pg_temp.check('16 "otros" con su texto', v_r->>'data_interests_other' = 'cédula', v_r::text);

  v_r := ops.update_chasis_agency(v_id, f.actor_id, '{"status":"client","referral_loaded":true}');
  PERFORM pg_temp.check('17 cliente con referido', v_r->>'status' = 'client' AND (v_r->>'referral_loaded')::boolean, v_r::text);

  -- Carbufy descarta, con ese motivo.
  v_r := ops.update_chasis_agency(v_id, f.actor_id, '{"uses_carbufy":true}');
  PERFORM pg_temp.check('18 usa Carbufy: descarta con ese motivo',
    v_r->>'status' = 'discarded' AND v_r->>'discard_reason' = 'Usa Carbufy', v_r::text);
  v_r := ops.update_chasis_agency(v_id, f.actor_id, '{"status":"contacted"}');
  PERFORM pg_temp.check('19 salir de descartada limpia el motivo',
    v_r->>'status' = 'contacted' AND v_r->'discard_reason' = 'null'::jsonb, v_r::text);
  v_r := ops.update_chasis_agency(v_id, f.actor_id, '{"uses_carbufy":true,"discard_reason":"Carbufy, contrato hasta 2027"}');
  PERFORM pg_temp.check('20 Carbufy con otro motivo: queda ése',
    v_r->>'status' = 'discarded' AND v_r->>'discard_reason' = 'Carbufy, contrato hasta 2027', v_r::text);
  v_r := ops.update_chasis_agency(v_id, f.actor_id, '{"uses_carbufy":false,"status":"contacted"}');
  PERFORM pg_temp.check('21 Carbufy en no no descarta', v_r->>'status' = 'contacted', v_r::text);

  SELECT count(*) INTO v_n FROM ops.action_log WHERE target_id = v_id AND action = 'chasis_agency.update';
  PERFORM ops.update_chasis_agency(v_id, f.actor_id, '{"name":"Agencia Norte"}');
  PERFORM pg_temp.check('22 guardar sin cambios no loguea',
    (SELECT count(*) FROM ops.action_log WHERE target_id = v_id AND action = 'chasis_agency.update') = v_n,
    v_n::text);
END $$;

SELECT pg_temp.expect_error('30 nombre vacío',
  format($q$SELECT ops.create_chasis_agency(%L, '{"name":" "}')$q$, (SELECT actor_id FROM t_fix)), 'NAME_REQUIRED');
SELECT pg_temp.expect_error('31 estado inválido',
  format($q$SELECT ops.update_chasis_agency(%L, %L, '{"status":"won"}')$q$, pg_temp.new_agency('E31'), (SELECT actor_id FROM t_fix)),
  'INVALID_AGENCY_STATUS');
SELECT pg_temp.expect_error('32 descartar sin motivo',
  format($q$SELECT ops.update_chasis_agency(%L, %L, '{"status":"discarded"}')$q$, pg_temp.new_agency('E32'), (SELECT actor_id FROM t_fix)),
  'DISCARD_REASON_REQUIRED');
SELECT pg_temp.expect_error('33 dato que no existe',
  format($q$SELECT ops.update_chasis_agency(%L, %L, '{"data_interests":["patente"]}')$q$, pg_temp.new_agency('E33'), (SELECT actor_id FROM t_fix)),
  'INVALID_DATA_INTEREST');
SELECT pg_temp.expect_error('34 volumen no numérico',
  format($q$SELECT ops.update_chasis_agency(%L, %L, '{"monthly_volume":"muchos"}')$q$, pg_temp.new_agency('E34'), (SELECT actor_id FROM t_fix)),
  'INVALID_MONTHLY_VOLUME');
SELECT pg_temp.expect_error('35 modo inválido',
  format($q$SELECT ops.update_chasis_agency(%L, %L, '{"integration_mode":"excel"}')$q$, pg_temp.new_agency('E35'), (SELECT actor_id FROM t_fix)),
  'INVALID_INTEGRATION_MODE');
SELECT pg_temp.expect_error('36 clave desconocida',
  format($q$SELECT ops.update_chasis_agency(%L, %L, '{"carbufy":true}')$q$, pg_temp.new_agency('E36'), (SELECT actor_id FROM t_fix)),
  'UNKNOWN_FIELD');
SELECT pg_temp.expect_error('37 teléfono duplicado',
  format($q$SELECT ops.create_chasis_agency(%L, '{"name":"Dup","phone":"+54 9 11 4100 0031"}')$q$, (SELECT actor_id FROM t_fix)),
  'DUPLICATE_PHONE');
SELECT pg_temp.expect_error('38 agencia inexistente',
  format($q$SELECT ops.update_chasis_agency(%L, %L, '{"notes":"x"}')$q$, gen_random_uuid(), (SELECT actor_id FROM t_fix)),
  'AGENCY_NOT_FOUND');
SELECT pg_temp.expect_error('39 sin actor',
  $q$SELECT ops.create_chasis_agency(NULL, '{"name":"X"}')$q$, 'ACTOR_REQUIRED');

-- ═══════════════════════════════════════════════════════════════════════════
-- Las charlas
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  f    t_fix%ROWTYPE;
  v_id uuid;
  v_r  jsonb;
  v_n  int;
BEGIN
  SELECT * INTO f FROM t_fix;
  v_id := pg_temp.new_agency('Charlas 031');

  v_r := ops.add_chasis_agency_interaction(v_id, f.actor_id, jsonb_build_object(
    'channel', 'visit', 'talked_to_decider', true, 'offered_model', 'subscription',
    'offered_amount', ' $80.000 por mes ', 'reaction', 'neutral', 'objection', 'has_provider',
    'status_after', 'saw_sample', 'next_step', 'Mandar propuesta', 'next_follow_up_on', '2026-11-25'));
  PERFORM pg_temp.check('50 charla: se guarda',
    v_r->'interaction'->>'offered_model' = 'subscription' AND v_r->'interaction'->>'offered_amount' = '$80.000 por mes'
    AND v_r->'interaction'->>'objection' = 'has_provider', v_r->>'interaction');
  PERFORM pg_temp.check('51 charla: mueve la agencia (estado, paso, seguimiento, quien decide)',
    v_r->'agency'->>'status' = 'saw_sample' AND v_r->'agency'->>'next_step' = 'Mandar propuesta'
    AND v_r->'agency'->>'next_follow_up_on' = '2026-11-25' AND (v_r->'agency'->>'talked_to_decider')::boolean,
    v_r->>'agency');
  PERFORM pg_temp.check('52 charla: último contacto hoy en Buenos Aires',
    v_r->'agency'->>'last_contact_on' = ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)::text, v_r->>'agency');

  v_r := ops.add_chasis_agency_interaction(v_id, f.actor_id, jsonb_build_object(
    'channel', 'call', 'occurred_at', (now() - interval '7 days')::text,
    'status_after', 'contacted', 'next_step', 'Primer llamado'));
  PERFORM pg_temp.check('53 una charla vieja no pisa el estado',
    v_r->'agency'->>'status' = 'saw_sample' AND v_r->'agency'->>'next_step' = 'Mandar propuesta', v_r->>'agency');
  SELECT count(*) INTO v_n FROM ops.chasis_agency_interaction WHERE agency_id = v_id;
  PERFORM pg_temp.check('54 el historial tiene las dos', v_n = 2, v_n::text);

  v_r := ops.add_chasis_agency_interaction(v_id, f.actor_id, jsonb_build_object(
    'channel', 'whatsapp', 'status_after', 'discarded', 'discard_reason', 'Poco volumen',
    'objection', 'other', 'objection_other', 'Cierra la agencia', 'next_step', 'Nada'));
  PERFORM pg_temp.check('55 charla que descarta',
    v_r->'agency'->>'status' = 'discarded' AND v_r->'agency'->>'discard_reason' = 'Poco volumen'
    AND v_r->'interaction'->>'objection_other' = 'Cierra la agencia', v_r::text);
END $$;

SELECT pg_temp.expect_error('60 charla sin canal',
  format($q$SELECT ops.add_chasis_agency_interaction(%L, %L, '{"status_after":"contacted","next_step":"x"}')$q$,
         pg_temp.new_agency('C1 031'), (SELECT actor_id FROM t_fix)), 'INVALID_CHANNEL');
SELECT pg_temp.expect_error('61 charla sin próximo paso',
  format($q$SELECT ops.add_chasis_agency_interaction(%L, %L, '{"channel":"call","status_after":"contacted","next_step":""}')$q$,
         pg_temp.new_agency('C2 031'), (SELECT actor_id FROM t_fix)), 'NEXT_STEP_REQUIRED');
SELECT pg_temp.expect_error('62 modelo de proveedores no vale acá',
  format($q$SELECT ops.add_chasis_agency_interaction(%L, %L, '{"channel":"call","status_after":"contacted","next_step":"x","offered_model":"fee_per_job"}')$q$,
         pg_temp.new_agency('C3 031'), (SELECT actor_id FROM t_fix)), 'INVALID_OFFERED_MODEL');
SELECT pg_temp.expect_error('63 objeción de proveedores no vale acá',
  format($q$SELECT ops.add_chasis_agency_interaction(%L, %L, '{"channel":"call","status_after":"contacted","next_step":"x","objection":"no_apps"}')$q$,
         pg_temp.new_agency('C4 031'), (SELECT actor_id FROM t_fix)), 'INVALID_OBJECTION');
SELECT pg_temp.expect_error('64 descartar sin motivo',
  format($q$SELECT ops.add_chasis_agency_interaction(%L, %L, '{"channel":"call","status_after":"discarded","next_step":"x"}')$q$,
         pg_temp.new_agency('C5 031'), (SELECT actor_id FROM t_fix)), 'DISCARD_REASON_REQUIRED');
SELECT pg_temp.expect_error('65 charla en el futuro',
  format($q$SELECT ops.add_chasis_agency_interaction(%L, %L, %L)$q$, pg_temp.new_agency('C6 031'), (SELECT actor_id FROM t_fix),
         jsonb_build_object('channel', 'call', 'status_after', 'contacted', 'next_step', 'x',
                            'occurred_at', (now() + interval '1 day')::text)), 'INTERACTION_IN_FUTURE');
SELECT pg_temp.expect_error('66 "otra" sin texto',
  format($q$SELECT ops.add_chasis_agency_interaction(%L, %L, '{"channel":"call","status_after":"contacted","next_step":"x","objection":"other"}')$q$,
         pg_temp.new_agency('C7 031'), (SELECT actor_id FROM t_fix)), 'OBJECTION_OTHER_REQUIRED');

-- ═══════════════════════════════════════════════════════════════════════════
-- De agencia a contacto de proveedor
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  f    t_fix%ROWTYPE;
  v_id uuid;
  v_r  jsonb;
  v_p  ops.partner_prospect%ROWTYPE;
  v_existing uuid;
BEGIN
  SELECT * INTO f FROM t_fix;
  v_id := pg_temp.new_agency('Agencia con taller 031', jsonb_build_object(
    'phone', '11 4100-0071', 'locality', 'Escobar', 'contact_name', 'Marta', 'owner_id', f.actor_id, 'has_workshop', true));
  v_r := ops.create_prospect_from_chasis_agency(v_id, f.actor_id);
  SELECT * INTO v_p FROM ops.partner_prospect WHERE id = (v_r->>'prospect_id')::uuid;
  PERFORM pg_temp.check('70 crea el contacto con los datos copiados',
    (v_r->>'created')::boolean AND v_p.name = 'Agencia con taller 031' AND v_p.phone_digits = '5491141000071'
    AND v_p.locality = 'Escobar' AND v_p.talked_to = 'Marta' AND v_p.owner_id = f.actor_id, v_r::text);
  PERFORM pg_temp.check('71 frente Corredor Norte, origen api-chasis',
    v_p.front = 'corredor-norte' AND v_p.origin_slug = 'api-chasis', v_p.front || ' ' || v_p.origin_slug);
  PERFORM pg_temp.check('72 la agencia queda linkeada',
    (SELECT prospect_id FROM ops.chasis_agency WHERE id = v_id) = v_p.id);

  -- Teléfono que ya es un contacto: linkea a ése, no duplica.
  v_existing := (ops.create_partner_prospect(f.actor_id, '{"name":"Ya cargado 031","phone":"11 4100-0072","origin_slug":"otro"}')->>'id')::uuid;
  v_id := pg_temp.new_agency('Agencia repetida 031', '{"phone":"11 4100-0072"}');
  v_r := ops.create_prospect_from_chasis_agency(v_id, f.actor_id);
  PERFORM pg_temp.check('73 teléfono ya cargado: linkea al existente sin crear',
    NOT (v_r->>'created')::boolean AND (v_r->>'prospect_id')::uuid = v_existing, v_r::text);
  PERFORM pg_temp.check('74 no se duplicó',
    (SELECT count(*) FROM ops.partner_prospect WHERE phone_digits = '5491141000072') = 1);
END $$;

SELECT pg_temp.expect_error('75 dos veces la misma agencia',
  format($q$SELECT ops.create_prospect_from_chasis_agency(%L, %L)$q$,
         (SELECT id FROM ops.chasis_agency WHERE name = 'Agencia con taller 031'), (SELECT actor_id FROM t_fix)),
  'AGENCY_ALREADY_LINKED');

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL exacto del repo, con PREPARE sin tipos
-- ═══════════════════════════════════════════════════════════════════════════

PREPARE t031_create AS SELECT ops.create_chasis_agency(p_actor_id => $1, p_data => $2::jsonb) AS r;
PREPARE t031_update AS SELECT ops.update_chasis_agency(p_id => $1, p_actor_id => $2, p_patch => $3::jsonb) AS r;
PREPARE t031_interaction AS
  SELECT ops.add_chasis_agency_interaction(p_agency_id => $1, p_actor_id => $2, p_data => $3::jsonb) AS r;
PREPARE t031_prospect AS SELECT ops.create_prospect_from_chasis_agency(p_agency_id => $1, p_actor_id => $2) AS r;

DO $$
DECLARE
  f   t_fix%ROWTYPE;
  v_r jsonb;
  v_id text;
BEGIN
  SELECT * INTO f FROM t_fix;
  EXECUTE format('CREATE TEMP TABLE t_i1 ON COMMIT DROP AS EXECUTE t031_create(%L, %L)', f.actor_id, '{"name":"Integración 031"}');
  SELECT r INTO v_r FROM t_i1;
  v_id := v_r->>'id';
  PERFORM pg_temp.check('90 integración: alta', v_r->>'name' = 'Integración 031', v_r::text);
  EXECUTE format('CREATE TEMP TABLE t_i2 ON COMMIT DROP AS EXECUTE t031_update(%L, %L, %L)', v_id, f.actor_id, '{"status":"proposal_sent"}');
  SELECT r INTO v_r FROM t_i2;
  PERFORM pg_temp.check('91 integración: parche', v_r->>'status' = 'proposal_sent', v_r::text);
  EXECUTE format('CREATE TEMP TABLE t_i3 ON COMMIT DROP AS EXECUTE t031_interaction(%L, %L, %L)', v_id, f.actor_id,
                 '{"channel":"call","status_after":"client","next_step":"Cargar el referido"}');
  SELECT r INTO v_r FROM t_i3;
  PERFORM pg_temp.check('92 integración: charla', v_r->'agency'->>'status' = 'client', v_r::text);
  EXECUTE format('CREATE TEMP TABLE t_i4 ON COMMIT DROP AS EXECUTE t031_prospect(%L, %L)', v_id, f.actor_id);
  SELECT r INTO v_r FROM t_i4;
  PERFORM pg_temp.check('93 integración: contacto de proveedor', (v_r->>'created')::boolean, v_r::text);
END $$;

DEALLOCATE t031_create;
DEALLOCATE t031_update;
DEALLOCATE t031_interaction;
DEALLOCATE t031_prospect;

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
