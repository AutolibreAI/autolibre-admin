-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 039 (comisiones de los comerciales).
-- BEGIN … ROLLBACK, fixtures propios. Pensada para la réplica PGlite (necesita
-- la 035 por `ops.team_member`).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id, gen_random_uuid() AS partner_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-039-' || actor_id || '@example.invalid', 'admin'::user_role, 'clerk'::auth_provider, 'test-039-' || actor_id
  FROM t_fix;
INSERT INTO partners (id, name, status) SELECT partner_id, 'Taller 039', 'active'::partner_status FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;
CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$ INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle); $$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END; $$;

DO $$
DECLARE
  v_actor uuid := (SELECT actor_id FROM t_fix);
  v_partner uuid := (SELECT partner_id FROM t_fix);
  v_tobi uuid := (SELECT id FROM ops.team_member WHERE name = 'Tobías Argonz');
  v_r jsonb; v_e text; v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'set_commercial_commission_payment'
     AND NOT p.prosecdef AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%');
  PERFORM pg_temp.check('01 un SP, INVOKER, search_path', v_n = 1, v_n::text);

  v_e := pg_temp.err(format('SELECT ops.set_commercial_commission_payment(%L, true, %L, %L, 10000, NULL, current_date, NULL, %L)',
                            v_partner, v_tobi, 'raro', v_actor));
  PERFORM pg_temp.check('02 tipo inválido', v_e LIKE 'INVALID_COMMISSION_KIND%', v_e);

  v_e := pg_temp.err(format('SELECT ops.set_commercial_commission_payment(%L, true, %L, %L, 10000, NULL, current_date + 10, NULL, %L)',
                            v_partner, v_tobi, 'primera_cuota', v_actor));
  PERFORM pg_temp.check('03 fecha futura', v_e LIKE 'COMMISSION_PAID_ON_IN_FUTURE%', v_e);

  v_e := pg_temp.err(format('SELECT ops.set_commercial_commission_payment(%L, true, %L, %L, 0, NULL, current_date, NULL, %L)',
                            v_partner, v_tobi, 'primera_cuota', v_actor));
  PERFORM pg_temp.check('04 monto cero', v_e LIKE 'COMMISSION_AMOUNT_REQUIRED%', v_e);

  v_e := pg_temp.err(format('SELECT ops.set_commercial_commission_payment(%L, true, %L, %L, 10000, NULL, current_date, NULL, %L)',
                            v_partner, gen_random_uuid(), 'primera_cuota', v_actor));
  PERFORM pg_temp.check('05 persona inexistente', v_e LIKE 'MEMBER_NOT_FOUND%', v_e);

  v_r := ops.set_commercial_commission_payment(v_partner, true, v_tobi, 'primera_cuota', 10000, ' plus ', current_date, NULL, v_actor);
  PERFORM pg_temp.check('06 paga', v_r->>'kind' = 'primera_cuota' AND v_r->>'reference' = 'plus', v_r::text);

  PERFORM ops.set_commercial_commission_payment(v_partner, true, v_tobi, 'primera_cuota', 10000, 'plus', current_date, NULL, v_actor);
  SELECT count(*) INTO v_n FROM ops.action_log WHERE target_id = v_partner AND action LIKE 'commercial_commission.%';
  PERFORM pg_temp.check('07 repetir no loguea', v_n = 1, v_n::text);

  PERFORM ops.set_commercial_commission_payment(v_partner, false, NULL, NULL, NULL, NULL, NULL, 'error', v_actor);
  SELECT count(*) INTO v_n FROM ops.commercial_commission_payment WHERE partner_id = v_partner;
  PERFORM pg_temp.check('08 volver a pendiente borra', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n FROM ops.action_log WHERE target_id = v_partner AND action = 'commercial_commission.unpay';
  PERFORM pg_temp.check('09 y loguea', v_n = 1, v_n::text);
END $$;

PREPARE p039 AS SELECT ops.set_commercial_commission_payment(
  p_partner_id => $1, p_paid => $2, p_member_id => $3, p_kind => $4, p_amount => $5,
  p_reference => $6, p_paid_on => $7, p_note => $8, p_actor_id => $9) AS r;
CREATE OR REPLACE FUNCTION pg_temp.fix(p_col text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid; BEGIN EXECUTE format('SELECT %I FROM t_fix', p_col) INTO v; RETURN v; END; $$;
CREATE OR REPLACE FUNCTION pg_temp.tobi() RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM ops.team_member WHERE name = 'Tobías Argonz' $$;
CREATE TEMP TABLE t_int ON COMMIT DROP AS
  EXECUTE p039(pg_temp.fix('partner_id'), true, pg_temp.tobi(),
               'fee_primer_trabajo', 20000, 'AL-1259', current_date, NULL, pg_temp.fix('actor_id'));
DO $$ BEGIN
  PERFORM pg_temp.check('60 integración', (SELECT r->>'reference' FROM t_int) = 'AL-1259');
END $$;
DEALLOCATE p039;

SELECT caso, CASE WHEN ok THEN 'PASA' ELSE 'FALLA' END AS estado, detalle FROM t_result ORDER BY caso;
SELECT count(*) FILTER (WHERE ok) AS pasaron, count(*) FILTER (WHERE NOT ok) AS fallaron, count(*) AS total FROM t_result;

ROLLBACK;
