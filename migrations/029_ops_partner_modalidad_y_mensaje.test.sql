-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 029.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/029_ops_partner_modalidad_y_mensaje.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea su propio partner y su propio
-- actor. Mismo patrón que la 007/008/009. Nunca `ORDER BY created_at` sobre
-- `ops.action_log`: adentro de la transacción `now()` es constante.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS partner_id,
       gen_random_uuid() AS actor_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-029-' || actor_id || '@example.invalid', 'admin',
       'clerk', 'test-029-' || actor_id
  FROM t_fix;

INSERT INTO partners (id, source, name, coverage_zone, tier, status,
                      whatsapp, email, redirect_link, hours, address,
                      modality, whatsapp_message)
SELECT partner_id, 'manual', 'Taller 029', 'Zona 029', 'standard', 'active',
       '5491111111111', 'taller@example.invalid', 'https://example.invalid',
       'Lun a Vie 9-18', 'Calle 123', 'Taller fijo', 'Hola, vengo de AutoLibre'
  FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle);
$$;

CREATE OR REPLACE FUNCTION pg_temp.log_count(p_action text)
RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM ops.action_log l JOIN t_fix f ON l.target_id = f.partner_id
   WHERE l.action = p_action;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Forma: sin sobrecarga, SECURITY INVOKER, search_path fijo, sin updated_at.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n    int;
  v_args text;
