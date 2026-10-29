-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 024.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/024_ops_seguimiento_comercial.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea su propio actor, su propio
-- comercial y su propio partner de fixture — mismo patrón que 010–022.
--
-- Las llamadas de integración (casos 80+) copian LITERAL el SQL de
-- `src/server/partner-prospects.repo.ts`, con `PREPARE` sin tipos —como los
-- manda `pg`—. Si se toca uno, se toca el otro.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS owner_id,
       gen_random_uuid() AS partner_id,
       (SELECT slug FROM service_categories ORDER BY slug LIMIT 1) AS cat_a,
       (SELECT slug FROM service_categories ORDER BY slug OFFSET 1 LIMIT 1) AS cat_b;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-024-' || actor_id || '@example.invalid', 'admin'::user_role,
       'clerk', 'test-024-' || actor_id
  FROM t_fix
UNION ALL
SELECT owner_id, 'test-024-' || owner_id || '@example.invalid', 'admin'::user_role,
       'clerk', 'test-024-' || owner_id
  FROM t_fix;

INSERT INTO partners (id, name, coverage_zone, status)
SELECT partner_id, 'Gomería de prueba 024', 'Zona Oeste', 'active'
  FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, coalesce(p_ok, false), p_detalle);
$$;

/** Corre `p_sql` y verifica que tire un error que empiece con `p_prefix`. */
CREATE OR REPLACE FUNCTION pg_temp.expect_error(p_caso text, p_sql text, p_prefix text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  PERFORM pg_temp.check(p_caso, false, 'no tiró error');
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_temp.check(p_caso, SQLERRM LIKE p_prefix || '%', SQLERRM);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Guardrails de forma
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fn text;
  v_n  int;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['create_partner_prospect', 'update_partner_prospect',
                              'import_partner_prospects', 'add_partner_prospect_origin',
                              'normalize_ar_phone'] LOOP
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

  -- Única FK: ops → ops (el origen). Ninguna a public.
  SELECT count(*) INTO v_n
    FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.conrelid = 'ops.partner_prospect'::regclass
     AND c.confrelid <> 'ops.partner_prospect_origin'::regclass;
  PERFORM pg_temp.check('04 sin FK a public (guardrail 6)', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'ops.partner_prospect'::regclass AND NOT tgisinternal;
  PERFORM pg_temp.check('05 sin trigger: updated_at lo escribe la función', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n FROM ops.partner_prospect_origin
   WHERE slug IN ('ruta-2', 'referido', 'meli', 'gps-taller', 'scrapeo', 'otro');
  PERFORM pg_temp.check('06 orígenes sembrados', v_n = 6, v_n::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Teléfono
-- ═══════════════════════════════════════════════════════════════════════════

SELECT pg_temp.check('10 tel: 11 2512-0472',        ops.normalize_ar_phone('11 2512-0472') = '5491125120472');
SELECT pg_temp.check('11 tel: 011 2512 0472',       ops.normalize_ar_phone('011 2512 0472') = '5491125120472');
SELECT pg_temp.check('12 tel: +54 9 11 2512 0472',  ops.normalize_ar_phone('+54 9 11 2512 0472') = '5491125120472');
SELECT pg_temp.check('13 tel: 54 11 2512 0472',     ops.normalize_ar_phone('54 11 2512 0472') = '5491125120472');
SELECT pg_temp.check('14 tel: 11 15 2512 0472',     ops.normalize_ar_phone('11 15 2512 0472') = '5491125120472');
SELECT pg_temp.check('15 tel: 221 455-1234 (La Plata)', ops.normalize_ar_phone('221 455-1234') = '5492214551234');
SELECT pg_temp.check('16 tel: 8 dígitos no se adivina', ops.normalize_ar_phone('4567-8901') IS NULL);
SELECT pg_temp.check('17 tel: 15 suelto no se adivina', ops.normalize_ar_phone('15 2512 0472') IS NULL);
SELECT pg_temp.check('18 tel: vacío y null',
  ops.normalize_ar_phone('') IS NULL AND ops.normalize_ar_phone(NULL) IS NULL);

-- ═══════════════════════════════════════════════════════════════════════════
-- Alta
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  f   t_fix%ROWTYPE;
  v_r jsonb;
  v_l ops.action_log%ROWTYPE;
BEGIN
  SELECT * INTO f FROM t_fix;

  v_r := ops.create_partner_prospect(f.actor_id, jsonb_build_object(
    'name', '  Gomería El Rulo  ', 'phone', '11 2512-0472', 'locality', 'Morón',
    'origin_slug', 'ruta-2', 'category_slugs', jsonb_build_array(f.cat_b, f.cat_a, f.cat_a, ''),
    'owner_id', f.owner_id, 'short_note', ''
  ));
  PERFORM pg_temp.check('20 alta: nombre trimeado', v_r->>'name' = 'Gomería El Rulo', v_r->>'name');
  PERFORM pg_temp.check('21 alta: teléfono crudo + normalizado',
    v_r->>'phone' = '11 2512-0472' AND v_r->>'phone_digits' = '5491125120472', v_r::text);
  PERFORM pg_temp.check('22 alta: defaults pending / undecided',
    v_r->>'status' = 'pending' AND v_r->>'plan' = 'undecided', v_r::text);
  PERFORM pg_temp.check('23 alta: rubros sin duplicados ni vacíos, ordenados',
    v_r->'category_slugs' = jsonb_build_array(least(f.cat_a, f.cat_b), greatest(f.cat_a, f.cat_b)),
    v_r->>'category_slugs');
  PERFORM pg_temp.check('24 alta: "" en un opcional es NULL', v_r->'short_note' = 'null'::jsonb, v_r->>'short_note');
  PERFORM pg_temp.check('25 alta: created_by es el actor', (v_r->>'created_by')::uuid = f.actor_id);
  PERFORM pg_temp.check('26 alta: comercial guardado', (v_r->>'owner_id')::uuid = f.owner_id);

  SELECT * INTO v_l FROM ops.action_log
   WHERE target_id = (v_r->>'id')::uuid AND action = 'partner_prospect.create';
  PERFORM pg_temp.check('27 log alta: before NULL, after completo, actor de la sesión',
    v_l.before IS NULL AND v_l.after->>'name' = 'Gomería El Rulo' AND v_l.actor_id = f.actor_id,
    v_l::text);

  -- Sin teléfono reconocible: entra, sin phone_digits.
  v_r := ops.create_partner_prospect(f.actor_id, jsonb_build_object(
    'name', 'Lavadero sin característica', 'phone', '4567-8901', 'origin_slug', 'scrapeo'));
  PERFORM pg_temp.check('28 alta: teléfono sin formato → phone_digits NULL',
    v_r->'phone_digits' = 'null'::jsonb AND v_r->>'phone' = '4567-8901', v_r::text);
  -- Y otro igual de irreconocible tampoco choca.
  v_r := ops.create_partner_prospect(f.actor_id, jsonb_build_object(
    'name', 'Otro lavadero', 'phone', '4567-8901', 'origin_slug', 'scrapeo'));
  PERFORM pg_temp.check('29 alta: dos sin phone_digits no son duplicados', v_r->>'id' IS NOT NULL);
END $$;

SELECT pg_temp.expect_error('30 alta: duplicado por teléfono (otra forma de escribirlo)',
  format($q$SELECT ops.create_partner_prospect(%L, '{"name":"Rulo bis","phone":"+54 9 11 2512 0472","origin_slug":"referido"}')$q$,
         (SELECT actor_id FROM t_fix)),
  'DUPLICATE_PHONE: ');
SELECT pg_temp.check('31 duplicado: el error trae el id del existente',
  EXISTS (SELECT 1 FROM t_result r, ops.partner_prospect p
           WHERE r.caso LIKE '30 %' AND p.name = 'Gomería El Rulo'
             AND r.detalle LIKE '%' || p.id::text || '%'));

SELECT pg_temp.expect_error('32 alta: sin nombre',
  format($q$SELECT ops.create_partner_prospect(%L, '{"name":"  ","origin_slug":"otro"}')$q$, (SELECT actor_id FROM t_fix)),
  'NAME_REQUIRED');
SELECT pg_temp.expect_error('33 alta: sin origen',
  format($q$SELECT ops.create_partner_prospect(%L, '{"name":"X"}')$q$, (SELECT actor_id FROM t_fix)),
  'INVALID_ORIGIN');
SELECT pg_temp.expect_error('34 alta: origen inexistente',
  format($q$SELECT ops.create_partner_prospect(%L, '{"name":"X","origin_slug":"nada"}')$q$, (SELECT actor_id FROM t_fix)),
  'INVALID_ORIGIN: nada');
SELECT pg_temp.expect_error('35 alta: estado inválido',
  format($q$SELECT ops.create_partner_prospect(%L, '{"name":"X","origin_slug":"otro","status":"won"}')$q$, (SELECT actor_id FROM t_fix)),
  'INVALID_PROSPECT_STATUS: won');
SELECT pg_temp.expect_error('36 alta: plan inválido',
  format($q$SELECT ops.create_partner_prospect(%L, '{"name":"X","origin_slug":"otro","plan":"gold"}')$q$, (SELECT actor_id FROM t_fix)),
  'INVALID_PLAN: gold');
SELECT pg_temp.expect_error('37 alta: rubro inexistente',
  format($q$SELECT ops.create_partner_prospect(%L, '{"name":"X","origin_slug":"otro","category_slugs":["no-existe"]}')$q$, (SELECT actor_id FROM t_fix)),
  'INVALID_CATEGORY_SLUG: no-existe');
SELECT pg_temp.expect_error('38 alta: comercial inexistente',
  format($q$SELECT ops.create_partner_prospect(%L, %L)$q$, (SELECT actor_id FROM t_fix),
         jsonb_build_object('name', 'X', 'origin_slug', 'otro', 'owner_id', gen_random_uuid())),
  'OWNER_NOT_FOUND');
SELECT pg_temp.expect_error('39 alta: partner inexistente',
  format($q$SELECT ops.create_partner_prospect(%L, %L)$q$, (SELECT actor_id FROM t_fix),
         jsonb_build_object('name', 'X', 'origin_slug', 'otro', 'partner_id', gen_random_uuid())),
  'PARTNER_NOT_FOUND');
SELECT pg_temp.expect_error('40 alta: fecha inválida',
  format($q$SELECT ops.create_partner_prospect(%L, '{"name":"X","origin_slug":"otro","next_follow_up_on":"31/10"}')$q$, (SELECT actor_id FROM t_fix)),
  'INVALID_DATE: next_follow_up_on');
SELECT pg_temp.expect_error('41 alta: clave desconocida',
  format($q$SELECT ops.create_partner_prospect(%L, '{"name":"X","origin_slug":"otro","nombre":"Y"}')$q$, (SELECT actor_id FROM t_fix)),
  'UNKNOWN_FIELD: nombre');
SELECT pg_temp.expect_error('42 alta: actor NULL',
  $q$SELECT ops.create_partner_prospect(NULL, '{"name":"X","origin_slug":"otro"}')$q$,
  'ACTOR_REQUIRED');
SELECT pg_temp.expect_error('43 alta: actor inexistente',
  format($q$SELECT ops.create_partner_prospect(%L, '{"name":"X","origin_slug":"otro"}')$q$, gen_random_uuid()),
  'ACTOR_NOT_FOUND');

-- ═══════════════════════════════════════════════════════════════════════════
-- Edición (parche)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  f      t_fix%ROWTYPE;
  v_id   uuid;
  v_r    jsonb;
  v_prev jsonb;
  v_n    int;
BEGIN
  SELECT * INTO f FROM t_fix;
  SELECT id INTO v_id FROM ops.partner_prospect WHERE name = 'Gomería El Rulo';
  SELECT to_jsonb(p) INTO v_prev FROM ops.partner_prospect p WHERE id = v_id;

  -- Una sola clave: el resto no se toca.
  v_r := ops.update_partner_prospect(v_id, f.actor_id, '{"notes":"  Dice que vuelva el jueves  "}');
  PERFORM pg_temp.check('50 parche: cambia sólo la clave enviada',
    v_r->>'notes' = 'Dice que vuelva el jueves'
    AND v_r->>'locality' = 'Morón' AND v_r->>'phone_digits' = '5491125120472'
    AND v_r->'category_slugs' = v_prev->'category_slugs', v_r::text);
  PERFORM pg_temp.check('51 parche: created_at intacto',
    v_r->>'created_at' = v_prev->>'created_at');

  SELECT count(*) INTO v_n FROM ops.action_log
   WHERE target_id = v_id AND action = 'partner_prospect.update';
  PERFORM pg_temp.check('52 parche: una entrada de log', v_n = 1, v_n::text);

  -- Lo mismo otra vez: no es un hecho.
  PERFORM ops.update_partner_prospect(v_id, f.actor_id, '{"notes":"Dice que vuelva el jueves"}');
  SELECT count(*) INTO v_n FROM ops.action_log
   WHERE target_id = v_id AND action = 'partner_prospect.update';
  PERFORM pg_temp.check('53 parche sin cambios: no loguea', v_n = 1, v_n::text);

  v_r := ops.update_partner_prospect(v_id, f.actor_id, jsonb_build_object(
    'status', 'registered', 'plan', 'plus', 'partner_id', f.partner_id,
    'last_contact_on', '2026-10-28', 'next_follow_up_on', '2026-11-04',
    'talked_to', 'Rulo (dueño)'));
  PERFORM pg_temp.check('54 parche: estado, plan, vínculo y fechas',
    v_r->>'status' = 'registered' AND v_r->>'plan' = 'plus'
    AND (v_r->>'partner_id')::uuid = f.partner_id
    AND v_r->>'last_contact_on' = '2026-10-28' AND v_r->>'next_follow_up_on' = '2026-11-04',
    v_r::text);

  -- null y "" borran.
  v_r := ops.update_partner_prospect(v_id, f.actor_id,
    '{"next_follow_up_on":"","talked_to":null,"partner_id":null,"category_slugs":[]}');
  PERFORM pg_temp.check('55 parche: "" y null borran (fecha, texto, uuid, array)',
    v_r->'next_follow_up_on' = 'null'::jsonb AND v_r->'talked_to' = 'null'::jsonb
    AND v_r->'partner_id' = 'null'::jsonb AND v_r->'category_slugs' = '[]'::jsonb, v_r::text);

  -- Cambiar el teléfono recalcula phone_digits.
  v_r := ops.update_partner_prospect(v_id, f.actor_id, '{"phone":"011 4000-1111"}');
  PERFORM pg_temp.check('56 parche: nuevo teléfono → nuevo phone_digits',
    v_r->>'phone_digits' = '5491140001111', v_r::text);
  -- Guardar su propio teléfono no choca consigo mismo.
  v_r := ops.update_partner_prospect(v_id, f.actor_id, '{"phone":"11 4000 1111"}');
  PERFORM pg_temp.check('57 parche: el mismo número escrito distinto no es duplicado de sí mismo',
    v_r->>'phone' = '11 4000 1111', v_r::text);
END $$;

-- Un contacto nuevo con el teléfono VIEJO del Rulo ahora sí entra (se liberó).
SELECT pg_temp.check('58 el teléfono que se cambió quedó libre',
  ops.create_partner_prospect((SELECT actor_id FROM t_fix),
    '{"name":"Nuevo dueño del número","phone":"1125120472","origin_slug":"otro"}')->>'phone_digits'
  = '5491125120472');

SELECT pg_temp.expect_error('59 parche: duplicado contra otro contacto',
  format($q$SELECT ops.update_partner_prospect(%L, %L, '{"phone":"11 2512 0472"}')$q$,
         (SELECT id FROM ops.partner_prospect WHERE name = 'Gomería El Rulo'), (SELECT actor_id FROM t_fix)),
  'DUPLICATE_PHONE: ');
SELECT pg_temp.expect_error('60 parche: borrar el nombre',
  format($q$SELECT ops.update_partner_prospect(%L, %L, '{"name":""}')$q$,
         (SELECT id FROM ops.partner_prospect WHERE name = 'Gomería El Rulo'), (SELECT actor_id FROM t_fix)),
  'NAME_REQUIRED');
SELECT pg_temp.expect_error('61 parche: misma validación que el alta (estado)',
  format($q$SELECT ops.update_partner_prospect(%L, %L, '{"status":"ganado"}')$q$,
         (SELECT id FROM ops.partner_prospect WHERE name = 'Gomería El Rulo'), (SELECT actor_id FROM t_fix)),
  'INVALID_PROSPECT_STATUS');
SELECT pg_temp.expect_error('62 parche: contacto inexistente',
  format($q$SELECT ops.update_partner_prospect(%L, %L, '{"notes":"x"}')$q$, gen_random_uuid(), (SELECT actor_id FROM t_fix)),
  'PROSPECT_NOT_FOUND');
SELECT pg_temp.expect_error('63 parche: no es un objeto',
  format($q$SELECT ops.update_partner_prospect(%L, %L, '[1]')$q$,
         (SELECT id FROM ops.partner_prospect WHERE name = 'Gomería El Rulo'), (SELECT actor_id FROM t_fix)),
  'INVALID_PATCH');

-- ═══════════════════════════════════════════════════════════════════════════
-- Importación
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  f   t_fix%ROWTYPE;
  v_r jsonb;
  v_n int;
BEGIN
  SELECT * INTO f FROM t_fix;
  v_r := ops.import_partner_prospects(f.actor_id, jsonb_build_array(
    jsonb_build_object('name', 'Grúas Norte', 'phone', '11 3000 0001', 'origin_slug', 'scrapeo'),
    jsonb_build_object('name', 'Ya cargado', 'phone', '1125120472', 'origin_slug', 'scrapeo'),
    jsonb_build_object('name', 'Gestoría Sur', 'phone', '11 3000 0002', 'origin_slug', 'scrapeo',
                       'locality', 'Lomas de Zamora'),
    jsonb_build_object('name', 'Grúas Norte (repetida en el CSV)', 'phone', '+54 9 11 3000-0001',
                       'origin_slug', 'scrapeo')
  ));
  PERFORM pg_temp.check('70 import: 2 creados', jsonb_array_length(v_r->'created') = 2, v_r::text);
  PERFORM pg_temp.check('71 import: 2 salteados (contra la base y dentro de la tanda)',
    jsonb_array_length(v_r->'skipped') = 2
    AND (v_r->'skipped'->0->>'index')::int = 1 AND (v_r->'skipped'->1->>'index')::int = 3, v_r::text);
  PERFORM pg_temp.check('72 import: el salteado trae el id existente',
    (v_r->'skipped'->1->>'existing_id')::uuid = (v_r->'created'->>0)::uuid, v_r::text);

  SELECT count(*) INTO v_n FROM ops.action_log
   WHERE action = 'partner_prospect.create' AND note = 'import'
     AND target_id IN (SELECT (jsonb_array_elements_text(v_r->'created'))::uuid);
  PERFORM pg_temp.check('73 import: cada alta logueada con nota import', v_n = 2, v_n::text);
END $$;

SELECT pg_temp.expect_error('74 import: una fila inválida corta todo, con el número',
  format($q$SELECT ops.import_partner_prospects(%L, '[{"name":"Ok","origin_slug":"otro"},{"name":"","origin_slug":"otro"}]')$q$,
         (SELECT actor_id FROM t_fix)),
  'IMPORT_ROW_INVALID: 1: NAME_REQUIRED');
SELECT pg_temp.check('75 import abortado: no quedó la fila válida',
  NOT EXISTS (SELECT 1 FROM ops.partner_prospect WHERE name = 'Ok'));
SELECT pg_temp.expect_error('76 import: vacío',
  format($q$SELECT ops.import_partner_prospects(%L, '[]')$q$, (SELECT actor_id FROM t_fix)),
  'IMPORT_EMPTY');

-- ═══════════════════════════════════════════════════════════════════════════
-- Orígenes
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  f   t_fix%ROWTYPE;
  v_r jsonb;
  v_n int;
BEGIN
  SELECT * INTO f FROM t_fix;
  v_r := ops.add_partner_prospect_origin(f.actor_id, 'feria-autopartes', '  Feria de autopartes ');
  PERFORM pg_temp.check('77 origen: alta con label trimeado', v_r->>'label' = 'Feria de autopartes', v_r::text);
  PERFORM ops.add_partner_prospect_origin(f.actor_id, 'feria-autopartes', 'Otro nombre');
  SELECT count(*) INTO v_n FROM ops.action_log WHERE action = 'partner_prospect_origin.create'
     AND target_id = (v_r->>'id')::uuid;
  PERFORM pg_temp.check('78 origen: idempotente por slug, un solo log', v_n = 1, v_n::text);
END $$;

SELECT pg_temp.expect_error('79 origen: slug inválido',
  format($q$SELECT ops.add_partner_prospect_origin(%L, 'Feria Grande', 'Feria')$q$, (SELECT actor_id FROM t_fix)),
  'INVALID_ORIGIN_SLUG');

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL exacto del repo, con PREPARE sin tipos
-- ═══════════════════════════════════════════════════════════════════════════

PREPARE t024_create AS SELECT ops.create_partner_prospect(p_actor_id => $1, p_data => $2::jsonb) AS r;
PREPARE t024_update AS SELECT ops.update_partner_prospect(p_id => $1, p_actor_id => $2, p_patch => $3::jsonb) AS r;
PREPARE t024_import AS SELECT ops.import_partner_prospects(p_actor_id => $1, p_rows => $2::jsonb) AS r;
PREPARE t024_origin AS SELECT ops.add_partner_prospect_origin(p_actor_id => $1, p_slug => $2, p_label => $3) AS r;

DO $$
DECLARE
  f   t_fix%ROWTYPE;
  v_r jsonb;
BEGIN
  SELECT * INTO f FROM t_fix;
  EXECUTE format('CREATE TEMP TABLE t_i1 ON COMMIT DROP AS EXECUTE t024_create(%L, %L)',
                 f.actor_id, '{"name":"Integración","origin_slug":"otro"}');
  SELECT r INTO v_r FROM t_i1;
  PERFORM pg_temp.check('80 integración: alta', v_r->>'name' = 'Integración', v_r::text);

  EXECUTE format('CREATE TEMP TABLE t_i2 ON COMMIT DROP AS EXECUTE t024_update(%L, %L, %L)',
                 v_r->>'id', f.actor_id, '{"status":"thinking"}');
  SELECT r INTO v_r FROM t_i2;
  PERFORM pg_temp.check('81 integración: parche', v_r->>'status' = 'thinking', v_r::text);

  EXECUTE format('CREATE TEMP TABLE t_i3 ON COMMIT DROP AS EXECUTE t024_import(%L, %L)',
                 f.actor_id, '[{"name":"Integración import","origin_slug":"otro"}]');
  SELECT r INTO v_r FROM t_i3;
  PERFORM pg_temp.check('82 integración: import', jsonb_array_length(v_r->'created') = 1, v_r::text);

  EXECUTE format('CREATE TEMP TABLE t_i4 ON COMMIT DROP AS EXECUTE t024_origin(%L, %L, %L)',
                 f.actor_id, 'integracion', 'Integración');
  SELECT r INTO v_r FROM t_i4;
  PERFORM pg_temp.check('83 integración: origen', v_r->>'slug' = 'integracion', v_r::text);
END $$;

DEALLOCATE t024_create;
DEALLOCATE t024_update;
DEALLOCATE t024_import;
DEALLOCATE t024_origin;

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
