-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 008.
--
-- ── CÓMO SE CORRE ─────────────────────────────────────────────────────────
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/008_ops_partner_perfil_y_links.test.sql
--
-- **Empieza en BEGIN y termina en ROLLBACK.** No deja nada: crea su propio
-- partner y su propio actor, prueba contra ellos y descarta todo. Es el mismo
-- patrón con el que se probó la 007 y la rule lo exige para cada SP nuevo —
-- *"un stored procedure sin probar es peor que no tenerlo: se ve como una
-- garantía y no lo es."*
--
-- Requiere que la 008 YA esté aplicada en la base contra la que se corre.
--
-- ── POR QUÉ CREA SUS PROPIAS FILAS Y NO USA UN PARTNER REAL ───────────────
--
-- Porque un ROLLBACK protege de dejar basura, no de los efectos de un error
-- mientras la transacción está abierta: un `UPDATE` sobre un partner real toma
-- su fila con `FOR UPDATE` y bloquea a cualquier otro que la toque. Con filas
-- propias, la prueba no puede trabar a nadie.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Andamiaje ──────────────────────────────────────────────────────────────

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS partner_id,
       gen_random_uuid() AS actor_id;

-- Un actor que existe en `users`: `ops.assert_actor` lo exige, y con razón —
-- un log de auditoría con actores fantasma no sirve para auditar.
INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-008-' || actor_id || '@example.invalid', 'admin',
       'clerk', 'test-008-' || actor_id
  FROM t_fix;

