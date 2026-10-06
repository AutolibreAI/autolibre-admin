-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 022 — presupuestos detallados por ítems.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/022_ops_items_de_presupuesto.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK. Crea su propio actor y su propio
-- pedido. Si la 022 no está aplicada en la base, pegar su cuerpo después del
-- BEGIN (necesita la 015).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS qr_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-022-' || actor_id || '@example.invalid', 'admin'::user_role,
       'clerk'::auth_provider, 'test-022-' || actor_id
  FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission)
SELECT qr_id, 'whatsapp', '5491100000022', 'AB123CD', 'Test 022: frenos', '{}'::jsonb
  FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;
CREATE TEMP TABLE t_resp (id uuid) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle);
$$;

-- Forma: UNA sola firma de cada función (la trampa de la 009).
SELECT pg_temp.check('01 una sola add_quote_request_response',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ops' AND p.proname = 'add_quote_request_response') = 1);
SELECT pg_temp.check('02 una sola update_quote_request_response',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ops' AND p.proname = 'update_quote_request_response') = 1);
SELECT pg_temp.check('03 SECURITY INVOKER + search_path fijo',
  (SELECT bool_and(NOT p.prosecdef AND p.proconfig IS NOT NULL)
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ops'
      AND p.proname IN ('add_quote_request_response', 'update_quote_request_response',
                        '_normalize_quote_response_items', '_quote_response_items_total')));

DO $$
DECLARE
  v_actor uuid := (SELECT actor_id FROM t_fix);
  v_qr    uuid := (SELECT qr_id FROM t_fix);
  v_res   jsonb;
  v_id    uuid;
  v_msg   text;
BEGIN
  -- 04 · sin ítems sigue igual que la 015 (llamada sin p_items)
  v_res := ops.add_quote_request_response(
    p_quote_request_id => v_qr, p_actor_id => v_actor, p_detail => 'Sin desglose',
    p_provider_name => 'Taller A', p_amount_min => 1000, p_amount_max => 2000);
  PERFORM pg_temp.check('04 sin ítems: rango de la 015 intacto',
    (v_res->>'amount_min')::numeric = 1000 AND (v_res->>'amount_max')::numeric = 2000 AND v_res->'items' = 'null'::jsonb);

  -- 05 · con ítems: total = suma de los obligatorios; los opcionales no suman
  v_res := ops.add_quote_request_response(
    p_quote_request_id => v_qr, p_actor_id => v_actor, p_detail => 'Con desglose',
    p_provider_name => 'Taller B', p_amount_min => 1, p_amount_max => 1,
    p_items => '[{"label":" Pastillas ","amount":60000},{"label":"Mano de obra","amount":40000.5,"optional":false},{"label":"Rectificar discos","amount":35000,"optional":true}]'::jsonb);
  v_id := (v_res->>'id')::uuid;
  INSERT INTO t_resp VALUES (v_id);
  PERFORM pg_temp.check('05 total = suma de los NO opcionales (ignora p_amount_*)',
    (v_res->>'amount_min')::numeric = 100000.50 AND (v_res->>'amount_max')::numeric = 100000.50,
    v_res->>'amount_min');
  PERFORM pg_temp.check('06 ítems normalizados (label recortado, optional default false)',
    v_res->'items'->0->>'label' = 'Pastillas'
      AND (v_res->'items'->0->>'optional')::boolean = false
      AND (v_res->'items'->2->>'optional')::boolean = true
      AND jsonb_array_length(v_res->'items') = 3);

  -- 07 · sólo opcionales: sin precio base
  v_res := ops.add_quote_request_response(
    p_quote_request_id => v_qr, p_actor_id => v_actor, p_detail => 'Sólo extras',
    p_provider_name => 'Taller C',
    p_items => '[{"label":"Lavado","amount":5000,"optional":true}]'::jsonb);
  PERFORM pg_temp.check('07 sólo opcionales: amount NULL',
    v_res->'amount_min' = 'null'::jsonb AND v_res->'amount_max' = 'null'::jsonb);

  -- 08 · ítem de $0 obligatorio: "sin cargo" es representable
  v_res := ops.add_quote_request_response(
    p_quote_request_id => v_qr, p_actor_id => v_actor, p_detail => 'Diagnóstico',
    p_provider_name => 'Taller D',
    p_items => '[{"label":"Diagnóstico","amount":0}]'::jsonb);
  PERFORM pg_temp.check('08 ítem obligatorio en 0 = sin cargo',
    (v_res->>'amount_min')::numeric = 0);

  -- 09 · `[]` es "sin desglose"
  v_res := ops.add_quote_request_response(
    p_quote_request_id => v_qr, p_actor_id => v_actor, p_detail => 'Vacío',
    p_provider_name => 'Taller E', p_amount_min => 300, p_amount_max => 300, p_items => '[]'::jsonb);
  PERFORM pg_temp.check('09 [] = sin desglose', v_res->'items' = 'null'::jsonb AND (v_res->>'amount_min')::numeric = 300);

  -- 10-14 · rechazos
  BEGIN
    PERFORM ops.add_quote_request_response(p_quote_request_id => v_qr, p_actor_id => v_actor, p_detail => 'x',
      p_provider_name => 'T', p_items => '[{"label":"","amount":10}]'::jsonb);
    v_msg := 'no tiró';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  PERFORM pg_temp.check('10 ITEM_LABEL_REQUIRED', v_msg LIKE 'ITEM_LABEL_REQUIRED%', v_msg);

  BEGIN
    PERFORM ops.add_quote_request_response(p_quote_request_id => v_qr, p_actor_id => v_actor, p_detail => 'x',
      p_provider_name => 'T', p_items => '[{"label":"a","amount":-1}]'::jsonb);
    v_msg := 'no tiró';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  PERFORM pg_temp.check('11 INVALID_ITEM_AMOUNT negativo', v_msg LIKE 'INVALID_ITEM_AMOUNT%', v_msg);

  BEGIN
    PERFORM ops.add_quote_request_response(p_quote_request_id => v_qr, p_actor_id => v_actor, p_detail => 'x',
      p_provider_name => 'T', p_items => '[{"label":"a","amount":"10"}]'::jsonb);
    v_msg := 'no tiró';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  PERFORM pg_temp.check('12 INVALID_ITEM_AMOUNT no numérico', v_msg LIKE 'INVALID_ITEM_AMOUNT%', v_msg);

  BEGIN
    PERFORM ops.add_quote_request_response(p_quote_request_id => v_qr, p_actor_id => v_actor, p_detail => 'x',
      p_provider_name => 'T', p_items => '{"label":"a"}'::jsonb);
    v_msg := 'no tiró';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  PERFORM pg_temp.check('13 INVALID_ITEMS no array', v_msg LIKE 'INVALID_ITEMS%', v_msg);

  BEGIN
    PERFORM ops.add_quote_request_response(p_quote_request_id => v_qr, p_actor_id => v_actor, p_detail => 'x',
      p_provider_name => 'T',
      p_items => '[{"label":"a","amount":9999999999},{"label":"b","amount":9999999999}]'::jsonb);
    v_msg := 'no tiró';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  PERFORM pg_temp.check('14 AMOUNT_TOO_LARGE en la suma', v_msg LIKE 'AMOUNT_TOO_LARGE%', v_msg);

  -- 15 · edición: reemplazo completo, cambia el total
  v_res := ops.update_quote_request_response(
    p_id => v_id, p_actor_id => v_actor, p_detail => 'Con desglose, corregido',
    p_provider_name => 'Taller B',
    p_items => '[{"label":"Pastillas","amount":70000}]'::jsonb);
  PERFORM pg_temp.check('15 edición recalcula el total',
    (v_res->>'amount_min')::numeric = 70000 AND jsonb_array_length(v_res->'items') = 1);

  -- 16 · log de la edición con before/after que traen los ítems
  PERFORM pg_temp.check('16 log con ítems en before y after',
    EXISTS (SELECT 1 FROM ops.action_log
             WHERE action = 'quote_request_response.update' AND target_id = v_id
               AND jsonb_array_length(before->'items') = 3 AND jsonb_array_length(after->'items') = 1));

  -- 17 · edición sin ítems: borra el desglose y vuelve al precio manual
  v_res := ops.update_quote_request_response(
    p_id => v_id, p_actor_id => v_actor, p_detail => 'Sin desglose ahora',
    p_provider_name => 'Taller B', p_amount_min => 50000, p_amount_max => 50000);
  PERFORM pg_temp.check('17 sin p_items borra el desglose',
    v_res->'items' = 'null'::jsonb AND (v_res->>'amount_min')::numeric = 50000);

  -- 18 · CHECK de la tabla: un array vacío no entra por fuera del SP
  BEGIN
    UPDATE ops.quote_request_response SET items = '[]'::jsonb WHERE id = v_id;
    v_msg := 'no tiró';
  EXCEPTION WHEN check_violation THEN v_msg := 'check';
  END;
  PERFORM pg_temp.check('18 CHECK rechaza []', v_msg = 'check', v_msg);
END;
$$;

-- 19 · integración: el SQL exacto de `quote-responses.repo.ts`, con PREPARE sin tipos.
CREATE OR REPLACE FUNCTION pg_temp.fix_qr() RETURNS uuid LANGUAGE sql AS $$ SELECT qr_id FROM t_fix $$;
CREATE OR REPLACE FUNCTION pg_temp.fix_actor() RETURNS uuid LANGUAGE sql AS $$ SELECT actor_id FROM t_fix $$;

PREPARE p022_add AS
  SELECT ops.add_quote_request_response(
       p_quote_request_id => $1,
       p_actor_id         => $2,
       p_detail           => $3,
       p_partner_id       => $4,
       p_provider_name    => $5,
       p_provider_address => $6,
       p_provider_phone   => $7,
       p_amount_min       => $8,
       p_amount_max       => $9,
       p_currency         => $10,
       p_valid_until      => $11,
       p_internal_notes   => $12,
       p_note             => $13,
       p_items            => $14
     ) AS r;

CREATE TEMP TABLE t_p022 ON COMMIT DROP AS
EXECUTE p022_add(
  pg_temp.fix_qr(), pg_temp.fix_actor(), 'Integración', NULL, 'Taller F', NULL, NULL,
  NULL, NULL, 'ARS', NULL, NULL, NULL,
  '[{"label":"Service","amount":120000},{"label":"Filtro de aire","amount":15000,"optional":true}]');
SELECT pg_temp.check('19 integración con PREPARE sin tipos',
  (SELECT (r->>'amount_min')::numeric = 120000 AND jsonb_array_length(r->'items') = 2 FROM t_p022));
DEALLOCATE p022_add;

SELECT caso, ok, detalle FROM t_result ORDER BY caso;
SELECT count(*) FILTER (WHERE ok) AS ok, count(*) AS total FROM t_result;

ROLLBACK;
