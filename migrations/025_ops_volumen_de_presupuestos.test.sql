-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 025 — presupuestos por proveedor.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/025_ops_volumen_de_presupuestos.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK. Crea su propio actor, tres partners,
-- tres pedidos (uno cerrado como `duplicate`) y filas en las DOS tablas. Como
-- la función agrega TODA la base, cada aserción mira sólo las filas de estos
-- fixtures (por `partner_id` o por el nombre de los talleres de afuera).
-- Si la 025 no está aplicada en la base, pegar su cuerpo después del BEGIN.
-- Necesita la 015 de ops y la 0120–0122 del backend.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS p1,      -- standard, activo
       gen_random_uuid() AS p2,      -- founding
       gen_random_uuid() AS p3,      -- MISMO nombre que p1
       gen_random_uuid() AS q1,      -- abierto
       gen_random_uuid() AS q2,      -- abierto
       gen_random_uuid() AS q3,      -- cerrado como duplicate (prueba del equipo)
       gen_random_uuid() AS s1,
       gen_random_uuid() AS s2,
       gen_random_uuid() AS s3;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-025-' || actor_id || '@example.invalid', 'admin',
       'clerk', 'test-025-' || actor_id
  FROM t_fix;

-- Los casts no son decorativos: en un UNION ALL un literal es `text`, no el enum
-- (misma trampa que la suite de la 018).
INSERT INTO partners (id, name, coverage_zone, status, tier)
SELECT p1, 'Taller Igual 025', 'Zona Norte', 'active'::partner_status, 'standard'::partner_tier FROM t_fix
UNION ALL
SELECT p2, 'Aliado 025', 'Zona Sur', 'active'::partner_status, 'founding'::partner_tier FROM t_fix
UNION ALL
SELECT p3, 'Taller Igual 025', 'Zona Oeste', 'paused'::partner_status, 'standard'::partner_tier FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission)
SELECT q1, 'whatsapp'::quote_request_channel, '5491100000025', 'AA025AA', 'Test 025: pedido 1', '{}'::jsonb FROM t_fix
UNION ALL
SELECT q2, 'web'::quote_request_channel, '5491100000026', 'AB025AB', 'Test 025: pedido 2', '{}'::jsonb FROM t_fix;

INSERT INTO quote_requests (id, channel, contact_phone, plate, description, raw_submission,
                            status, contacted_at, closed_at, close_reason_code)
SELECT q3, 'web', '5491100000027', 'AC025AC', 'Test 025: pedido de prueba', '{}'::jsonb,
       'closed', now(), now(), 'duplicate'
  FROM t_fix;

-- ── Tabla vieja (ops, 015) ──────────────────────────────────────────────────
INSERT INTO ops.quote_request_response
  (quote_request_id, partner_id, actor_id, position, provider_name, provider_phone, detail)
-- p1 en q1, DOS filas: las dos tienen su versión en la tabla nueva → no cuentan
SELECT q1, p1, actor_id, 1, NULL, NULL, 'p1 q1 viejo A' FROM t_fix UNION ALL
SELECT q1, p1, actor_id, 2, NULL, NULL, 'p1 q1 viejo B' FROM t_fix UNION ALL
-- p1 en q2: sólo en la vieja → cuenta
SELECT q2, p1, actor_id, 1, NULL, NULL, 'p1 q2 viejo'   FROM t_fix UNION ALL
-- p2 en q2: en la nueva está RETIRADA → igual es duplicado, no cuenta acá
SELECT q2, p2, actor_id, 2, NULL, NULL, 'p2 q2 viejo'   FROM t_fix UNION ALL
-- p2 en q3 (pedido de prueba) → no cuenta
SELECT q3, p2, actor_id, 1, NULL, NULL, 'p2 q3 viejo'   FROM t_fix UNION ALL
-- p3 en q2: mismo nombre que p1, otro partner → fila propia
SELECT q2, p3, actor_id, 3, NULL, NULL, 'p3 q2 viejo'   FROM t_fix UNION ALL
-- Taller de afuera en q1. En la nueva hay OTRO taller de afuera en q1: con
-- `IS NOT DISTINCT FROM` sobre partner_id esta fila se perdía.
SELECT q1, NULL, actor_id, 3, 'Taller Externo 025', '1100000001', 'ext q1' FROM t_fix UNION ALL
-- El mismo taller de afuera en q2, escrito distinto → se agrupa con el de q1
SELECT q2, NULL, actor_id, 4, '  taller externo 025 ', '1100000001', 'ext q2' FROM t_fix;

