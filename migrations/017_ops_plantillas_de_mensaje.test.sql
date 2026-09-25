-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 017.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/017_ops_plantillas_de_mensaje.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea su propio actor. No depende de
-- `quote_requests` (esta tabla no tiene FK a esa, guardrail 6), así que corre
-- igual en una base donde esa tabla no exista.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id, gen_random_uuid() AS other_actor_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-017-' || actor_id || '@example.invalid', 'admin', 'clerk', 'test-017-' || actor_id
  FROM t_fix
UNION ALL
SELECT other_actor_id, 'test-017-b-' || other_actor_id || '@example.invalid', 'admin', 'clerk', 'test-017-b-' || other_actor_id
  FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, coalesce(p_ok, false), p_detalle);
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Guardrails de forma
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'save_quote_message_template';
  PERFORM pg_temp.check('01 existe UNA sola ops.save_quote_message_template', v_n = 1, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'save_quote_message_template' AND p.prosecdef;
  PERFORM pg_temp.check('02 SECURITY INVOKER, no DEFINER', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'save_quote_message_template'
     AND coalesce(array_to_string(p.proconfig, ' '), '') NOT LIKE 'search_path=%';
  PERFORM pg_temp.check('03 search_path fijo (guardrail 3)', v_n = 0, v_n::text);

  -- Guardrail 6: sin FK a ningún lado. `actor_id` es lo único que podría
  -- tentar una FK a `public.users`, y no la tiene.
  SELECT count(*) INTO v_n
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
   WHERE n.nspname = 'ops' AND c.conrelid = 'ops.quote_message_template_version'::regclass AND c.contype = 'f';
  PERFORM pg_temp.check('04 sin FK cruzada (guardrail 6)', v_n = 0, v_n::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Comportamiento
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fix   t_fix%ROWTYPE;
  v_out   jsonb;
  v_key   text;
  v_n     int;
  v_msg   text;
  v_log   ops.action_log%ROWTYPE;
BEGIN
  SELECT * INTO v_fix FROM t_fix;

  -- 10-13. Alta de una plantilla NUEVA: sin `p_template_key`, el SP genera una.
  v_out := ops.save_quote_message_template(
    v_fix.actor_id, 'Mi plantilla', 'persona', 'Hola {{codigo}}, ¿cómo va?'
  );
  v_key := v_out->>'template_key';
  PERFORM pg_temp.check('10 genera una clave nueva', v_key LIKE 'custom_%', coalesce(v_key, '(null)'));
  PERFORM pg_temp.check('11 archived arranca en false', (v_out->>'archived')::boolean = false, v_out->>'archived');
  PERFORM pg_temp.check('12 title/audience/content guardados',
    v_out->>'title' = 'Mi plantilla' AND v_out->>'audience' = 'persona'
      AND v_out->>'content' = 'Hola {{codigo}}, ¿cómo va?',
    v_out::text);

  SELECT count(*) INTO v_n FROM ops.quote_message_template_version WHERE template_key = v_key;
  PERFORM pg_temp.check('13 una sola versión para esta clave', v_n = 1, v_n::text);

  -- 14-16. Editar la MISMA clave crea una versión NUEVA, no pisa la anterior.
  PERFORM pg_sleep(0.01); -- separa now() de la fila anterior, sin depender del reloj del runner
  v_out := ops.save_quote_message_template(
    v_fix.other_actor_id, 'Mi plantilla (corregida)', 'persona',
    'Hola {{codigo}}, ¿cómo va todo?', v_key
  );
  SELECT count(*) INTO v_n FROM ops.quote_message_template_version WHERE template_key = v_key;
  PERFORM pg_temp.check('14 ahora hay DOS versiones de la misma clave', v_n = 2, v_n::text);
  PERFORM pg_temp.check('15 la versión vigente es la nueva',
    v_out->>'title' = 'Mi plantilla (corregida)', v_out->>'title');
  PERFORM pg_temp.check('16 la clave no cambió', v_out->>'template_key' = v_key, v_out->>'template_key');

  -- 17-18. `title`/`content` vacíos rechazados.
  BEGIN
    PERFORM ops.save_quote_message_template(v_fix.actor_id, '  ', 'persona', 'Hola {{codigo}}');
    PERFORM pg_temp.check('17 título vacío rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('17 título vacío rechazado', v_msg LIKE 'TITLE_REQUIRED%', v_msg);
  END;
  BEGIN
    PERFORM ops.save_quote_message_template(v_fix.actor_id, 'Título', 'persona', '   ');
    PERFORM pg_temp.check('18 contenido vacío rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('18 contenido vacío rechazado', v_msg LIKE 'CONTENT_REQUIRED%', v_msg);
  END;

  -- 19. Audiencia fuera del catálogo cerrado.
  BEGIN
    PERFORM ops.save_quote_message_template(v_fix.actor_id, 'Título', 'ambos', 'Hola {{codigo}}');
    PERFORM pg_temp.check('19 audiencia inválida rechazada', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('19 audiencia inválida rechazada', v_msg LIKE 'INVALID_AUDIENCE%', v_msg);
  END;

  -- 20. Sin `{{codigo}}`, rechazado — el CHECK de la tabla lo respalda, pero
  -- el SP lo valida antes para dar una sentinela legible.
  BEGIN
    PERFORM ops.save_quote_message_template(v_fix.actor_id, 'Título', 'persona', 'Hola, sin código');
    PERFORM pg_temp.check('20 sin {{codigo}} rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('20 sin {{codigo}} rechazado', v_msg LIKE 'MISSING_CODIGO_PLACEHOLDER%', v_msg);
  END;

  -- 21. Actor inexistente / NULL.
  BEGIN
    PERFORM ops.save_quote_message_template(gen_random_uuid(), 'Título', 'persona', 'Hola {{codigo}}');
    PERFORM pg_temp.check('21 actor inexistente rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('21 actor inexistente rechazado', v_msg LIKE 'ACTOR_NOT_FOUND%', v_msg);
  END;

  -- 22-24. Auditoría: la primera versión tiene `before` NULL; la segunda trae
  -- el título ANTERIOR en `before` — es información real, a diferencia de
  -- otros SP de este repo donde `before` es siempre NULL en el alta.
  SELECT * INTO v_log FROM ops.action_log
   WHERE action = 'quote_message_template.save' AND after->>'template_key' = v_key
   ORDER BY created_at ASC LIMIT 1;
  PERFORM pg_temp.check('22 log #1: before NULL (primera versión de la clave)', v_log.before IS NULL, 'no null');

  SELECT * INTO v_log FROM ops.action_log
   WHERE action = 'quote_message_template.save' AND after->>'template_key' = v_key
   ORDER BY created_at DESC LIMIT 1;
  PERFORM pg_temp.check('23 log #2: before trae el título anterior',
    v_log.before->>'title' = 'Mi plantilla', coalesce(v_log.before->>'title', '(null)'));
  PERFORM pg_temp.check('24 log #2: after trae el título nuevo',
    v_log.after->>'title' = 'Mi plantilla (corregida)', coalesce(v_log.after->>'title', '(null)'));

  -- 25. Editar una plantilla de SEMILLA (una de las 4 fijas del código) crea
  -- su primera fila en la tabla — el `template_key` coincide con el `id` de
  -- TS, y el SP no sabe ni le importa que sea una semilla.
  v_out := ops.save_quote_message_template(
    v_fix.actor_id, 'Apertura (editada)', 'persona',
    'Hola! Pedido {{codigo}}. {{patente}} — {{vehiculo_completo}} — {{pedido}} — {{zona}}',
    'apertura'
  );
  PERFORM pg_temp.check('25 la clave de semilla "apertura" ahora tiene versión propia',
    v_out->>'template_key' = 'apertura', v_out->>'template_key');
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL exacto que va a mandar el repo (parámetros nombrados)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor uuid;
  v_out   jsonb;
BEGIN
  SELECT actor_id INTO v_actor FROM t_fix;

  SELECT ops.save_quote_message_template(
    p_actor_id     => v_actor,
    p_title        => 'Integración',
    p_audience     => 'taller',
    p_content      => 'Hola {{codigo}}, ¿cotizás esto?',
    p_template_key => NULL,
    p_archived     => false,
    p_note         => NULL
  ) INTO v_out;

  PERFORM pg_temp.check('30 integración: parámetros nombrados',
    v_out->>'title' = 'Integración' AND v_out->>'audience' = 'taller', v_out::text);
END $$;

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
