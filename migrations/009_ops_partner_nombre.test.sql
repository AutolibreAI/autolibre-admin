-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 009.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/009_ops_partner_nombre.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea su propio partner y su propio
-- actor. Mismo patrón que la 007 y la 008.
--
-- ── DOS TRAMPAS QUE LA SUITE DE LA 008 YA PAGÓ ────────────────────────────
--
-- 1. `now()` es el instante en que arrancó la TRANSACCIÓN, no la sentencia.
--    Así que `updated_at > created_at` es falso por construcción, y un
--    `ORDER BY created_at` sobre `ops.action_log` devuelve una fila CUALQUIERA
--    porque todas comparten timestamp. Acá el log se captura cuando hay una
--    sola fila, y el guardrail de `updated_at` se verifica sobre el cuerpo de
--    la función.
--
-- 2. Se llama a la función varias veces en la misma transacción, a propósito:
--    es la regresión que detecta un `CREATE TEMP TABLE ... ON COMMIT DROP`
--    adentro de un SP.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS partner_id,
       gen_random_uuid() AS actor_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-009-' || actor_id || '@example.invalid', 'admin',
       'clerk', 'test-009-' || actor_id
  FROM t_fix;

INSERT INTO partners (id, source, name, coverage_zone, tier, status, description)
SELECT partner_id, 'manual', 'Nombre original', 'Zona original', 'standard',
       'active', 'Descripción original'
  FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle);
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Lo primero: que la firma vieja NO haya sobrevivido.
--
-- Es el caso más importante de esta migración. Si el DROP no corrió, quedan
-- dos `ops.set_partner_profile` y una llamada por parámetros nombrados —como
-- la que hace `partners.repo.ts`— revienta con "function is not unique". Eso
-- NO aparece migrando: aparece en el primer guardado de un operador.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n int;
  v_args text;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'set_partner_profile';

  SELECT string_agg(pg_get_function_identity_arguments(p.oid), ' | ') INTO v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'set_partner_profile';

  PERFORM pg_temp.check('01 sin sobrecarga: existe UNA sola set_partner_profile',
                        v_n = 1, v_n::text || ' → ' || coalesce(v_args, '(ninguna)'));

  PERFORM pg_temp.check('02 la firma nueva incluye p_name',
                        v_args LIKE '%p_name text%', coalesce(v_args, '(ninguna)'));

  -- SECURITY INVOKER es el guardrail 2. DEFINER convertiría la función en una
  -- escalada de privilegios.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'ops' AND p.proname = 'set_partner_profile' AND p.prosecdef;
  PERFORM pg_temp.check('03 SECURITY INVOKER, no DEFINER', v_n = 0, v_n::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- El comportamiento
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_partner uuid;
  v_actor   uuid;
  v_row     partners%ROWTYPE;
  v_log     ops.action_log%ROWTYPE;
  v_msg     text;
BEGIN
  SELECT partner_id, actor_id INTO v_partner, v_actor FROM t_fix;

  -- 04-07. El camino feliz: los cuatro campos cambian de una.
  PERFORM ops.set_partner_profile(v_partner, v_actor, 'Nombre nuevo', 'Zona nueva',
                                  'Texto nuevo', 'founding');
  SELECT * INTO v_row FROM partners WHERE id = v_partner;
  PERFORM pg_temp.check('04 nombre actualizado',      v_row.name          = 'Nombre nuevo', v_row.name);
  PERFORM pg_temp.check('05 zona actualizada',        v_row.coverage_zone = 'Zona nueva',   v_row.coverage_zone);
  PERFORM pg_temp.check('06 descripción actualizada', v_row.description   = 'Texto nuevo',  v_row.description);
  PERFORM pg_temp.check('07 tier actualizado',        v_row.tier::text    = 'founding',     v_row.tier::text);

  -- El log de ESTA llamada, capturado con una sola fila presente. Ver la nota
  -- de arriba sobre `now()` y el orden.
  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_partner AND action = 'partner.set_profile';

  -- 08. El nombre se normaliza: se le sacan los espacios de los bordes.
  PERFORM ops.set_partner_profile(v_partner, v_actor, '   Con espacios   ', 'Zona nueva',
                                  'Texto nuevo', 'founding');
  SELECT * INTO v_row FROM partners WHERE id = v_partner;
  PERFORM pg_temp.check('08 nombre con btrim', v_row.name = 'Con espacios', '[' || v_row.name || ']');

  -- 09. Nombre vacío: NO borra, rechaza. La columna es NOT NULL.
  BEGIN
    PERFORM ops.set_partner_profile(v_partner, v_actor, '   ', 'Zona nueva', 'x', 'standard');
    PERFORM pg_temp.check('09 nombre vacío rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('09 nombre vacío rechazado', v_msg LIKE 'NAME_REQUIRED%', v_msg);
  END;

  -- 10. Un nombre DUPLICADO se acepta: no es asunto del SP.
  --     `partners.name` no tiene índice único, así que dos partners con el
  --     mismo nombre son representables. La función valida representabilidad,
  --     no reglas de negocio — la ficha avisa después de guardar.
  BEGIN
    PERFORM ops.set_partner_profile(v_partner, v_actor,
      (SELECT name FROM partners WHERE id <> v_partner ORDER BY name LIMIT 1),
      'Zona nueva', 'x', 'standard');
    SELECT * INTO v_row FROM partners WHERE id = v_partner;
    PERFORM pg_temp.check('10 nombre duplicado se acepta', true, v_row.name);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('10 nombre duplicado se acepta', false, v_msg);
  END;

  -- 11-13. Las validaciones que la 008 ya tenía siguen vivas después del
  --        DROP + CREATE. Una migración que reescribe una función es
  --        exactamente donde se pierde una validación sin que nadie lo note.
  BEGIN
    PERFORM ops.set_partner_profile(v_partner, v_actor, 'n', '  ', 'x', 'standard');
    PERFORM pg_temp.check('11 zona vacía sigue rechazada', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('11 zona vacía sigue rechazada',
                          v_msg LIKE 'COVERAGE_ZONE_REQUIRED%', v_msg);
  END;

  BEGIN
    PERFORM ops.set_partner_profile(v_partner, v_actor, 'n', 'z', 'x', 'platinum');
    PERFORM pg_temp.check('12 tier inválido sigue rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('12 tier inválido sigue rechazado', v_msg LIKE 'INVALID_TIER%', v_msg);
  END;

  PERFORM ops.set_partner_profile(v_partner, v_actor, 'n', 'z', '   ', 'standard');
  SELECT * INTO v_row FROM partners WHERE id = v_partner;
  PERFORM pg_temp.check('13 descripción vacía sigue borrando', v_row.description IS NULL,
                        coalesce(v_row.description, '(null)'));

  -- 14-16. Actor y partner.
  BEGIN
    PERFORM ops.set_partner_profile(gen_random_uuid(), v_actor, 'n', 'z', 'x', 'standard');
    PERFORM pg_temp.check('14 partner inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('14 partner inexistente', v_msg LIKE 'PARTNER_NOT_FOUND%', v_msg);
  END;

  BEGIN
    PERFORM ops.set_partner_profile(v_partner, gen_random_uuid(), 'n', 'z', 'x', 'standard');
    PERFORM pg_temp.check('15 actor inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('15 actor inexistente', v_msg LIKE 'ACTOR_NOT_FOUND%', v_msg);
  END;

  BEGIN
    PERFORM ops.set_partner_profile(v_partner, NULL, 'n', 'z', 'x', 'standard');
    PERFORM pg_temp.check('16 actor NULL', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('16 actor NULL', v_msg LIKE 'ACTOR_REQUIRED%', v_msg);
  END;

  -- 17-19. La auditoría registra el rename con before y after completos.
  PERFORM pg_temp.check('17 log: registra el nombre viejo',
                        v_log.before ->> 'name' = 'Nombre original',
                        coalesce(v_log.before ->> 'name', '(null)'));
  PERFORM pg_temp.check('18 log: registra el nombre nuevo',
                        v_log.after ->> 'name' = 'Nombre nuevo',
                        coalesce(v_log.after ->> 'name', '(null)'));
  PERFORM pg_temp.check('19 log: con el actor de la sesión',
                        v_log.actor_id = v_actor, v_log.actor_id::text);

  -- 20. Guardrail 8: la función no escribe `updated_at` a mano.
  --     No se compara updated_at > created_at: `now()` es constante adentro de
  --     una transacción y esa comparación es falsa por construcción. Se
  --     verifica el guardrail directamente.
  PERFORM pg_temp.check(
    '20 el SP no escribe updated_at a mano',
    pg_get_functiondef('ops.set_partner_profile(uuid,uuid,text,text,text,text,text)'::regprocedure)
      !~* 'updated_at[[:space:]]*=',
    'guardrail 8: lo pone trg_partners_updated_at');
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL EXACTO que manda `partners.repo.ts`.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_partner uuid;
  v_actor   uuid;
  v_out     jsonb;
BEGIN
  SELECT partner_id, actor_id INTO v_partner, v_actor FROM t_fix;

  SELECT ops.set_partner_profile(
    p_partner_id    => v_partner,
    p_actor_id      => v_actor,
    p_name          => 'Desde el repo',
    p_coverage_zone => 'Integración',
    p_description   => 'texto',
    p_tier          => 'standard'
  ) INTO v_out;

  PERFORM pg_temp.check('21 integración: devuelve la fila con el nombre nuevo',
                        v_out ->> 'name' = 'Desde el repo'
                    AND v_out ->> 'coverage_zone' = 'Integración',
                        v_out::text);
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
