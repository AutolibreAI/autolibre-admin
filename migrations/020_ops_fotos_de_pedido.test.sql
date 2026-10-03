-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 020 — adjuntar fotos a un pedido.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/020_ops_fotos_de_pedido.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK. Crea su propio actor, su propio
-- pedido (con `ops.create_quote_request`, 018/019) y sus propias filas de
-- `files` — sin tocar Spaces: la función sólo referencia, no sube. Si la 020
-- no está aplicada en la base, pegar su cuerpo después del BEGIN.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id,
       gen_random_uuid() AS img_id,
       gen_random_uuid() AS img2_id,
       gen_random_uuid() AS pdf_id,
       gen_random_uuid() AS gif_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-020-' || actor_id || '@example.invalid', 'admin'::user_role, 'clerk'::auth_provider, 'test-020-' || actor_id
  FROM t_fix;

INSERT INTO files (id, user_id, s3_key, mime_type, size_bytes)
SELECT img_id,  actor_id, 'files/test-020/' || img_id  || '/foto.jpg', 'image/jpeg',      1000 FROM t_fix
UNION ALL
SELECT img2_id, actor_id, 'files/test-020/' || img2_id || '/foto.png', 'image/png',       1000 FROM t_fix
UNION ALL
SELECT pdf_id,  actor_id, 'files/test-020/' || pdf_id  || '/doc.pdf',  'application/pdf', 1000 FROM t_fix
UNION ALL
SELECT gif_id,  actor_id, 'files/test-020/' || gif_id  || '/anim.gif', 'image/gif',       1000 FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle);
$$;

