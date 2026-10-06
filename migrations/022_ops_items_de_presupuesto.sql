-- ═══════════════════════════════════════════════════════════════════════════
-- 022 — Un presupuesto detallado por ítems, con opcionales.
--
-- Hasta la 015 un presupuesto tenía UN precio (o un rango). Lo que contesta un
-- taller casi siempre viene desglosado — "pastillas $60.000, discos $90.000,
-- mano de obra $40.000" — y a veces con extras que la persona puede sumar o
-- no ("si querés, rectificamos los discos: $35.000"). El operador sumaba a
-- mano y perdía el detalle.
--
-- ── Qué cambia ──────────────────────────────────────────────────────────────
--
-- `ops.quote_request_response.items`: un jsonb array de
-- `{label, amount, optional}`. NULL = el presupuesto no está detallado (todo
-- lo cargado antes de esta migración sigue igual).
--
-- **Con ítems, el precio del presupuesto se DERIVA**: `amount_min = amount_max
-- = suma de los ítems NO opcionales`. Los opcionales no suman al total: se
-- listan aparte con su precio, para que la persona elija. Si todos los ítems
-- son opcionales, el presupuesto queda "sin precio" base (amount NULL) y los
-- opcionales se muestran igual. La suma la hace la función y no el cliente:
-- el total guardado no puede contradecir a los ítems guardados.
--
-- ── Por qué un jsonb y no una tabla de ítems ──────────────────────────────
--
-- Un ítem no tiene vida propia: no se edita suelto, no se reordena por fuera
-- de su presupuesto, nadie lo consulta solo. La edición de la 015 ya es
-- REEMPLAZO COMPLETO de la fila, y los ítems viajan con ella — así el
-- `before`/`after` del log trae el desglose entero en la misma entrada, sin una
-- segunda tabla que sincronizar. Si algún día hace falta "¿cuánto se cobra
-- en promedio un cambio de pastillas?", eso es un `jsonb_array_elements` sobre
-- esta columna, no una migración.
--
-- ── Por qué DROP + CREATE ───────────────────────────────────────────────────
--
-- Agregarle un parámetro a una función NO la reemplaza: crea una sobrecarga, y
-- con dos vivas una llamada por parámetros nombrados falla con "is not unique"
-- en runtime (la trampa de la 009). Se dropean las firmas EXACTAS de la 015 y
-- se crean de nuevo con `p_items` AL FINAL y con default NULL: una llamada que
-- no lo manda sigue resolviendo igual que antes.
--
-- Los 8 guardrails son los de la 015, sin cambios. El cuerpo es el de la 015
-- más los ítems; las validaciones compartidas siguen en
-- `ops._normalize_quote_response`, que no se toca.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ops.quote_request_response
  ADD COLUMN IF NOT EXISTS items jsonb;

ALTER TABLE ops.quote_request_response
  DROP CONSTRAINT IF EXISTS chk_ops_qrr_items_array;
ALTER TABLE ops.quote_request_response
  ADD CONSTRAINT chk_ops_qrr_items_array
  CHECK (items IS NULL OR (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) > 0));

COMMENT ON COLUMN ops.quote_request_response.items IS
  'Desglose [{label, amount, optional}]. Con ítems, amount_min = amount_max = suma de los NO opcionales. NULL = sin desglose. 022.';

-- ── Normalizar los ítems ─────────────────────────────────────────────────────

/**
 * Valida y limpia el array de ítems. Devuelve NULL para "sin desglose" (NULL o
 * `[]`) y el array limpio si no: `label` recortado, `amount` redondeado a dos
 * decimales, `optional` booleano (ausente = false).
 *
 * Valida REPRESENTABILIDAD, no negocio: no exige que haya un ítem obligatorio,
 * ni limita cuántos opcionales hay.
 */
