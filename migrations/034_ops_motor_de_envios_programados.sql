-- ═══════════════════════════════════════════════════════════════════════════
-- 034 — El motor de los envíos programados: `ops.enqueue_due_notifications()`.
--
-- Es la Fase 4 del plan (`.claude/plans/notificaciones-automaticas.md`) que la
-- 014 dejó bloqueada por "quién autentica un envío que nadie disparó". La
-- respuesta quedó así: el panel NO manda nada. El BACKEND corre un cron cada 15
-- minutos que hace
--
--     SELECT * FROM ops.enqueue_due_notifications();
--
-- y esta función sólo ENCOLA: escribe filas en
-- `public.notification_dispatch_requests` (tabla del backend, que este repo
-- nunca altera). Después el backend las procesa con su propio caso de uso
-- (`Notification.create()`, preferencias, push) y les pone `status`,
-- `processed_at` o `reject_reason`. **Esta función escribe SÓLO `batch_id`,
-- `user_id`, `title`, `body` y `scheduled_at`**, y no toca `public.notifications`
-- jamás: crear una notificación es del backend (decisión 4b del CLAUDE.md).
--
-- ── Qué hace en cada tick ───────────────────────────────────────────────────
--
--  1. Por cada regla ACTIVA, calcula la ÚLTIMA ocurrencia `<= now()` según su
--     `recurrence` (forma de la 014), en hora de Buenos Aires.
--  2. La ocurrencia cuenta si su FECHA (BA) está en [starts_on, ends_on] y es
--     `>= activated_at` (033): reanudar una regla no dispara lo que "se perdió"
--     mientras estaba pausada.
--  3. Si ya hay corrida para `(schedule_id, occurrence_at)`, no hace nada.
--  4. Si pasó hace más de 6 h → corrida `skipped` / `missed_window` (sólo la
--     última; las más viejas no se registran). Un push de "tu seguro vence"
--     siete horas tarde, a las 3 de la mañana, es peor que ninguno.
--  5. Si no → corrida + destinatarios + filas de `notification_dispatch_requests`.
--
-- ── Decisiones, y por qué ───────────────────────────────────────────────────
--
-- * **La corrida ES el `batch_id`.** `ops.notification_schedule_run.id` va como
--   `batch_id` de cada fila; el UNIQUE `(batch_id, user_id)` del backend y el
--   `ON CONFLICT DO NOTHING` hacen que reintentar no duplique a nadie.
-- * **Sin `pg_advisory_xact_lock`.** El freno de la doble corrida es el UNIQUE
--   `(schedule_id, occurrence_at)` de la 014: dos ticks simultáneos chocan en el
--   `INSERT … ON CONFLICT DO NOTHING` de la corrida (el segundo espera el commit
--   del primero y no inserta nada). Un lock aparte sería un segundo mecanismo
--   para lo mismo, y uno que no sobrevive a un pooler en modo transacción.
-- * **Sin `ops.action_log` por tick.** Sería una fila cada 15 minutos por regla,
--   sin actor humano (`assert_actor` no tiene a quién encontrar). La auditoría
--   del motor es `ops.notification_schedule_run` (una fila por ocurrencia, con
--   matched / sent_count / skip_reason / error); la auditoría de las PERSONAS
--   (quién creó, editó o activó la regla) sigue en `ops.action_log`.
-- * **Cada regla en su propio bloque `BEGIN … EXCEPTION`.** Una regla rota no
--   tira las demás. La corrida se inserta ANTES del bloque, así sobrevive al
--   rollback del subbloque y el handler la marca `failed` con el `SQLERRM`.
--   Nunca se re-lanza: el cron no tiene a quién avisarle salvo por el retorno.
--   Una `recurrence` que no se puede interpretar (sólo posible saltándose la
--   validación de la 014) devuelve `failed` SIN corrida: sin ocurrencia no hay
--   clave con la que guardarla.
-- * **La única excepción que sí corta todo: `DISPATCH_TABLE_MISSING`.** Sin la
--   tabla del backend no hay dónde encolar, y eso no es un problema de UNA
--   regla: es un deploy desfasado. Si se tragara por regla, cada tick llenaría
--   la tabla de corridas `failed` y quemaría las ocurrencias (el UNIQUE no deja
--   reintentarlas cuando la tabla aparezca). Fallar la llamada entera no deja
--   ningún rastro y el backend lo loguea.
-- * **`monthlyDay` en meses cortos: no existe el caso.** La 014 sólo admite
--   `day` de 1 a 28, justamente para no decidir qué pasa un 31 de febrero.
-- * **`weekly`**: `weekdays` es un array de enteros 0 (domingo) … 6 (sábado),
--   igual que `extract(dow …)` de Postgres.
-- * **`everyNDays`** se cuenta desde `starts_on`: `(fecha - starts_on) % n = 0`.
-- * **La hora es de Buenos Aires** con `AT TIME ZONE`, nunca un `- 3 horas`
--   escrito a mano (un cambio de huso de la Argentina no debería romper esto).
-- * **`now()` es inyectable**: la lógica vive en
--   `ops._enqueue_due_notifications_at(p_now)` y la pública la llama con
--   `now()`. Las pruebas manejan el reloj.
--
-- ── Destinatarios, en el momento del tick ───────────────────────────────────
--
-- `ops.resolve_audience(conditions)` (033) ∩
--   `require_device`   → tiene al menos un `expo_push_tokens`;
--   `exclude_internal` → NO cumple `INTERNAL_PREDICATE` (el mismo texto de
--                        `ops.repo.ts` y de la 033);
--   `max_per_user`     → filas suyas de `notification_dispatch_requests`, de
--                        corridas ANTERIORES de ESTA regla, con
--                        `status <> 'rejected'` (lo rechazado nunca le llegó),
--                        menos que el tope. Las `pending` sí cuentan.
--
-- ── Guardrails ──────────────────────────────────────────────────────────────
--
-- SECURITY INVOKER (corre con el rol del cron del backend, que necesita poder
-- leer/escribir `ops.notification_schedule{,_run}` y llamar a la 033: los GRANT
-- a ese rol, si no es el dueño, son una migración aparte como la 026),
-- `SET search_path` fijo, VOLATILE. Todo el SQL sobre `public` se planifica al
-- ejecutar (plpgsql), así que la 034 se crea aunque la tabla del backend falte.
-- ═══════════════════════════════════════════════════════════════════════════