-- 01 · forma: una sola firma, SECURITY INVOKER, search_path fijo
SELECT pg_temp.check('01 una sola ops.add_quote_request_file',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ops' AND p.proname = 'add_quote_request_file') = 1);
SELECT pg_temp.check('02 SECURITY INVOKER + search_path fijo',
  (SELECT NOT p.prosecdef AND p.proconfig IS NOT NULL
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ops' AND p.proname = 'add_quote_request_file'));

DO $$
DECLARE
  v_actor uuid := (SELECT actor_id FROM t_fix);
  v_img   uuid := (SELECT img_id FROM t_fix);
  v_img2  uuid := (SELECT img2_id FROM t_fix);
  v_pdf   uuid := (SELECT pdf_id FROM t_fix);
  v_gif   uuid := (SELECT gif_id FROM t_fix);
  v_qr    uuid;
  v_res   jsonb;
  v_res2  jsonb;
  v_msg   text;
  v_logs  int;
BEGIN
  v_qr := (ops.create_quote_request(
    p_actor_id => v_actor, p_channel => 'whatsapp', p_contact_phone => '5491100000020',
    p_description => 'Test 020')->>'id')::uuid;

  -- 03 · camino feliz: foto atada, purpose default problem_photo
  v_res := ops.add_quote_request_file(v_qr, v_img, v_actor);
  PERFORM pg_temp.check('03 foto atada',
    (SELECT count(*) = 1 AND bool_and(purpose::text = 'problem_photo')
       FROM quote_request_files WHERE quote_request_id = v_qr AND file_id = v_img));

  -- 04 · log con before NULL y after la fila
  PERFORM pg_temp.check('04 action_log',
    (SELECT count(*) = 1 AND bool_and(before IS NULL AND after->>'file_id' = v_img::text AND actor_id = v_actor)
       FROM ops.action_log WHERE action = 'add_quote_request_file' AND target_id = (v_res->>'id')::uuid));

  -- 05 · idempotente: misma fila, sin segundo log
  v_res2 := ops.add_quote_request_file(v_qr, v_img, v_actor);
  SELECT count(*) INTO v_logs FROM ops.action_log
   WHERE action = 'add_quote_request_file' AND after->>'quote_request_id' = v_qr::text;
  PERFORM pg_temp.check('05 idempotente', v_res2->>'id' = v_res->>'id' AND v_logs = 1);

  -- 06 · una segunda foto entra aparte
  PERFORM ops.add_quote_request_file(v_qr, v_img2, v_actor);
  PERFORM pg_temp.check('06 segunda foto',
    (SELECT count(*) = 2 FROM quote_request_files WHERE quote_request_id = v_qr));

  -- 07 · un PDF no es una foto del problema
  BEGIN
    PERFORM ops.add_quote_request_file(v_qr, v_pdf, v_actor);
    PERFORM pg_temp.check('07 PDF como foto rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('07 PDF como foto rechazado', v_msg LIKE 'FILE_NOT_IMAGE%', v_msg);
  END;

  -- 07b · un GIF tampoco: la regla es la del backend (jpeg/png/webp), no `image/*`
  BEGIN
    PERFORM ops.add_quote_request_file(v_qr, v_gif, v_actor);
    PERFORM pg_temp.check('07b GIF como foto rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('07b GIF como foto rechazado', v_msg LIKE 'FILE_NOT_IMAGE%', v_msg);
  END;
  BEGIN
    PERFORM ops.add_quote_request_file(v_qr, v_gif, v_actor, 'budget');
    PERFORM pg_temp.check('07c GIF como presupuesto rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('07c GIF como presupuesto rechazado', v_msg LIKE 'FILE_TYPE_NOT_ALLOWED%', v_msg);
  END;

  -- 08 · …pero sí como presupuesto
  PERFORM ops.add_quote_request_file(v_qr, v_pdf, v_actor, 'budget');
  PERFORM pg_temp.check('08 PDF como budget',
    (SELECT purpose::text = 'budget' FROM quote_request_files WHERE quote_request_id = v_qr AND file_id = v_pdf));

  -- 09 · purpose inválido
  BEGIN
    PERFORM ops.add_quote_request_file(v_qr, v_img, v_actor, 'selfie');
    PERFORM pg_temp.check('09 purpose inválido', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('09 purpose inválido', v_msg LIKE 'INVALID_FILE_PURPOSE%', v_msg);
  END;

  -- 10 · archivo inexistente
  BEGIN
    PERFORM ops.add_quote_request_file(v_qr, gen_random_uuid(), v_actor);
    PERFORM pg_temp.check('10 archivo inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('10 archivo inexistente', v_msg LIKE 'FILE_NOT_FOUND%', v_msg);
  END;

  -- 11 · pedido inexistente
  BEGIN
    PERFORM ops.add_quote_request_file(gen_random_uuid(), v_img, v_actor);
    PERFORM pg_temp.check('11 pedido inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('11 pedido inexistente', v_msg LIKE 'QUOTE_REQUEST_NOT_FOUND%', v_msg);
  END;

  -- 12 · actor NULL / inexistente
  BEGIN
    PERFORM ops.add_quote_request_file(v_qr, v_img, NULL);
    PERFORM pg_temp.check('12 actor NULL', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('12 actor NULL', v_msg LIKE 'ACTOR_REQUIRED%', v_msg);
  END;
  BEGIN
    PERFORM ops.add_quote_request_file(v_qr, v_img, gen_random_uuid());
    PERFORM pg_temp.check('13 actor inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('13 actor inexistente', v_msg LIKE 'ACTOR_NOT_FOUND%', v_msg);
  END;

  -- 14 · file_id NULL
  BEGIN
    PERFORM ops.add_quote_request_file(v_qr, NULL, v_actor);
    PERFORM pg_temp.check('14 archivo NULL', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('14 archivo NULL', v_msg LIKE 'FILE_REQUIRED%', v_msg);
  END;
END;
$$;

-- 15 · integración: el SQL exacto del repo, por parámetros nombrados y sin
-- tipos. `EXECUTE` no acepta subconsultas como argumento (011): van por funciones.
CREATE OR REPLACE FUNCTION pg_temp.fix_qr() RETURNS text LANGUAGE sql AS $$
  SELECT after->>'quote_request_id' FROM ops.action_log
   WHERE action = 'add_quote_request_file' AND actor_id = (SELECT actor_id FROM t_fix) LIMIT 1
$$;
CREATE OR REPLACE FUNCTION pg_temp.fix_img() RETURNS text LANGUAGE sql AS $$ SELECT img_id::text FROM t_fix $$;
CREATE OR REPLACE FUNCTION pg_temp.fix_actor() RETURNS text LANGUAGE sql AS $$ SELECT actor_id::text FROM t_fix $$;
PREPARE add_file AS
  SELECT ops.add_quote_request_file(
    p_quote_request_id => $1, p_file_id => $2, p_actor_id => $3, p_purpose => $4) AS row;
CREATE TEMP TABLE t_int ON COMMIT DROP AS
  EXECUTE add_file(pg_temp.fix_qr(), pg_temp.fix_img(), pg_temp.fix_actor(), 'problem_photo');
SELECT pg_temp.check('15 integración PREPARE sin tipos', (SELECT row->>'file_id' FROM t_int) = pg_temp.fix_img());
DEALLOCATE add_file;

SELECT caso, ok, detalle FROM t_result ORDER BY caso;
SELECT count(*) FILTER (WHERE ok) AS pasaron, count(*) AS total FROM t_result;

ROLLBACK;
