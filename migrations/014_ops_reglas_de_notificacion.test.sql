-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 014.
--
--   node .claude/skills/db-connect/query.mjs --allow-write \
--        --file migrations/014_ops_reglas_de_notificacion.test.sql
--
-- Empieza en BEGIN y termina en ROLLBACK; crea su propio actor — mismo patrón
-- que 007–013. Esta migración no toca ninguna tabla de `public`, así que no
-- hace falta fixture de dominio (partner, lead, quote_request): sólo un
-- `users` para que `ops.assert_actor` tenga a quién encontrar.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_fix ON COMMIT DROP AS
SELECT gen_random_uuid() AS actor_id;

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT actor_id, 'test-014-' || actor_id || '@example.invalid', 'admin', 'clerk', 'test-014-' || actor_id
  FROM t_fix;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, p_ok, p_detalle);
$$;

-- Una condición y una recurrencia válidas, reusadas por casi todos los casos.
CREATE TEMP TABLE t_shapes ON COMMIT DROP AS
SELECT
  '[{"field": "vehicles", "op": "eq", "value": 0}]'::jsonb AS conditions,
  '{"kind": "everyNDays", "n": 2, "atHour": 19, "atMinute": 0}'::jsonb AS recurrence;

-- ═══════════════════════════════════════════════════════════════════════════
-- Guardrails de forma (las cuatro funciones de escritura)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fn text;
  v_n  int;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'create_notification_schedule', 'update_notification_schedule',
    'set_notification_schedule_active', 'delete_notification_schedule'
  ]
  LOOP
    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = v_fn;
    PERFORM pg_temp.check('01 existe UNA sola ops.' || v_fn, v_n = 1, v_n::text);

    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = v_fn AND p.prosecdef;
    PERFORM pg_temp.check('02 ' || v_fn || ': SECURITY INVOKER, no DEFINER', v_n = 0, v_n::text);

    PERFORM pg_temp.check('03 ' || v_fn || ': search_path fijo',
      EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'ops' AND p.proname = v_fn
           AND array_to_string(p.proconfig, ' ') LIKE 'search_path=%'
      ), v_fn);
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Alta: camino feliz, y que nace pausada
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor uuid;
  v_cond  jsonb;
  v_rec   jsonb;
  v_out   jsonb;
  v_id    uuid;
  v_row   ops.notification_schedule%ROWTYPE;
BEGIN
  SELECT actor_id INTO v_actor FROM t_fix;
  SELECT conditions, recurrence INTO v_cond, v_rec FROM t_shapes;

  v_out := ops.create_notification_schedule(
    'Sin vehículo día por medio', 'Cargá tu auto', 'Sumá tu vehículo a AutoLibre para no perderte nada.',
    v_cond, v_rec, current_date, v_actor
  );
  v_id := (v_out->>'id')::uuid;
  SELECT * INTO v_row FROM ops.notification_schedule WHERE id = v_id;

  PERFORM pg_temp.check('04 alta: nace con active = false', v_row.active = false, v_row.active::text);
  PERFORM pg_temp.check('05 alta: name guardado', v_row.name = 'Sin vehículo día por medio', v_row.name);
  PERFORM pg_temp.check('06 alta: require_device default true', v_row.require_device = true, v_row.require_device::text);
  PERFORM pg_temp.check('07 alta: exclude_internal default true', v_row.exclude_internal = true, v_row.exclude_internal::text);
  PERFORM pg_temp.check('08 alta: created_by = actor', v_row.created_by = v_actor, v_row.created_by::text);
  PERFORM pg_temp.check('09 alta: devuelto == guardado', v_out->>'name' = v_row.name, v_out::text);

  PERFORM pg_temp.check('10 log: before NULL en el alta',
    (SELECT before IS NULL FROM ops.action_log
      WHERE target_id = v_id AND action = 'notification_schedule.create'), 'no null');
  PERFORM pg_temp.check('11 log: target_table',
    (SELECT target_table FROM ops.action_log WHERE target_id = v_id AND action = 'notification_schedule.create')
      = 'ops.notification_schedule', 'mal target_table');
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Alta: cada rechazo, uno por uno
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor uuid;
  v_cond  jsonb;
  v_rec   jsonb;
  v_msg   text;