/**
 * La última ocurrencia `<= p_now` de una `recurrence` de la 014, en hora de
 * Buenos Aires, con FECHA dentro de [starts_on, ends_on]. NULL si no hay.
 *
 * Mira hasta 92 días para atrás: el período más largo que admite la 014 es
 * `everyNDays` con n = 90 (y `monthlyDay` ~31). Lo que quede más atrás nunca
 * sería procesable (ventana de 6 h) y ni siquiera se registra como perdido.
 */
CREATE OR REPLACE FUNCTION ops._notification_schedule_latest_occurrence(
  p_recurrence jsonb,
  p_starts_on  date,
  p_ends_on    date,
  p_now        timestamptz
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, ops
AS $fn$
DECLARE
  v_tz      constant text := 'America/Argentina/Buenos_Aires';
  v_kind    text := p_recurrence->>'kind';
  v_time    time;
  v_today   date;
  v_n       int;
  v_day     int;
  v_wdays   int[];
  v_result  timestamptz;
BEGIN
  IF v_kind IS NULL OR v_kind NOT IN ('daily', 'everyNDays', 'weekly', 'monthlyDay') THEN
    RAISE EXCEPTION 'INVALID_RECURRENCE_KIND: %', coalesce(v_kind, 'null');
  END IF;

  v_time := make_time((p_recurrence->>'atHour')::int, (p_recurrence->>'atMinute')::int, 0);
  IF v_time IS NULL THEN
    RAISE EXCEPTION 'INVALID_RECURRENCE_TIME';
  END IF;

  IF v_kind = 'everyNDays' THEN
    v_n := (p_recurrence->>'n')::int;
    IF v_n IS NULL OR v_n < 1 THEN
      RAISE EXCEPTION 'INVALID_RECURRENCE_N';
    END IF;
  ELSIF v_kind = 'weekly' THEN
    SELECT array_agg(w::int) INTO v_wdays
      FROM jsonb_array_elements_text(p_recurrence->'weekdays') w;
    IF v_wdays IS NULL THEN
      RAISE EXCEPTION 'INVALID_RECURRENCE_WEEKDAYS';
    END IF;
  ELSIF v_kind = 'monthlyDay' THEN
    v_day := (p_recurrence->>'day')::int;
    IF v_day IS NULL THEN
      RAISE EXCEPTION 'INVALID_RECURRENCE_DAY';
    END IF;
  END IF;

  -- La fecha de HOY en Buenos Aires, no en UTC: a las 23:30 de BA ya es
  -- mañana en UTC.
  v_today := (p_now AT TIME ZONE v_tz)::date;

  SELECT max((d.d + v_time) AT TIME ZONE v_tz)
    INTO v_result
    -- Serie de ENTEROS restados a una `date`: una serie de timestamps pasaría
    -- por `timestamptz` y el `::date` de vuelta dependería del huso de la sesión.
    FROM generate_series(0, 92) AS g(k)
    CROSS JOIN LATERAL (SELECT v_today - g.k AS d) d
   WHERE d.d >= p_starts_on
     AND (p_ends_on IS NULL OR d.d <= p_ends_on)
     AND ((d.d + v_time) AT TIME ZONE v_tz) <= p_now
     AND CASE v_kind
           WHEN 'daily'      THEN true
           WHEN 'everyNDays' THEN (d.d - p_starts_on) % v_n = 0
           WHEN 'weekly'     THEN extract(dow FROM d.d)::int = ANY (v_wdays)
           WHEN 'monthlyDay' THEN extract(day FROM d.d)::int = v_day
         END;

  RETURN v_result;
END;
$fn$;

/**
 * El motor, con el reloj inyectado. Ver la cabecera.
 */
CREATE OR REPLACE FUNCTION ops._enqueue_due_notifications_at(p_now timestamptz)
RETURNS TABLE (schedule_id uuid, occurrence_at timestamptz, status text, matched int, error text)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, ops
AS $fn$
#variable_conflict use_column
DECLARE
  v_s       record;
  v_occ     timestamptz;
  v_run_id  uuid;
  v_ids     uuid[];
  v_matched int;
  v_sent    int;
BEGIN
  IF to_regclass('public.notification_dispatch_requests') IS NULL THEN
    RAISE EXCEPTION 'DISPATCH_TABLE_MISSING: public.notification_dispatch_requests no existe'
      USING HINT = 'Falta la migración del backend que crea la cola de envíos. No se encoló nada.';
  END IF;

  FOR v_s IN
    SELECT s.* FROM ops.notification_schedule s
     WHERE s.active
     ORDER BY s.created_at, s.id
  LOOP
    -- 1. La ocurrencia. Una recurrence ilegible es una regla rota: se informa
    --    sin corrida (no hay `occurrence_at` con el que guardarla).
    BEGIN
      v_occ := ops._notification_schedule_latest_occurrence(
        v_s.recurrence, v_s.starts_on, v_s.ends_on, p_now);
    EXCEPTION WHEN OTHERS THEN
      schedule_id := v_s.id; occurrence_at := NULL; status := 'failed';
      matched := NULL; error := SQLERRM;
      RETURN NEXT;
      CONTINUE;
    END;

    -- 2. Nada que hacer: sin ocurrencia, anterior a la activación, o ya tomada.
    CONTINUE WHEN v_occ IS NULL;
    CONTINUE WHEN v_s.activated_at IS NULL OR v_occ < v_s.activated_at;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM ops.notification_schedule_run r
       WHERE r.schedule_id = v_s.id AND r.occurrence_at = v_occ);

    -- 3. Fuera de la ventana de 6 h: se deja constancia UNA vez y no se manda.
    IF p_now - v_occ > interval '6 hours' THEN
      v_run_id := NULL;
      INSERT INTO ops.notification_schedule_run AS r
        (schedule_id, occurrence_at, status, skip_reason, started_at, finished_at)
      VALUES (v_s.id, v_occ, 'skipped', 'missed_window', p_now, p_now)
      ON CONFLICT (schedule_id, occurrence_at) DO NOTHING
      RETURNING r.id INTO v_run_id;

      IF v_run_id IS NOT NULL THEN
        schedule_id := v_s.id; occurrence_at := v_occ; status := 'skipped';
        matched := NULL; error := 'missed_window';
        RETURN NEXT;
      END IF;
      CONTINUE;
    END IF;

    -- 4. La corrida, AFUERA del subbloque: sobrevive a un error de la regla.
    v_run_id := NULL;
    INSERT INTO ops.notification_schedule_run AS r (schedule_id, occurrence_at, status, started_at)
    VALUES (v_s.id, v_occ, 'pending', p_now)
    ON CONFLICT (schedule_id, occurrence_at) DO NOTHING
    RETURNING r.id INTO v_run_id;

    -- Otro tick la tomó entre el EXISTS y acá: es suya, en silencio.
    CONTINUE WHEN v_run_id IS NULL;

    BEGIN
      SELECT coalesce(array_agg(a.id), ARRAY[]::uuid[])
        INTO v_ids
        FROM ops.resolve_audience(v_s.conditions) AS a(id)
        JOIN users u ON u.id = a.id
       WHERE (NOT v_s.require_device
              OR EXISTS (SELECT 1 FROM expo_push_tokens t WHERE t.user_id = u.id))
         AND (NOT v_s.exclude_internal
              OR NOT coalesce(
  split_part(lower(u.email), '@', 2) IN (SELECT d.domain FROM ops.excluded_email_domains d),
  false
))
         AND (v_s.max_per_user IS NULL
              OR (SELECT count(*)
                    FROM notification_dispatch_requests q
                    JOIN ops.notification_schedule_run pr ON pr.id = q.batch_id
                   WHERE pr.schedule_id = v_s.id
                     AND pr.id <> v_run_id
                     AND q.user_id = u.id
                     AND q.status::text <> 'rejected') < v_s.max_per_user);

      v_matched := cardinality(v_ids);

      INSERT INTO notification_dispatch_requests (batch_id, user_id, title, body, scheduled_at)
      SELECT v_run_id, x.id, btrim(v_s.title), btrim(v_s.body), v_occ
        FROM unnest(v_ids) AS x(id)
      ON CONFLICT (batch_id, user_id) DO NOTHING;
      GET DIAGNOSTICS v_sent = ROW_COUNT;

      UPDATE ops.notification_schedule_run r
         SET status      = CASE WHEN v_matched = 0 THEN 'skipped' ELSE 'sent' END,
             skip_reason = CASE WHEN v_matched = 0 THEN 'no_recipients' END,
             matched     = v_matched,
             sent_count  = v_sent,
             finished_at = p_now
       WHERE r.id = v_run_id;

      schedule_id := v_s.id; occurrence_at := v_occ;
      status := CASE WHEN v_matched = 0 THEN 'skipped' ELSE 'enqueued' END;
      matched := v_matched;
      error := CASE WHEN v_matched = 0 THEN 'no_recipients' END;
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      UPDATE ops.notification_schedule_run r
         SET status = 'failed', error = SQLERRM, finished_at = p_now
       WHERE r.id = v_run_id;

      schedule_id := v_s.id; occurrence_at := v_occ; status := 'failed';
      matched := NULL; error := SQLERRM;
      RETURN NEXT;
    END;
  END LOOP;
END;
$fn$;

/**
 * Lo que llama el cron del backend cada 15 minutos.
 */
CREATE OR REPLACE FUNCTION ops.enqueue_due_notifications()
RETURNS TABLE (schedule_id uuid, occurrence_at timestamptz, status text, matched int, error text)
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, ops
AS $fn$
  SELECT * FROM ops._enqueue_due_notifications_at(now());
$fn$;
