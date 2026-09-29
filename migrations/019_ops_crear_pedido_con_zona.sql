-- ═══════════════════════════════════════════════════════════════════════════
-- 019 — Cargar un pedido a mano CON la zona.
--
-- La 018 sumó la zona a la EDICIÓN (`ops.update_quote_request`) pero no al
-- alta: quien cargaba un pedido informal tenía que crearlo y después abrir la
-- ficha y «Editar datos» sólo para decir dónde está el auto. En la práctica
-- eso es lo primero que se pregunta por teléfono, y es lo que ordena a los
-- talleres por cercanía y completa las plantillas.
--
-- Cambia UNA cosa: `ops.create_quote_request` acepta `p_location_address`,
-- `p_location_locality` y `p_location_province`, con las mismas reglas que la
-- edición (`update_quote_request`, 018):
--
--   * la ubicación tipeada es SIEMPRE `location_source = 'typed'` — un alta a
--     mano no tiene GPS, así que no hay coordenadas ni `device`;
--   * `typed` exige la dirección/zona (`chk_quote_requests_location_typed_has_address`):
--     localidad o provincia sin dirección se rechaza con `LOCATION_ADDRESS_REQUIRED`;
--   * `LOCATION_ADDRESS_TOO_LONG` a los 300 caracteres
--     (`chk_quote_requests_location_address_max_length`).
--
-- ── DROP + CREATE, y los parámetros nuevos van AL FINAL ─────────────────────
--
-- Trampa de la 009: agregar un parámetro con `CREATE OR REPLACE` crea una
-- SOBRECARGA y las llamadas por parámetros nombrados dejan de resolver ("is
-- not unique"). Por eso DROP con la firma exacta de la 018. Los tres nuevos
-- van DESPUÉS de `p_note` y con default NULL, así que toda llamada anterior
-- —incluida la integración de `018_ops_editar_pedido.test.sql`— sigue
-- resolviendo igual.
--
-- ── LOS 8 GUARDRAILS ────────────────────────────────────────────────────────
--
-- Sin cambios respecto de la 012/018: SECURITY INVOKER, `search_path` fijo,
-- actor de la sesión, `ops.action_log` adentro (con la ubicación redactada de
-- GPS — un `typed` nunca la trae), sin FK a `public`, y sin `FOR UPDATE` porque
-- es un INSERT (no hay fila previa que lockear).
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION ops.create_quote_request(uuid, text, text, text, text, text, text, text, numeric, text);

CREATE FUNCTION ops.create_quote_request(
  p_actor_id          uuid,
  p_channel           text,
  p_contact_phone     text,
  p_description       text,
  p_plate             text    DEFAULT NULL,
  p_vehicle_text      text    DEFAULT NULL,
  p_contact_name      text    DEFAULT NULL,
  p_contact_email     text    DEFAULT NULL,
  p_declared_amount   numeric DEFAULT NULL,
  p_note              text    DEFAULT NULL,
  p_location_address  text    DEFAULT NULL,
  p_location_locality text    DEFAULT NULL,
  p_location_province text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_channel       quote_request_channel;
  v_contact_phone text := btrim(coalesce(p_contact_phone, ''));
  v_description   text := btrim(coalesce(p_description, ''));
  v_address       text := nullif(btrim(coalesce(p_location_address, '')), '');
  v_locality      text := nullif(btrim(coalesce(p_location_locality, '')), '');
  v_province      text := nullif(btrim(coalesce(p_location_province, '')), '');
  v_source        quote_request_location_source;
  v_plate         text;
  v_vehicle_text  text;
  v_amount        numeric;
  v_id            uuid;
  v_after         jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  BEGIN
    v_channel := p_channel::quote_request_channel;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'INVALID_CHANNEL: %', p_channel
      USING HINT = 'Valores válidos: app, web, whatsapp.';
  END;

  IF v_contact_phone = '' THEN
    RAISE EXCEPTION 'CONTACT_PHONE_REQUIRED'
      USING HINT = 'contact_phone es NOT NULL en public.quote_requests.';
  END IF;
  IF v_description = '' THEN
    RAISE EXCEPTION 'DESCRIPTION_REQUIRED'
      USING HINT = 'description es NOT NULL en public.quote_requests.';
  END IF;

  v_plate        := ops._normalize_quote_plate(p_plate);
  v_vehicle_text := ops._normalize_quote_vehicle_text(p_vehicle_text);
  v_amount       := ops._check_quote_declared_amount(p_declared_amount);

  -- Misma regla que `update_quote_request`: `typed` exige la dirección.
  IF v_address IS NOT NULL OR v_locality IS NOT NULL OR v_province IS NOT NULL THEN
    IF v_address IS NULL THEN
      RAISE EXCEPTION 'LOCATION_ADDRESS_REQUIRED'
        USING HINT = 'Una ubicación tipeada necesita la dirección o zona.';
    END IF;
    IF char_length(v_address) > 300 THEN
      RAISE EXCEPTION 'LOCATION_ADDRESS_TOO_LONG';
    END IF;
    v_source := 'typed';
  END IF;

  INSERT INTO quote_requests (
    channel, contact_name, contact_phone, contact_email, plate, description,
    declared_amount, location_source, location_address, location_locality,
    location_province, raw_submission
  ) VALUES (
    v_channel,
    nullif(btrim(coalesce(p_contact_name, '')), ''),
    v_contact_phone,
    nullif(btrim(coalesce(p_contact_email, '')), ''),
    v_plate,
    v_description,
    v_amount,
    v_source,
    v_address,
    v_locality,
    v_province,
    jsonb_build_object(
      'source', 'admin_manual_entry',
      'enteredBy', p_actor_id,
      'enteredAt', now()
    )
  )
  RETURNING id INTO v_id;

  PERFORM ops._set_quote_request_vehicle_text(v_id, p_actor_id, v_vehicle_text);

  v_after := ops._quote_request_snapshot(ops._read_quote_request(v_id), v_id);
  PERFORM ops.log_action(
    p_actor_id, 'quote_request.create', 'public.quote_requests', v_id,
    NULL, v_after, p_note
  );

  RETURN v_after;
END;
$$;
