-- ═══════════════════════════════════════════════════════════════════════════
-- 016 — Varios rubros por pedido, y la nota del cierre atómica con el cierre.
--
-- Dos cambios independientes que llegaron juntos en el mismo pedido de
-- producto del 2026-09-25 (`.claude/plans/pedidos-ficha-2026-09-25.md`).
--
-- ── 1. Rubros: de UNO a VARIOS ─────────────────────────────────────────────
--
-- La 013 modelaba "el rubro del pedido" como una sola fila
-- `(quote_request_id) → category_slug`. En la práctica un pedido pide más de
-- una cosa ("frenos y suspensión"), y el candidato correcto para derivar no
-- es "cubre ESE rubro" sino "cubre el MÁXIMO de rubros que este pedido pide" —
-- eso necesita el CONJUNTO, no un solo slug.
--
-- `ops.quote_request_rubro` tenía **0 filas** en producción al relevar esto
-- (2026-09-25): reestructurarla no migra datos, así que se DROPEA y se
-- recrea con la forma nueva en vez de un `ALTER TABLE` que preserve un
-- historial que no existe.
--
-- La PK pasa de `(quote_request_id)` a `(quote_request_id, category_slug)`:
-- ahora son N filas por pedido, una por rubro elegido. `service_slug` se
-- saca ENTERO — la decisión del plan fue "servicio puntual: fuera", porque
-- clasificar por rubro ya alcanza para elegir candidatos y una segunda
-- dimensión (rubro × servicio puntual) no se estaba usando para nada.
--
-- `ops.set_quote_request_rubro` (singular, 013) se DROPEA con su firma
-- EXACTA — agregar un parámetro (o, acá, cambiar la forma entera) NO
-- reemplaza una función existente: crea una sobrecarga, y las dos firmas
-- viviendo juntas revientan en el primer guardado con
-- "function … is not unique" (la trampa de la 009). Se reemplaza por
-- `ops.set_quote_request_rubros` (plural), que reemplaza el CONJUNTO entero
-- de rubros de un pedido — mismo patrón que `ops.reorder_quote_request_responses`
-- (015): la lista completa, no un alta/baja individual, porque dos pestañas
-- agregando un rubro cada una a la vez tienen que converger a lo que el
-- operador vio en pantalla, no a una unión implícita.
--
-- ── 2. La nota del cierre, ATÓMICA con el cierre ───────────────────────────
--
-- Hasta acá, agregar una nota antes de cerrar eran DOS llamadas:
-- `add_quote_request_internal_note` y después `close_quote_request`. Un
-- pedido cerrado no admite notas nuevas (`ops._assert_quote_request_status`
-- las corta), así que si la segunda llamada fallaba —la persona lo canceló
-- desde la app entre medio— la nota de la primera quedaba huérfana: una nota
-- sobre un cierre que nunca pasó.
--
-- `ops.close_quote_request` suma `p_internal_note text DEFAULT NULL`: si
-- viene, se agrega al hilo de `internal_notes` con el MISMO formato fechado
-- (hora de Buenos Aires) que `add_quote_request_internal_note`, dentro de la
-- MISMA sentencia `UPDATE` que cierra el pedido. Las dos cosas pasan juntas o
-- ninguna.
--
-- Agregar un parámetro es la misma trampa de la 009: `DROP FUNCTION` con la
-- firma exacta de la 011, después `CREATE`. La suite re-verifica TODAS las
-- validaciones de la 011 sobre la función nueva, no sólo las que cambiaron —
-- mismo criterio que la suite de la 009 con `set_partner_profile`: un
-- `DROP + CREATE` es exactamente donde se cae un `IF` sin que nadie lo note.
--
-- ── Los 8 guardrails, igual que 007–015 ────────────────────────────────────
--
--   1. Vive en `migrations/`, nunca DDL a mano.
--   2. SECURITY INVOKER (el default).
--   3. `SET search_path` fijo.
--   4. `p_actor_id` sale de la sesión de Clerk, JAMÁS del payload.
--   5. `ops.action_log` DENTRO de la función, con `before`/`after` jsonb.
--   6. Ninguna FK cruza a `public`: `quote_request_id` sigue siendo UUID
--      pelado en `ops.quote_request_rubro`, igual que en la 013.
--   7. `SELECT … FOR UPDATE` antes de escribir. En `set_quote_request_rubros`
--      lockea las filas EXISTENTES del pedido (si las hay) antes de
--      reemplazarlas — mismo criterio que el reordenamiento de la 015.
--   8. `updated_at`: `ops.quote_request_rubro` no tiene trigger (es de
--      `ops`). Como el reemplazo es DELETE + INSERT, alcanza con el
--      `DEFAULT now()` de la columna — no hace falta un `UPDATE … SET
--      updated_at` a mano, así que no hay nada que pueda divergir.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Rubros múltiples ─────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS ops.set_quote_request_rubro(uuid, text, uuid, text, text);
DROP TABLE IF EXISTS ops.quote_request_rubro;

CREATE TABLE ops.quote_request_rubro (
  -- UUID pelado de `public.quote_requests.id`, sin FK (guardrail 6).
  quote_request_id uuid        NOT NULL,
  category_slug    text        NOT NULL,
  actor_id         uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quote_request_id, category_slug)
);

CREATE INDEX idx_ops_quote_request_rubro_request ON ops.quote_request_rubro (quote_request_id);

