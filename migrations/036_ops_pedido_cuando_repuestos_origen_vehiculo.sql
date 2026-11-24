-- ═══════════════════════════════════════════════════════════════════════════
-- 036 — Lo que le faltaba a la carga a mano de un pedido: para cuándo,
-- repuestos, de dónde vino, y el vehículo identificado por patente.
--
-- Tarjetas de Trello T73NyHFN (A: el vehículo identificado entra al pedido) y
-- bMtiAAQZ (B: variables nuevas en las plantillas, que necesitan `timing` y
-- `parts_supply` cargados también en los pedidos de WhatsApp y web).
--
-- ── EL GREP AL BACKEND (2026-11-24, `autolibre-backend-hex` @ 8180a83) ──────
--
-- `AdminQuoteRequestController` tiene PUT de ubicación, patente, catálogo y
-- servicios, y ningún camino para `timing`, `preferred_date`, `parts_supply`
-- ni `vehicle_description`. La app los escribe al crear el pedido (0143 y
-- 0160) y nada más. La excepción de `ops-write-actions.md` aplica: se escriben
-- con SPs de `ops`, con auditoría. Si el backend suma un endpoint, éstos se
-- retiran.
--
-- ── QUÉ CREA ────────────────────────────────────────────────────────────────
--
--   1. `ops.set_quote_request_timing_and_parts(id, actor, timing, preferred_date,
--      parts_supply, note)`: REEMPLAZO COMPLETO de las tres columnas de la 0143.
--      Parámetros `text` con el cast en el cuerpo (mismo motivo que la 011: una
--      base sin la 0143 no rompe la migración, rompe recién al ejecutar).
--   2. `ops.set_quote_request_vehicle_description(id, actor, text, expected,
--      note)`: escribe `vehicle_description` (0160) SÓLO si su valor actual es
--      `p_expected` — el que vio el operador, o NULL para "estaba vacío". Si
--      alguien lo escribió a mano mientras tanto: `VEHICLE_DESCRIPTION_CHANGED`
--      y no se pisa nada. Es lo que usa «Identificar vehículo» para completar
--      el campo solo sin pisar lo escrito a mano.
--   3. `ops.quote_request_origin` + `ops.set_quote_request_origin(id, actor,
--      origin, note)`: de dónde vino un pedido cargado a mano (pauta de Meta,
--      Instagram orgánico, flyer, partner, taller, boca a boca, otro). Tabla
--      nuestra: `quote_requests` no tiene `source`/`medium`/`campaign`, y la
--      clave `source` de `raw_submission` ya está tomada
--      (`admin_manual_entry`). `NULL` borra.
--
-- NO toca `ops.create_quote_request` ni `ops.update_quote_request`: el alta y
-- la edición llaman a estos SPs en la MISMA sentencia (una sola transacción),
-- así ninguna firma existente cambia y las suites de la 018/019/028 siguen
-- valiendo. Idempotente: `IF NOT EXISTS` y `CREATE OR REPLACE` de firmas nuevas.
--
-- ── LOS 8 GUARDRAILS ────────────────────────────────────────────────────────
--
--   1. Vive en `migrations/`.
--   2. SECURITY INVOKER (el default).
--   3. `SET search_path` fijo en cada función.
--   4. `p_actor_id` sale de la sesión de Clerk, jamás del payload.
--   5. `ops.action_log` dentro de cada función, con `before`/`after`
--      (la fila de `quote_requests` redactada por `_redact_quote_request`).
--   6. `ops.quote_request_origin` no tiene FK a `public` (UUID pelado).
--   7. `FOR UPDATE` sobre el pedido (`_lock_quote_request`) antes del `before`.
--   8. `quote_requests.updated_at` lo mueve su trigger; el de
--      `ops.quote_request_origin` lo escribe la función (en `ops` no hay trigger).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Para cuándo y repuestos ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ops.set_quote_request_timing_and_parts(
  p_quote_request_id uuid,
  p_actor_id         uuid,
  p_timing           text,
  p_preferred_date   text,
  p_parts_supply     text,
  p_note             text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_timing_txt text := nullif(btrim(coalesce(p_timing, '')), '');
  v_date_txt   text := nullif(btrim(coalesce(p_preferred_date, '')), '');
  v_parts_txt  text := nullif(btrim(coalesce(p_parts_supply, '')), '');
  v_date       date;
  v_before     jsonb;
  v_after      jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  v_before := ops._lock_quote_request(p_quote_request_id);

  IF v_timing_txt IS NOT NULL AND v_timing_txt NOT IN ('asap', 'this_week', 'date') THEN
    RAISE EXCEPTION 'INVALID_TIMING: %', v_timing_txt
      USING HINT = 'Valores válidos: asap, this_week, date.';
  END IF;
  IF v_parts_txt IS NOT NULL AND v_parts_txt NOT IN ('workshop', 'customer') THEN
    RAISE EXCEPTION 'INVALID_PARTS_SUPPLY: %', v_parts_txt
      USING HINT = 'Valores válidos: workshop, customer.';
  END IF;

  -- chk_quote_requests_preferred_date_iff_date, traducido.
  IF v_timing_txt = 'date' AND v_date_txt IS NULL THEN
    RAISE EXCEPTION 'PREFERRED_DATE_REQUIRED'
      USING HINT = 'Con timing = date hace falta la fecha.';
  END IF;
  IF v_timing_txt IS DISTINCT FROM 'date' AND v_date_txt IS NOT NULL THEN
    RAISE EXCEPTION 'PREFERRED_DATE_ONLY_WITH_DATE'
      USING HINT = 'La fecha va sólo con timing = date.';
  END IF;
  IF v_date_txt IS NOT NULL THEN
    BEGIN
      v_date := to_date(v_date_txt, 'YYYY-MM-DD');
      IF to_char(v_date, 'YYYY-MM-DD') <> v_date_txt THEN
        RAISE EXCEPTION 'bad';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'INVALID_PREFERRED_DATE: %', v_date_txt
        USING HINT = 'Formato YYYY-MM-DD.';
    END;
  END IF;

  EXECUTE
    'UPDATE quote_requests
        SET timing = $2::quote_request_timing,
            preferred_date = $3,
            parts_supply = $4::quote_request_parts_supply
      WHERE id = $1
        AND (timing::text, preferred_date, parts_supply::text) IS DISTINCT FROM ($2, $3, $4)'
    USING p_quote_request_id, v_timing_txt, v_date, v_parts_txt;

  v_after := ops._read_quote_request(p_quote_request_id);

  IF (v_after - 'updated_at') IS DISTINCT FROM (v_before - 'updated_at') THEN
    PERFORM ops.log_action(
      p_actor_id, 'quote_request.set_timing_and_parts', 'public.quote_requests', p_quote_request_id,
      v_before, v_after, p_note
    );
  END IF;

  RETURN jsonb_build_object(
    'timing', v_after->>'timing',
    'preferred_date', v_after->>'preferred_date',
    'parts_supply', v_after->>'parts_supply'
  );
END;
$$;

-- ── 2. El vehículo, sin pisar lo escrito a mano ─────────────────────────────

CREATE OR REPLACE FUNCTION ops.set_quote_request_vehicle_description(
  p_quote_request_id uuid,
  p_actor_id         uuid,
  p_vehicle_text     text,
  p_expected         text,
  p_note             text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before   jsonb;
  v_after    jsonb;
  v_new      text;
  v_expected text;
  v_current  text;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  v_before := ops._lock_quote_request(p_quote_request_id);

  v_new := ops._normalize_quote_vehicle_text(p_vehicle_text);
  IF v_new IS NULL THEN
    RAISE EXCEPTION 'VEHICLE_TEXT_REQUIRED'
      USING HINT = 'Para borrar el vehículo escrito está «Editar datos».';
  END IF;

  v_expected := nullif(btrim(regexp_replace(coalesce(p_expected, ''), '\s+', ' ', 'g')), '');
  v_current  := nullif(btrim(regexp_replace(coalesce(v_before->>'vehicle_description', ''), '\s+', ' ', 'g')), '');

  -- Ya dice eso: no hay nada que hacer (y tampoco es una pisada).
  IF v_current IS NOT DISTINCT FROM v_new THEN
    RETURN jsonb_build_object('vehicle_description', v_current, 'changed', false);
  END IF;

  IF v_current IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'VEHICLE_DESCRIPTION_CHANGED'
      USING HINT = 'El vehículo escrito cambió desde que se leyó la ficha: no se pisa.';
  END IF;

  UPDATE quote_requests SET vehicle_description = v_new WHERE id = p_quote_request_id;

  v_after := ops._read_quote_request(p_quote_request_id);
  PERFORM ops.log_action(
    p_actor_id, 'quote_request.set_vehicle_description', 'public.quote_requests', p_quote_request_id,
    v_before, v_after, p_note
  );

  RETURN jsonb_build_object('vehicle_description', v_new, 'changed', true);
END;
$$;

-- ── 3. El origen de un pedido cargado a mano ────────────────────────────────

CREATE TABLE IF NOT EXISTS ops.quote_request_origin (
  quote_request_id uuid        PRIMARY KEY,
  origin           text        NOT NULL,
  actor_id         uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ops_qro_origin CHECK (
    origin IN ('meta_ads', 'instagram_organic', 'flyer', 'partner', 'workshop', 'word_of_mouth', 'other')
  )
);

COMMENT ON TABLE ops.quote_request_origin IS
  'De dónde vino un pedido cargado a mano (migración 036). Sin FK a public.quote_requests (guardrail 6). '
  'Se escribe sólo por ops.set_quote_request_origin.';

CREATE OR REPLACE FUNCTION ops.set_quote_request_origin(
  p_quote_request_id uuid,
  p_actor_id         uuid,
  p_origin           text,
  p_note             text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_origin text := nullif(btrim(coalesce(p_origin, '')), '');
  v_before jsonb;
  v_after  jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  -- El pedido tiene que existir (sin FK no hay nada más que lo garantice), y
  -- su lock serializa dos ediciones del mismo origen.
  PERFORM ops._lock_quote_request(p_quote_request_id);

  IF v_origin IS NOT NULL
     AND v_origin NOT IN ('meta_ads', 'instagram_organic', 'flyer', 'partner', 'workshop', 'word_of_mouth', 'other') THEN
    RAISE EXCEPTION 'INVALID_ORIGIN: %', v_origin;
  END IF;

  SELECT to_jsonb(o) INTO v_before FROM ops.quote_request_origin o WHERE o.quote_request_id = p_quote_request_id;

  IF v_origin IS NULL THEN
    DELETE FROM ops.quote_request_origin WHERE quote_request_id = p_quote_request_id;
  ELSIF v_before IS NULL THEN
    INSERT INTO ops.quote_request_origin (quote_request_id, origin, actor_id)
    VALUES (p_quote_request_id, v_origin, p_actor_id);
  ELSIF v_before->>'origin' <> v_origin THEN
    UPDATE ops.quote_request_origin
       SET origin = v_origin, actor_id = p_actor_id, updated_at = now()
     WHERE quote_request_id = p_quote_request_id;
  END IF;

  SELECT to_jsonb(o) INTO v_after FROM ops.quote_request_origin o WHERE o.quote_request_id = p_quote_request_id;

  IF (v_before->>'origin') IS DISTINCT FROM (v_after->>'origin') THEN
    PERFORM ops.log_action(
      p_actor_id, 'quote_request.set_origin', 'ops.quote_request_origin', p_quote_request_id,
      v_before, v_after, p_note
    );
  END IF;

  RETURN jsonb_build_object('origin', v_after->>'origin');
END;
$$;
