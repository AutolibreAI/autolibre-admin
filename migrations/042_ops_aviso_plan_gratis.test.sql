-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 042 (aviso del cambio del plan gratis).
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/042_ops_aviso_plan_gratis.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea sus propios actores y partners.
-- Nunca `ORDER BY created_at` sobre los logs: adentro de la transacción
-- `now()` es constante.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS actor2_id,
       gen_random_uuid() AS p1,
       gen_random_uuid() AS p2;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-042-a-' || actor_id || '@example.invalid', 'admin'::user_role,
       'clerk'::auth_provider, 'test-042-a-' || actor_id
  FROM t_fix
UNION ALL
SELECT actor2_id, 'test-042-b-' || actor2_id || '@example.invalid', 'admin'::user_role,
       'clerk'::auth_provider, 'test-042-b-' || actor2_id
  FROM t_fix;

INSERT INTO partners (id, name, coverage_zone, status, tier)
SELECT p1, 'Taller 042', 'Zona Norte', 'active'::partner_status, 'standard'::partner_tier FROM t_fix
UNION ALL
SELECT p2, 'Taller 042 bis', 'Zona Sur', 'paused'::partner_status, 'standard'::partner_tier FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, coalesce(p_ok, false), p_detalle);
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

-- ═══════════════════════════════════════════════════════════════════════════
-- Forma
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'set_partner_free_plan_notice';
  PERFORM pg_temp.check('01 un solo SP, sin sobrecargas', v_n = 1, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops'
     AND p.proname IN ('set_partner_free_plan_notice', '_partner_free_plan_notice_json')
     AND (p.prosecdef OR p.proconfig IS NULL OR NOT EXISTS (
          SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'));
  PERFORM pg_temp.check('02 SECURITY INVOKER y search_path fijo', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'ops' AND c.contype = 'f'
     AND t.relname IN ('partner_free_plan_notice', 'partner_free_plan_notice_log');
  PERFORM pg_temp.check('03 ninguna FK (sobre todo a public)', v_n = 0, v_n::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Tildar, no-op, pisada, destildar
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  f  t_fix%ROWTYPE;
  r  jsonb;
  e  text;
BEGIN
  SELECT * INTO f FROM t_fix;

  r := ops.set_partner_free_plan_notice(f.p1, true, 'whatsapp', '  Le mandé el audio  ', false, f.actor_id);
  PERFORM pg_temp.check('10 tilda', (r->>'changed')::boolean AND (r->>'notified')::boolean, r::text);
  PERFORM pg_temp.check('11 vigente con canal, nota recortada y quién',
    EXISTS (SELECT 1 FROM ops.partner_free_plan_notice
             WHERE partner_id = f.p1 AND channel = 'whatsapp' AND note = 'Le mandé el audio'
               AND notified_by = f.actor_id AND notified_at IS NOT NULL));
  PERFORM pg_temp.check('12 historial false → true',
    EXISTS (SELECT 1 FROM ops.partner_free_plan_notice_log
             WHERE partner_id = f.p1 AND NOT before_notified AND after_notified
               AND channel = 'whatsapp' AND actor_id = f.actor_id));
  PERFORM pg_temp.check('13 action_log con after',
    EXISTS (SELECT 1 FROM ops.action_log
             WHERE action = 'partner.set_free_plan_notice' AND target_id = f.p1
               AND before IS NULL AND after->>'channel' = 'whatsapp'));

  -- Mismo estado: no-op
  r := ops.set_partner_free_plan_notice(f.p1, true, 'llamada', NULL, true, f.actor_id);
  PERFORM pg_temp.check('14 mismo estado = no-op', NOT (r->>'changed')::boolean, r::text);
  PERFORM pg_temp.check('15 no-op no toca la vigente ni el historial',
    (SELECT channel FROM ops.partner_free_plan_notice WHERE partner_id = f.p1) = 'whatsapp'
    AND (SELECT count(*) FROM ops.partner_free_plan_notice_log WHERE partner_id = f.p1) = 1
    AND (SELECT count(*) FROM ops.action_log WHERE action = 'partner.set_free_plan_notice' AND target_id = f.p1) = 1);

  -- Pisada: alguien vio "sin avisar" y quiere tildar
  e := pg_temp.err(format('SELECT ops.set_partner_free_plan_notice(%L, true, %L, NULL, false, %L)',
                          f.p1, 'llamada', f.actor2_id));
  PERFORM pg_temp.check('16 vio sin avisar y ya estaba avisado → FREE_PLAN_NOTICE_CHANGED',
    e LIKE 'FREE_PLAN_NOTICE_CHANGED%', e);
  e := pg_temp.err(format('SELECT ops.set_partner_free_plan_notice(%L, false, NULL, NULL, false, %L)',
                          f.p1, f.actor2_id));
  PERFORM pg_temp.check('17 destildar con lo visto viejo también se frena', e LIKE 'FREE_PLAN_NOTICE_CHANGED%', e);
  PERFORM pg_temp.check('18 y no pisó nada',
    (SELECT notified_by FROM ops.partner_free_plan_notice WHERE partner_id = f.p1) = f.actor_id);

  -- Destildar
  r := ops.set_partner_free_plan_notice(f.p1, false, 'whatsapp', 'Era otro número', true, f.actor2_id);
  PERFORM pg_temp.check('19 destilda', (r->>'changed')::boolean AND NOT (r->>'notified')::boolean, r::text);
  PERFORM pg_temp.check('20 borra la vigente',
    NOT EXISTS (SELECT 1 FROM ops.partner_free_plan_notice WHERE partner_id = f.p1));
  PERFORM pg_temp.check('21 historial true → false, sin canal, con la nota como motivo',
    EXISTS (SELECT 1 FROM ops.partner_free_plan_notice_log
             WHERE partner_id = f.p1 AND before_notified AND NOT after_notified
               AND channel IS NULL AND note = 'Era otro número' AND actor_id = f.actor2_id));
  PERFORM pg_temp.check('22 action_log del destilde con before y after NULL',
    EXISTS (SELECT 1 FROM ops.action_log
             WHERE action = 'partner.set_free_plan_notice' AND target_id = f.p1
               AND before->>'channel' = 'whatsapp' AND after IS NULL AND note = 'Era otro número'));

  r := ops.set_partner_free_plan_notice(f.p1, false, NULL, NULL, false, f.actor_id);
  PERFORM pg_temp.check('23 destildar sin aviso = no-op', NOT (r->>'changed')::boolean, r::text);

  -- Re-tildar con otro canal (así se corrige)
  r := ops.set_partner_free_plan_notice(f.p1, true, 'en_persona', '', false, f.actor2_id);
  PERFORM pg_temp.check('24 re-tilda con otro canal y nota vacía = sin nota',
    (SELECT channel = 'en_persona' AND note IS NULL AND notified_by = f.actor2_id
       FROM ops.partner_free_plan_notice WHERE partner_id = f.p1));
  PERFORM pg_temp.check('25 historial append-only: tres filas',
    (SELECT count(*) FROM ops.partner_free_plan_notice_log WHERE partner_id = f.p1) = 3);

  -- Un pausado también se puede marcar (el SP no decide sobre el plan ni el estado)
  r := ops.set_partner_free_plan_notice(f.p2, true, 'llamada', NULL, false, f.actor_id);
  PERFORM pg_temp.check('26 partner pausado se marca', (r->>'changed')::boolean, r::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Validaciones
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  f  t_fix%ROWTYPE;
  e  text;
BEGIN
  SELECT * INTO f FROM t_fix;
  DELETE FROM ops.partner_free_plan_notice WHERE partner_id = f.p2;

  e := pg_temp.err(format('SELECT ops.set_partner_free_plan_notice(%L, true, NULL, NULL, false, %L)', f.p2, f.actor_id));
  PERFORM pg_temp.check('30 tildar sin canal', e = 'CHANNEL_REQUIRED', e);
  e := pg_temp.err(format('SELECT ops.set_partner_free_plan_notice(%L, true, %L, NULL, false, %L)', f.p2, '   ', f.actor_id));
  PERFORM pg_temp.check('31 canal en blanco', e = 'CHANNEL_REQUIRED', e);
  e := pg_temp.err(format('SELECT ops.set_partner_free_plan_notice(%L, true, %L, NULL, false, %L)', f.p2, 'email', f.actor_id));
  PERFORM pg_temp.check('32 canal fuera del catálogo', e LIKE 'INVALID_CHANNEL%', e);
  e := pg_temp.err(format('SELECT ops.set_partner_free_plan_notice(%L, true, %L, %L, false, %L)',
                          f.p2, 'whatsapp', repeat('x', 1001), f.actor_id));
  PERFORM pg_temp.check('33 nota de más de 1000', e = 'NOTE_TOO_LONG', e);
  e := pg_temp.err(format('SELECT ops.set_partner_free_plan_notice(%L, true, %L, NULL, false, %L)',
                          gen_random_uuid(), 'whatsapp', f.actor_id));
  PERFORM pg_temp.check('34 partner inexistente', e LIKE 'PARTNER_NOT_FOUND%', e);
  e := pg_temp.err(format('SELECT ops.set_partner_free_plan_notice(%L, true, %L, NULL, false, NULL)', f.p2, 'whatsapp'));
  PERFORM pg_temp.check('35 sin actor', e = 'ACTOR_REQUIRED', e);
  e := pg_temp.err(format('SELECT ops.set_partner_free_plan_notice(%L, true, %L, NULL, false, %L)',
                          f.p2, 'whatsapp', gen_random_uuid()));
  PERFORM pg_temp.check('36 actor inexistente', e LIKE 'ACTOR_NOT_FOUND%', e);
  e := pg_temp.err(format('SELECT ops.set_partner_free_plan_notice(%L, NULL, %L, NULL, false, %L)', f.p2, 'whatsapp', f.actor_id));
  PERFORM pg_temp.check('37 sin estado pedido', e = 'NOTIFIED_REQUIRED', e);
  e := pg_temp.err(format('SELECT ops.set_partner_free_plan_notice(%L, true, %L, NULL, NULL, %L)', f.p2, 'whatsapp', f.actor_id));
  PERFORM pg_temp.check('38 sin lo visto', e = 'EXPECTED_NOTIFIED_REQUIRED', e);
  PERFORM pg_temp.check('39 ningún error dejó una fila',
    NOT EXISTS (SELECT 1 FROM ops.partner_free_plan_notice WHERE partner_id = f.p2));
  PERFORM pg_temp.check('40 no toca partners',
    (SELECT status::text = 'paused' FROM partners WHERE id = f.p2));
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

PREPARE p042_set AS
  SELECT ops.set_partner_free_plan_notice(
           p_partner_id => $1, p_notified => $2, p_channel => $3,
           p_note => $4, p_expected_notified => $5, p_actor_id => $6) AS r;

CREATE TEMP TABLE t_int ON COMMIT DROP AS
  EXECUTE p042_set(pg_temp.fix('p2')::uuid, true, 'whatsapp', NULL, false, pg_temp.fix('actor_id')::uuid);

DO $$
DECLARE v_r jsonb;
BEGIN
  SELECT r INTO v_r FROM t_int;
  PERFORM pg_temp.check('60 integración: parámetros sin tipo', (v_r->>'changed')::boolean, v_r::text);
END $$;

DEALLOCATE p042_set;

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
