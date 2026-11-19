-- ═══════════════════════════════════════════════════════════════════════════
-- Pruebas de la migración 034 (el motor de envíos programados).
--
--   PGLITE_DIR=… node tmp/run-034.mjs   (réplica: rojo sin la 034, verde con ella)
--
-- BEGIN … ROLLBACK. Necesita 007, 014, 033 y la cola del backend
-- (`public.notification_dispatch_requests`, copiada en `tmp/replica-034.sql`).
-- Igual que la de la 033, está pensada para la RÉPLICA: los destinatarios salen
-- de `ops.resolve_audience` sobre TODA la base, y los números esperados suponen
-- que los únicos usuarios son los de esta suite.
--
-- El reloj se maneja con `ops._enqueue_due_notifications_at(p_now)`. Cada tick
-- de la suite activa SÓLO las reglas que nombra (`pg_temp.tick`), así una
-- regla no le consume la ocurrencia a otra prueba.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE t_result (caso text, ok boolean, detalle text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.check(p_caso text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_result VALUES (p_caso, coalesce(p_ok, false), p_detalle);
$$;

-- ── Fixtures: usuarios ─────────────────────────────────────────────────────

CREATE TEMP TABLE t_u (label text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;
INSERT INTO t_u VALUES
  ('actor', gen_random_uuid()),  -- admin, sin dispositivo
  ('ua',    gen_random_uuid()),  -- con dispositivo
  ('ub',    gen_random_uuid()),  -- SIN dispositivo
  ('uc',    gen_random_uuid()),  -- con dispositivo
  ('ui',    gen_random_uuid());  -- interna, con dispositivo

CREATE OR REPLACE FUNCTION pg_temp.uid(p_label text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM t_u WHERE label = p_label;
$$;

INSERT INTO ops.excluded_email_domains (domain, note) VALUES ('test034.invalid', 'suite 034');

INSERT INTO users (id, email, role, auth_provider, external_auth_id)
SELECT id,
       CASE label WHEN 'ui' THEN 'interna-' || id || '@test034.invalid'
                  ELSE 'test-034-' || label || '-' || id || '@example.invalid' END,
       CASE label WHEN 'actor' THEN 'admin'::user_role ELSE 'user'::user_role END,
       'clerk'::auth_provider,
       'test-034-' || id
  FROM t_u;

INSERT INTO expo_push_tokens (user_id)
SELECT id FROM t_u WHERE label IN ('ua', 'uc', 'ui');

-- La suite cuenta sobre la base entera: que no haya reglas ajenas activas.
UPDATE ops.notification_schedule SET active = false WHERE active;

-- ── Fixtures: reglas y el tick ─────────────────────────────────────────────

CREATE TEMP TABLE t_s (label text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.sid(p_label text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM t_s WHERE label = p_label;
$$;

-- Alta por el SP de la 014 (valida como el panel) y `activated_at` plantado en
-- 2020: así cualquier `p_now` de la suite es posterior a la activación. Queda
-- PAUSADA; la activa `pg_temp.tick`.
CREATE OR REPLACE FUNCTION pg_temp.mk(
  p_label  text,
  p_rec    text,
  p_starts date,
  p_ends   date DEFAULT NULL,
  p_cond   text DEFAULT '[{"field":"isAdmin","op":"no"}]',
  p_dev    boolean DEFAULT true,
  p_int    boolean DEFAULT true,
  p_max    int DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  v := (ops.create_notification_schedule('034 ' || p_label, '  Título 034  ', ' Cuerpo 034 ',
        p_cond::jsonb, p_rec::jsonb, p_starts, pg_temp.uid('actor'),
        p_ends, p_max, p_dev, p_int)->>'id')::uuid;
  UPDATE ops.notification_schedule SET activated_at = '2020-01-01T00:00:00Z' WHERE id = v;
  INSERT INTO t_s VALUES (p_label, v);
  RETURN v;
END;
$$;

CREATE TEMP TABLE t_out (
  tick text, schedule_id uuid, occurrence_at timestamptz, status text, matched int, error text
) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.tick(p_tick text, p_now timestamptz, p_labels text[])
RETURNS int LANGUAGE plpgsql AS $$
DECLARE v int;
BEGIN
  UPDATE ops.notification_schedule s
     SET active = s.id IN (SELECT id FROM t_s WHERE label = ANY (p_labels))
   WHERE s.id IN (SELECT id FROM t_s);
  INSERT INTO t_out
  SELECT p_tick, r.* FROM ops._enqueue_due_notifications_at(p_now) r;
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.out(p_tick text, p_label text)
RETURNS t_out LANGUAGE sql AS $$
  SELECT * FROM t_out WHERE tick = p_tick AND schedule_id = pg_temp.sid(p_label);
$$;

CREATE OR REPLACE FUNCTION pg_temp.runs(p_label text) RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM ops.notification_schedule_run WHERE schedule_id = pg_temp.sid(p_label);
$$;

CREATE OR REPLACE FUNCTION pg_temp.rows_of(p_label text) RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM notification_dispatch_requests q
    JOIN ops.notification_schedule_run r ON r.id = q.batch_id
   WHERE r.schedule_id = pg_temp.sid(p_label);
$$;

CREATE OR REPLACE FUNCTION pg_temp.recipients(p_label text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(t.label, ',' ORDER BY t.label), '')
    FROM notification_dispatch_requests q
    JOIN ops.notification_schedule_run r ON r.id = q.batch_id
    JOIN t_u t ON t.id = q.user_id
   WHERE r.schedule_id = pg_temp.sid(p_label);
$$;

CREATE TEMP TABLE t_notif ON COMMIT DROP AS SELECT count(*)::int AS n FROM notifications;

-- ═══════════════════════════════════════════════════════════════════════════
-- 01–09 Guardrails de forma
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fn text;
  v_n  int;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'enqueue_due_notifications', '_enqueue_due_notifications_at',
    '_notification_schedule_latest_occurrence'
  ]
  LOOP
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = v_fn;
    PERFORM pg_temp.check('01 existe UNA sola ops.' || v_fn, v_n = 1, v_n::text);

    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = v_fn AND p.prosecdef;
    PERFORM pg_temp.check('02 ' || v_fn || ': SECURITY INVOKER', v_n = 0, v_n::text);

    PERFORM pg_temp.check('03 ' || v_fn || ': search_path fijo',
      EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'ops' AND p.proname = v_fn
                 AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')));
  END LOOP;

  PERFORM pg_temp.check('04 enqueue_due_notifications() sin argumentos, VOLATILE',
    (SELECT p.provolatile = 'v' FROM pg_proc p WHERE p.oid = to_regprocedure('ops.enqueue_due_notifications()')));
  PERFORM pg_temp.check('05 _enqueue_due_notifications_at(timestamptz), VOLATILE',
    (SELECT p.provolatile = 'v' FROM pg_proc p
      WHERE p.oid = to_regprocedure('ops._enqueue_due_notifications_at(timestamptz)')));
  PERFORM pg_temp.check('06 columnas de retorno: schedule_id, occurrence_at, status, matched, error',
    (SELECT p.proargnames[2:6] = ARRAY['schedule_id','occurrence_at','status','matched','error']
       FROM pg_proc p WHERE p.oid = to_regprocedure('ops._enqueue_due_notifications_at(timestamptz)')));
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10–29 La última ocurrencia (función pura, sin efectos)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pg_temp.occ(p_caso text, p_rec text, p_starts date, p_ends date,
                                        p_now timestamptz, p_expected timestamptz)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v timestamptz;
BEGIN
  v := ops._notification_schedule_latest_occurrence(p_rec::jsonb, p_starts, p_ends, p_now);
  PERFORM pg_temp.check(p_caso, v IS NOT DISTINCT FROM p_expected,
    'esperado ' || coalesce(p_expected::text, 'NULL') || ' dio ' || coalesce(v::text, 'NULL'));
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_temp.check(p_caso, false, SQLERRM);
END;
$$;

-- 2026-03-10 es MARTES. 09:00 en Buenos Aires = 12:00 UTC.
SELECT pg_temp.occ('10 daily: hoy, ya pasó la hora',
  '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01', NULL,
  '2026-03-10T12:30Z', '2026-03-10T12:00Z');
SELECT pg_temp.occ('11 daily: hoy todavía no → ayer',
  '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01', NULL,
  '2026-03-10T11:30Z', '2026-03-09T12:00Z');
SELECT pg_temp.occ('12 daily 23:30 BA = 02:30 UTC del día siguiente',
  '{"kind":"daily","atHour":23,"atMinute":30}', '2026-01-01', NULL,
  '2026-03-11T02:45Z', '2026-03-11T02:30Z');
SELECT pg_temp.occ('13 daily 23:30 BA: a las 23:20 BA (ya es mañana en UTC) → la de ayer',
  '{"kind":"daily","atHour":23,"atMinute":30}', '2026-01-01', NULL,
  '2026-03-11T02:20Z', '2026-03-10T02:30Z');
SELECT pg_temp.occ('14 daily 00:15 BA: a las 00:20 BA es HOY en BA (03:15 UTC)',
  '{"kind":"daily","atHour":0,"atMinute":15}', '2026-01-01', NULL,
  '2026-03-10T03:20Z', '2026-03-10T03:15Z');
SELECT pg_temp.occ('15 everyNDays n=3 desde el 1/3: el 10 toca',
  '{"kind":"everyNDays","n":3,"atHour":10,"atMinute":0}', '2026-03-01', NULL,
  '2026-03-10T13:15Z', '2026-03-10T13:00Z');
SELECT pg_temp.occ('16 everyNDays n=3 desde el 2/3: el 10 no toca → el 8',
  '{"kind":"everyNDays","n":3,"atHour":10,"atMinute":0}', '2026-03-02', NULL,
  '2026-03-10T13:15Z', '2026-03-08T13:00Z');
SELECT pg_temp.occ('17 everyNDays: antes de la hora del día que toca → la anterior',
  '{"kind":"everyNDays","n":3,"atHour":10,"atMinute":0}', '2026-03-01', NULL,
  '2026-03-10T12:59Z', '2026-03-07T13:00Z');
SELECT pg_temp.occ('18 weekly [2] (martes): hoy',
  '{"kind":"weekly","weekdays":[2],"atHour":8,"atMinute":0}', '2026-01-01', NULL,
  '2026-03-10T11:05Z', '2026-03-10T11:00Z');
SELECT pg_temp.occ('19 weekly [3] (miércoles): el de la semana pasada',
  '{"kind":"weekly","weekdays":[3],"atHour":8,"atMinute":0}', '2026-01-01', NULL,
  '2026-03-10T11:05Z', '2026-03-04T11:00Z');
SELECT pg_temp.occ('20 weekly [0,6]: el domingo es más reciente que el sábado',
  '{"kind":"weekly","weekdays":[0,6],"atHour":8,"atMinute":0}', '2026-01-01', NULL,
  '2026-03-10T11:05Z', '2026-03-08T11:00Z');
SELECT pg_temp.occ('21 weekly [2] 23:30: el martes BA cae miércoles en UTC',
  '{"kind":"weekly","weekdays":[2],"atHour":23,"atMinute":30}', '2026-01-01', NULL,
  '2026-03-11T02:45Z', '2026-03-11T02:30Z');
SELECT pg_temp.occ('22 monthlyDay 10: hoy',
  '{"kind":"monthlyDay","day":10,"atHour":9,"atMinute":0}', '2026-01-01', NULL,
  '2026-03-10T12:10Z', '2026-03-10T12:00Z');
SELECT pg_temp.occ('23 monthlyDay 11: el del mes pasado',
  '{"kind":"monthlyDay","day":11,"atHour":9,"atMinute":0}', '2026-01-01', NULL,
  '2026-03-10T12:10Z', '2026-02-11T12:00Z');
SELECT pg_temp.occ('24 starts_on en el futuro: ninguna',
  '{"kind":"daily","atHour":9,"atMinute":0}', '2026-03-11', NULL,
  '2026-03-10T12:30Z', NULL);
SELECT pg_temp.occ('25 starts_on hoy: la de hoy',
  '{"kind":"daily","atHour":9,"atMinute":0}', '2026-03-10', NULL,
  '2026-03-10T12:30Z', '2026-03-10T12:00Z');
SELECT pg_temp.occ('26 starts_on hoy pero todavía no es la hora: ninguna (no ayer)',
  '{"kind":"daily","atHour":9,"atMinute":0}', '2026-03-10', NULL,
  '2026-03-10T11:30Z', NULL);
SELECT pg_temp.occ('27 ends_on (incluido): la última es la de ese día',
  '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01', '2026-03-05',
  '2026-03-10T12:30Z', '2026-03-05T12:00Z');
DO $$
BEGIN
  PERFORM ops._notification_schedule_latest_occurrence('{"kind":"yearly","atHour":9,"atMinute":0}',
    '2026-01-01', NULL, '2026-03-10T12:30Z');
  PERFORM pg_temp.check('28 recurrence ilegible tira', false, 'no tiró');
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_temp.check('28 recurrence ilegible tira', SQLERRM LIKE 'INVALID_RECURRENCE_KIND%', SQLERRM);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 30–39 Encolar, y que el segundo tick no duplique
-- ═══════════════════════════════════════════════════════════════════════════

SELECT pg_temp.mk('s1', '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01');
SELECT pg_temp.tick('s1a', '2026-03-10T12:30Z', ARRAY['s1']);

DO $$
DECLARE o t_out; r record;
BEGIN
  o := pg_temp.out('s1a', 's1');
  PERFORM pg_temp.check('30 enqueued, ocurrencia de hoy, matched 2',
    o.status = 'enqueued' AND o.occurrence_at = '2026-03-10T12:00Z' AND o.matched = 2 AND o.error IS NULL,
    row_to_json(o)::text);
  PERFORM pg_temp.check('31 por default (dispositivo, sin internas): ua y uc',
    pg_temp.recipients('s1') = 'ua,uc', pg_temp.recipients('s1'));

  SELECT * INTO r FROM ops.notification_schedule_run WHERE schedule_id = pg_temp.sid('s1');
  PERFORM pg_temp.check('32 la corrida: sent, matched 2, sent_count 2, finished_at, sin skip_reason',
    r.status = 'sent' AND r.matched = 2 AND r.sent_count = 2 AND r.finished_at = '2026-03-10T12:30Z'
      AND r.skip_reason IS NULL AND r.error IS NULL, row_to_json(r)::text);

  PERFORM pg_temp.check('33 las filas: batch_id = corrida y scheduled_at = ocurrencia',
    NOT EXISTS (SELECT 1 FROM notification_dispatch_requests q
                 WHERE q.user_id IN (pg_temp.uid('ua'), pg_temp.uid('uc'))
                   AND (q.batch_id <> r.id OR q.scheduled_at <> '2026-03-10T12:00Z'))
      AND pg_temp.rows_of('s1') = 2);
  PERFORM pg_temp.check('34 no escribe status/reject_reason/processed_at (quedan los default)',
    NOT EXISTS (SELECT 1 FROM notification_dispatch_requests q WHERE q.batch_id = r.id
                   AND (q.status <> 'pending' OR q.reject_reason IS NOT NULL OR q.processed_at IS NOT NULL)));
  PERFORM pg_temp.check('35 título y cuerpo recortados',
    NOT EXISTS (SELECT 1 FROM notification_dispatch_requests q WHERE q.batch_id = r.id
                   AND (q.title <> 'Título 034' OR q.body <> 'Cuerpo 034')));
END $$;

SELECT pg_temp.check('36 segundo tick, mismo reloj: no devuelve fila',
  pg_temp.tick('s1b', '2026-03-10T12:30Z', ARRAY['s1']) = 0);
SELECT pg_temp.check('37 … ni corrida ni filas de más',
  pg_temp.runs('s1') = 1 AND pg_temp.rows_of('s1') = 2);
SELECT pg_temp.check('38 más tarde el mismo día: misma ocurrencia, nada',
  pg_temp.tick('s1c', '2026-03-10T16:00Z', ARRAY['s1']) = 0 AND pg_temp.runs('s1') = 1);
SELECT pg_temp.tick('s1d', '2026-03-11T12:01Z', ARRAY['s1']);
SELECT pg_temp.check('39 al día siguiente: corrida nueva',
  (pg_temp.out('s1d', 's1')).status = 'enqueued' AND pg_temp.runs('s1') = 2 AND pg_temp.rows_of('s1') = 4);

-- ═══════════════════════════════════════════════════════════════════════════
-- 40–49 La ventana de 6 h
-- ═══════════════════════════════════════════════════════════════════════════

SELECT pg_temp.mk('s2', '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01');
SELECT pg_temp.tick('s2a', '2026-03-10T11:30Z', ARRAY['s2']);
DO $$
DECLARE o t_out; r record;
BEGIN
  o := pg_temp.out('s2a', 's2');
  PERFORM pg_temp.check('40 > 6 h: skipped missed_window con la ocurrencia de ayer',
    o.status = 'skipped' AND o.error = 'missed_window' AND o.occurrence_at = '2026-03-09T12:00Z',
    row_to_json(o)::text);
  SELECT * INTO r FROM ops.notification_schedule_run WHERE schedule_id = pg_temp.sid('s2');
  PERFORM pg_temp.check('41 la corrida queda skipped / missed_window, con finished_at',
    r.status = 'skipped' AND r.skip_reason = 'missed_window' AND r.finished_at IS NOT NULL,
    row_to_json(r)::text);
  PERFORM pg_temp.check('42 y no encola a nadie', pg_temp.rows_of('s2') = 0);
END $$;
SELECT pg_temp.check('43 el missed_window se registra UNA vez',
  pg_temp.tick('s2b', '2026-03-10T11:45Z', ARRAY['s2']) = 0 AND pg_temp.runs('s2') = 1);

SELECT pg_temp.mk('s2x', '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01');
SELECT pg_temp.tick('s2x', '2026-03-09T18:00Z', ARRAY['s2x']);
SELECT pg_temp.check('44 justo 6 h después: se procesa',
  (pg_temp.out('s2x', 's2x')).status = 'enqueued');

SELECT pg_temp.mk('s2y', '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01');
SELECT pg_temp.tick('s2y', '2026-03-09T18:01Z', ARRAY['s2y']);
SELECT pg_temp.check('45 6 h y 1 min: missed_window',
  (pg_temp.out('s2y', 's2y')).error = 'missed_window');

-- ═══════════════════════════════════════════════════════════════════════════
-- 50–59 Qué reglas cuentan
-- ═══════════════════════════════════════════════════════════════════════════

SELECT pg_temp.mk('s4', '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01');
SELECT pg_temp.tick('s4', '2026-03-10T12:30Z', ARRAY[]::text[]);
SELECT pg_temp.check('50 pausada: se ignora',
  pg_temp.out('s4', 's4') IS NULL AND pg_temp.runs('s4') = 0);

SELECT pg_temp.mk('s5', '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01');
UPDATE ops.notification_schedule SET activated_at = '2026-03-10T12:05Z' WHERE id = pg_temp.sid('s5');
SELECT pg_temp.tick('s5a', '2026-03-10T12:30Z', ARRAY['s5']);
SELECT pg_temp.check('51 ocurrencia anterior a activated_at: ni fila ni corrida',
  pg_temp.out('s5a', 's5') IS NULL AND pg_temp.runs('s5') = 0);
SELECT pg_temp.tick('s5b', '2026-03-11T12:10Z', ARRAY['s5']);
SELECT pg_temp.check('52 la siguiente (posterior a la activación) sí',
  (pg_temp.out('s5b', 's5')).status = 'enqueued');

SELECT pg_temp.mk('s6', '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01', '2026-03-05');
SELECT pg_temp.tick('s6', '2026-03-10T12:30Z', ARRAY['s6']);
SELECT pg_temp.check('53 terminada (ends_on): sólo constancia de su última, perdida',
  (pg_temp.out('s6', 's6')).occurrence_at = '2026-03-05T12:00Z'
    AND (pg_temp.out('s6', 's6')).error = 'missed_window' AND pg_temp.rows_of('s6') = 0);

SELECT pg_temp.mk('s7', '{"kind":"daily","atHour":9,"atMinute":0}', '2026-03-11');
SELECT pg_temp.tick('s7', '2026-03-10T12:30Z', ARRAY['s7']);
SELECT pg_temp.check('54 todavía no empezó: nada', pg_temp.out('s7', 's7') IS NULL AND pg_temp.runs('s7') = 0);

SELECT pg_temp.mk('s3', '{"kind":"daily","atHour":23,"atMinute":30}', '2026-01-01');
SELECT pg_temp.tick('s3', '2026-03-11T02:45Z', ARRAY['s3']);
SELECT pg_temp.check('55 23:30 BA: encola con scheduled_at 02:30 UTC del día siguiente',
  (pg_temp.out('s3', 's3')).occurrence_at = '2026-03-11T02:30Z'
    AND NOT EXISTS (SELECT 1 FROM notification_dispatch_requests q
                      JOIN ops.notification_schedule_run r ON r.id = q.batch_id
                     WHERE r.schedule_id = pg_temp.sid('s3') AND q.scheduled_at <> '2026-03-11T02:30Z'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 60–69 Destinatarios
-- ═══════════════════════════════════════════════════════════════════════════

SELECT pg_temp.mk('s8', '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01', NULL,
  '[{"field":"isAdmin","op":"no"}]', false, true);
SELECT pg_temp.tick('s8', '2026-03-10T12:30Z', ARRAY['s8']);
SELECT pg_temp.check('60 require_device = false: también ub (sin dispositivo)',
  pg_temp.recipients('s8') = 'ua,ub,uc' AND (pg_temp.out('s8', 's8')).matched = 3, pg_temp.recipients('s8'));

SELECT pg_temp.mk('s9', '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01', NULL,
  '[{"field":"isAdmin","op":"no"}]', true, false);
SELECT pg_temp.tick('s9', '2026-03-10T12:30Z', ARRAY['s9']);
SELECT pg_temp.check('61 exclude_internal = false: también ui (interna)',
  pg_temp.recipients('s9') = 'ua,uc,ui', pg_temp.recipients('s9'));

-- max_per_user = 2, con dos corridas ANTERIORES de esta regla:
--   ua: 2 rechazadas (no cuentan) → entra.
--   uc: 1 pending + 1 processed (cuentan) → 2, no entra.
-- Más ruido de OTRA regla (s1 ya le encoló a ua y uc): no cuenta.
SELECT pg_temp.mk('s10', '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01', NULL,
  '[{"field":"isAdmin","op":"no"}]', true, true, 2);
DO $$
DECLARE r1 uuid; r2 uuid;
BEGIN
  -- `error = 'fixture'` marca las corridas plantadas por la suite (caso 83).
  INSERT INTO ops.notification_schedule_run (schedule_id, occurrence_at, status, finished_at, error)
  VALUES (pg_temp.sid('s10'), '2026-03-01T12:00Z', 'sent', '2026-03-01T12:00Z', 'fixture') RETURNING id INTO r1;
  INSERT INTO ops.notification_schedule_run (schedule_id, occurrence_at, status, finished_at, error)
  VALUES (pg_temp.sid('s10'), '2026-03-02T12:00Z', 'sent', '2026-03-02T12:00Z', 'fixture') RETURNING id INTO r2;
  INSERT INTO notification_dispatch_requests (batch_id, user_id, title, body, scheduled_at, status, reject_reason, processed_at)
  VALUES
    (r1, pg_temp.uid('ua'), 't', 'b', '2026-03-01T12:00Z', 'rejected', 'announcement silenciado', '2026-03-01T12:01Z'),
    (r2, pg_temp.uid('ua'), 't', 'b', '2026-03-02T12:00Z', 'rejected', 'announcement silenciado', '2026-03-02T12:01Z'),
    (r1, pg_temp.uid('uc'), 't', 'b', '2026-03-01T12:00Z', 'pending', NULL, NULL),
    (r2, pg_temp.uid('uc'), 't', 'b', '2026-03-02T12:00Z', 'processed', NULL, '2026-03-02T12:01Z');
END $$;
SELECT pg_temp.tick('s10', '2026-03-10T12:30Z', ARRAY['s10']);
SELECT pg_temp.check('62 max_per_user: rechazadas no cuentan, pending/processed sí',
  (pg_temp.out('s10', 's10')).matched = 1
    AND EXISTS (SELECT 1 FROM notification_dispatch_requests q
                  JOIN ops.notification_schedule_run r ON r.id = q.batch_id
                 WHERE r.schedule_id = pg_temp.sid('s10') AND r.occurrence_at = '2026-03-10T12:00Z'
                   AND q.user_id = pg_temp.uid('ua'))
    AND NOT EXISTS (SELECT 1 FROM notification_dispatch_requests q
                  JOIN ops.notification_schedule_run r ON r.id = q.batch_id
                 WHERE r.schedule_id = pg_temp.sid('s10') AND r.occurrence_at = '2026-03-10T12:00Z'
                   AND q.user_id = pg_temp.uid('uc')),
  row_to_json(pg_temp.out('s10', 's10'))::text);

-- Nadie: los admins son el actor, que no tiene dispositivo.
SELECT pg_temp.mk('s11', '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01', NULL,
  '[{"field":"isAdmin","op":"yes"}]');
SELECT pg_temp.tick('s11', '2026-03-10T12:30Z', ARRAY['s11']);
DO $$
DECLARE o t_out; r record;
BEGIN
  o := pg_temp.out('s11', 's11');
  PERFORM pg_temp.check('63 matched 0: skipped no_recipients',
    o.status = 'skipped' AND o.matched = 0 AND o.error = 'no_recipients', row_to_json(o)::text);
  SELECT * INTO r FROM ops.notification_schedule_run WHERE schedule_id = pg_temp.sid('s11');
  PERFORM pg_temp.check('64 la corrida: skipped / no_recipients, matched 0, sent_count 0',
    r.status = 'skipped' AND r.skip_reason = 'no_recipients' AND r.matched = 0 AND r.sent_count = 0
      AND r.finished_at IS NOT NULL, row_to_json(r)::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 70–79 Una regla rota no tira las demás
-- ═══════════════════════════════════════════════════════════════════════════

SELECT pg_temp.mk('s12', '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01');
SELECT pg_temp.mk('s13', '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01');
SELECT pg_temp.mk('s14', '{"kind":"daily","atHour":9,"atMinute":0}', '2026-01-01');
-- Rotas a mano, salteando la validación de la 014/033.
UPDATE ops.notification_schedule SET conditions = '[{"field":"bogus","op":"eq","value":1}]'
 WHERE id = pg_temp.sid('s12');
UPDATE ops.notification_schedule SET recurrence = '{"kind":"yearly","atHour":9,"atMinute":0}'
 WHERE id = pg_temp.sid('s14');
SELECT pg_temp.tick('s12', '2026-03-12T12:10Z', ARRAY['s12', 's13', 's14']);

DO $$
DECLARE o t_out; r record;
BEGIN
  o := pg_temp.out('s12', 's12');
  PERFORM pg_temp.check('70 condición rota: failed con el error',
    o.status = 'failed' AND o.error LIKE 'INVALID_AUDIENCE_FIELD%' AND o.occurrence_at = '2026-03-12T12:00Z',
    row_to_json(o)::text);
  SELECT * INTO r FROM ops.notification_schedule_run WHERE schedule_id = pg_temp.sid('s12');
  PERFORM pg_temp.check('71 la corrida sobrevive y queda failed con error y finished_at',
    r.status = 'failed' AND r.error LIKE 'INVALID_AUDIENCE_FIELD%' AND r.finished_at IS NOT NULL,
    row_to_json(r)::text);
  PERFORM pg_temp.check('72 la rota no encoló nada', pg_temp.rows_of('s12') = 0);
  PERFORM pg_temp.check('73 la sana del mismo tick encoló igual',
    (pg_temp.out('s12', 's13')).status = 'enqueued' AND pg_temp.rows_of('s13') = 2);
  o := pg_temp.out('s12', 's14');
  PERFORM pg_temp.check('74 recurrence rota: failed sin ocurrencia y sin corrida',
    o.status = 'failed' AND o.occurrence_at IS NULL AND o.error LIKE 'INVALID_RECURRENCE_KIND%'
      AND pg_temp.runs('s14') = 0, row_to_json(o)::text);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 80–89 Sin la cola del backend, y lo que nunca toca
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  BEGIN
    ALTER TABLE notification_dispatch_requests RENAME TO notification_dispatch_requests_034;
    PERFORM count(*) FROM ops._enqueue_due_notifications_at('2026-03-10T12:30Z');
    PERFORM pg_temp.check('80 DISPATCH_TABLE_MISSING', false, 'no tiró');
    RAISE EXCEPTION 'deshacer el rename';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'deshacer el rename' THEN
      PERFORM pg_temp.check('80 DISPATCH_TABLE_MISSING', SQLERRM LIKE 'DISPATCH_TABLE_MISSING%', SQLERRM);
    END IF;
  END;
  PERFORM pg_temp.check('81 la tabla volvió (el rename se deshizo)',
    to_regclass('public.notification_dispatch_requests') IS NOT NULL);
END $$;

SELECT pg_temp.check('82 nunca escribe public.notifications',
  (SELECT count(*)::int FROM notifications) = (SELECT n FROM t_notif));

-- Todo lo que encoló el motor (no las filas que plantó la suite para s10).
SELECT pg_temp.check('83 ninguna fila encolada tiene status/reject_reason/processed_at escritos',
  NOT EXISTS (SELECT 1 FROM notification_dispatch_requests q
                JOIN ops.notification_schedule_run r ON r.id = q.batch_id
               WHERE r.error IS DISTINCT FROM 'fixture'
                 AND (q.status <> 'pending' OR q.reject_reason IS NOT NULL OR q.processed_at IS NOT NULL)));

SELECT pg_temp.check('84 todas las filas encoladas: scheduled_at = ocurrencia de su corrida',
  NOT EXISTS (SELECT 1 FROM notification_dispatch_requests q
                JOIN ops.notification_schedule_run r ON r.id = q.batch_id
               WHERE q.scheduled_at <> r.occurrence_at));

SELECT pg_temp.check('85 el motor no escribe ops.action_log',
  NOT EXISTS (SELECT 1 FROM ops.action_log WHERE action NOT LIKE 'notification_schedule.%'));

-- La pública, con todo pausado: corre y no devuelve nada.
DO $$
DECLARE v int;
BEGIN
  UPDATE ops.notification_schedule SET active = false WHERE id IN (SELECT id FROM t_s);
  SELECT count(*) INTO v FROM ops.enqueue_due_notifications();
  PERFORM pg_temp.check('86 enqueue_due_notifications() con todo pausado: 0 filas', v = 0, v::text);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_temp.check('86 enqueue_due_notifications() con todo pausado: 0 filas', false, SQLERRM);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════

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