CREATE OR REPLACE FUNCTION ops._normalize_quote_response_items(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_item   jsonb;
  v_label  text;
  v_amount numeric;
  v_out    jsonb := '[]'::jsonb;
BEGIN
  IF p_items IS NULL OR p_items = 'null'::jsonb THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_ITEMS'
      USING HINT = 'Los ítems van como un array de {label, amount, optional}.';
  END IF;

  IF jsonb_array_length(p_items) = 0 THEN
    RETURN NULL;
  END IF;

  IF jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'TOO_MANY_ITEMS: %', jsonb_array_length(p_items);
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'INVALID_ITEMS';
    END IF;

    v_label := nullif(btrim(v_item->>'label'), '');
    IF v_label IS NULL THEN
      RAISE EXCEPTION 'ITEM_LABEL_REQUIRED';
    END IF;
    IF length(v_label) > 200 THEN
      RAISE EXCEPTION 'ITEM_LABEL_TOO_LONG';
    END IF;

    IF jsonb_typeof(v_item->'amount') <> 'number' THEN
      RAISE EXCEPTION 'INVALID_ITEM_AMOUNT: %', v_label;
    END IF;
    v_amount := round((v_item->>'amount')::numeric, 2);
    IF v_amount < 0 THEN
      RAISE EXCEPTION 'INVALID_ITEM_AMOUNT: %', v_label;
    END IF;
    IF v_amount > 9999999999.99 THEN
      RAISE EXCEPTION 'AMOUNT_TOO_LARGE';
    END IF;

    IF v_item ? 'optional' AND jsonb_typeof(v_item->'optional') NOT IN ('boolean', 'null') THEN
      RAISE EXCEPTION 'INVALID_ITEMS';
    END IF;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'label',    v_label,
      'amount',   v_amount,
      'optional', coalesce((v_item->>'optional')::boolean, false)
    ));
  END LOOP;

  RETURN v_out;
END;
$$;

/**
 * El precio del presupuesto según sus ítems: la suma de los NO opcionales, o
 * NULL si no hay ninguno obligatorio. `p_items` ya normalizado.
 */
CREATE OR REPLACE FUNCTION ops._quote_response_items_total(p_items jsonb)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, ops
AS $$
  SELECT CASE
           WHEN count(*) FILTER (WHERE NOT (e->>'optional')::boolean) = 0 THEN NULL
           ELSE sum((e->>'amount')::numeric) FILTER (WHERE NOT (e->>'optional')::boolean)
         END
    FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) AS e;
$$;

-- ── Alta ────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS ops.add_quote_request_response(
  uuid, uuid, text, uuid, text, text, text, numeric, numeric, text, text, text, text
);

