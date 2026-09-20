-- ═══════════════════════════════════════════════════════════════════════════
-- 014 — Reglas de notificación (envíos automáticos recurrentes).
--
-- `.claude/plans/notificaciones-automaticas.md` es el plan completo. Esta
-- migración es su Fase 1: las dos tablas + los SP de alta / edición /
-- pausa-reanudación / baja, CON auditoría. NO incluye el motor que dispara los
-- envíos (Fase 4 del plan) — esa fase está bloqueada por una decisión de
-- autenticación que el plan deja abierta a propósito (§3: quién autentica un
-- envío que nadie disparó, porque `auth()` de Clerk no existe adentro de un
-- cron). Una regla guardada acá NO le manda un push a nadie: nace pausada
-- (`active = false`, guardrail propio, más abajo) y nada de este archivo la
-- activa.
--
-- ── Por qué vive en `ops`, igual que el resto de este schema ────────────────
--
-- Una regla de notificación es operación del panel — nadie de la app la lee, y
-- el backend no tiene concepto de "audiencia recurrente". Misma razón que
-- `ops.quote_request_rubro` (013) o los precios de IA (decisión 3 del
-- CLAUDE.md): el panel la crea, la migra y la consulta, y el backend no la
-- conoce.
--
-- ── Los 8 guardrails, igual que 007–013 ─────────────────────────────────────
--
--   1. Vive en `migrations/`, nunca DDL a mano.
--   2. SECURITY INVOKER (el default).
--   3. `SET search_path` fijo en cada función.
--   4. `p_actor_id` sale de la sesión de Clerk, JAMÁS del payload.
--   5. Escribe `ops.action_log` DENTRO de cada función, con `before`/`after`
--      completos (`before` es NULL en el alta — no había fila; `after` es NULL
--      en la baja — ya no hay fila).
--   6. **Acá SÍ hay una FK**, y es la excepción documentada por el propio plan
--      (§5): `notification_schedule_run.schedule_id` referencia
--      `notification_schedule.id`, las dos tablas de ESTE schema. El guardrail
--      prohíbe cruzar a `public`, no relacionarse adentro de `ops` — acá no hay
--      dos repos con ciclos de migración distintos que desacoplar.
--   7. `SELECT … FOR UPDATE` antes de editar, pausar/reanudar o borrar: son
--      UPDATEs/DELETEs sobre una fila existente, a diferencia del alta (que no
--      tiene fila previa que lockear — mismo caso que la 012).
--   8. `updated_at` se pisa a mano en cada función de escritura: a diferencia
--      de `partners`/`leads`/`quote_requests`, esta tabla es NUEVA y no tiene
--      trigger de `set_updated_at()` — no hace falta uno más si cada SP ya lo
--      hace, y sumar el trigger sería la MISMA columna escrita por dos
--      caminos, que es justo la clase de duplicación que el guardrail 8 de
--      `ops-write-actions.md` prohíbe para las tablas que sí tienen trigger.
--
-- ── Las funciones VALIDAN REPRESENTABILIDAD, no reglas de negocio ───────────
--
-- Misma condición que el resto de `ops`: "mueven estado y copian datos, no
-- deciden nada". Lo que se valida acá es que `conditions` y `recurrence`
-- puedan interpretarse — no que la audiencia elegida "tenga sentido" para el
-- texto del mensaje, eso es juicio del operador.
--
--   - `conditions` es el MISMO array `{field, op, value}` que ya valida zod en
--     `~/lib/audience` del lado del servidor (el único llamador de estos SP es
--     ese repo). Acá se revisa sólo la FORMA (es un array de 1 a 8 objetos con
--     `field` y `op`) — no se reimplementa el catálogo de 29 campos, que vive
--     en TypeScript y puede crecer sin una migración. Reimplementarlo acá
--     sería la misma clase de acoplamiento que `INTERNAL_PREDICATE` entre
--     `ops.repo.ts` y `ops.v_ai_usage`, aplicada al revés (SQL copiando TS).
--   - `recurrence` SÍ se valida a fondo (`ops._validate_notification_recurrence`,
--     abajo): es el único dato de este archivo que un error de forma vuelve
--     completamente silencioso — una regla con `atHour` fuera de rango no
--     falla al guardarse, falla el día que el cron (todavía no escrito) intente
--     leerla, y para entonces nadie se acuerda de qué se guardó.
--
-- ── Por qué nace pausada, y por qué eso NO es un guardrail más de los 8 ─────
--
-- Es la regla de negocio del plan (§8.7: "una regla nueva nace PAUSADA. Un
-- formulario que manda el primer push al apretar Guardar es una mina") y por
-- eso el alta NO tiene un parámetro `p_active`: la columna se escribe `false`
-- fija en el `INSERT`, sin que el llamador pueda pedir otra cosa. La única
-- función que puede poner `active = true` es `ops.set_notification_schedule_active`,
-- y llamarla es una acción aparte y deliberada — nunca un efecto colateral de
-- guardar el formulario.
--
-- ── Por qué `ops.notification_schedule_run` existe ya, sin el motor ─────────
--
-- El plan la describe como la pieza central de la idempotencia (§7: la corrida
-- ES el `broadcastId`) vía `unique (schedule_id, occurrence_at)`. Crearla ahora
-- dejá lista esa defensa para cuando la Fase 4 empiece a escribir en ella; no
-- tiene SP propio en esta migración porque nadie humano crea una corrida — la
-- va a crear el cron, sin actor y sin sesión de Clerk, que es exactamente el
-- problema que el plan deja abierto en su §3.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ops.notification_schedule (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text        NOT NULL,
  -- Texto del push. Mismos topes que `BROADCAST_TITLE_MAX`/`BROADCAST_BODY_MAX`
  -- del envío ad-hoc (100/500) — se validan en el CUERPO de las funciones, no
  -- acá, para poder devolver una sentinela legible en vez de un 23514 crudo.
  title            text        NOT NULL,
  body             text        NOT NULL,
  -- El array `{field, op, value}` de `~/lib/audience`, tal cual.
  conditions       jsonb       NOT NULL,
  -- La forma de la §4 del plan: `{kind, atHour, atMinute, ...}`.
  recurrence       jsonb       NOT NULL,
  starts_on        date        NOT NULL,
  ends_on          date,
  max_per_user     int,
  require_device   boolean     NOT NULL DEFAULT true,
  exclude_internal boolean     NOT NULL DEFAULT true,
  -- Nace en `false`. Ninguna función de alta puede pisar esto — ver el
  -- comentario de cabecera.
  active           boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- UUID pelado de `users.id`. Sin FK a `public`, mismo criterio que
  -- `actor_id`/`target_id` de `ops.action_log`.
  created_by       uuid        NOT NULL
);

-- "¿Qué reglas están corriendo hoy?" — la consulta que el cron (Fase 4) va a
-- hacer en cada tick.
CREATE INDEX IF NOT EXISTS idx_ops_notification_schedule_active
  ON ops.notification_schedule (active);

CREATE TABLE IF NOT EXISTS ops.notification_schedule_run (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- FK DENTRO de `ops` — es la excepción documentada en el guardrail 6, arriba.
  schedule_id   uuid        NOT NULL REFERENCES ops.notification_schedule(id) ON DELETE CASCADE,
  occurrence_at timestamptz NOT NULL,
  status        text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  matched       int,
  sent_count    int,
  skip_reason   text,
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  -- El freno de la doble corrida (plan, §5 y §7): dos invocaciones del cron
  -- sobre la misma ocurrencia chocan acá, y la segunda no hace nada.
  UNIQUE (schedule_id, occurrence_at)
);

CREATE INDEX IF NOT EXISTS idx_ops_notification_schedule_run_schedule
  ON ops.notification_schedule_run (schedule_id, occurrence_at DESC);

-- ── Validación de forma (representabilidad, no reglas de negocio) ──────────

/**
 * `conditions` tiene que ser un array de 1 a 8 objetos con `field` y `op`.
 *
 * NO valida que `field` sea una de las 29 claves del catálogo de
 * `~/lib/audience`, ni que `op` corresponda a ese `field` — eso ya lo hace zod
 * del lado del único llamador (`~/server/schedules.repo`), y reimplementarlo acá
 * sería una segunda copia del catálogo divergiendo en silencio el día que
 * alguien agregue un campo nuevo sin tocar esta migración.
 */
CREATE OR REPLACE FUNCTION ops._validate_notification_conditions(p_conditions jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, ops
AS $$
BEGIN
  IF jsonb_typeof(p_conditions) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INVALID_CONDITIONS'
      USING HINT = 'Tiene que ser un array de condiciones.';
  END IF;

  IF jsonb_array_length(p_conditions) < 1 OR jsonb_array_length(p_conditions) > 8 THEN
    RAISE EXCEPTION 'INVALID_CONDITIONS_COUNT'
      USING HINT = 'Entre 1 y 8 condiciones, igual que el armador de audiencias.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_conditions) c
     WHERE jsonb_typeof(c) IS DISTINCT FROM 'object'
        OR NOT (c ? 'field')
        OR NOT (c ? 'op')
  ) THEN
    RAISE EXCEPTION 'INVALID_CONDITIONS_SHAPE'
      USING HINT = 'Cada condición necesita al menos field y op.';
  END IF;
END;
$$;

/**
 * `recurrence` tiene que describir un punto en el tiempo interpretable.
 *
 * A diferencia de `conditions`, esto se valida a fondo: es el único dato de
 * esta migración cuyo error de forma queda invisible hasta que algo (el cron,
 * todavía sin escribir) intente leerlo — para entonces nadie se acuerda de qué
 * se guardó. `atHour`/`atMinute` en cuartos, `n` de `everyNDays` en [2, 90],
 * `day` de `monthlyDay` en [1, 28] (nunca 29–31, por febrero) — los mismos
 * rangos de la §4 del plan.
 */
CREATE OR REPLACE FUNCTION ops._validate_notification_recurrence(p_recurrence jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, ops
AS $$
DECLARE
  v_kind      text;
  v_at_hour   int;
  v_at_minute int;
  v_n         int;
  v_day       int;
  v_weekdays  jsonb;
BEGIN
  IF jsonb_typeof(p_recurrence) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INVALID_RECURRENCE'
      USING HINT = 'Tiene que ser un objeto.';
  END IF;

  v_kind := p_recurrence->>'kind';
  IF v_kind IS NULL OR v_kind NOT IN ('daily', 'everyNDays', 'weekly', 'monthlyDay') THEN
    RAISE EXCEPTION 'INVALID_RECURRENCE_KIND: %', coalesce(v_kind, 'null')
      USING HINT = 'Valores válidos: daily, everyNDays, weekly, monthlyDay.';
  END IF;

  BEGIN
    v_at_hour := (p_recurrence->>'atHour')::int;
    v_at_minute := (p_recurrence->>'atMinute')::int;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'INVALID_RECURRENCE_TIME'
      USING HINT = 'atHour y atMinute tienen que ser enteros.';
  END;

  IF v_at_hour IS NULL OR v_at_hour < 0 OR v_at_hour > 23 THEN
    RAISE EXCEPTION 'INVALID_RECURRENCE_TIME'
      USING HINT = 'atHour tiene que estar entre 0 y 23.';
  END IF;
  IF v_at_minute IS NULL OR v_at_minute NOT IN (0, 15, 30, 45) THEN
    RAISE EXCEPTION 'INVALID_RECURRENCE_TIME'
      USING HINT = 'atMinute tiene que ser 0, 15, 30 o 45 — cuartos, no minutos sueltos.';
  END IF;

  IF v_kind = 'everyNDays' THEN
    BEGIN
      v_n := (p_recurrence->>'n')::int;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'INVALID_RECURRENCE_N';
    END;
    IF v_n IS NULL OR v_n < 2 OR v_n > 90 THEN
      RAISE EXCEPTION 'INVALID_RECURRENCE_N'
        USING HINT = 'n tiene que estar entre 2 y 90.';
    END IF;
  END IF;

  IF v_kind = 'weekly' THEN
    v_weekdays := p_recurrence->'weekdays';
    IF v_weekdays IS NULL OR jsonb_typeof(v_weekdays) IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_weekdays) = 0 THEN
      RAISE EXCEPTION 'INVALID_RECURRENCE_WEEKDAYS'
        USING HINT = 'weekdays tiene que ser un array no vacío de enteros 0–6.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(v_weekdays) w
       WHERE w !~ '^\d+$' OR w::int < 0 OR w::int > 6
    ) THEN
      RAISE EXCEPTION 'INVALID_RECURRENCE_WEEKDAYS'
        USING HINT = 'Cada día tiene que ser un entero de 0 (domingo) a 6 (sábado).';
    END IF;
  END IF;

  IF v_kind = 'monthlyDay' THEN
    BEGIN
      v_day := (p_recurrence->>'day')::int;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'INVALID_RECURRENCE_DAY';
    END;
    IF v_day IS NULL OR v_day < 1 OR v_day > 28 THEN
      RAISE EXCEPTION 'INVALID_RECURRENCE_DAY'
        USING HINT = 'day tiene que estar entre 1 y 28 — nunca 29–31: no todos los meses los tienen.';
    END IF;
  END IF;
