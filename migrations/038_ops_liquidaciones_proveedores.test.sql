-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 038 (liquidaciones a proveedores).
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/038_ops_liquidaciones_proveedores.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea su propio actor, partners y
-- pedidos. Nunca `ORDER BY created_at` sobre los logs: adentro de la
-- transacción `now()` es constante.
--
-- Los fixtures de `quote_requests` sólo llenan `id`: corre contra una réplica
-- mínima (PGlite). Contra una base real, insertar pedidos exige sus NOT NULL:
-- usar el probe del repo en vez de esta suite.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS partner_a,
       gen_random_uuid() AS partner_b,
       gen_random_uuid() AS q1,
       gen_random_uuid() AS q2,
       gen_random_uuid() AS q3;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-038-' || actor_id || '@example.invalid', 'admin'::user_role,
       'clerk'::auth_provider, 'test-038-' || actor_id
  FROM t_fix;

INSERT INTO partners (id, name, status)
SELECT partner_a, 'Taller 038 A', 'active'::partner_status FROM t_fix
UNION ALL
SELECT partner_b, 'Taller 038 B', 'active'::partner_status FROM t_fix;

INSERT INTO quote_requests (id)
SELECT q1 FROM t_fix UNION ALL SELECT q2 FROM t_fix UNION ALL SELECT q3 FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle);
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