CREATE OR REPLACE FUNCTION ops.add_quote_request_response(
  p_quote_request_id uuid,
  p_actor_id         uuid,
  p_detail           text,
  p_partner_id       uuid    DEFAULT NULL,
  p_provider_name    text    DEFAULT NULL,
  p_provider_address text    DEFAULT NULL,
  p_provider_phone   text    DEFAULT NULL,
  p_amount_min       numeric DEFAULT NULL,
  p_amount_max       numeric DEFAULT NULL,
  p_currency         text    DEFAULT 'ARS',
  p_valid_until      text    DEFAULT NULL,
  p_internal_notes   text    DEFAULT NULL,
  p_note             text    DEFAULT NULL,
  p_items            jsonb   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_items jsonb;
  v_total numeric;
  v_min   numeric := p_amount_min;
  v_max   numeric := p_amount_max;
  v_clean jsonb;
  v_after jsonb;
  v_id    uuid;
  v_pos   int;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF NOT EXISTS (SELECT 1 FROM quote_requests WHERE id = p_quote_request_id) THEN
    RAISE EXCEPTION 'QUOTE_REQUEST_NOT_FOUND: %', p_quote_request_id
      USING HINT = 'Se busca por id (UUID), no por el código AL-n.';
  END IF;

  -- Con ítems, el precio se deriva de ellos: lo que venga en p_amount_* se ignora.
  v_items := ops._normalize_quote_response_items(p_items);
  IF v_items IS NOT NULL THEN
    v_total := ops._quote_response_items_total(v_items);
    v_min := v_total;
    v_max := v_total;
  END IF;

  v_clean := ops._normalize_quote_response(
    p_partner_id, p_provider_name, p_provider_address, p_provider_phone,
    v_min, v_max, p_currency, p_detail, p_valid_until,
    p_internal_notes, (now() AT TIME ZONE 'UTC')::date
  );

  SELECT coalesce(max(position), 0) + 1 INTO v_pos
    FROM ops.quote_request_response
   WHERE quote_request_id = p_quote_request_id;

  INSERT INTO ops.quote_request_response (
    quote_request_id, actor_id, position,
    partner_id, provider_name, provider_address, provider_phone,
    amount_min, amount_max, currency, detail, valid_until, internal_notes, items
  )
  VALUES (
    p_quote_request_id, p_actor_id, v_pos,
    (v_clean->>'partner_id')::uuid,
    v_clean->>'provider_name',
    v_clean->>'provider_address',
    v_clean->>'provider_phone',
    (v_clean->>'amount_min')::numeric,
    (v_clean->>'amount_max')::numeric,
    v_clean->>'currency',
    v_clean->>'detail',
    (v_clean->>'valid_until')::date,
    v_clean->>'internal_notes',
    v_items
  )
  RETURNING id INTO v_id;

  SELECT to_jsonb(r) INTO v_after FROM ops.quote_request_response r WHERE r.id = v_id;

  PERFORM ops.log_action(
    p_actor_id, 'quote_request_response.add', 'ops.quote_request_response', v_id,
    NULL, v_after, p_note
  );

  RETURN v_after;
END;
$$;

-- ── Edición ─────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS ops.update_quote_request_response(
  uuid, uuid, text, uuid, text, text, text, numeric, numeric, text, text, text, text
);

/**
 * Reemplazo COMPLETO, igual que en la 015: ítems incluidos. Un `p_items` NULL
 * o `[]` BORRA el desglose y el precio vuelve a ser el de `p_amount_*`.
 */
CREATE OR REPLACE FUNCTION ops.update_quote_request_response(
  p_id               uuid,
  p_actor_id         uuid,
  p_detail           text,
  p_partner_id       uuid    DEFAULT NULL,
  p_provider_name    text    DEFAULT NULL,
  p_provider_address text    DEFAULT NULL,
  p_provider_phone   text    DEFAULT NULL,
  p_amount_min       numeric DEFAULT NULL,
  p_amount_max       numeric DEFAULT NULL,
  p_currency         text    DEFAULT 'ARS',
  p_valid_until      text    DEFAULT NULL,
  p_internal_notes   text    DEFAULT NULL,
  p_note             text    DEFAULT NULL,
  p_items            jsonb   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_items  jsonb;
  v_total  numeric;
  v_min    numeric := p_amount_min;
  v_max    numeric := p_amount_max;
  v_clean  jsonb;
  v_after  jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  v_before := ops._lock_quote_response(p_id);

  v_items := ops._normalize_quote_response_items(p_items);
  IF v_items IS NOT NULL THEN
    v_total := ops._quote_response_items_total(v_items);
    v_min := v_total;
    v_max := v_total;
  END IF;

  v_clean := ops._normalize_quote_response(
    p_partner_id, p_provider_name, p_provider_address, p_provider_phone,
    v_min, v_max, p_currency, p_detail, p_valid_until,
    p_internal_notes,
    ((v_before->>'created_at')::timestamptz AT TIME ZONE 'UTC')::date
  );

  UPDATE ops.quote_request_response
     SET partner_id       = (v_clean->>'partner_id')::uuid,
         provider_name    = v_clean->>'provider_name',
         provider_address = v_clean->>'provider_address',
         provider_phone   = v_clean->>'provider_phone',
         amount_min       = (v_clean->>'amount_min')::numeric,
         amount_max       = (v_clean->>'amount_max')::numeric,
         currency         = v_clean->>'currency',
         detail           = v_clean->>'detail',
         valid_until      = (v_clean->>'valid_until')::date,
         internal_notes   = v_clean->>'internal_notes',
         items            = v_items,
         updated_at       = now()
   WHERE id = p_id;

  SELECT to_jsonb(r) INTO v_after FROM ops.quote_request_response r WHERE r.id = p_id;

  PERFORM ops.log_action(
    p_actor_id, 'quote_request_response.update', 'ops.quote_request_response', p_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;

COMMENT ON FUNCTION ops.add_quote_request_response(uuid, uuid, text, uuid, text, text, text, numeric, numeric, text, text, text, text, jsonb) IS
  'Carga lo que contestó un taller. Con p_items, el precio es la suma de los ítems no opcionales. 015 + 022.';
COMMENT ON FUNCTION ops.update_quote_request_response(uuid, uuid, text, uuid, text, text, text, numeric, numeric, text, text, text, text, jsonb) IS
  'Reemplazo completo de un presupuesto, ítems incluidos. 015 + 022.';
