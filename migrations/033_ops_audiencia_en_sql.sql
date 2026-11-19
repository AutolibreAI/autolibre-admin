-- ═══════════════════════════════════════════════════════════════════════════
-- 033 — La audiencia en SQL: el catálogo de `~/lib/audience` adentro de `ops`.
--
-- ── Por qué, y por qué esto da vuelta lo que decía la 014 ───────────────────
--
-- La 014 decidió NO reimplementar el catálogo de audiencias en SQL: vivía en
-- TypeScript (`~/lib/audience` + `AUDIENCE_SQL` de `~/server/audience.repo`) y
-- una segunda copia acá iba a divergir en silencio. Era correcto mientras el
-- único que resolvía una audiencia era el panel.
--
-- Deja de serlo con el motor de envíos programados: el backend va a correr un
-- cron que llama a `ops.enqueue_due_notifications()` (otra migración, no ésta),
-- y ese cron no tiene TypeScript del panel — tiene Postgres. La audiencia de una
-- regla se tiene que poder resolver ADENTRO de la base, con UNA definición.
--
-- Así que la copia existe, y la defensa contra la divergencia cambia de forma:
--
--   1. Las expresiones se copiaron TEXTUALMENTE de `AUDIENCE_SQL`, de `OK`
--      (`scanners.repo.ts`), de `INTERNAL_PREDICATE` (`ops.repo.ts`) y de
--      `lastSignalSql('u.id')` (`~/lib/activity`). Cada `WHEN` dice de dónde.
--   2. `tmp/probe-audiencia-paridad.mjs` corre la MISMA audiencia por los dos
--      caminos (`previewAudience` real cargado con vite, y esta función) y
--      compara los ids uno por uno. **Tocar un campo de un lado sin correr ese
--      probe es exactamente el bug que esta nota existe para evitar.**
--   3. La validación es la de zod, campo por campo: lo que TS rechaza, SQL
--      rechaza (`def.ops ?? OPERATORS_BY_KIND[kind]`, `OPERATORS_WITH_VALUE`,
--      entero de 0 a 3650). Una regla guardada que el cron no pueda resolver
--      falla al guardarse, no a las 19:00 de un martes.
--
-- ── Lo que viaja sigue sin ser SQL ──────────────────────────────────────────
--
-- `field` y `op` se resuelven con un CASE CERRADO: una clave que no está en el
-- catálogo es `INVALID_AUDIENCE_FIELD`, nunca un fragmento concatenado. `value`
-- se valida como entero de 0 a 3650 ANTES de tocar nada y viaja por
-- `EXECUTE … USING` (un `int[]`, referenciado como `$1[n]`): jamás entra al
-- texto de la consulta. Lo único que `format()` interpola es `n`, el índice del
-- slot — un entero que pone la función, no el llamador.
--
-- ── La función puede crearse aunque falten tablas ───────────────────────────
--
-- Todo el SQL sobre `public` es DINÁMICO (plpgsql + `EXECUTE`): Postgres lo
-- planifica al ejecutar, no al crear. La 033 se aplica en cualquier base que el
-- panel migre, tenga o no todas las tablas del backend; recién una audiencia
-- que use un campo cuya tabla falte revienta, y revienta en la ejecución.
-- Mismo motivo por el que los SP de la 011 no son `LANGUAGE sql`.
--
-- ── `activated_at` ──────────────────────────────────────────────────────────
--
-- El cron va a considerar elegibles sólo las ocurrencias posteriores a la
-- última activación: reanudar una regla pausada hace tres semanas no puede
-- disparar de golpe las ocurrencias que "se perdió". La columna la estampa
-- `ops.set_notification_schedule_active` cuando `active` pasa de false a true
-- (nunca en true→true, y una pausa la deja como estaba).
--
-- ── Título y cuerpo: ya cuadraban con el backend ────────────────────────────
--
-- `notification_dispatch_requests` (backend) exige título 1..100 y cuerpo
-- 1..500 medidos DESPUÉS de `btrim`. Relevado: la 014 ya hace exactamente eso
-- (`nullif(btrim(x), '')` + `length(...) > N`, y guarda el texto recortado),
-- así que esta migración no toca el alta ni la edición. La suite lo fija con
-- casos de borde (100/101, 500/501, sólo espacios) para que no se corra solo.
--
-- ── Guardrails ──────────────────────────────────────────────────────────────
--
-- Las funciones nuevas son de LECTURA (no escriben, no loguean): SECURITY
-- INVOKER, `SET search_path` fijo. `ops.resolve_audience` es STABLE (lee
-- `now()`/`current_date`, que son constantes en la transacción). La única
-- escritura que cambia es `set_notification_schedule_active`, misma firma y
-- los mismos 8 guardrails de la 014 (actor de la sesión, `FOR UPDATE`, log
-- adentro con before/after, `updated_at` a mano porque no hay trigger).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── El catálogo: expresión por campo ─────────────────────────────────────────