/**
 * Reemplaza el CONJUNTO de rubros de un pedido por `p_category_slugs`.
 *
 * `[]` (array vacío, NO NULL) es "sin clasificar" y borra todo lo que había —
 * es una elección válida, no un error: el operador puede decidir que un
 * pedido todavía no tiene rubro claro. `NULL` se trata como `[]` para que un
 * cliente que no mande el array no reviente con un error de tipo.
 *
 * Cada slug se valida contra `service_categories` activas — mismo chequeo de
 * representabilidad que la 013, repetido por cada elemento del array.
 *
 * `SELECT … FOR UPDATE` antes de tocar nada: si el pedido ya tenía rubros
 * clasificados, se lockean ANTES de leer el `before` y de borrarlos, así el
 * log no describe un estado que otra transacción concurrente ya cambió.
 */
CREATE OR REPLACE FUNCTION ops.set_quote_request_rubros(
  p_quote_request_id uuid,
  p_actor_id         uuid,
  p_category_slugs   text[],
  p_note             text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_slugs    text[] := coalesce(p_category_slugs, ARRAY[]::text[]);
  v_slug     text;
  v_before   jsonb;
  v_after    jsonb;
  v_invalid  text;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF NOT EXISTS (SELECT 1 FROM quote_requests WHERE id = p_quote_request_id) THEN
    RAISE EXCEPTION 'QUOTE_REQUEST_NOT_FOUND: %', p_quote_request_id
      USING HINT = 'Se busca por id (UUID), no por el código AL-n.';
  END IF;

  -- Cada slug tiene que ser una categoría activa. Se valida ANTES de tocar la
  -- tabla: una lista a medio reemplazar por un slug malo a mitad de camino
  -- sería peor que rechazar el pedido entero.
  FOREACH v_slug IN ARRAY v_slugs LOOP
    IF NOT EXISTS (SELECT 1 FROM service_categories sc WHERE sc.slug = v_slug AND sc.active) THEN
      v_invalid := v_slug;
      EXIT;
    END IF;
  END LOOP;
  IF v_invalid IS NOT NULL THEN
    RAISE EXCEPTION 'INVALID_CATEGORY_SLUG: %', v_invalid
      USING HINT = 'Tiene que ser un slug activo de service_categories.';
  END IF;

  -- Lockea lo que ya había ANTES de leer el `before` (guardrail 7).
  PERFORM 1 FROM ops.quote_request_rubro WHERE quote_request_id = p_quote_request_id FOR UPDATE;

  SELECT coalesce(jsonb_agg(r.category_slug ORDER BY r.category_slug), '[]'::jsonb)
    INTO v_before
    FROM ops.quote_request_rubro r
   WHERE r.quote_request_id = p_quote_request_id;

  DELETE FROM ops.quote_request_rubro WHERE quote_request_id = p_quote_request_id;

  -- `DISTINCT`: un array con un slug repetido (no debería pasar desde la UI,
  -- que arma el conjunto con un `Set`, pero el SP valida representabilidad y
  -- no debería reventar con un unique_violation por un duplicado inofensivo).
  INSERT INTO ops.quote_request_rubro (quote_request_id, category_slug, actor_id)
  SELECT DISTINCT p_quote_request_id, s, p_actor_id
    FROM unnest(v_slugs) AS s;

  SELECT coalesce(jsonb_agg(r.category_slug ORDER BY r.category_slug), '[]'::jsonb)
    INTO v_after
    FROM ops.quote_request_rubro r
   WHERE r.quote_request_id = p_quote_request_id;

  PERFORM ops.log_action(
    p_actor_id, 'quote_request.set_rubros', 'ops.quote_request_rubro', p_quote_request_id,
    jsonb_build_object('category_slugs', v_before),
    jsonb_build_object('category_slugs', v_after),
    p_note
  );

  RETURN jsonb_build_object('quote_request_id', p_quote_request_id, 'category_slugs', v_after);
END;
$$;

-- ── 2. Nota del cierre, atómica con el cierre ───────────────────────────────

DROP FUNCTION IF EXISTS ops.close_quote_request(uuid, text, uuid, text, text, text, text);

CREATE OR REPLACE FUNCTION ops.close_quote_request(
  p_quote_request_id  uuid,
  p_close_reason_code text,
  p_actor_id          uuid,
  p_closed_reason     text DEFAULT NULL,
  p_outcome           text DEFAULT NULL,
  p_outcome_note      text DEFAULT NULL,
  p_internal_note     text DEFAULT NULL,
  p_note              text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_code          text := nullif(btrim(p_close_reason_code), '');
  v_outcome       text := nullif(btrim(p_outcome), '');
  v_internal_note text := nullif(btrim(p_internal_note), '');
  v_before        jsonb;
  v_after         jsonb;
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
         outcome_note = nullif(btrim(p_outcome_note), ''),
         -- La nota, en la MISMA sentencia que cierra: si esto fallara (por
         -- ejemplo porque el estado cambió por debajo, capturado arriba en el
         -- `_assert_quote_request_status`), la nota tampoco se aplica. Nunca
         -- queda una nota huérfana de un cierre que no pasó.
         internal_notes = CASE
           WHEN v_internal_note IS NULL THEN internal_notes
           ELSE concat_ws(
             E'\n',
             internal_notes,
             to_char(now() AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD HH24:MI')
               || ' — '
               || v_internal_note
           )
         END
   WHERE id = p_quote_request_id;

  v_after := ops._read_quote_request(p_quote_request_id);
  PERFORM ops.log_action(
    p_actor_id, 'quote_request.close', 'public.quote_requests', p_quote_request_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;