INSERT INTO partners (id, source, name, coverage_zone, tier, status, description)
SELECT partner_id, 'manual', 'Test 008', 'Zona original', 'standard', 'active',
       'Descripción original'
  FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle);
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- set_partner_profile
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

  -- 1. El camino feliz: los tres campos cambian.
  PERFORM ops.set_partner_profile(v_partner, v_actor, 'Zona nueva', 'Texto nuevo', 'founding');
  SELECT * INTO v_row FROM partners WHERE id = v_partner;
  PERFORM pg_temp.check('01 perfil: zona actualizada',        v_row.coverage_zone = 'Zona nueva', v_row.coverage_zone);
  PERFORM pg_temp.check('02 perfil: descripción actualizada', v_row.description   = 'Texto nuevo', v_row.description);
  PERFORM pg_temp.check('03 perfil: tier actualizado',        v_row.tier::text    = 'founding',    v_row.tier::text);

  /**
   * 2. Guardrail 8: la función NO escribe `updated_at` a mano.
   *
   * ── POR QUÉ NO SE COMPARA `updated_at > created_at` ───────────────────────
   *
   * Porque no se puede, y la primera versión de esta prueba lo intentaba y
   * fallaba: `trg_partners_updated_at` llama a `set_updated_at()`, que usa
   * `now()` — y `now()` es el instante en que arrancó la TRANSACCIÓN, no el de
   * la sentencia. Adentro de una sola transacción, el `created_at` del INSERT y
   * el `updated_at` del trigger reciben el MISMO valor, así que `>` es falso
   * por construcción y no dice nada sobre el trigger.
   *
   * (`clock_timestamp()` sí avanza, pero el trigger es del backend y no se
   * cambia desde este repo para que una prueba nuestra sea más cómoda.)
   *
   * Se verifica el guardrail DIRECTAMENTE: que el cuerpo de la función no
   * asigne la columna. Es mejor prueba que la comparación de timestamps —
   * aquella pasaba igual si la función escribía `updated_at` a mano, que es
   * exactamente la duplicación que el guardrail existe para prevenir.
   */
  PERFORM pg_temp.check(
    '04 perfil: el SP no escribe updated_at a mano',
    pg_get_functiondef('ops.set_partner_profile(uuid,uuid,text,text,text,text)'::regprocedure)
      !~* 'updated_at[[:space:]]*=',
    'guardrail 8: lo pone trg_partners_updated_at');

  -- 3. La descripción vacía BORRA (la columna es nullable).
  PERFORM ops.set_partner_profile(v_partner, v_actor, 'Zona nueva', '   ', 'founding');
  SELECT * INTO v_row FROM partners WHERE id = v_partner;
  PERFORM pg_temp.check('05 perfil: descripción vacía → NULL', v_row.description IS NULL,
                        coalesce(v_row.description, '(null)'));

  -- 4. La zona vacía NO borra: rechaza. La columna es NOT NULL.
  BEGIN
    PERFORM ops.set_partner_profile(v_partner, v_actor, '  ', 'x', 'standard');
    PERFORM pg_temp.check('06 perfil: zona vacía rechazada', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('06 perfil: zona vacía rechazada',
                          v_msg LIKE 'COVERAGE_ZONE_REQUIRED%', v_msg);
  END;

  -- 5. Un tier fuera del enum rebota con sentinela propia, no con el error
  --    crudo del cast de Postgres.
  BEGIN
    PERFORM ops.set_partner_profile(v_partner, v_actor, 'Zona nueva', 'x', 'platinum');
    PERFORM pg_temp.check('07 perfil: tier inválido rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('07 perfil: tier inválido rechazado',
                          v_msg LIKE 'INVALID_TIER%', v_msg);
  END;

  -- 6. Un partner inexistente.
  BEGIN
    PERFORM ops.set_partner_profile(gen_random_uuid(), v_actor, 'z', 'x', 'standard');
    PERFORM pg_temp.check('08 perfil: partner inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('08 perfil: partner inexistente',
                          v_msg LIKE 'PARTNER_NOT_FOUND%', v_msg);
  END;

  -- 7. Un actor que no existe en `users`.
  BEGIN
    PERFORM ops.set_partner_profile(v_partner, gen_random_uuid(), 'z', 'x', 'standard');
    PERFORM pg_temp.check('09 perfil: actor inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('09 perfil: actor inexistente',
                          v_msg LIKE 'ACTOR_NOT_FOUND%', v_msg);
  END;

  -- 8. Actor NULL.
  BEGIN
    PERFORM ops.set_partner_profile(v_partner, NULL, 'z', 'x', 'standard');
    PERFORM pg_temp.check('10 perfil: actor NULL', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('10 perfil: actor NULL', v_msg LIKE 'ACTOR_REQUIRED%', v_msg);
  END;

  -- 9. La auditoría guarda before Y after completos, no un delta.
  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_partner AND action = 'partner.set_profile'
   ORDER BY created_at LIMIT 1;
  PERFORM pg_temp.check('11 perfil: log con before',  v_log.before ? 'coverage_zone',
                        coalesce(v_log.before::text, '(null)'));
  PERFORM pg_temp.check('12 perfil: log con after',   v_log.after  ? 'coverage_zone',
                        coalesce(v_log.after::text, '(null)'));
  PERFORM pg_temp.check('13 perfil: log registra el cambio real',
                        v_log.before ->> 'coverage_zone' = 'Zona original'
                    AND v_log.after  ->> 'coverage_zone' = 'Zona nueva',
                        (v_log.before ->> 'coverage_zone') || ' → ' || (v_log.after ->> 'coverage_zone'));
  PERFORM pg_temp.check('14 perfil: log con el actor de la sesión',
                        v_log.actor_id = v_actor, v_log.actor_id::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- set_partner_links
--
-- ── ESTE BLOQUE ES, ADEMÁS, UNA PRUEBA DE REGRESIÓN ───────────────────────
--
-- Llama a la función DIEZ VECES dentro de la misma transacción. La primera
-- versión de `set_partner_links` materializaba el conjunto entrante en un
-- `CREATE TEMP TABLE _incoming ON COMMIT DROP`, que vive hasta el fin de la
-- TRANSACCIÓN y no de la llamada: la segunda invocación moría con
-- `relation "_incoming" already exists`.
--
-- Probando la función una sola vez, eso no aparece. Aparece acá, y aparecería
-- en producción el día que alguien guarde dos partners en una transacción.
-- **Si se refactoriza el SP, estas llamadas encadenadas no se separan.**
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_partner uuid;
  v_actor   uuid;
  v_msg     text;
  v_n       int;
  v_url     text;
  v_created timestamptz;
  v_created2 timestamptz;
  v_id      uuid;
  v_id2     uuid;
  v_log     ops.action_log%ROWTYPE;
BEGIN
  SELECT partner_id, actor_id INTO v_partner, v_actor FROM t_fix;

  -- 15. Alta inicial: un kind único y dos `other`.
  PERFORM ops.set_partner_links(v_partner, v_actor, jsonb_build_array(
    jsonb_build_object('kind','instagram','url','https://instagram.com/taller'),
    jsonb_build_object('kind','other','url','https://maps.app.goo.gl/abc'),
    jsonb_build_object('kind','other','url','https://otracosa.example/x')
  ));
  SELECT count(*) INTO v_n FROM partner_links WHERE partner_id = v_partner;
  PERFORM pg_temp.check('15 links: alta inicial', v_n = 3, v_n::text);

  /**
   * El log de ESTA llamada se captura ACÁ, no al final del bloque.
   *
   * `ops.action_log.created_at` es `now()`, que dentro de una transacción es
   * constante: todas las filas del log comparten el mismo timestamp, y un
   * `ORDER BY created_at LIMIT 1` devuelve una CUALQUIERA de ellas. La versión
   * anterior de esta prueba hacía exactamente eso: pasó en el ensayo y falló
   * contra la migración ya aplicada, con el mismo SQL y los mismos datos.
   *
   * Una prueba cuyo resultado depende del orden físico de las filas es peor que
   * no tenerla: la primera vez que falla, se la lee como un bug del código.
   *
   * Capturándolo cuando hay UNA sola fila, no hay orden que resolver.
   */
  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_partner AND action = 'partner.set_links';

  -- 16. Las URLs vacías se descartan en silencio: el formulario manda los
  --     campos que el operador dejó en blanco.
  SELECT id, created_at INTO v_id, v_created
    FROM partner_links WHERE partner_id = v_partner AND kind = 'instagram';

  PERFORM ops.set_partner_links(v_partner, v_actor, jsonb_build_array(
    jsonb_build_object('kind','instagram','url','https://instagram.com/taller'),
    jsonb_build_object('kind','facebook','url','   '),
    jsonb_build_object('kind','other','url','https://maps.app.goo.gl/abc'),
    jsonb_build_object('kind','other','url','https://otracosa.example/x')
  ));
  SELECT count(*) INTO v_n FROM partner_links WHERE partner_id = v_partner;
  PERFORM pg_temp.check('16 links: URL vacía descartada', v_n = 3, v_n::text);

  -- 17. LA PRUEBA QUE JUSTIFICA TODO EL DISEÑO: un link que no cambió conserva
  --     su `id` y su `created_at`. Con un DELETE + INSERT, los dos se
  --     regenerarían y se perdería cuándo se cargó el link.
  SELECT id, created_at INTO v_id2, v_created2
    FROM partner_links WHERE partner_id = v_partner AND kind = 'instagram';
  PERFORM pg_temp.check('17 links: el intacto conserva id',
                        v_id = v_id2, v_id::text || ' vs ' || v_id2::text);
  PERFORM pg_temp.check('18 links: el intacto conserva created_at',
                        v_created = v_created2, v_created::text);

  -- 19. Cambiar la URL de un kind único es UPDATE, no INSERT: mismo id.
  PERFORM ops.set_partner_links(v_partner, v_actor, jsonb_build_array(
    jsonb_build_object('kind','instagram','url','https://instagram.com/otro'),
    jsonb_build_object('kind','other','url','https://maps.app.goo.gl/abc'),
    jsonb_build_object('kind','other','url','https://otracosa.example/x')
  ));
  SELECT id, url INTO v_id2, v_url
    FROM partner_links WHERE partner_id = v_partner AND kind = 'instagram';
  PERFORM pg_temp.check('19 links: cambio de URL es upsert',
                        v_id = v_id2 AND v_url = 'https://instagram.com/otro', v_url);

  -- 20. Un kind único ausente se BORRA.
  PERFORM ops.set_partner_links(v_partner, v_actor, jsonb_build_array(
    jsonb_build_object('kind','other','url','https://maps.app.goo.gl/abc'),
    jsonb_build_object('kind','other','url','https://otracosa.example/x')
  ));
  SELECT count(*) INTO v_n
    FROM partner_links WHERE partner_id = v_partner AND kind = 'instagram';
  PERFORM pg_temp.check('20 links: kind ausente se borra', v_n = 0, v_n::text);

  -- 21. Un `other` ausente se borra; el que sigue estando NO se toca.
  PERFORM ops.set_partner_links(v_partner, v_actor, jsonb_build_array(
    jsonb_build_object('kind','other','url','https://maps.app.goo.gl/abc')
  ));
  SELECT count(*) INTO v_n FROM partner_links WHERE partner_id = v_partner;
  PERFORM pg_temp.check('21 links: other ausente se borra', v_n = 1, v_n::text);

  -- 22. Dos `other` con la MISMA url no crean dos filas. No hay unique que lo
  --     impida (el índice excluye `other`), así que lo tiene que hacer el SP.
  PERFORM ops.set_partner_links(v_partner, v_actor, jsonb_build_array(
    jsonb_build_object('kind','other','url','https://dup.example/a'),
    jsonb_build_object('kind','other','url','https://dup.example/a')
  ));
  SELECT count(*) INTO v_n
    FROM partner_links WHERE partner_id = v_partner AND url = 'https://dup.example/a';
  PERFORM pg_temp.check('22 links: other duplicado se deduplica', v_n = 1, v_n::text);

  -- 22b. El MISMO kind único dos veces en el payload no revienta.
  --      Sin el `DISTINCT ON (kind)` del insert, `ON CONFLICT` tira
  --      "cannot affect row a second time" — un error sobre la sentencia, no
  --      sobre el dato, que el operador no puede interpretar.
  PERFORM ops.set_partner_links(v_partner, v_actor, jsonb_build_array(
    jsonb_build_object('kind','website','url','https://a.example'),
    jsonb_build_object('kind','website','url','https://b.example')
  ));
  SELECT count(*) INTO v_n
    FROM partner_links WHERE partner_id = v_partner AND kind = 'website';
  PERFORM pg_temp.check('22b links: kind único duplicado no revienta', v_n = 1, v_n::text);

  -- 23. Un array vacío borra todo. Es el caso que hay que poder hacer a
  --     propósito y no por accidente.
  PERFORM ops.set_partner_links(v_partner, v_actor, '[]'::jsonb);
  SELECT count(*) INTO v_n FROM partner_links WHERE partner_id = v_partner;
  PERFORM pg_temp.check('23 links: array vacío borra todo', v_n = 0, v_n::text);

  -- 24. Un kind fuera del enum rebota con sentinela y NOMBRA el kind malo.
  BEGIN
    PERFORM ops.set_partner_links(v_partner, v_actor, jsonb_build_array(
      jsonb_build_object('kind','linkedin','url','https://x.example')
    ));
    PERFORM pg_temp.check('24 links: kind inválido rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('24 links: kind inválido rechazado',
                          v_msg LIKE 'INVALID_LINK_KIND%linkedin%', v_msg);
  END;

  -- 25. Algo que no es un array.
  BEGIN
    PERFORM ops.set_partner_links(v_partner, v_actor, '{"kind":"x"}'::jsonb);
    PERFORM pg_temp.check('25 links: no-array rechazado', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('25 links: no-array rechazado',
                          v_msg LIKE 'LINKS_NOT_AN_ARRAY%', v_msg);
  END;

  -- 26. Partner inexistente.
  BEGIN
    PERFORM ops.set_partner_links(gen_random_uuid(), v_actor, '[]'::jsonb);
    PERFORM pg_temp.check('26 links: partner inexistente', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('26 links: partner inexistente',
                          v_msg LIKE 'PARTNER_NOT_FOUND%', v_msg);
  END;

  -- 27. El log de links guarda los LINKS, no la fila del partner. Si guardara
  --     `to_jsonb(partners)` diría que no pasó nada, porque esta función no
  --     toca esa tabla. `v_log` viene capturado desde el caso 15, cuando había
  --     una sola fila — ver el comentario de allá.
  PERFORM pg_temp.check('27 links: log en la tabla correcta',
                        v_log.target_table = 'public.partner_links', v_log.target_table);
  PERFORM pg_temp.check('28 links: before es un array de links',
                        jsonb_typeof(v_log.before) = 'array', v_log.before::text);
  PERFORM pg_temp.check('29 links: after registra el alta',
                        jsonb_array_length(v_log.after) = 3, v_log.after::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL EXACTO que manda `partners.repo.ts`
--
-- Se copia la forma con parámetros nombrados que usa el repo. Una prueba que
-- llame a la función de otra forma verifica la función, no el llamador.
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
    p_coverage_zone => 'Integración',
    p_description   => 'desde el repo',
    p_tier          => 'standard'
  ) INTO v_out;
  PERFORM pg_temp.check('30 integración: set_partner_profile devuelve la fila',
                        v_out ->> 'coverage_zone' = 'Integración', v_out::text);

  SELECT ops.set_partner_links(
    p_partner_id => v_partner,
    p_actor_id   => v_actor,
    p_links      => '[{"kind":"website","url":"https://desde-el-repo.example"}]'::jsonb
  ) INTO v_out;
  PERFORM pg_temp.check('31 integración: set_partner_links devuelve los links',
                        jsonb_array_length(v_out) = 1 AND v_out -> 0 ->> 'kind' = 'website',
                        v_out::text);
END $$;

-- ── Resultado ──────────────────────────────────────────────────────────────

SELECT caso,
       CASE WHEN ok THEN 'PASA' ELSE 'FALLA' END AS estado,
       detalle
  FROM t_result
 ORDER BY caso;

SELECT count(*) FILTER (WHERE ok)       AS pasaron,
       count(*) FILTER (WHERE NOT ok)   AS fallaron,
       count(*)                          AS total
  FROM t_result;

ROLLBACK;
