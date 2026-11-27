-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 045 (premios a comerciales) — y de la 043 (revisión
-- de cuentas), que comparten forma.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/045_ops_premios_comerciales.test.sql
--
-- BEGIN … ROLLBACK, con sus propios actor, partner y persona del equipo.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id, gen_random_uuid() AS user_id, gen_random_uuid() AS p1;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-045-a-' || actor_id || '@example.invalid', 'admin'::user_role, 'clerk'::auth_provider,
       'test-045-a-' || actor_id FROM t_fix
UNION ALL
SELECT user_id, 'test-045-u-' || user_id || '@example.invalid', 'user'::user_role, 'clerk'::auth_provider,
       'test-045-u-' || user_id FROM t_fix;
INSERT INTO partners (id, name, coverage_zone, status, tier)
SELECT p1, 'Taller 045', 'Zona Norte', 'active'::partner_status, 'standard'::partner_tier FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;
CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$ INSERT INTO t_result VALUES (p_caso, coalesce(p_ok, false), p_detalle); $$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END; $$;

DO $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
  f record;
  v_m uuid;
  v_f uuid;
  v_r jsonb;
  v_e text;
BEGIN
  SELECT * INTO f FROM t_fix;
  v_m := (ops.create_team_member(f.actor_id, 'Comercial 045', 'comercial', NULL)->>'id')::uuid;
  v_f := (ops.create_team_member(f.actor_id, 'Ramiro Sarasola 045', 'fundador', NULL)->>'id')::uuid;

  -- 01–03 «Cobra premio»
  PERFORM pg_temp.check('01 persona nueva cobra premio',
    (SELECT earns_award FROM ops.team_member WHERE id = v_m), NULL);
  v_r := ops.set_team_member_earns_award(v_f, false, f.actor_id);
  PERFORM pg_temp.check('02 se apaga', (v_r->>'earns_award')::boolean = false, v_r::text);
  PERFORM pg_temp.check('03 fundadores sembrados apagados',
    NOT EXISTS (SELECT 1 FROM ops.team_member WHERE role = 'fundador' AND earns_award AND id <> v_f), NULL);

  -- 10–16 premio
  v_e := pg_temp.err(format('select ops.set_commercial_award(%L, %L, %L, null, null, %L::date, null, null, %L)',
                            f.p1, 'pagado', v_m, v_today, f.actor_id));
  PERFORM pg_temp.check('10 pagado exige monto', v_e LIKE 'AWARD_AMOUNT_REQUIRED%', v_e);
  v_e := pg_temp.err(format('select ops.set_commercial_award(%L, %L, %L, 1000, null, %L::date + 5, null, null, %L)',
                            f.p1, 'pagado', v_m, v_today, f.actor_id));
  PERFORM pg_temp.check('11 fecha futura', v_e LIKE 'AWARD_PAID_ON_IN_FUTURE%', v_e);
  v_r := ops.set_commercial_award(f.p1, 'pagado', v_m, 15000, 'AL-1', v_today, 'ok', NULL, f.actor_id);
  PERFORM pg_temp.check('12 pagado', v_r->>'status' = 'pagado' AND (v_r->>'amount')::numeric = 15000, v_r::text);
  v_e := pg_temp.err(format('select ops.set_commercial_award(%L, %L, %L, null, null, null, null, %L, %L)',
                            f.p1, 'anulado', v_m, ' ', f.actor_id));
  PERFORM pg_temp.check('13 anular exige motivo', v_e LIKE 'AWARD_VOID_REASON_REQUIRED%', v_e);
  v_r := ops.set_commercial_award(f.p1, 'anulado', v_m, NULL, 'AL-1', NULL, NULL, 'no fue de él', f.actor_id);
  PERFORM pg_temp.check('14 anulado limpia monto y fecha',
    v_r->>'status' = 'anulado' AND v_r->>'amount' IS NULL AND v_r->>'paid_on' IS NULL, v_r::text);
  PERFORM ops.set_commercial_award(f.p1, 'pendiente', NULL, NULL, NULL, NULL, NULL, NULL, f.actor_id);
  PERFORM pg_temp.check('15 pendiente borra la fila',
    NOT EXISTS (SELECT 1 FROM ops.commercial_award WHERE partner_id = f.p1), NULL);
  PERFORM pg_temp.check('16 log', EXISTS (SELECT 1 FROM ops.action_log WHERE action = 'commercial_award.reopen'), NULL);

  -- 20–23 043: revisión de cuentas
  v_r := ops.set_account_reviewed(f.user_id, 'possible_partner', true, 'Le escribimos', f.actor_id);
  PERFORM pg_temp.check('20 marcar revisado', v_r->>'kind' = 'possible_partner', v_r::text);
  v_e := pg_temp.err(format('select ops.set_account_reviewed(%L, %L, true, null, %L)', f.user_id, 'otra', f.actor_id));
  PERFORM pg_temp.check('21 tipo inválido', v_e LIKE 'INVALID_REVIEW_KIND%', v_e);
  PERFORM ops.set_account_reviewed(f.user_id, 'possible_partner', false, NULL, f.actor_id);
  PERFORM pg_temp.check('22 volver a pendiente borra',
    NOT EXISTS (SELECT 1 FROM ops.account_review WHERE user_id = f.user_id), NULL);
  v_e := pg_temp.err(format('select ops.set_account_reviewed(%L, %L, true, null, %L)', gen_random_uuid(), 'stale_role', f.actor_id));
  PERFORM pg_temp.check('23 cuenta inexistente', v_e LIKE 'USER_NOT_FOUND%', v_e);
END $$;

SELECT caso, CASE WHEN ok THEN 'PASA' ELSE 'FALLA' END AS estado, detalle FROM t_result ORDER BY caso;
SELECT count(*) FILTER (WHERE ok) AS pasaron, count(*) FILTER (WHERE NOT ok) AS fallaron, count(*) AS total FROM t_result;

ROLLBACK;