-- ── Tabla nueva (public, 0120–0122) ─────────────────────────────────────────
INSERT INTO quote_request_proposal_sends (id, quote_request_id, sent_by)
SELECT s1, q1, actor_id FROM t_fix UNION ALL
SELECT s2, q2, actor_id FROM t_fix UNION ALL
SELECT s3, q3, actor_id FROM t_fix;

INSERT INTO quote_request_proposals
  (quote_request_id, send_id, position, partner_id, provider_name, provider_phone, description, withdrawn_at)
SELECT q1, s1, 1, p1,   NULL::text,         NULL::text,   'p1 q1 nuevo', NULL::timestamptz FROM t_fix UNION ALL
SELECT q1, s1, 2, NULL, 'Otro Externo 025', '1100000002', 'otro ext q1', NULL  FROM t_fix UNION ALL
SELECT q2, s2, 1, p2,   NULL,               NULL,         'p2 q2 retirada', now() FROM t_fix UNION ALL
SELECT q3, s3, 1, p1,   NULL,               NULL,         'p1 q3 prueba', NULL FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, coalesce(p_ok, false), p_detalle);
$$;

-- Lo que devuelve la función, acotado a los fixtures.
CREATE TEMP TABLE t_vol ON COMMIT DROP AS
SELECT v.*
  FROM ops.partner_quote_volume() v, t_fix f
 WHERE v.partner_id IN (f.p1, f.p2, f.p3)
    OR (v.partner_id IS NULL AND lower(btrim(v.partner_name)) IN ('taller externo 025', 'otro externo 025'));

