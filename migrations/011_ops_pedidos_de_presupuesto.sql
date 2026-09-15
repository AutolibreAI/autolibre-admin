-- ═══════════════════════════════════════════════════════════════════════════
-- 011 — Mover los pedidos de presupuesto desde `ops`.
--
-- Reemplaza los cuatro scripts que el operador copiaba y editaba en DBeaver
-- desde `autolibre-backend-hex/scripts/sql/` —y que ese repo borró—:
--
--   marcar-pedido-de-presupuesto-contactado.sql      → ops.mark_quote_request_contacted
--   marcar-pedido-de-presupuesto-respondido.sql      → ops.mark_quote_request_answered
--   cerrar-pedido-de-presupuesto.sql                 → ops.close_quote_request
--   agregar-nota-interna-a-pedido-de-presupuesto.sql → ops.add_quote_request_internal_note
--
-- El quinto, `listar-pedidos-de-presupuesto-abiertos.sql`, no tiene SP: ya lo
-- reemplazó la pantalla `/leads/pedidos`.
--
-- ── POR QUÉ ESTO PUEDE ESCRIBIR `public.quote_requests` ──────────────────────
--
-- Mismo caso que partners (007) y solicitudes (010). Verificado con `grep` en
-- `autolibre-backend-hex/src/quotes` el 2026-09-15: el backend sólo tiene las
-- transiciones del USUARIO (crear, cancelar, declarar resultado), ningún
-- endpoint con `AdminGuard`. La del operador ya era SQL a mano, designado así
-- por el propio CLAUDE.md del backend. Lo que cambia es dónde vive: deja de ser
-- una plantilla que se edita antes de correr —donde cada edición podía borrar
-- la guarda de estado del WHERE, o correr una versión vieja guardada— y pasa a
-- estar versionada, con la guarda adentro y AUDITADA en `ops.action_log`.
--
-- ── LOS 8 GUARDRAILS, IGUAL QUE 007/008/009/010 ─────────────────────────────
--
--   1. Vive en `migrations/`, nunca DDL a mano.
--   2. SECURITY INVOKER (el default). El control de acceso es de `adminMiddleware`.
--   3. `SET search_path` fijo.
--   4. `p_actor_id` sale de la sesión de Clerk, JAMÁS del payload. Desde DBeaver
--      es el `users.id` de quien la corre.
--   5. Escribe `ops.action_log` DENTRO de la función, con `before`/`after` jsonb.
--   6. Ninguna FK cruza a `public`.
--   7. `SELECT ... FOR UPDATE` antes de leer el `before`. Acá además serializa
--      contra la APP, que escribe la misma fila cuando el usuario cancela.
--   8. `updated_at` NO se toca: `trg_quote_requests_updated_at` ya lo hace.
--
-- ── EL `before`/`after` NO LLEVA LA UBICACIÓN EXACTA ────────────────────────
--
-- Es la única desviación del guardrail 5, y es a propósito. `quote_requests`
-- guarda la posición GPS de la persona (Ley 25.326, deuda BLOQUEANTE del
-- backend), y el derecho de supresión ya obliga a limpiarla en dos lugares: las
-- columnas y `raw_submission->'location'`. Copiarla a cada entrada de auditoría
-- sumaría un tercero, que además crece con cada transición.
--
-- Se sacan `location_latitude`, `location_longitude`, `location_accuracy_meters`
-- y `raw_submission`. Ninguna función de acá escribe esas columnas, así que el
-- log no pierde nada de lo que CAMBIÓ. La localidad y la provincia sí quedan.
--
-- ── LA MÁQUINA DE ESTADOS ───────────────────────────────────────────────────
--
-- received → contacted → answered → closed. Se cierra desde cualquier estado
-- abierto. Los CHECK de la tabla protegen que cada estado tenga sus fechas pero
-- NO impiden retroceder: la guarda de estado es de estas funciones, y por eso
-- cada una la valida contra el `before` bloqueado, no contra una lectura previa.
--
-- ── LO QUE NO DECIDE ────────────────────────────────────────────────────────
--
-- Sólo valida REPRESENTABILIDAD: la transición existe, el código está en el
-- enum, la cantidad no es negativa. Traduce a sentinela lo que un CHECK
-- rechazaría igual, para que quien opere lea `PROPOSALS_COUNT_REQUIRED` y no un
-- 23514 con el nombre de un constraint. No decide si un pedido "merece" cerrarse.
--
-- ── NO REFERENCIA TIPOS DE `quote_requests` EN LAS FIRMAS ───────────────────
--
-- Al 2026-09-14 `quote_requests` no existe en producción (las migraciones
-- 0092–0094 del backend no se desplegaron). Los parámetros son `text` y el cast
-- al enum va en el cuerpo: plpgsql resuelve los tipos de la firma y del DECLARE
-- al crear la función, pero las sentencias SQL recién al ejecutarlas. Con un
-- parámetro `quote_request_close_reason`, esta migración rompería el deploy del
-- panel hasta que salga el del backend.
-- ═══════════════════════════════════════════════════════════════════════════