/**
 * La expresión SQL de un campo, sobre el alias `u` de `users`. Copia textual de
 * `AUDIENCE_SQL` (`src/server/audience.repo.ts`). Un campo desconocido no
 * devuelve NULL: tira `INVALID_AUDIENCE_FIELD`.
 */
CREATE OR REPLACE FUNCTION ops._audience_field_expr(p_field text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, ops
AS $fn$
BEGIN
  RETURN CASE p_field
    -- ── Uso de la app ──
    WHEN 'vehicles' THEN
      $e$(select count(*) from vehicles v where v.user_id = u.id and not v.archived)$e$
    -- El corte `OK` de `scanners.repo.ts`, escrito con el alias `d`.
    WHEN 'scansOk' THEN
      $e$(select count(*) from driving_sessions d
               where d.user_id = u.id
                 and d.status::text = 'completed'
                 and coalesce(d.total_readings, 0) > 0)$e$
    WHEN 'scansTotal' THEN
      $e$(select count(*) from driving_sessions d where d.user_id = u.id)$e$
    -- Con al menos un mensaje, como `usageAdoption` (`chats.md`).
    WHEN 'chats' THEN
      $e$(select count(*) from conversations c
             where c.user_id = u.id
               and exists (select 1 from conversation_messages m where m.conversation_id = c.id))$e$
    WHEN 'maintenanceUpcoming' THEN
      $e$(select count(*) from maintenance_occurrences m
                           where m.user_id = u.id and not m.archived and m.performed_at is null)$e$

    -- ── Documentos ──
    WHEN 'insurances' THEN
      $e$(select count(*) from insurances i where i.user_id = u.id and not i.archived)$e$
    WHEN 'inspections' THEN
      $e$(select count(*) from vehicle_inspections i where i.user_id = u.id and not i.archived)$e$
    WHEN 'registrationCards' THEN
      $e$(select count(*) from registration_cards r where r.user_id = u.id and not r.archived)$e$
    WHEN 'driverLicenses' THEN
      $e$(select count(*) from driver_licenses l where l.user_id = u.id and not l.archived)$e$

    -- ── Vencimientos: el MÁS PRÓXIMO ──
    WHEN 'vtvExpiry' THEN
      $e$(select min(i.expiration_date) from vehicle_inspections i
                 where i.user_id = u.id and not i.archived)$e$
    WHEN 'insuranceExpiry' THEN
      $e$(select min(i.expiration_date) from insurances i
                       where i.user_id = u.id and not i.archived)$e$
    WHEN 'licenseExpiry' THEN
      $e$(select min(l.expiration_date) from driver_licenses l
                     where l.user_id = u.id and not l.archived)$e$
    WHEN 'registrationExpiry' THEN
      $e$(select min(r.expiration_date) from registration_cards r
                          where r.user_id = u.id and not r.archived)$e$

    -- ── Multas: el `status = 'pending'` de `fines.repo.ts` ──
    WHEN 'pendingFines' THEN
      $e$(select count(*) from fines f where f.user_id = u.id and f.status::text = 'pending')$e$

    -- ── Vehículos: `vehicleFlag()`, "ALGUNO" y nunca "TODOS" ──
    WHEN 'vehicleWithoutInsurance' THEN
      $e$exists (select 1 from vehicles v2
                    where v2.user_id = u.id and not v2.archived
                      and not exists (select 1 from insurances i2
                  where i2.vehicle_id = v2.id and not i2.archived))$e$
    -- El "es OCR" de `documents.md`: `file_id` cargado y `source = 'manual'`.
    WHEN 'vehicleWithoutVtv' THEN
      $e$exists (select 1 from vehicles v2
                    where v2.user_id = u.id and not v2.archived
                      and not exists (select 1 from vehicle_inspections vi2
                  where vi2.vehicle_id = v2.id and not vi2.archived
                    and vi2.file_id is not null and vi2.source::text = 'manual'))$e$
    WHEN 'vehicleWithoutRegistration' THEN
      $e$exists (select 1 from vehicles v2
                    where v2.user_id = u.id and not v2.archived
                      and not exists (select 1 from registration_cards r2
                  where r2.vehicle_id = v2.id and not r2.archived))$e$
    WHEN 'vehicleWithPendingFines' THEN
      $e$exists (select 1 from vehicles v2
                    where v2.user_id = u.id and not v2.archived
                      and exists (select 1 from fines f2
              where f2.vehicle_id = v2.id and f2.status::text = 'pending'))$e$
    -- `OK` de `scanners.repo.ts`, LITERAL, con su alias `ds` cableado.
    WHEN 'vehicleNeverScanned' THEN
      $e$exists (select 1 from vehicles v2
                    where v2.user_id = u.id and not v2.archived
                      and not exists (select 1 from driving_sessions ds where ds.vehicle_id = v2.id and ds.status::text = 'completed' and coalesce(ds.total_readings, 0) > 0))$e$
    WHEN 'vehicleWithoutOdometer' THEN
      $e$exists (select 1 from vehicles v2
                    where v2.user_id = u.id and not v2.archived
                      and coalesce(v2.odometer_value, 0) = 0)$e$

    -- ── Actividad ──
    WHEN 'signup' THEN
      $e$u.created_at$e$
    -- `lastSignalSql('u.id')` de `~/lib/activity`, sin piso: `null` = "se
    -- registró y no hizo nada". Si `USER_ACTIVITY_SIGNALS` suma una señal, se
    -- suma acá también — y el probe de paridad lo agarra si no.
    WHEN 'lastActivity' THEN
      $e$greatest((select max(t.created_at) from vehicles t where t.user_id = u.id), (select max(t.created_at) from conversations t where t.user_id = u.id), (select max(t.created_at) from driving_sessions t where t.user_id = u.id))$e$
    WHEN 'lastScan' THEN
      $e$(select max(d.created_at) from driving_sessions d where d.user_id = u.id)$e$
    WHEN 'lastChat' THEN
      $e$(select max(c.created_at) from conversations c where c.user_id = u.id)$e$

    -- ── Cuenta y entrega ──
    WHEN 'pushTokens' THEN
      $e$(select count(*) from expo_push_tokens t where t.user_id = u.id)$e$
    WHEN 'announcementsReceived' THEN
      $e$(select count(*) from notifications n
                             where n.user_id = u.id and n.source_type::text = 'broadcast')$e$
    WHEN 'isAdmin' THEN
      $e$(u.role::text = 'admin')$e$
    -- `INTERNAL_PREDICATE` de `ops.repo.ts`, el mismo de `ops.v_ai_usage`.
    WHEN 'isInternal' THEN
      $e$coalesce(
  split_part(lower(u.email), '@', 2) IN (SELECT d.domain FROM ops.excluded_email_domains d),
  false
)$e$
    WHEN 'isLegacyNative' THEN
      $e$(u.auth_provider::text = 'native')$e$
  END;
END;
$fn$;

/**
 * Los operadores que admite un campo: `def.ops ?? OPERATORS_BY_KIND[kind]` de
 * `~/lib/audience`. NULL = el campo no existe.
 */
CREATE OR REPLACE FUNCTION ops._audience_field_ops(p_field text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, ops
AS $fn$
  SELECT CASE
    -- `signup` tiene `ops` propios: `users.created_at` es NOT NULL, "nunca" no existe.
    WHEN p_field = 'signup' THEN
      ARRAY['moreThan', 'lessThan']
    -- kind = count
    WHEN p_field IN ('vehicles', 'scansOk', 'scansTotal', 'chats', 'maintenanceUpcoming',
                     'insurances', 'inspections', 'registrationCards', 'driverLicenses',
                     'pendingFines', 'pushTokens', 'announcementsReceived') THEN
      ARRAY['eq', 'gte', 'lte']
    -- kind = days
    WHEN p_field IN ('lastActivity', 'lastScan', 'lastChat') THEN
      ARRAY['moreThan', 'lessThan', 'never', 'ever']
    -- kind = expiry
    WHEN p_field IN ('vtvExpiry', 'insuranceExpiry', 'licenseExpiry', 'registrationExpiry') THEN
      ARRAY['expired', 'withinDays', 'valid', 'missing']
    -- kind = flag
    WHEN p_field IN ('vehicleWithoutInsurance', 'vehicleWithoutVtv', 'vehicleWithoutRegistration',
                     'vehicleWithPendingFines', 'vehicleNeverScanned', 'vehicleWithoutOdometer',
                     'isAdmin', 'isInternal', 'isLegacyNative') THEN
      ARRAY['yes', 'no']
  END;
$fn$;

/**
 * UNA condición → fragmento de `where`. Valida todo (campo, operador del campo,
 * presencia y rango de `value`) y es lo que comparten `resolve_audience` y la
 * validación de reglas: una sola definición de "condición válida".
 *
 * `p_slot` es la posición del valor en el `int[]` que `resolve_audience` pasa
 * por `USING` (`$1[p_slot]`). Lo pone la función que llama, nunca el payload.
 *
 * Copia de `conditionSql()` de `audience.repo.ts`, con `$1[n]` donde allá va
 * `$n::int`. `null` nunca matchea, igual que allá: para "nunca" está `never`.
 */
CREATE OR REPLACE FUNCTION ops._audience_condition_sql(p_condition jsonb, p_slot int)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, ops
AS $fn$
DECLARE
  v_field text;
  v_op    text;
  v_ops   text[];
  v_expr  text;
  v_val   jsonb;
  v_needs boolean;
  v_p     text;
BEGIN
  IF jsonb_typeof(p_condition) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INVALID_CONDITIONS_SHAPE'
      USING HINT = 'Cada condición es un objeto {field, op, value?}.';
  END IF;

  -- `field` y `op` tienen que ser strings: `{"field": 1}` no es un campo.
  IF jsonb_typeof(p_condition->'field') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'INVALID_AUDIENCE_FIELD: %', coalesce(p_condition->>'field', 'null');
  END IF;
  v_field := p_condition->>'field';
  v_ops := ops._audience_field_ops(v_field);
  IF v_ops IS NULL THEN
    RAISE EXCEPTION 'INVALID_AUDIENCE_FIELD: %', v_field
      USING HINT = 'El campo no está en el catálogo de ~/lib/audience.';
  END IF;

  v_op := CASE WHEN jsonb_typeof(p_condition->'op') = 'string' THEN p_condition->>'op' END;
  IF v_op IS NULL OR NOT (v_op = ANY (v_ops)) THEN
    RAISE EXCEPTION 'INVALID_AUDIENCE_OPERATOR: %.%', v_field, coalesce(p_condition->>'op', 'null')
      USING HINT = 'Operadores válidos para ese campo: ' || array_to_string(v_ops, ', ');
  END IF;

  -- `OPERATORS_WITH_VALUE`. Un `value` de más es error, no se ignora (zod igual).
  v_needs := v_op IN ('eq', 'gte', 'lte', 'moreThan', 'lessThan', 'withinDays');
  IF v_needs AND NOT (p_condition ? 'value') THEN
    RAISE EXCEPTION 'AUDIENCE_VALUE_REQUIRED: %.%', v_field, v_op
      USING HINT = 'Ese operador lleva un número.';
  END IF;
  IF NOT v_needs AND (p_condition ? 'value') THEN
    RAISE EXCEPTION 'AUDIENCE_VALUE_NOT_ALLOWED: %.%', v_field, v_op
      USING HINT = 'Ese operador no lleva número.';
  END IF;

  IF v_needs THEN
    v_val := p_condition->'value';
    -- `z.number().int().min(0).max(3650)`: número JSON (no string, no null),
    -- entero y en rango. `5.0` pasa (JS no lo distingue de 5); `5.5` no.
    IF jsonb_typeof(v_val) IS DISTINCT FROM 'number'
       OR (v_val::text)::numeric <> trunc((v_val::text)::numeric)
       OR (v_val::text)::numeric < 0
       OR (v_val::text)::numeric > 3650 THEN
      RAISE EXCEPTION 'INVALID_AUDIENCE_VALUE: %.% = %', v_field, v_op, v_val::text
        USING HINT = 'Un entero de 0 a 3650.';
    END IF;
  END IF;

  IF p_slot IS NULL OR p_slot < 1 THEN
    RAISE EXCEPTION 'INVALID_AUDIENCE_SLOT';
  END IF;

  v_expr := ops._audience_field_expr(v_field);
  -- Lo único que entra por `format` es el índice, un int de la función.
  v_p := format('$1[%s]', p_slot);

  RETURN CASE v_op
    WHEN 'eq'         THEN v_expr || ' = ' || v_p
    WHEN 'gte'        THEN v_expr || ' >= ' || v_p
    WHEN 'lte'        THEN v_expr || ' <= ' || v_p
    WHEN 'moreThan'   THEN v_expr || ' < now() - make_interval(days => ' || v_p || ')'
    WHEN 'lessThan'   THEN v_expr || ' >= now() - make_interval(days => ' || v_p || ')'
    WHEN 'never'      THEN v_expr || ' is null'
    WHEN 'ever'       THEN v_expr || ' is not null'
    WHEN 'expired'    THEN v_expr || ' < current_date'
    WHEN 'withinDays' THEN '(' || v_expr || ' >= current_date and ' || v_expr || ' <= current_date + ' || v_p || ')'
    WHEN 'valid'      THEN v_expr || ' >= current_date'
    WHEN 'missing'    THEN v_expr || ' is null'
    WHEN 'yes'        THEN '(' || v_expr || ')'
    WHEN 'no'         THEN 'not (' || v_expr || ')'
  END;
END;
$fn$;

-- ── Validación de reglas: ahora con el catálogo ──────────────────────────────

/**
 * Misma firma que la 014 (CREATE OR REPLACE alcanza). Conserva las tres
 * sentinelas de forma y suma, por condición, las de `_audience_condition_sql`.
 * La regla de la 014 ("no se reimplementa el catálogo") queda reemplazada por
 * la cabecera de esta migración.
 *
 * Ojo: las reglas YA guardadas no se revalidan. Una regla vieja con una
 * condición fuera del catálogo rebota recién al editarla (o al resolverla).
 */
CREATE OR REPLACE FUNCTION ops._validate_notification_conditions(p_conditions jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, ops
AS $$
DECLARE
  v_c jsonb;
  v_i int := 0;
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

  FOR v_c IN SELECT c FROM jsonb_array_elements(p_conditions) c LOOP
    v_i := v_i + 1;
    PERFORM ops._audience_condition_sql(v_c, v_i);
  END LOOP;
END;
$$;

-- ── Resolver una audiencia ───────────────────────────────────────────────────

/**
 * Los `users.id` que cumplen TODAS las condiciones (Y, nunca O). Mismo
 * universo que `previewAudience`: `users` entero, sin ningún filtro por
 * default (ni internos, ni admins, ni sin dispositivo — eso lo decide quien
 * llama, con condiciones o con las banderas de la regla). Mismo orden:
 * `created_at, id`.
 *
 * Sin el tope de 500 de la vista previa: el corte es de la UI y del lote del
 * backend, no de la definición de la audiencia.
 */
CREATE OR REPLACE FUNCTION ops.resolve_audience(p_conditions jsonb)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, ops
AS $fn$
DECLARE
  v_c     jsonb;
  v_i     int := 0;
  v_where text[] := ARRAY[]::text[];
  v_vals  int[] := ARRAY[]::int[];
BEGIN
  -- La misma validación que una regla guardada: 1 a 8, forma y catálogo. Un
  -- array vacío NO es "todos": es un error.
  PERFORM ops._validate_notification_conditions(p_conditions);

  FOR v_c IN SELECT c FROM jsonb_array_elements(p_conditions) c LOOP
    v_i := v_i + 1;
    v_where := v_where || ops._audience_condition_sql(v_c, v_i);
    -- Ya validado: entero en rango o ausente (NULL ocupa el slot igual).
    v_vals := v_vals || (CASE WHEN v_c ? 'value' THEN ((v_c->'value')::text)::numeric::int END);
  END LOOP;

  RETURN QUERY EXECUTE
    'select u.id from users u where ' || array_to_string(v_where, ' and ')
    || ' order by u.created_at, u.id'
  USING v_vals;
END;
$fn$;

-- ── `activated_at` ───────────────────────────────────────────────────────────

ALTER TABLE ops.notification_schedule
  ADD COLUMN IF NOT EXISTS activated_at timestamptz;

-- Backfill: lo más cercano que hay a "cuándo se activó" una regla activa hoy es
-- su `updated_at` (la 014 lo pisa en cada activación). No toca `updated_at`.
UPDATE ops.notification_schedule
   SET activated_at = updated_at
 WHERE active AND activated_at IS NULL;

-- Una regla activa sin `activated_at` dejaría al cron sin desde cuándo contar.
ALTER TABLE ops.notification_schedule
  DROP CONSTRAINT IF EXISTS chk_ops_notification_schedule_activated_at;
ALTER TABLE ops.notification_schedule
  ADD CONSTRAINT chk_ops_notification_schedule_activated_at
  CHECK (NOT active OR activated_at IS NOT NULL);

/**
 * Misma firma que la 014. Estampa `activated_at` sólo en false→true: en el
 * `SET`, `active` del lado derecho es el valor VIEJO de la fila. true→true no
 * lo mueve; una pausa lo conserva (el dato de la última activación sigue
 * siendo cierto).
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
     SET active       = p_active,
         activated_at = CASE WHEN p_active AND NOT active THEN now() ELSE activated_at END,
         updated_at   = now()
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