BEGIN
  SELECT count(*), string_agg(pg_get_function_identity_arguments(p.oid), ' | ')
    INTO v_n, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'set_partner_contact';
  PERFORM pg_temp.check('01 sin sobrecarga: UNA sola set_partner_contact', v_n = 1,
                        v_n::text || ' → ' || coalesce(v_args, '(ninguna)'));
  PERFORM pg_temp.check('02 la firma nueva incluye p_whatsapp_message',
                        v_args LIKE '%p_whatsapp_message text%', coalesce(v_args, '(ninguna)'));

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'set_partner_modality';
  PERFORM pg_temp.check('03 existe UNA set_partner_modality', v_n = 1, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname IN ('set_partner_contact', 'set_partner_modality')
     AND p.prosecdef;
  PERFORM pg_temp.check('04 SECURITY INVOKER, no DEFINER', v_n = 0, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname IN ('set_partner_contact', 'set_partner_modality')
     AND array_to_string(p.proconfig, ',') LIKE '%search_path=%';
  PERFORM pg_temp.check('05 search_path fijo en las dos', v_n = 2, v_n::text);

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname IN ('set_partner_contact', 'set_partner_modality')
     AND p.prosrc ~* 'updated_at\s*=';
  PERFORM pg_temp.check('06 ninguna escribe updated_at a mano', v_n = 0, v_n::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Modalidad.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_partner uuid;
  v_actor   uuid;
  v_out     jsonb;
  v_log     ops.action_log%ROWTYPE;
  v_err     text;
BEGIN
  SELECT partner_id, actor_id INTO v_partner, v_actor FROM t_fix;

  v_out := ops.set_partner_modality(v_partner, v_actor, '  Mixto  ');
  PERFORM pg_temp.check('10 modalidad: guarda recortada',
                        v_out ->> 'modality' = 'Mixto', v_out ->> 'modality');
  PERFORM pg_temp.check('11 modalidad: no toca el contacto',
                        v_out ->> 'whatsapp' = '5491111111111'
                    AND v_out ->> 'whatsapp_message' = 'Hola, vengo de AutoLibre', v_out::text);

  SELECT l.* INTO v_log FROM ops.action_log l
   WHERE l.target_id = v_partner AND l.action = 'partner.set_modality';
  PERFORM pg_temp.check('12 log con before y after completos',
                        v_log.before ->> 'modality' = 'Taller fijo'
                    AND v_log.after ->> 'modality' = 'Mixto'
                    AND v_log.actor_id = v_actor
                    AND v_log.target_table = 'public.partners'
                    AND v_log.before ? 'name',
                        coalesce(v_log.before::text, '(sin log)'));

  -- Sin cambios: ni UPDATE ni segunda entrada.
  v_out := ops.set_partner_modality(v_partner, v_actor, 'Mixto');
  PERFORM pg_temp.check('13 sin cambios no loguea',
                        pg_temp.log_count('partner.set_modality') = 1,
                        pg_temp.log_count('partner.set_modality')::text);

  v_out := ops.set_partner_modality(v_partner, v_actor, '');
  PERFORM pg_temp.check('14 vacío borra (NULL)', v_out -> 'modality' = 'null'::jsonb, v_out ->> 'modality');

  v_out := ops.set_partner_modality(v_partner, v_actor, NULL);
  PERFORM pg_temp.check('15 NULL sobre NULL no loguea',
                        pg_temp.log_count('partner.set_modality') = 2,
                        pg_temp.log_count('partner.set_modality')::text);

  -- La lista NO la cierra la función: un texto cualquiera es representable.
  v_out := ops.set_partner_modality(v_partner, v_actor, 'A domicilio');
  PERFORM pg_temp.check('16 acepta un valor válido después de borrar',
                        v_out ->> 'modality' = 'A domicilio', v_out ->> 'modality');

  BEGIN
    PERFORM ops.set_partner_modality(v_partner, v_actor, repeat('x', 61));
    v_err := '(no tiró)';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.check('17 MODALITY_TOO_LONG', v_err LIKE 'MODALITY_TOO_LONG%', v_err);

  BEGIN
    PERFORM ops.set_partner_modality(gen_random_uuid(), v_actor, 'Mixto');
    v_err := '(no tiró)';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.check('18 PARTNER_NOT_FOUND', v_err LIKE 'PARTNER_NOT_FOUND%', v_err);

  BEGIN
    PERFORM ops.set_partner_modality(v_partner, gen_random_uuid(), 'Mixto');
    v_err := '(no tiró)';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.check('19 ACTOR_NOT_FOUND', v_err LIKE 'ACTOR_NOT_FOUND%', v_err);

  BEGIN
    PERFORM ops.set_partner_modality(v_partner, NULL, 'Mixto');
    v_err := '(no tiró)';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.check('20 ACTOR_REQUIRED', v_err LIKE 'ACTOR_REQUIRED%', v_err);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Contacto: lo nuevo (mensaje) y lo de la 007, re-verificado después del
-- DROP + CREATE.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_partner uuid;
  v_actor   uuid;
  v_out     jsonb;
  v_err     text;
  v_n       int;
BEGIN
  SELECT partner_id, actor_id INTO v_partner, v_actor FROM t_fix;

  -- Llamada SIN el parámetro nuevo (como la de antes de la 029): no toca el mensaje.
  v_out := ops.set_partner_contact(p_partner_id => v_partner, p_actor_id => v_actor,
                                   p_hours => 'Sáb 9-13');
  PERFORM pg_temp.check('30 sin p_whatsapp_message no toca el mensaje',
                        v_out ->> 'whatsapp_message' = 'Hola, vengo de AutoLibre'
                    AND v_out ->> 'hours' = 'Sáb 9-13', v_out::text);
  PERFORM pg_temp.check('31 NULL = no tocar: los demás campos quedan',
                        v_out ->> 'whatsapp' = '5491111111111'
                    AND v_out ->> 'email' = 'taller@example.invalid'
                    AND v_out ->> 'address' = 'Calle 123'
                    AND v_out ->> 'redirect_link' = 'https://example.invalid', v_out::text);

  v_out := ops.set_partner_contact(p_partner_id => v_partner, p_actor_id => v_actor,
                                   p_whatsapp_message => '  Hola! Te escribo desde AutoLibre  ');
  PERFORM pg_temp.check('32 guarda el mensaje recortado',
                        v_out ->> 'whatsapp_message' = 'Hola! Te escribo desde AutoLibre',
                        v_out ->> 'whatsapp_message');

  v_out := ops.set_partner_contact(p_partner_id => v_partner, p_actor_id => v_actor,
                                   p_whatsapp_message => '', p_email => '');
  PERFORM pg_temp.check('33 vacío borra mensaje y email',
                        v_out -> 'whatsapp_message' = 'null'::jsonb
                    AND v_out -> 'email' = 'null'::jsonb, v_out::text);

  BEGIN
    PERFORM ops.set_partner_contact(p_partner_id => v_partner, p_actor_id => v_actor,
                                    p_whatsapp_message => repeat('x', 1001));
    v_err := '(no tiró)';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.check('34 WHATSAPP_MESSAGE_TOO_LONG', v_err LIKE 'WHATSAPP_MESSAGE_TOO_LONG%', v_err);

  BEGIN
    PERFORM ops.set_partner_contact(p_partner_id => gen_random_uuid(), p_actor_id => v_actor,
                                    p_whatsapp => 'x');
    v_err := '(no tiró)';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.check('35 PARTNER_NOT_FOUND (de la 007)', v_err LIKE 'PARTNER_NOT_FOUND%', v_err);

  BEGIN
    PERFORM ops.set_partner_contact(p_partner_id => v_partner, p_actor_id => NULL,
                                    p_whatsapp => 'x');
    v_err := '(no tiró)';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.check('36 ACTOR_REQUIRED (de la 007)', v_err LIKE 'ACTOR_REQUIRED%', v_err);

  SELECT count(*) INTO v_n FROM ops.action_log l
   WHERE l.target_id = v_partner AND l.action = 'partner.set_contact'
     AND l.before ? 'whatsapp_message' AND l.after ? 'whatsapp_message';
  PERFORM pg_temp.check('37 cada guardado de contacto loguea before/after (3)', v_n = 3, v_n::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración con el SQL EXACTO de partners.repo.ts, con PREPARE sin tipos
-- (así manda `pg` cada $n: tipo desconocido, lo resuelve Postgres).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pg_temp.fix_partner() RETURNS uuid LANGUAGE sql AS $$ SELECT partner_id FROM t_fix $$;
CREATE OR REPLACE FUNCTION pg_temp.fix_actor() RETURNS uuid LANGUAGE sql AS $$ SELECT actor_id FROM t_fix $$;

PREPARE p029_contact AS
  SELECT ops.set_partner_contact(
    p_partner_id       => $1,
    p_actor_id         => $2,
    p_whatsapp         => $3,
    p_email            => $4,
    p_redirect_link    => $5,
    p_hours            => $6,
    p_address          => $7,
    p_whatsapp_message => $8
  ) AS p;

PREPARE p029_modality AS
  SELECT ops.set_partner_modality(
    p_partner_id => $1,
    p_actor_id   => $2,
    p_modality   => $3
  ) AS p;

DO $$
DECLARE
  v_partner uuid := pg_temp.fix_partner();
  v_actor   uuid := pg_temp.fix_actor();
BEGIN
  EXECUTE format('CREATE TEMP TABLE t_int_c ON COMMIT DROP AS EXECUTE p029_contact(%L, %L, %L, %L, %L, %L, %L, %L)',
                 v_partner, v_actor, '5492222222222', 'nuevo@example.invalid', '', 'Lun 9-18',
                 'Otra calle 456', 'Mensaje desde el repo');
  EXECUTE format('CREATE TEMP TABLE t_int_m ON COMMIT DROP AS EXECUTE p029_modality(%L, %L, %L)',
                 v_partner, v_actor, 'A distancia');
END $$;

DO $$
DECLARE
  v_c jsonb := (SELECT p FROM t_int_c);
  v_m jsonb := (SELECT p FROM t_int_m);
BEGIN
  PERFORM pg_temp.check('40 integración contacto: los seis campos',
                        v_c ->> 'whatsapp' = '5492222222222'
                    AND v_c ->> 'email' = 'nuevo@example.invalid'
                    AND v_c -> 'redirect_link' = 'null'::jsonb
                    AND v_c ->> 'hours' = 'Lun 9-18'
                    AND v_c ->> 'address' = 'Otra calle 456'
                    AND v_c ->> 'whatsapp_message' = 'Mensaje desde el repo', v_c::text);
  PERFORM pg_temp.check('41 integración modalidad', v_m ->> 'modality' = 'A distancia', v_m::text);
END $$;

DEALLOCATE p029_contact;
DEALLOCATE p029_modality;

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