BEGIN
  SELECT actor_id INTO v_actor FROM t_fix;
  SELECT conditions, recurrence INTO v_cond, v_rec FROM t_shapes;

  BEGIN
    PERFORM ops.create_notification_schedule('  ', 'x', 'y', v_cond, v_rec, current_date, v_actor);
    PERFORM pg_temp.check('12 NAME_REQUIRED', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('12 NAME_REQUIRED', v_msg LIKE 'NAME_REQUIRED%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', repeat('x', 101), 'y', v_cond, v_rec, current_date, v_actor);
    PERFORM pg_temp.check('13 INVALID_TITLE (>100)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('13 INVALID_TITLE (>100)', v_msg LIKE 'INVALID_TITLE%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', 'x', repeat('y', 501), v_cond, v_rec, current_date, v_actor);
    PERFORM pg_temp.check('14 INVALID_BODY (>500)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('14 INVALID_BODY (>500)', v_msg LIKE 'INVALID_BODY%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', 'x', 'y', '{}'::jsonb, v_rec, current_date, v_actor);
    PERFORM pg_temp.check('15 INVALID_CONDITIONS (no array)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('15 INVALID_CONDITIONS (no array)', v_msg LIKE 'INVALID_CONDITIONS%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', 'x', 'y', '[]'::jsonb, v_rec, current_date, v_actor);
    PERFORM pg_temp.check('16 INVALID_CONDITIONS_COUNT (0)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('16 INVALID_CONDITIONS_COUNT (0)', v_msg LIKE 'INVALID_CONDITIONS_COUNT%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', 'x', 'y', '[{"op": "eq"}]'::jsonb, v_rec, current_date, v_actor);
    PERFORM pg_temp.check('17 INVALID_CONDITIONS_SHAPE (sin field)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('17 INVALID_CONDITIONS_SHAPE (sin field)', v_msg LIKE 'INVALID_CONDITIONS_SHAPE%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', 'x', 'y', v_cond, '"no-object"'::jsonb, current_date, v_actor);
    PERFORM pg_temp.check('18 INVALID_RECURRENCE (no object)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('18 INVALID_RECURRENCE (no object)', v_msg LIKE 'INVALID_RECURRENCE%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', 'x', 'y', v_cond, '{"kind": "yearly", "atHour": 1, "atMinute": 0}'::jsonb, current_date, v_actor);
    PERFORM pg_temp.check('19 INVALID_RECURRENCE_KIND', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('19 INVALID_RECURRENCE_KIND', v_msg LIKE 'INVALID_RECURRENCE_KIND%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', 'x', 'y', v_cond, '{"kind": "daily", "atHour": 25, "atMinute": 0}'::jsonb, current_date, v_actor);
    PERFORM pg_temp.check('20 INVALID_RECURRENCE_TIME (atHour)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('20 INVALID_RECURRENCE_TIME (atHour)', v_msg LIKE 'INVALID_RECURRENCE_TIME%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', 'x', 'y', v_cond, '{"kind": "daily", "atHour": 19, "atMinute": 7}'::jsonb, current_date, v_actor);
    PERFORM pg_temp.check('21 INVALID_RECURRENCE_TIME (atMinute no es cuarto)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('21 INVALID_RECURRENCE_TIME (atMinute no es cuarto)', v_msg LIKE 'INVALID_RECURRENCE_TIME%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', 'x', 'y', v_cond, '{"kind": "everyNDays", "n": 1, "atHour": 19, "atMinute": 0}'::jsonb, current_date, v_actor);
    PERFORM pg_temp.check('22 INVALID_RECURRENCE_N (n=1)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('22 INVALID_RECURRENCE_N (n=1)', v_msg LIKE 'INVALID_RECURRENCE_N%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', 'x', 'y', v_cond, '{"kind": "weekly", "weekdays": [], "atHour": 18, "atMinute": 0}'::jsonb, current_date, v_actor);
    PERFORM pg_temp.check('23 INVALID_RECURRENCE_WEEKDAYS (vacío)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('23 INVALID_RECURRENCE_WEEKDAYS (vacío)', v_msg LIKE 'INVALID_RECURRENCE_WEEKDAYS%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', 'x', 'y', v_cond, '{"kind": "weekly", "weekdays": [7], "atHour": 18, "atMinute": 0}'::jsonb, current_date, v_actor);
    PERFORM pg_temp.check('24 INVALID_RECURRENCE_WEEKDAYS (7 fuera de rango)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('24 INVALID_RECURRENCE_WEEKDAYS (7 fuera de rango)', v_msg LIKE 'INVALID_RECURRENCE_WEEKDAYS%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', 'x', 'y', v_cond, '{"kind": "monthlyDay", "day": 30, "atHour": 9, "atMinute": 0}'::jsonb, current_date, v_actor);
    PERFORM pg_temp.check('25 INVALID_RECURRENCE_DAY (30, sólo 1-28)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('25 INVALID_RECURRENCE_DAY (30, sólo 1-28)', v_msg LIKE 'INVALID_RECURRENCE_DAY%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', 'x', 'y', v_cond, v_rec, current_date, v_actor, current_date - 1);
    PERFORM pg_temp.check('26 INVALID_ENDS_ON (anterior a starts_on)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('26 INVALID_ENDS_ON (anterior a starts_on)', v_msg LIKE 'INVALID_ENDS_ON%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', 'x', 'y', v_cond, v_rec, current_date, v_actor, NULL, 0);
    PERFORM pg_temp.check('27 INVALID_MAX_PER_USER (0)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('27 INVALID_MAX_PER_USER (0)', v_msg LIKE 'INVALID_MAX_PER_USER%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', 'x', 'y', v_cond, v_rec, current_date, gen_random_uuid());
    PERFORM pg_temp.check('28 ACTOR_NOT_FOUND', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('28 ACTOR_NOT_FOUND', v_msg LIKE 'ACTOR_NOT_FOUND%', v_msg);
  END;

  BEGIN
    PERFORM ops.create_notification_schedule('n', 'x', 'y', v_cond, v_rec, current_date, NULL);
    PERFORM pg_temp.check('29 ACTOR_REQUIRED', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('29 ACTOR_REQUIRED', v_msg LIKE 'ACTOR_REQUIRED%', v_msg);
  END;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- `weekly` y `monthlyDay` válidos (camino feliz de las dos formas que la
-- sección anterior sólo probó en el rechazo)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor uuid;
  v_cond  jsonb;
  v_out   jsonb;
BEGIN
  SELECT actor_id INTO v_actor FROM t_fix;
  SELECT conditions INTO v_cond FROM t_shapes;

  v_out := ops.create_notification_schedule(
    'Sin seguro domingos', 'x', 'y', v_cond,
    '{"kind": "weekly", "weekdays": [0], "atHour": 18, "atMinute": 0}'::jsonb,
    current_date, v_actor
  );
  PERFORM pg_temp.check('30 weekly válido', v_out ? 'id', v_out::text);

  v_out := ops.create_notification_schedule(
    'Mensual', 'x', 'y', v_cond,
    '{"kind": "monthlyDay", "day": 1, "atHour": 9, "atMinute": 30}'::jsonb,
    current_date, v_actor
  );
  PERFORM pg_temp.check('31 monthlyDay válido', v_out ? 'id', v_out::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Edición: cambia todo menos `active`; `SCHEDULE_NOT_FOUND`
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor uuid;
  v_cond  jsonb;
  v_rec   jsonb;
  v_id    uuid;
  v_out   jsonb;
  v_row   ops.notification_schedule%ROWTYPE;
  v_msg   text;
BEGIN
  SELECT actor_id INTO v_actor FROM t_fix;
  SELECT conditions, recurrence INTO v_cond, v_rec FROM t_shapes;

  v_out := ops.create_notification_schedule('Editable', 'Título viejo', 'Cuerpo viejo', v_cond, v_rec, current_date, v_actor);
  v_id := (v_out->>'id')::uuid;

  v_out := ops.update_notification_schedule(
    v_id, 'Editable (renombrada)', 'Título nuevo', 'Cuerpo nuevo', v_cond,
    '{"kind": "daily", "atHour": 8, "atMinute": 0}'::jsonb, current_date + 1, v_actor,
    NULL, 3, false, false, 'Ajuste de horario'
  );
  SELECT * INTO v_row FROM ops.notification_schedule WHERE id = v_id;

  PERFORM pg_temp.check('32 update: title', v_row.title = 'Título nuevo', v_row.title);
  PERFORM pg_temp.check('33 update: max_per_user', v_row.max_per_user = 3, v_row.max_per_user::text);
  PERFORM pg_temp.check('34 update: require_device', v_row.require_device = false, v_row.require_device::text);
  PERFORM pg_temp.check('35 update: NO toca active', v_row.active = false, v_row.active::text);
  PERFORM pg_temp.check('36 update: devuelto == guardado', v_out->>'title' = 'Título nuevo', v_out::text);

  BEGIN
    PERFORM ops.update_notification_schedule(gen_random_uuid(), 'x', 'y', 'z', v_cond, v_rec, current_date, v_actor);
    PERFORM pg_temp.check('37 SCHEDULE_NOT_FOUND (update)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('37 SCHEDULE_NOT_FOUND (update)', v_msg LIKE 'SCHEDULE_NOT_FOUND%', v_msg);
  END;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Pausar / reanudar
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor uuid;
  v_cond  jsonb;
  v_rec   jsonb;
  v_id    uuid;
  v_out   jsonb;
  v_log   ops.action_log%ROWTYPE;
BEGIN
  SELECT actor_id INTO v_actor FROM t_fix;
  SELECT conditions, recurrence INTO v_cond, v_rec FROM t_shapes;

  v_out := ops.create_notification_schedule('Para pausar', 'x', 'y', v_cond, v_rec, current_date, v_actor);
  v_id := (v_out->>'id')::uuid;

  v_out := ops.set_notification_schedule_active(v_id, true, v_actor, 'Activada para probar');
  PERFORM pg_temp.check('38 activar: active = true', (v_out->>'active')::boolean = true, v_out::text);

  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_id AND action = 'notification_schedule.activate'
   ORDER BY created_at DESC LIMIT 1;
  PERFORM pg_temp.check('39 log de activar', v_log.action = 'notification_schedule.activate', v_log.action);

  v_out := ops.set_notification_schedule_active(v_id, false, v_actor);
  PERFORM pg_temp.check('40 pausar: active = false', (v_out->>'active')::boolean = false, v_out::text);

  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_id AND action = 'notification_schedule.pause'
   ORDER BY created_at DESC LIMIT 1;
  PERFORM pg_temp.check('41 log de pausar', v_log.action = 'notification_schedule.pause', v_log.action);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Baja: camino feliz, rechazo con historial, log con after NULL
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor uuid;
  v_cond  jsonb;
  v_rec   jsonb;
  v_id_a  uuid;
  v_id_b  uuid;
  v_out   jsonb;
  v_log   ops.action_log%ROWTYPE;
  v_msg   text;
BEGIN
  SELECT actor_id INTO v_actor FROM t_fix;
  SELECT conditions, recurrence INTO v_cond, v_rec FROM t_shapes;

  v_out := ops.create_notification_schedule('Para borrar', 'x', 'y', v_cond, v_rec, current_date, v_actor);
  v_id_a := (v_out->>'id')::uuid;

  v_out := ops.delete_notification_schedule(v_id_a, v_actor, 'Se creó de más');
  PERFORM pg_temp.check('42 baja: no queda la fila',
    NOT EXISTS (SELECT 1 FROM ops.notification_schedule WHERE id = v_id_a), 'sigue');
  PERFORM pg_temp.check('43 baja: devuelve el before', v_out->>'name' = 'Para borrar', v_out::text);

  SELECT * INTO v_log FROM ops.action_log
   WHERE target_id = v_id_a AND action = 'notification_schedule.delete'
   ORDER BY created_at DESC LIMIT 1;
  PERFORM pg_temp.check('44 log de baja: after es NULL', v_log.after IS NULL, 'no null');
  PERFORM pg_temp.check('45 log de baja: before trae la fila', v_log.before->>'name' = 'Para borrar', v_log.before::text);

  -- Con historial: se rechaza.
  v_out := ops.create_notification_schedule('Con historial', 'x', 'y', v_cond, v_rec, current_date, v_actor);
  v_id_b := (v_out->>'id')::uuid;
  INSERT INTO ops.notification_schedule_run (schedule_id, occurrence_at, status)
  VALUES (v_id_b, now(), 'sent');

  BEGIN
    PERFORM ops.delete_notification_schedule(v_id_b, v_actor);
    PERFORM pg_temp.check('46 SCHEDULE_HAS_RUNS rechaza la baja', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('46 SCHEDULE_HAS_RUNS rechaza la baja', v_msg LIKE 'SCHEDULE_HAS_RUNS%', v_msg);
  END;
  PERFORM pg_temp.check('47 con el rechazo, la fila sigue existiendo',
    EXISTS (SELECT 1 FROM ops.notification_schedule WHERE id = v_id_b), 'desapareció');

  BEGIN
    PERFORM ops.delete_notification_schedule(gen_random_uuid(), v_actor);
    PERFORM pg_temp.check('48 SCHEDULE_NOT_FOUND (delete)', false, 'no tiró');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    PERFORM pg_temp.check('48 SCHEDULE_NOT_FOUND (delete)', v_msg LIKE 'SCHEDULE_NOT_FOUND%', v_msg);
  END;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- El freno de la doble corrida, y el `ON DELETE CASCADE` (guardrail 6)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor uuid;
  v_cond  jsonb;
  v_rec   jsonb;
  v_id    uuid;
  v_out   jsonb;
  v_occ   timestamptz := date_trunc('hour', now());
BEGIN
  SELECT actor_id INTO v_actor FROM t_fix;
  SELECT conditions, recurrence INTO v_cond, v_rec FROM t_shapes;

  v_out := ops.create_notification_schedule('Para el freno', 'x', 'y', v_cond, v_rec, current_date, v_actor);
  v_id := (v_out->>'id')::uuid;

  INSERT INTO ops.notification_schedule_run (schedule_id, occurrence_at, status) VALUES (v_id, v_occ, 'sent');
  BEGIN
    INSERT INTO ops.notification_schedule_run (schedule_id, occurrence_at, status) VALUES (v_id, v_occ, 'pending');
    PERFORM pg_temp.check('49 unique(schedule_id, occurrence_at) frena la doble corrida', false, 'no chocó');
  EXCEPTION WHEN unique_violation THEN
    PERFORM pg_temp.check('49 unique(schedule_id, occurrence_at) frena la doble corrida', true, NULL);
  END;

  -- Borrado directo de la tabla (no vía SP, que ya rechaza con historial): el
  -- `ON DELETE CASCADE` es del schema, y esto verifica que esté ahí.
  DELETE FROM ops.notification_schedule WHERE id = v_id;
  PERFORM pg_temp.check('50 ON DELETE CASCADE se lleva las corridas',
    NOT EXISTS (SELECT 1 FROM ops.notification_schedule_run WHERE schedule_id = v_id), 'sobrevivió');
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Integración: el SQL exacto con parámetros nombrados
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_actor uuid;
  v_cond  jsonb;
  v_rec   jsonb;
  v_out   jsonb;
BEGIN
  SELECT actor_id INTO v_actor FROM t_fix;
  SELECT conditions, recurrence INTO v_cond, v_rec FROM t_shapes;

  SELECT ops.create_notification_schedule(
    p_name             => 'Integración',
    p_title            => 'x',
    p_body             => 'y',
    p_conditions       => v_cond,
    p_recurrence       => v_rec,
    p_starts_on        => current_date,
    p_actor_id         => v_actor,
    p_ends_on          => NULL,
    p_max_per_user     => NULL,
    p_require_device   => true,
    p_exclude_internal => true,
    p_note             => NULL
  ) INTO v_out;

  PERFORM pg_temp.check('51 integración: parámetros nombrados', v_out->>'name' = 'Integración', v_out::text);
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