/**
 * Saca la ubicación exacta de un snapshot de `quote_requests`.
 *
 * Se define primero porque las otras dos la llaman.
 */
CREATE OR REPLACE FUNCTION ops._redact_quote_request(p_row jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT p_row - ARRAY['location_latitude', 'location_longitude', 'location_accuracy_meters', 'raw_submission']
$$;

/**
 * La fila bloqueada, como jsonb y sin la ubicación exacta.
 *
 * Toma el `FOR UPDATE` (guardrail 7): el lock dura hasta el final de la
 * transacción de quien llama, no sólo de esta función.
 */
CREATE OR REPLACE FUNCTION ops._lock_quote_request(p_quote_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_row jsonb;
BEGIN
  SELECT to_jsonb(q) INTO v_row FROM quote_requests q WHERE q.id = p_quote_request_id FOR UPDATE;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'QUOTE_REQUEST_NOT_FOUND: %', p_quote_request_id
      USING HINT = 'Se busca por id (UUID), no por el código AL-n.';
  END IF;

  RETURN ops._redact_quote_request(v_row);
END;
$$;

/** La fila actual, sin bloquear (el lock ya lo tomó `_lock_quote_request`). */
CREATE OR REPLACE FUNCTION ops._read_quote_request(p_quote_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_row jsonb;
BEGIN
  SELECT to_jsonb(q) INTO v_row FROM quote_requests q WHERE q.id = p_quote_request_id;
  RETURN ops._redact_quote_request(v_row);
END;
$$;

/**
 * Corta si el estado del `before` no admite la operación.
 *
 * Una sola sentinela para todas las transiciones inválidas, con el estado real
 * en el mensaje: para quien opera, "está en closed" dice más que un código por
 * cada combinación.
 */
CREATE OR REPLACE FUNCTION ops._assert_quote_request_status(
  p_before  jsonb,
  p_allowed text[],
  p_action  text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT (p_before->>'status' = ANY (p_allowed)) THEN
    RAISE EXCEPTION 'INVALID_QUOTE_REQUEST_TRANSITION: no se puede % un pedido en %',
                    p_action, p_before->>'status'
      USING HINT = 'Sólo desde: ' || array_to_string(p_allowed, ', ') || '.';
  END IF;
END;
$$;

/**
 * received → contacted.
 *
 * `contacted` significa "ya le respondimos algo al usuario" —un mensaje, una
 * llamada, un "estamos buscando"—, no sólo que el pedido entró. La app se lo
 * muestra a la persona, y mientras esté en received o contacted ella todavía
 * lo puede cancelar.
 *
 * `p_note` es la nota de AUDITORÍA (va a `ops.action_log`), no la nota interna
 * del pedido: esa es `add_quote_request_internal_note`.
 */
CREATE OR REPLACE FUNCTION ops.mark_quote_request_contacted(
  p_quote_request_id uuid,
  p_actor_id         uuid,
  p_note             text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  v_before := ops._lock_quote_request(p_quote_request_id);
  PERFORM ops._assert_quote_request_status(v_before, ARRAY['received'], 'marcar como contactado');

  UPDATE quote_requests
     SET status = 'contacted',
         contacted_at = now()
   WHERE id = p_quote_request_id;

  v_after := ops._read_quote_request(p_quote_request_id);
  PERFORM ops.log_action(
    p_actor_id, 'quote_request.mark_contacted', 'public.quote_requests', p_quote_request_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;

/**
 * contacted → answered, con la cantidad de propuestas que se le pasaron.
 *
 * La cantidad es obligatoria: la app la muestra, y es lo que le habilita a la
 * persona declarar si contrató. Cero es legítimo ("llamamos y no conseguimos
 * nada"). Un pedido en received va primero por `mark_quote_request_contacted`.
 */
CREATE OR REPLACE FUNCTION ops.mark_quote_request_answered(
  p_quote_request_id uuid,
  p_proposals_count  integer,
  p_actor_id         uuid,
  p_note             text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF p_proposals_count IS NULL THEN
    RAISE EXCEPTION 'PROPOSALS_COUNT_REQUIRED'
      USING HINT = 'Cuántas propuestas de talleres se le pasaron a la persona. Cero es válido.';
  END IF;
  IF p_proposals_count < 0 THEN
    RAISE EXCEPTION 'INVALID_PROPOSALS_COUNT: %', p_proposals_count;
  END IF;

  v_before := ops._lock_quote_request(p_quote_request_id);
  PERFORM ops._assert_quote_request_status(v_before, ARRAY['contacted'], 'marcar como respondido');

  UPDATE quote_requests
     SET status = 'answered',
         answered_at = now(),
         proposals_count = p_proposals_count
   WHERE id = p_quote_request_id;

  v_after := ops._read_quote_request(p_quote_request_id);
  PERFORM ops.log_action(
    p_actor_id, 'quote_request.mark_answered', 'public.quote_requests', p_quote_request_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;

/**
 * Cualquier estado abierto → closed.
 *
 * `p_close_reason_code` es obligatorio:
 *   no_workshops_found  no conseguimos talleres
 *   no_user_response    la persona dejó de contestar
 *   resolved            se resolvió (le pasamos propuestas, contrató o no)
 *   duplicate           es un duplicado o spam
 * `cancelled_by_user` lo pone SOLO la app, junto con el motivo de la persona.
 *
 * Opcionales, y `''` es "sin dato" (se guarda NULL):
 *   p_closed_reason  nota interna del cierre. El cliente nunca la ve.
 *   p_outcome        lo que registra el EQUIPO: hired | not_hired | no_response.
 *                    NULL es "no se sabe", que no es lo mismo que no_response
 *                    ("se le preguntó y no contestó"). Lo que declara el usuario
 *                    va aparte (`user_outcome`) y esto no lo toca.
 *   p_outcome_note   nota del outcome.
 *   p_note           nota de auditoría, a `ops.action_log`.
 *
 * Un pedido ya cerrado —incluido uno que canceló el usuario— no se toca: no se
 * le pisa el `closed_at` ni el motivo, y no se reabre.
 */
CREATE OR REPLACE FUNCTION ops.close_quote_request(
  p_quote_request_id  uuid,
  p_close_reason_code text,
  p_actor_id          uuid,
  p_closed_reason     text DEFAULT NULL,
  p_outcome           text DEFAULT NULL,
  p_outcome_note      text DEFAULT NULL,
  p_note              text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_code    text := nullif(btrim(p_close_reason_code), '');
  v_outcome text := nullif(btrim(p_outcome), '');
  v_before  jsonb;
  v_after   jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF v_code IS NULL THEN
    RAISE EXCEPTION 'CLOSE_REASON_CODE_REQUIRED'
      USING HINT = 'Valores válidos: no_workshops_found, no_user_response, resolved, duplicate.';
  END IF;

  IF v_code = 'cancelled_by_user' THEN
    RAISE EXCEPTION 'CLOSE_REASON_RESERVED_FOR_APP: cancelled_by_user'
      USING HINT = 'Ese código lo pone sólo la app cuando la persona cancela, junto con su motivo.';
  END IF;

  -- El cast valida contra el enum. Se captura para dar un error legible en vez
  -- del `invalid input value for enum` crudo de Postgres.
  BEGIN
    PERFORM v_code::quote_request_close_reason;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'INVALID_CLOSE_REASON_CODE: %', v_code
      USING HINT = 'Valores válidos: no_workshops_found, no_user_response, resolved, duplicate.';
  END;

  IF v_outcome IS NOT NULL THEN
    BEGIN
      PERFORM v_outcome::quote_request_outcome;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'INVALID_OUTCOME: %', v_outcome
        USING HINT = 'Valores válidos: hired, not_hired, no_response. Vacío si no se sabe.';
    END;
  END IF;

  v_before := ops._lock_quote_request(p_quote_request_id);
  PERFORM ops._assert_quote_request_status(
    v_before, ARRAY['received', 'contacted', 'answered'], 'cerrar'
  );

  UPDATE quote_requests
     SET status = 'closed',
         closed_at = now(),
         close_reason_code = v_code::quote_request_close_reason,
         closed_reason = nullif(btrim(p_closed_reason), ''),
         outcome = v_outcome::quote_request_outcome,
         outcome_note = nullif(btrim(p_outcome_note), '')
   WHERE id = p_quote_request_id;

  v_after := ops._read_quote_request(p_quote_request_id);
  PERFORM ops.log_action(
    p_actor_id, 'quote_request.close', 'public.quote_requests', p_quote_request_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;

/**
 * Agrega una línea a `internal_notes`: lo que se consiguió llamando a talleres
 * ("Taller X: $180.000, turno el jueves"). NUNCA se le muestra al cliente.
 *
 * Agrega, nunca pisa: borrar el historial de llamadas de un pedido no tiene
 * vuelta. Cada línea lleva fecha y hora de Buenos Aires —no la zona de la
 * sesión— para que dos operadores con configuraciones distintas no dejen horas
 * que no se pueden comparar. Sin notas previas, `concat_ws` saltea el NULL y la
 * primera línea queda sin un salto adelante. `/leads/pedidos/:id` las muestra
 * como hilo leyendo ese formato.
 *
 * A un pedido cerrado no se le agregan notas.
 */
CREATE OR REPLACE FUNCTION ops.add_quote_request_internal_note(
  p_quote_request_id uuid,
  p_text             text,
  p_actor_id         uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_text   text := nullif(btrim(p_text), '');
  v_before jsonb;
  v_after  jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF v_text IS NULL THEN
    RAISE EXCEPTION 'INTERNAL_NOTE_REQUIRED'
      USING HINT = 'La nota no puede estar vacía.';
  END IF;

  v_before := ops._lock_quote_request(p_quote_request_id);
  PERFORM ops._assert_quote_request_status(
    v_before, ARRAY['received', 'contacted', 'answered'], 'anotar'
  );

  UPDATE quote_requests
     SET internal_notes = concat_ws(
           E'\n',
           internal_notes,
           to_char(now() AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD HH24:MI')
             || ' — '
             || v_text
         )
   WHERE id = p_quote_request_id;

  v_after := ops._read_quote_request(p_quote_request_id);
  PERFORM ops.log_action(
    p_actor_id, 'quote_request.add_internal_note', 'public.quote_requests', p_quote_request_id,
    v_before, v_after, NULL
  );

  RETURN v_after;
END;
$$;