CREATE OR REPLACE FUNCTION pg_temp.fix(p_col text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  EXECUTE format('SELECT %I::text FROM t_fix', p_col) INTO v;
  RETURN v;
END;
$$;

-- Llamada corta a set_partner_fee_charges con lo que la mayoría de los casos usa.
CREATE OR REPLACE FUNCTION pg_temp.charge(
  p_ids text, p_partner text, p_status text, p_amount numeric DEFAULT NULL,
  p_paid date DEFAULT NULL, p_method text DEFAULT NULL, p_note text DEFAULT NULL, p_void text DEFAULT NULL
) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  RETURN pg_temp.err(format(
    'SELECT ops.set_partner_fee_charges(%s, %L::uuid, %L, %L::numeric, %L::date, %L, %L, %L, %L::uuid)',
    p_ids, p_partner, p_status, p_amount, p_paid, p_method, p_note, p_void, pg_temp.fix('actor_id')));
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
   WHERE n.nspname = 'ops' AND p.proname IN ('set_partner_fee_attribution', 'set_partner_fee_charges');
  PERFORM pg_temp.check('01 dos SP, sin sobrecargas', v_n = 2, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname IN ('set_partner_fee_attribution', 'set_partner_fee_charges')
     AND (p.prosecdef OR p.proconfig IS NULL OR NOT EXISTS (
          SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'));
  PERFORM pg_temp.check('02 SECURITY INVOKER y search_path fijo', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'ops' AND c.contype = 'f'
     AND t.relname IN ('partner_fee_attribution', 'partner_fee_charge');
  PERFORM pg_temp.check('03 ninguna FK (guardrail 6)', v_n = 0, v_n::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Atribución
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_r jsonb; v_n int; v_e text;
BEGIN
  v_r := ops.set_partner_fee_attribution(pg_temp.fix('q1')::uuid, pg_temp.fix('partner_a')::uuid,
                                          '  Fue a Taller A, dice la nota  ', pg_temp.fix('actor_id')::uuid);
  PERFORM pg_temp.check('10 atribuye', v_r->>'partner_id' = pg_temp.fix('partner_a'), v_r::text);
  PERFORM pg_temp.check('11 recorta la nota', v_r->>'note' = 'Fue a Taller A, dice la nota', v_r->>'note');

  SELECT count(*) INTO v_n FROM ops.action_log
   WHERE action = 'partner_fee.attribute' AND target_id = pg_temp.fix('q1')::uuid;
  PERFORM pg_temp.check('12 loguea', v_n = 1, v_n::text);

  PERFORM ops.set_partner_fee_attribution(pg_temp.fix('q1')::uuid, pg_temp.fix('partner_a')::uuid,
                                          'Fue a Taller A, dice la nota', pg_temp.fix('actor_id')::uuid);
  SELECT count(*) INTO v_n FROM ops.action_log
   WHERE action = 'partner_fee.attribute' AND target_id = pg_temp.fix('q1')::uuid;
  PERFORM pg_temp.check('13 lo mismo no loguea', v_n = 1, v_n::text);

  v_e := pg_temp.err(format('SELECT ops.set_partner_fee_attribution(%L::uuid, %L::uuid, NULL, %L::uuid)',
                            gen_random_uuid(), pg_temp.fix('partner_a'), pg_temp.fix('actor_id')));
  PERFORM pg_temp.check('14 pedido inexistente', v_e LIKE 'QUOTE_REQUEST_NOT_FOUND%', v_e);

  v_e := pg_temp.err(format('SELECT ops.set_partner_fee_attribution(%L::uuid, %L::uuid, NULL, %L::uuid)',
                            pg_temp.fix('q1'), gen_random_uuid(), pg_temp.fix('actor_id')));
  PERFORM pg_temp.check('15 partner inexistente', v_e LIKE 'PARTNER_NOT_FOUND%', v_e);

  v_e := pg_temp.err(format('SELECT ops.set_partner_fee_attribution(%L::uuid, %L::uuid, NULL, NULL)',
                            pg_temp.fix('q1'), pg_temp.fix('partner_a')));
  PERFORM pg_temp.check('16 sin actor', v_e LIKE 'ACTOR_REQUIRED%', v_e);

  v_r := ops.set_partner_fee_attribution(pg_temp.fix('q2')::uuid, pg_temp.fix('partner_b')::uuid, NULL,
                                          pg_temp.fix('actor_id')::uuid);
  v_r := ops.set_partner_fee_attribution(pg_temp.fix('q2')::uuid, NULL, NULL, pg_temp.fix('actor_id')::uuid);
  SELECT count(*) INTO v_n FROM ops.partner_fee_attribution WHERE quote_request_id = pg_temp.fix('q2')::uuid;
  PERFORM pg_temp.check('17 NULL quita la atribución', v_n = 0 AND v_r IS NULL, v_n::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Cobro
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_e text; v_c ops.partner_fee_charge%ROWTYPE; v_n int; v_ids text;
BEGIN
  v_ids := format('ARRAY[%L::uuid, %L::uuid]', pg_temp.fix('q1'), pg_temp.fix('q2'));

  v_e := pg_temp.charge(v_ids, pg_temp.fix('partner_a'), 'avisado');
  PERFORM pg_temp.check('20 avisar exige monto', v_e LIKE 'FEE_AMOUNT_REQUIRED%', v_e);

  v_e := pg_temp.charge(v_ids, pg_temp.fix('partner_a'), 'raro', 20000);
  PERFORM pg_temp.check('21 estado inválido', v_e LIKE 'INVALID_FEE_STATUS%', v_e);

  v_e := pg_temp.charge('ARRAY[]::uuid[]', pg_temp.fix('partner_a'), 'avisado', 20000);
  PERFORM pg_temp.check('22 lista vacía', v_e LIKE 'FEE_JOBS_REQUIRED%', v_e);

  v_e := pg_temp.charge(format('ARRAY[%L::uuid, %L::uuid]', pg_temp.fix('q1'), pg_temp.fix('q1')),
                        pg_temp.fix('partner_a'), 'avisado', 20000);
  PERFORM pg_temp.check('23 duplicados', v_e LIKE 'FEE_DUPLICATE_JOBS%', v_e);

  v_e := pg_temp.charge(format('ARRAY[%L::uuid, %L::uuid]', pg_temp.fix('q1'), gen_random_uuid()),
                        pg_temp.fix('partner_a'), 'avisado', 20000);
  SELECT count(*) INTO v_n FROM ops.partner_fee_charge WHERE quote_request_id = pg_temp.fix('q1')::uuid;
  PERFORM pg_temp.check('24 un pedido inexistente aborta todo', v_e LIKE 'QUOTE_REQUEST_NOT_FOUND%' AND v_n = 0,
                        coalesce(v_e, 'sin error') || ' / ' || v_n);

  v_e := pg_temp.charge(v_ids, pg_temp.fix('partner_a'), 'avisado', 20000);
  SELECT * INTO v_c FROM ops.partner_fee_charge WHERE quote_request_id = pg_temp.fix('q1')::uuid;
  PERFORM pg_temp.check('25 avisa: monto congelado y notified_at',
    v_e IS NULL AND v_c.status = 'avisado' AND v_c.amount = 20000 AND v_c.notified_at IS NOT NULL, v_e);

  SELECT count(*) INTO v_n FROM ops.action_log WHERE action = 'partner_fee.set_status'
     AND target_id IN (pg_temp.fix('q1')::uuid, pg_temp.fix('q2')::uuid);
  PERFORM pg_temp.check('26 un log por trabajo', v_n = 2, v_n::text);

  v_e := pg_temp.charge(v_ids, pg_temp.fix('partner_a'), 'avisado', 20000);
  SELECT count(*) INTO v_n FROM ops.action_log WHERE action = 'partner_fee.set_status'
     AND target_id IN (pg_temp.fix('q1')::uuid, pg_temp.fix('q2')::uuid);
  PERFORM pg_temp.check('27 repetir no loguea', v_n = 2, v_n::text);

  v_e := pg_temp.charge(v_ids, pg_temp.fix('partner_a'), 'cobrado', 20000);
  PERFORM pg_temp.check('28 cobrar exige fecha', v_e LIKE 'FEE_PAID_ON_REQUIRED%', v_e);

  v_e := pg_temp.charge(v_ids, pg_temp.fix('partner_a'), 'cobrado', 20000, current_date - 1, 'cheque');
  PERFORM pg_temp.check('29 medio inválido', v_e LIKE 'INVALID_PAYMENT_METHOD%', v_e);

  v_e := pg_temp.charge(v_ids, pg_temp.fix('partner_a'), 'cobrado', 20000, current_date + 30, 'efectivo');
  PERFORM pg_temp.check('30 fecha futura', v_e LIKE 'FEE_PAID_ON_IN_FUTURE%', v_e);

  v_e := pg_temp.charge(v_ids, pg_temp.fix('partner_a'), 'cobrado', 20000, current_date - 1, 'mercado_pago', ' por MP ');
  SELECT * INTO v_c FROM ops.partner_fee_charge WHERE quote_request_id = pg_temp.fix('q1')::uuid;
  PERFORM pg_temp.check('31 cobra: fecha, medio y nota; conserva notified_at',
    v_e IS NULL AND v_c.status = 'cobrado' AND v_c.payment_method = 'mercado_pago'
    AND v_c.paid_on = current_date - 1 AND v_c.note = 'por MP' AND v_c.notified_at IS NOT NULL, v_e);

  v_e := pg_temp.err(format('SELECT ops.set_partner_fee_attribution(%L::uuid, %L::uuid, NULL, %L::uuid)',
                            pg_temp.fix('q1'), pg_temp.fix('partner_b'), pg_temp.fix('actor_id')));
  PERFORM pg_temp.check('32 no se reatribuye un cobrado', v_e LIKE 'FEE_ALREADY_CHARGED%', v_e);

  v_e := pg_temp.charge(format('ARRAY[%L::uuid]', pg_temp.fix('q1')), pg_temp.fix('partner_b'), 'avisado', 20000);
  PERFORM pg_temp.check('33 no se cobra a otro proveedor', v_e LIKE 'FEE_ALREADY_CHARGED%', v_e);

  v_e := pg_temp.charge(format('ARRAY[%L::uuid]', pg_temp.fix('q3')), pg_temp.fix('partner_a'), 'anulado');
  PERFORM pg_temp.check('34 anular exige motivo', v_e LIKE 'FEE_VOID_REASON_REQUIRED%', v_e);

  v_e := pg_temp.charge(format('ARRAY[%L::uuid]', pg_temp.fix('q3')), pg_temp.fix('partner_a'), 'anulado',
                        NULL, NULL, NULL, NULL, 'No reconoce el trabajo');
  SELECT * INTO v_c FROM ops.partner_fee_charge WHERE quote_request_id = pg_temp.fix('q3')::uuid;
  PERFORM pg_temp.check('35 anula sin monto previo', v_e IS NULL AND v_c.status = 'anulado'
    AND v_c.void_reason = 'No reconoce el trabajo' AND v_c.amount IS NULL, v_e);

  v_e := pg_temp.charge(format('ARRAY[%L::uuid]', pg_temp.fix('q2')), pg_temp.fix('partner_a'), 'anulado',
                        NULL, NULL, NULL, NULL, 'Disputa');
  SELECT * INTO v_c FROM ops.partner_fee_charge WHERE quote_request_id = pg_temp.fix('q2')::uuid;
  PERFORM pg_temp.check('36 anular un avisado conserva el monto', v_e IS NULL AND v_c.amount = 20000, v_e);

  v_e := pg_temp.charge(format('ARRAY[%L::uuid]', pg_temp.fix('q1')), pg_temp.fix('partner_a'), 'pendiente');
  SELECT count(*) INTO v_n FROM ops.partner_fee_charge WHERE quote_request_id = pg_temp.fix('q1')::uuid;
  PERFORM pg_temp.check('37 volver a pendiente borra la fila', v_e IS NULL AND v_n = 0, v_e);

  v_e := pg_temp.err(format('SELECT ops.set_partner_fee_attribution(%L::uuid, %L::uuid, NULL, %L::uuid)',
                            pg_temp.fix('q1'), pg_temp.fix('partner_b'), pg_temp.fix('actor_id')));
  PERFORM pg_temp.check('38 en pendiente sí se reatribuye', v_e IS NULL, v_e);

  v_e := pg_temp.err(format(
    'INSERT INTO ops.partner_fee_charge (quote_request_id, partner_id, status, updated_by) VALUES (%L, %L, %L, %L)',
    gen_random_uuid(), pg_temp.fix('partner_a'), 'cobrado', pg_temp.fix('actor_id')));
  PERFORM pg_temp.check('39 CHECK: cobrado sin datos no entra', v_e LIKE '%chk_ops_pfc_paid%', v_e);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL exacto del repo, con parámetros sin tipo
-- ═══════════════════════════════════════════════════════════════════════════

PREPARE p038_attr AS SELECT ops.set_partner_fee_attribution(
  p_quote_request_id => $1, p_partner_id => $2, p_note => $3, p_actor_id => $4) AS r;
PREPARE p038_charge AS SELECT ops.set_partner_fee_charges(
  p_quote_request_ids => $1, p_partner_id => $2, p_status => $3, p_amount => $4,
  p_paid_on => $5, p_payment_method => $6, p_note => $7, p_void_reason => $8, p_actor_id => $9) AS n;

CREATE TEMP TABLE t_int1 ON COMMIT DROP AS
  EXECUTE p038_attr(pg_temp.fix('q3')::uuid, pg_temp.fix('partner_a')::uuid, 'integración', pg_temp.fix('actor_id')::uuid);
CREATE TEMP TABLE t_int2 ON COMMIT DROP AS
  EXECUTE p038_charge(ARRAY[pg_temp.fix('q3')::uuid], pg_temp.fix('partner_a')::uuid, 'avisado', 20000, NULL, NULL, NULL, NULL,
                      pg_temp.fix('actor_id')::uuid);

DO $$
DECLARE v_r jsonb; v_n int;
BEGIN
  SELECT r INTO v_r FROM t_int1;
  PERFORM pg_temp.check('60 integración: atribuir', v_r->>'partner_id' = pg_temp.fix('partner_a'), v_r::text);
  SELECT n INTO v_n FROM t_int2;
  PERFORM pg_temp.check('61 integración: avisar', v_n = 1, v_n::text);
END $$;

DEALLOCATE p038_attr;
DEALLOCATE p038_charge;

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
