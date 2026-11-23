-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 035 ("Alta por" + catálogo del equipo).
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/035_ops_alta_por.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea sus propios actores, personas y
-- solicitudes. Nunca `ORDER BY created_at` sobre los logs: adentro de la
-- transacción `now()` es constante.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS actor2_id,
       gen_random_uuid() AS app_id,
       gen_random_uuid() AS app2_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-035-a-' || actor_id || '@example.invalid', 'admin'::user_role,
       'clerk'::auth_provider, 'test-035-a-' || actor_id
  FROM t_fix
UNION ALL
SELECT actor2_id, 'test-035-b-' || actor2_id || '@example.invalid', 'admin'::user_role,
       'clerk'::auth_provider, 'test-035-b-' || actor2_id
  FROM t_fix;

INSERT INTO partner_applications (id, business_name, whatsapp, email, address, raw_submission, status)
SELECT app_id, 'Taller 035', '5491111111111', 't035@example.invalid', 'Calle 1', '{}'::jsonb,
       'not_contacted'::partner_application_status FROM t_fix
UNION ALL
SELECT app2_id, 'Taller 035 bis', '5491122222222', 't035b@example.invalid', 'Calle 2', '{}'::jsonb,
       'discarded'::partner_application_status FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle);
$$;

-- Captura el mensaje de error de una sentencia (NULL si no falló).
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Forma
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops'
     AND p.proname IN ('create_team_member', 'update_team_member', 'set_application_sourcer');
  PERFORM pg_temp.check('01 tres SP, sin sobrecargas', v_n = 3, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops'
     AND p.proname IN ('create_team_member', 'update_team_member', 'set_application_sourcer')
     AND (p.prosecdef OR p.proconfig IS NULL OR NOT EXISTS (
          SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'));
  PERFORM pg_temp.check('02 SECURITY INVOKER y search_path fijo', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_class r ON r.oid = c.confrelid
    JOIN pg_namespace rn ON rn.oid = r.relnamespace
   WHERE n.nspname = 'ops' AND c.contype = 'f'
     AND t.relname IN ('team_member', 'partner_application_sourcer', 'partner_application_sourcer_log')
     AND rn.nspname <> 'ops';
  PERFORM pg_temp.check('03 ninguna FK cruza a public', v_n = 0, v_n::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Semilla
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  PERFORM pg_temp.check('04 semilla: Tobías comercial activo',
    EXISTS (SELECT 1 FROM ops.team_member WHERE name = 'Tobías Argonz' AND role = 'comercial' AND active));
  PERFORM pg_temp.check('05 semilla: Lautaro inactivo desde el 20/11/26',
    EXISTS (SELECT 1 FROM ops.team_member WHERE name = 'Lautaro' AND NOT active AND inactive_since = DATE '2026-11-20'));
  PERFORM pg_temp.check('06 semilla: Nicolás fundador',
    EXISTS (SELECT 1 FROM ops.team_member WHERE name = 'Nicolás' AND role = 'fundador' AND active));
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Personas
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  f   t_fix%ROWTYPE;
  v   jsonb;
  v2  jsonb;
  e   text;
BEGIN
  SELECT * INTO f FROM t_fix;

  v := ops.create_team_member(f.actor_id, '  Persona 035  ', 'otro');
  PERFORM pg_temp.check('10 alta: recorta el nombre', v->>'name' = 'Persona 035', v::text);
  PERFORM pg_temp.check('11 alta: activa y sin usuario', (v->>'active')::boolean AND v->'user_id' = 'null'::jsonb, v::text);
  PERFORM pg_temp.check('12 alta: log',
    EXISTS (SELECT 1 FROM ops.action_log WHERE action = 'team_member.create' AND target_id = (v->>'id')::uuid));

  e := pg_temp.err(format('SELECT ops.create_team_member(%L, %L, %L)', f.actor_id, 'persona 035', 'otro'));
  PERFORM pg_temp.check('13 nombre repetido (sin importar mayúsculas)', e LIKE 'MEMBER_NAME_TAKEN%', e);
  e := pg_temp.err(format('SELECT ops.create_team_member(%L, %L, %L)', f.actor_id, '   ', 'otro'));
  PERFORM pg_temp.check('14 nombre vacío', e = 'MEMBER_NAME_REQUIRED', e);
  e := pg_temp.err(format('SELECT ops.create_team_member(%L, %L, %L)', f.actor_id, 'X 035', 'jefe'));
  PERFORM pg_temp.check('15 rol fuera del catálogo', e LIKE 'INVALID_MEMBER_ROLE%', e);
  e := pg_temp.err(format('SELECT ops.create_team_member(NULL, %L, %L)', 'Y 035', 'otro'));
  PERFORM pg_temp.check('16 sin actor', e = 'ACTOR_REQUIRED', e);
  e := pg_temp.err(format('SELECT ops.create_team_member(%L, %L, %L, %L)', f.actor_id, 'Z 035', 'otro', gen_random_uuid()));
  PERFORM pg_temp.check('17 usuario inexistente', e LIKE 'USER_NOT_FOUND%', e);

  -- Vincular usuario
  v2 := ops.update_team_member((v->>'id')::uuid, f.actor_id, jsonb_build_object('user_id', f.actor_id));
  PERFORM pg_temp.check('18 vincula usuario', (v2->>'user_id')::uuid = f.actor_id, v2::text);
  e := pg_temp.err(format('SELECT ops.create_team_member(%L, %L, %L, %L)', f.actor_id, 'W 035', 'otro', f.actor_id));
  PERFORM pg_temp.check('19 un usuario no se vincula a dos personas', e LIKE 'USER_ALREADY_LINKED%', e);

  -- Desactivar / reactivar
  v2 := ops.update_team_member((v->>'id')::uuid, f.actor_id, '{"active": false}');
  PERFORM pg_temp.check('20 desactivar estampa inactive_since',
    NOT (v2->>'active')::boolean AND v2->>'inactive_since' IS NOT NULL, v2::text);
  v2 := ops.update_team_member((v->>'id')::uuid, f.actor_id, '{"active": true}');
  PERFORM pg_temp.check('21 reactivar borra inactive_since',
    (v2->>'active')::boolean AND v2->'inactive_since' = 'null'::jsonb, v2::text);

  -- Sin cambios: no loguea
  PERFORM ops.update_team_member((v->>'id')::uuid, f.actor_id, '{"role": "otro"}');
  PERFORM pg_temp.check('22 sin cambios no loguea',
    (SELECT count(*) FROM ops.action_log WHERE action = 'team_member.update' AND target_id = (v->>'id')::uuid) = 3);

  e := pg_temp.err(format('SELECT ops.update_team_member(%L, %L, %L)', v->>'id', f.actor_id, '{"nombre": "x"}'));
  PERFORM pg_temp.check('23 clave desconocida', e LIKE 'UNKNOWN_FIELD%', e);
  e := pg_temp.err(format('SELECT ops.update_team_member(%L, %L, %L)', gen_random_uuid(), f.actor_id, '{"role": "otro"}'));
  PERFORM pg_temp.check('24 persona inexistente', e LIKE 'MEMBER_NOT_FOUND%', e);

  -- Desvincular
  v2 := ops.update_team_member((v->>'id')::uuid, f.actor_id, '{"user_id": null}');
  PERFORM pg_temp.check('25 desvincula usuario', v2->'user_id' = 'null'::jsonb, v2::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Asignación
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  f       t_fix%ROWTYPE;
  v_tobi  uuid;
  v_lau   uuid;
  v_nico  uuid;
  r       jsonb;
  e       text;
BEGIN
  SELECT * INTO f FROM t_fix;
  SELECT id INTO v_tobi FROM ops.team_member WHERE name = 'Tobías Argonz';
  SELECT id INTO v_lau FROM ops.team_member WHERE name = 'Lautaro';
  SELECT id INTO v_nico FROM ops.team_member WHERE name = 'Nicolás';

  r := ops.set_application_sourcer(f.app_id, v_tobi, NULL, f.actor_id);
  PERFORM pg_temp.check('30 asigna una sin asignar', (r->>'changed')::boolean, r::text);
  PERFORM pg_temp.check('31 queda vigente',
    (SELECT member_id FROM ops.partner_application_sourcer WHERE application_id = f.app_id) = v_tobi);
  PERFORM pg_temp.check('32 historial: NULL → Tobías',
    EXISTS (SELECT 1 FROM ops.partner_application_sourcer_log
             WHERE application_id = f.app_id AND before_member_id IS NULL AND after_member_id = v_tobi
               AND actor_id = f.actor_id));
  PERFORM pg_temp.check('33 action_log',
    EXISTS (SELECT 1 FROM ops.action_log WHERE action = 'partner_application.set_sourcer' AND target_id = f.app_id));

  -- Lo mismo otra vez: no-op sin log
  r := ops.set_application_sourcer(f.app_id, v_tobi, v_tobi, f.actor_id);
  PERFORM pg_temp.check('34 misma persona = no-op', NOT (r->>'changed')::boolean, r::text);
  PERFORM pg_temp.check('35 no-op no agrega historial',
    (SELECT count(*) FROM ops.partner_application_sourcer_log WHERE application_id = f.app_id) = 1);

  -- Control de pisada
  e := pg_temp.err(format('SELECT ops.set_application_sourcer(%L, %L, NULL, %L)', f.app_id, v_nico, f.actor2_id));
  PERFORM pg_temp.check('36 "Es mío" sobre una ya asignada → SOURCER_CHANGED', e LIKE 'SOURCER_CHANGED%', e);
  PERFORM pg_temp.check('37 y no pisó nada',
    (SELECT member_id FROM ops.partner_application_sourcer WHERE application_id = f.app_id) = v_tobi);

  -- Reasignar con lo que vio
  r := ops.set_application_sourcer(f.app_id, v_nico, v_tobi, f.actor2_id);
  PERFORM pg_temp.check('38 reasigna Tobías → Nicolás', (r->>'changed')::boolean, r::text);
  PERFORM pg_temp.check('39 historial: Tobías → Nicolás por el actor 2',
    EXISTS (SELECT 1 FROM ops.partner_application_sourcer_log
             WHERE application_id = f.app_id AND before_member_id = v_tobi AND after_member_id = v_nico
               AND actor_id = f.actor2_id));

  -- Inactiva: no se asigna nueva
  e := pg_temp.err(format('SELECT ops.set_application_sourcer(%L, %L, %L, %L)', f.app_id, v_lau, v_nico, f.actor_id));
  PERFORM pg_temp.check('40 persona inactiva no se asigna', e LIKE 'MEMBER_INACTIVE%', e);

  -- Inactiva ya asignada se conserva (Lautaro en sus altas viejas)
  UPDATE ops.team_member SET active = true, inactive_since = NULL WHERE id = v_lau;
  PERFORM ops.set_application_sourcer(f.app2_id, v_lau, NULL, f.actor_id);
  UPDATE ops.team_member SET active = false, inactive_since = DATE '2026-11-20' WHERE id = v_lau;
  r := ops.set_application_sourcer(f.app2_id, v_lau, v_lau, f.actor_id);
  PERFORM pg_temp.check('41 re-guardar a una inactiva ya asignada es no-op, no error', NOT (r->>'changed')::boolean, r::text);
  PERFORM pg_temp.check('42 descartada también se asigna (sin importar el estado)',
    (SELECT member_id FROM ops.partner_application_sourcer WHERE application_id = f.app2_id) = v_lau);

  -- Quitar
  r := ops.set_application_sourcer(f.app_id, NULL, v_nico, f.actor_id);
  PERFORM pg_temp.check('43 quitar deja sin asignar',
    NOT EXISTS (SELECT 1 FROM ops.partner_application_sourcer WHERE application_id = f.app_id));
  PERFORM pg_temp.check('44 historial: Nicolás → NULL',
    EXISTS (SELECT 1 FROM ops.partner_application_sourcer_log
             WHERE application_id = f.app_id AND before_member_id = v_nico AND after_member_id IS NULL));

  e := pg_temp.err(format('SELECT ops.set_application_sourcer(%L, %L, NULL, %L)', gen_random_uuid(), v_tobi, f.actor_id));
  PERFORM pg_temp.check('45 solicitud inexistente', e LIKE 'APPLICATION_NOT_FOUND%', e);
  e := pg_temp.err(format('SELECT ops.set_application_sourcer(%L, %L, NULL, %L)', f.app_id, gen_random_uuid(), f.actor_id));
  PERFORM pg_temp.check('46 persona inexistente', e LIKE 'MEMBER_NOT_FOUND%', e);
  e := pg_temp.err(format('SELECT ops.set_application_sourcer(%L, %L, NULL, NULL)', f.app_id, v_tobi));
  PERFORM pg_temp.check('47 sin actor', e = 'ACTOR_REQUIRED', e);

  PERFORM pg_temp.check('48 no toca partner_applications (status ni reviewed_by_id)',
    (SELECT status::text = 'not_contacted' AND reviewed_by_id IS NULL FROM partner_applications WHERE id = f.app_id));
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL exacto del repo, con parámetros sin tipo (como `pg`).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pg_temp.fix(p_col text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  EXECUTE format('SELECT %I::text FROM t_fix', p_col) INTO v;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.tobi()
RETURNS text LANGUAGE sql AS $$
  SELECT id::text FROM ops.team_member WHERE name = 'Tobías Argonz';
$$;

PREPARE p035_set AS
  SELECT ops.set_application_sourcer(
           p_application_id => $1, p_member_id => $2,
           p_expected_member_id => $3, p_actor_id => $4) AS r;

CREATE TEMP TABLE t_int ON COMMIT DROP AS
  EXECUTE p035_set(pg_temp.fix('app_id')::uuid, pg_temp.tobi()::uuid, NULL, pg_temp.fix('actor_id')::uuid);

DO $$
DECLARE v_r jsonb;
BEGIN
  SELECT r INTO v_r FROM t_int;
  PERFORM pg_temp.check('60 integración: parámetros sin tipo', (v_r->>'changed')::boolean, v_r::text);
END $$;

DEALLOCATE p035_set;

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
