-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 044 (paquetes de trabajos).
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/044_ops_paquetes_de_trabajos.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea su propio actor, partner y
-- pedidos. Nunca `ORDER BY created_at` sobre los logs (now() es constante).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id, gen_random_uuid() AS p1,
       gen_random_uuid() AS q1, gen_random_uuid() AS q2, gen_random_uuid() AS q3;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-044-' || actor_id || '@example.invalid', 'admin'::user_role, 'clerk'::auth_provider,
       'test-044-' || actor_id FROM t_fix;
INSERT INTO partners (id, name, coverage_zone, status, tier)
SELECT p1, 'Taller 044', 'Zona Norte', 'active'::partner_status, 'standard'::partner_tier FROM t_fix;
INSERT INTO quote_requests (id) SELECT q1 FROM t_fix UNION ALL SELECT q2 FROM t_fix UNION ALL SELECT q3 FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;
CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$ INSERT INTO t_result VALUES (p_caso, coalesce(p_ok, false), p_detalle); $$;
CREATE OR REPLACE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END; $$;

DO $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
  f record;
  v_pkg jsonb;
  v_id uuid;
  v_e text;
  v_n int;
BEGIN
  SELECT * INTO f FROM t_fix;

  -- 01–05 alta y validaciones
  v_pkg := ops.create_partner_job_package(f.p1, 2, 90, (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
                                          50000, 'transferencia', ' ', f.actor_id);
  v_id := (v_pkg->>'id')::uuid;
  PERFORM pg_temp.check('01 alta', v_pkg->>'jobs' = '2' AND v_pkg->>'note' IS NULL, v_pkg::text);
  PERFORM pg_temp.check('02 vence = compra + vigencia',
    (v_pkg->>'expires_on')::date = (v_pkg->>'purchased_on')::date + 90, v_pkg::text);
  v_e := pg_temp.err(format('select ops.create_partner_job_package(%L, 0, 90, %L::date, 1, %L, null, %L)', f.p1, v_today, 'efectivo', f.actor_id));
  PERFORM pg_temp.check('03 trabajos inválidos', v_e LIKE 'INVALID_PACKAGE_JOBS%', v_e);
  v_e := pg_temp.err(format('select ops.create_partner_job_package(%L, 5, 90, %L::date + 10, 1, %L, null, %L)', f.p1, v_today, 'efectivo', f.actor_id));
  PERFORM pg_temp.check('04 compra futura', v_e LIKE 'PACKAGE_PURCHASED_ON_IN_FUTURE%', v_e);
  v_e := pg_temp.err(format('select ops.create_partner_job_package(%L, 5, 90, %L::date, 1, %L, null, %L)', f.p1, v_today, 'cheque', f.actor_id));
  PERFORM pg_temp.check('05 medio inválido', v_e LIKE 'INVALID_PAYMENT_METHOD%', v_e);

  -- 10–14 imputación y saldo
  PERFORM ops.allocate_job_to_package(f.q1, v_id, f.actor_id);
  PERFORM ops.allocate_job_to_package(f.q1, v_id, f.actor_id); -- mismo: no-op
  SELECT count(*) INTO v_n FROM ops.partner_job_package_allocation WHERE quote_request_id = f.q1;
  PERFORM pg_temp.check('10 imputar es idempotente', v_n = 1, v_n::text);
  PERFORM ops.allocate_job_to_package(f.q2, v_id, f.actor_id);
  v_e := pg_temp.err(format('select ops.allocate_job_to_package(%L, %L, %L)', f.q3, v_id, f.actor_id));
  PERFORM pg_temp.check('11 sin saldo', v_e LIKE 'PACKAGE_EXHAUSTED%', v_e);
  v_e := pg_temp.err(format('select ops.void_partner_job_package(%L, %L, %L)', v_id, 'error', f.actor_id));
  PERFORM pg_temp.check('12 no se anula con imputaciones', v_e LIKE 'PACKAGE_HAS_ALLOCATIONS%', v_e);

  -- 20–24 deshacer, marca, reabrir
  v_e := pg_temp.err(format('select ops.undo_job_package_allocation(%L, %L, %L, %L)', f.q1, v_id, ' ', f.actor_id));
  PERFORM pg_temp.check('20 deshacer exige motivo', v_e LIKE 'ALLOCATION_UNDO_REASON_REQUIRED%', v_e);
  PERFORM ops.undo_job_package_allocation(f.q1, v_id, 'se atribuyó mal', f.actor_id);
  SELECT count(*) INTO v_n FROM ops.partner_job_package_allocation WHERE quote_request_id = f.q1 AND undone_at IS NULL;
  PERFORM pg_temp.check('21 deshecha, no borrada', v_n = 0
    AND EXISTS (SELECT 1 FROM ops.partner_job_package_allocation WHERE quote_request_id = f.q1), v_n::text);
  PERFORM ops.undo_job_package_allocation(f.q3, v_id, 'no va a paquete', f.actor_id);
  PERFORM pg_temp.check('22 rechazar una propuesta deja la marca',
    EXISTS (SELECT 1 FROM ops.partner_job_package_allocation WHERE quote_request_id = f.q3 AND undone_at IS NOT NULL), NULL);
  PERFORM ops.reopen_job_package_allocation(f.q3, f.actor_id);
  PERFORM pg_temp.check('23 reabrir marca reopened_at',
    NOT EXISTS (SELECT 1 FROM ops.partner_job_package_allocation WHERE quote_request_id = f.q3 AND reopened_at IS NULL), NULL);

  -- 30–32 anular
  PERFORM ops.undo_job_package_allocation(f.q2, v_id, 'error', f.actor_id);
  v_e := pg_temp.err(format('select ops.void_partner_job_package(%L, %L, %L)', v_id, '', f.actor_id));
  PERFORM pg_temp.check('30 anular exige motivo', v_e LIKE 'PACKAGE_VOID_REASON_REQUIRED%', v_e);
  v_pkg := ops.void_partner_job_package(v_id, 'cargado por error', f.actor_id);
  PERFORM pg_temp.check('31 anulado, no borrado', v_pkg->>'voided_at' IS NOT NULL, v_pkg::text);
  v_e := pg_temp.err(format('select ops.allocate_job_to_package(%L, %L, %L)', f.q2, v_id, f.actor_id));
  PERFORM pg_temp.check('32 no se imputa a un anulado', v_e LIKE 'PACKAGE_VOIDED%', v_e);
  SELECT count(*) INTO v_n FROM ops.action_log WHERE action LIKE 'partner_job_package.%';
  PERFORM pg_temp.check('33 todo pasa por action_log', v_n >= 8, v_n::text);
END $$;

SELECT caso, CASE WHEN ok THEN 'PASA' ELSE 'FALLA' END AS estado, detalle FROM t_result ORDER BY caso;
SELECT count(*) FILTER (WHERE ok) AS pasaron, count(*) FILTER (WHERE NOT ok) AS fallaron, count(*) AS total FROM t_result;

ROLLBACK;