END;
$$;

-- ── Escrituras ───────────────────────────────────────────────────────────────

/**
 * Alta. Nace PAUSADA siempre — no hay parámetro `p_active` (ver cabecera).
 */
CREATE OR REPLACE FUNCTION ops.create_notification_schedule(
  p_name             text,
  p_title            text,
  p_body             text,
  p_conditions       jsonb,
  p_recurrence       jsonb,
  p_starts_on        date,
  p_actor_id         uuid,
  p_ends_on          date DEFAULT NULL,
  p_max_per_user     int DEFAULT NULL,
  p_require_device   boolean DEFAULT true,
  p_exclude_internal boolean DEFAULT true,
  p_note             text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, ops
AS $$
DECLARE
  v_id    uuid;
  v_name  text := nullif(btrim(p_name), '');
  v_title text := nullif(btrim(p_title), '');
  v_body  text := nullif(btrim(p_body), '');
  v_after jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'NAME_REQUIRED';
  END IF;
  IF v_title IS NULL OR length(v_title) > 100 THEN
    RAISE EXCEPTION 'INVALID_TITLE'
      USING HINT = 'De 1 a 100 caracteres, igual que el envío ad-hoc.';
  END IF;
  IF v_body IS NULL OR length(v_body) > 500 THEN
    RAISE EXCEPTION 'INVALID_BODY'
      USING HINT = 'De 1 a 500 caracteres, igual que el envío ad-hoc.';
  END IF;

  PERFORM ops._validate_notification_conditions(p_conditions);
  PERFORM ops._validate_notification_recurrence(p_recurrence);

  IF p_ends_on IS NOT NULL AND p_ends_on <= p_starts_on THEN
    RAISE EXCEPTION 'INVALID_ENDS_ON'
      USING HINT = 'Tiene que ser posterior a starts_on.';
  END IF;
  IF p_max_per_user IS NOT NULL AND p_max_per_user < 1 THEN
    RAISE EXCEPTION 'INVALID_MAX_PER_USER'
      USING HINT = 'Si se manda, tiene que ser 1 o más.';
  END IF;

  v_id := gen_random_uuid();

  INSERT INTO ops.notification_schedule (
    id, name, title, body, conditions, recurrence, starts_on, ends_on,
    max_per_user, require_device, exclude_internal, active, created_by
  ) VALUES (
    v_id, v_name, v_title, v_body, p_conditions, p_recurrence, p_starts_on, p_ends_on,
    p_max_per_user, p_require_device, p_exclude_internal, false, p_actor_id
  );

  SELECT to_jsonb(s) INTO v_after FROM ops.notification_schedule s WHERE s.id = v_id;

  PERFORM ops.log_action(
    p_actor_id, 'notification_schedule.create', 'ops.notification_schedule', v_id,
    NULL, v_after, p_note
  );

  RETURN v_after;
END;
$$;

/**
 * Edición completa. Nunca toca `active` — pausar/reanudar es la otra función,
 * a propósito: guardar el formulario no puede tener el efecto colateral de
 * activar una regla.
 */
CREATE OR REPLACE FUNCTION ops.update_notification_schedule(
  p_schedule_id      uuid,
  p_name             text,
  p_title            text,
  p_body             text,
  p_conditions       jsonb,
  p_recurrence       jsonb,
  p_starts_on        date,
  p_actor_id         uuid,
  p_ends_on          date DEFAULT NULL,
  p_max_per_user     int DEFAULT NULL,
  p_require_device   boolean DEFAULT true,
  p_exclude_internal boolean DEFAULT true,
  p_note             text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, ops
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_name  text := nullif(btrim(p_name), '');
  v_title text := nullif(btrim(p_title), '');
  v_body  text := nullif(btrim(p_body), '');
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  SELECT to_jsonb(s) INTO v_before
    FROM ops.notification_schedule s
   WHERE s.id = p_schedule_id
     FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'SCHEDULE_NOT_FOUND: %', p_schedule_id;
  END IF;

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'NAME_REQUIRED';
  END IF;
  IF v_title IS NULL OR length(v_title) > 100 THEN
    RAISE EXCEPTION 'INVALID_TITLE'
      USING HINT = 'De 1 a 100 caracteres, igual que el envío ad-hoc.';
  END IF;
  IF v_body IS NULL OR length(v_body) > 500 THEN
    RAISE EXCEPTION 'INVALID_BODY'
      USING HINT = 'De 1 a 500 caracteres, igual que el envío ad-hoc.';
  END IF;

  PERFORM ops._validate_notification_conditions(p_conditions);
  PERFORM ops._validate_notification_recurrence(p_recurrence);

  IF p_ends_on IS NOT NULL AND p_ends_on <= p_starts_on THEN
    RAISE EXCEPTION 'INVALID_ENDS_ON'
      USING HINT = 'Tiene que ser posterior a starts_on.';
  END IF;
  IF p_max_per_user IS NOT NULL AND p_max_per_user < 1 THEN
    RAISE EXCEPTION 'INVALID_MAX_PER_USER'
      USING HINT = 'Si se manda, tiene que ser 1 o más.';
  END IF;

  UPDATE ops.notification_schedule SET
    name             = v_name,
    title            = v_title,
    body             = v_body,
    conditions       = p_conditions,
    recurrence       = p_recurrence,
    starts_on        = p_starts_on,
    ends_on          = p_ends_on,
    max_per_user     = p_max_per_user,
    require_device   = p_require_device,
    exclude_internal = p_exclude_internal,
    updated_at       = now()
  WHERE id = p_schedule_id;

  SELECT to_jsonb(s) INTO v_after FROM ops.notification_schedule s WHERE s.id = p_schedule_id;

  PERFORM ops.log_action(
    p_actor_id, 'notification_schedule.update', 'ops.notification_schedule', p_schedule_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;

/**
 * Pausar / reanudar. Una sola función que toggla el booleano, mismo patrón que
 * `ops.set_partner_status` — el log distingue la dirección por el nombre de la
 * acción (`activate` / `pause`), no por dos funciones separadas.
 */
CREATE OR REPLACE FUNCTION ops.set_notification_schedule_active(
  p_schedule_id uuid,
  p_active      boolean,
  p_actor_id    uuid,
  p_note        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, ops
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  SELECT to_jsonb(s) INTO v_before
    FROM ops.notification_schedule s
   WHERE s.id = p_schedule_id
     FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'SCHEDULE_NOT_FOUND: %', p_schedule_id;
  END IF;

  UPDATE ops.notification_schedule
     SET active = p_active, updated_at = now()
   WHERE id = p_schedule_id;

  SELECT to_jsonb(s) INTO v_after FROM ops.notification_schedule s WHERE s.id = p_schedule_id;

  PERFORM ops.log_action(
    p_actor_id,
    CASE WHEN p_active THEN 'notification_schedule.activate' ELSE 'notification_schedule.pause' END,
    'ops.notification_schedule', p_schedule_id, v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;

/**
 * Baja. Sólo para una regla que TODAVÍA NO CORRIÓ — con al menos una fila en
 * `ops.notification_schedule_run`, se rechaza: borrar la regla borraría (por
 * el `ON DELETE CASCADE`) el único rastro de qué se le mandó a quién y cuándo.
 * Para una regla con historial, la acción es pausarla, no borrarla.
 */
CREATE OR REPLACE FUNCTION ops.delete_notification_schedule(
  p_schedule_id uuid,
  p_actor_id    uuid,
  p_note        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, ops
AS $$
DECLARE
  v_before jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  SELECT to_jsonb(s) INTO v_before
    FROM ops.notification_schedule s
   WHERE s.id = p_schedule_id
     FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'SCHEDULE_NOT_FOUND: %', p_schedule_id;
  END IF;

  IF EXISTS (SELECT 1 FROM ops.notification_schedule_run r WHERE r.schedule_id = p_schedule_id) THEN
    RAISE EXCEPTION 'SCHEDULE_HAS_RUNS'
      USING HINT = 'Ya mandó al menos un envío — pausala en vez de borrarla, así no se pierde el historial.';
  END IF;

  DELETE FROM ops.notification_schedule WHERE id = p_schedule_id;

  PERFORM ops.log_action(
    p_actor_id, 'notification_schedule.delete', 'ops.notification_schedule', p_schedule_id,
    v_before, NULL, p_note
  );

  RETURN v_before;
END;
$$;
