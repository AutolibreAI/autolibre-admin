-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 037 («Formato de cada propuesta»).
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/037_ops_plantilla_de_cada_propuesta.test.sql
--
-- BEGIN … ROLLBACK, con su propio actor.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS SELECT gen_random_uuid() AS actor_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-037-' || actor_id || '@example.invalid', 'admin'::user_role,
       'clerk'::auth_provider, 'test-037-' || actor_id
  FROM t_fix;

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

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'save_quote_message_template';
  PERFORM pg_temp.check('01 una sola save_quote_message_template', v_n = 1, v_n::text);
END $$;

DO $$
DECLARE a uuid; v jsonb; e text;
BEGIN
  SELECT actor_id INTO a FROM t_fix;

  v := ops.save_quote_message_template(a, 'Formato de cada propuesta', 'propuesta',
         E'{{numero}}. *{{taller}}*\n💵 {{monto}}', 'propuesta_item');
  PERFORM pg_temp.check('10 propuesta sin {{codigo}} se guarda', v->>'audience' = 'propuesta', v::text);

  e := pg_temp.err(format('SELECT ops.save_quote_message_template(%L, %L, %L, %L, %L)', a, 'X', 'propuesta', '{{taller}}', 'otra_clave'));
  PERFORM pg_temp.check('11 propuesta con otra clave: PROPOSAL_TEMPLATE_KEY', e LIKE 'PROPOSAL_TEMPLATE_KEY%', e);

  e := pg_temp.err(format('SELECT ops.save_quote_message_template(%L, %L, %L, %L)', a, 'X', 'propuesta', '{{taller}}'));
  PERFORM pg_temp.check('12 propuesta sin clave: PROPOSAL_TEMPLATE_KEY', e LIKE 'PROPOSAL_TEMPLATE_KEY%', e);

  e := pg_temp.err(format('SELECT ops.save_quote_message_template(%L, %L, %L, %L, %L)', a, 'X', 'persona', 'Hola {{codigo}}', 'propuesta_item'));
  PERFORM pg_temp.check('13 la clave propuesta_item con otra audiencia', e LIKE 'PROPOSAL_TEMPLATE_KEY%', e);

  e := pg_temp.err(format('SELECT ops.save_quote_message_template(%L, %L, %L, %L)', a, 'X', 'persona', 'Hola sin código'));
  PERFORM pg_temp.check('14 persona sigue exigiendo {{codigo}}', e LIKE 'MISSING_CODIGO_PLACEHOLDER%', e);

  v := ops.save_quote_message_template(a, 'Nueva', 'taller', 'Pedido {{codigo}}');
  PERFORM pg_temp.check('15 taller con {{codigo}} sigue andando', v->>'template_key' LIKE 'custom_%', v::text);

  e := pg_temp.err(format('SELECT ops.save_quote_message_template(%L, %L, %L, %L)', a, 'X', 'otra', 'Hola {{codigo}}'));
  PERFORM pg_temp.check('16 audiencia fuera del catálogo', e LIKE 'INVALID_AUDIENCE%', e);

  e := pg_temp.err($q$INSERT INTO ops.quote_message_template_version (template_key, title, audience, content, actor_id)
                      VALUES ('x', 'x', 'persona', 'sin codigo', gen_random_uuid())$q$);
  PERFORM pg_temp.check('17 el CHECK de {{codigo}} sigue para persona', e LIKE '%chk_ops_qmtv_has_codigo%', e);
END $$;

SELECT caso, CASE WHEN ok THEN 'PASA' ELSE 'FALLA' END AS estado, detalle FROM t_result ORDER BY caso;
SELECT count(*) FILTER (WHERE ok) AS pasaron, count(*) FILTER (WHERE NOT ok) AS fallaron, count(*) AS total FROM t_result;

ROLLBACK;