-- ── Forma ──────────────────────────────────────────────────────────────────
SELECT pg_temp.check('01 una sola ops.partner_quote_volume',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ops' AND p.proname = 'partner_quote_volume') = 1);

SELECT pg_temp.check('02 plpgsql, SECURITY INVOKER, STABLE, search_path fijo',
  (SELECT l.lanname = 'plpgsql' AND NOT p.prosecdef AND p.provolatile = 's' AND p.proconfig IS NOT NULL
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'ops' AND p.proname = 'partner_quote_volume'));

-- El motivo de que sea función y no vista: ninguna dependencia registrada
-- sobre las tablas del backend.
SELECT pg_temp.check('03 sin dependencia registrada sobre tablas de public',
  NOT EXISTS (
    SELECT 1 FROM pg_depend d
      JOIN pg_proc p ON p.oid = d.objid
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = 'partner_quote_volume'
       AND d.refobjid IN ('public.quote_request_proposals'::regclass,
                          'public.quote_requests'::regclass,
                          'public.partners'::regclass)));

-- ── Conteos ────────────────────────────────────────────────────────────────
SELECT pg_temp.check('04 p1: 2 pedidos, 2 presupuestos (1 vieja + 1 nueva), sin duplicar q1',
  (SELECT requests = 2 AND quotes = 2 AND withdrawn = 0 AND from_ops = 1 AND from_app = 1
     FROM t_vol, t_fix WHERE partner_id = p1),
  (SELECT row_to_json(t_vol)::text FROM t_vol, t_fix WHERE partner_id = p1));

SELECT pg_temp.check('05 p2: la retirada cuenta aparte y tapa a su copia vieja',
  (SELECT requests = 1 AND quotes = 0 AND withdrawn = 1 AND from_ops = 0 AND from_app = 1
     FROM t_vol, t_fix WHERE partner_id = p2),
  (SELECT row_to_json(t_vol)::text FROM t_vol, t_fix WHERE partner_id = p2));

SELECT pg_temp.check('06 el pedido de prueba (duplicate) no cuenta en ninguna tabla',
  (SELECT coalesce(sum(requests), 0) FROM t_vol, t_fix WHERE partner_id IN (p1, p2)) = 3);

SELECT pg_temp.check('07 mismo nombre, otro partner: p3 tiene su propia fila',
  (SELECT count(*) = 1 AND bool_and(requests = 1 AND quotes = 1 AND status = 'paused')
     FROM t_vol, t_fix WHERE partner_id = p3));

SELECT pg_temp.check('08 taller de afuera NO tapado por otro taller de afuera del mismo pedido',
  (SELECT count(*) = 1 AND bool_and(is_external AND requests = 2 AND quotes = 2 AND from_ops = 2)
     FROM t_vol WHERE lower(btrim(partner_name)) = 'taller externo 025'),
  (SELECT string_agg(row_to_json(t_vol)::text, ' | ') FROM t_vol WHERE partner_id IS NULL));

SELECT pg_temp.check('09 taller de afuera de la nueva cuenta',
  (SELECT count(*) = 1 AND bool_and(is_external AND requests = 1 AND from_app = 1)
     FROM t_vol WHERE lower(btrim(partner_name)) = 'otro externo 025'));

SELECT pg_temp.check('10 tier y status como texto, sin nombre inventado',
  (SELECT tier = 'founding' AND status = 'active' AND partner_name = 'Aliado 025'
     FROM t_vol, t_fix WHERE partner_id = p2));

SELECT pg_temp.check('11 fechas en hora de Buenos Aires, primera <= última',
  (SELECT bool_and(first_quoted_on IS NOT NULL AND first_quoted_on <= last_quoted_on
                   AND last_quoted_on = (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)
     FROM t_vol));

SELECT pg_temp.check('12 cinco filas para los fixtures (p1, p2, p3, dos de afuera)',
  (SELECT count(*) FROM t_vol) = 5);

-- ── ops.partner_proposal_usage_monthly() ───────────────────────────────────
-- La persona eligió la propuesta de p1 en q1.
UPDATE quote_requests q
   SET status = 'answered', contacted_at = now(), answered_at = now(), proposals_count = 2,
       selected_proposal_id = p.id, selected_at = now()
  FROM quote_request_proposals p, t_fix f
 WHERE q.id = f.q1 AND p.quote_request_id = f.q1 AND p.partner_id = f.p1;

CREATE TEMP TABLE t_month ON COMMIT DROP AS
SELECT m.*
  FROM ops.partner_proposal_usage_monthly() m, t_fix f
 WHERE m.partner_id IN (f.p1, f.p2, f.p3)
    OR (m.partner_id IS NULL AND lower(btrim(m.partner_name)) IN ('taller externo 025', 'otro externo 025'));

SELECT pg_temp.check('20 mensual: una sola firma, plpgsql, SECURITY INVOKER, STABLE, search_path fijo',
  (SELECT count(*) = 1
          AND bool_and(l.lanname = 'plpgsql' AND NOT p.prosecdef AND p.provolatile = 's' AND p.proconfig IS NOT NULL)
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'ops' AND p.proname = 'partner_proposal_usage_monthly'));

SELECT pg_temp.check('21 mensual: el mes es el de hoy en Buenos Aires',
  (SELECT bool_and(month = to_char(now() AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM'))
     FROM t_month));

SELECT pg_temp.check('22 mensual p1: 1 enviada, 1 elegida; el pedido de prueba no cuenta',
  (SELECT count(*) = 1 AND bool_and(sent = 1 AND withdrawn = 0 AND selected = 1)
     FROM t_month, t_fix WHERE partner_id = p1),
  (SELECT string_agg(row_to_json(t_month)::text, ' | ') FROM t_month, t_fix WHERE partner_id = p1));

SELECT pg_temp.check('23 mensual p2: la retirada suma aparte',
  (SELECT count(*) = 1 AND bool_and(sent = 0 AND withdrawn = 1 AND selected = 0)
     FROM t_month, t_fix WHERE partner_id = p2));

SELECT pg_temp.check('24 mensual: sólo la tabla nueva (p3 y el externo viejo no aparecen)',
  (SELECT count(*) FROM t_month, t_fix
    WHERE partner_id = p3 OR lower(btrim(partner_name)) = 'taller externo 025') = 0);

SELECT pg_temp.check('25 mensual: el taller de afuera de la app aparece',
  (SELECT count(*) = 1 AND bool_and(is_external AND sent = 1)
     FROM t_month WHERE lower(btrim(partner_name)) = 'otro externo 025'));

SELECT pg_temp.check('26 mensual: p_from en el futuro no devuelve nada de los fixtures',
  NOT EXISTS (SELECT 1 FROM ops.partner_proposal_usage_monthly(now() + interval '1 day') m, t_fix f
               WHERE m.partner_id IN (f.p1, f.p2)));

-- ── Sin las tablas: sentinela, no un error crudo ───────────────────────────
-- El RENAME se deshace con el ROLLBACK del final.
ALTER TABLE ops.quote_request_response RENAME TO quote_request_response_t025;

DO $$
DECLARE v_msg text;
BEGIN
  BEGIN
    PERFORM * FROM ops.partner_quote_volume();
    v_msg := 'no tiró';
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
  END;
  PERFORM pg_temp.check('13 sin ops.quote_request_response: QUOTE_VOLUME_UNAVAILABLE',
    v_msg LIKE 'QUOTE_VOLUME_UNAVAILABLE:%ops.quote_request_response%', v_msg);
END $$;

ALTER TABLE ops.quote_request_response_t025 RENAME TO quote_request_response;

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
