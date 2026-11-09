-- ═══════════════════════════════════════════════════════════════════════════
-- 028 — Editar un pedido SIN tocar la ubicación.
--
-- La 018 hizo que «Editar datos» (`ops.update_quote_request`) escribiera
-- también la ubicación tipeada. Desde el 2026-11-09 el backend tiene el camino
-- para eso: `PUT /admin/quote-requests/:id/location` (`AdminGuard`,
-- `ChangeQuoteRequestLocationDto`), el mismo caso de uso que usa la persona
-- desde la app. Ese endpoint además limpia `geocoded_*` y re-encola el geocode
-- del backend: un `UPDATE` por SQL se saltearía las dos cosas.
--
-- ── POR QUÉ SACAR LOS PARÁMETROS, Y NO MANDAR "LA UBICACIÓN ACTUAL" ─────────
--
-- Mandarla sin cambios por el SP NO alcanza: el formulario la lee al abrirse,
-- y si entre que se abrió y se guardó alguien la corrigió (por HTTP desde la
-- ficha, o la persona desde la app), el SP la pisaría con la vieja. Last write
-- wins, pero el que gana tiene que ser alguien que QUISO escribir la
-- ubicación, no un formulario que pasaba por ahí. Así que la ubicación tiene
-- UN solo camino de escritura (el HTTP) y este SP no la nombra.
--
-- ── EL `grep` AL BACKEND ─────────────────────────────────────────────────────
--
-- Positivo el 2026-11-09 (séptima vez): `AdminQuoteRequestController` →
-- `PUT :id/location`. Para el resto de los campos (contacto, patente,
-- descripción, monto) sigue sin haber endpoint admin, y el vehículo escrito
-- ni siquiera tiene columna en `quote_requests`: esto sigue siendo un SP.
--
-- ── LO QUE CAMBIA RESPECTO DE LA 018 ─────────────────────────────────────────
--
--   * Firma: sin `p_location_address/locality/province`. DROP con la firma
--     EXACTA de la 018 + CREATE (trampa de la 009: un CREATE solo dejaría una
--     sobrecarga viva y la llamada nombrada fallaría con "is not unique").
--   * El UPDATE no menciona ninguna columna `location_*`.
--   * Desaparecen `LOCATION_FROM_DEVICE`, `LOCATION_ADDRESS_REQUIRED` y
--     `LOCATION_ADDRESS_TOO_LONG` de esta función (las dos últimas siguen en
--     `ops.create_quote_request`, 019, que NO se toca: el backend no tiene alta
--     admin y el alta a mano sigue cargando su zona tipeada).
--
-- Todo lo demás es igual a la 018, validación por validación: teléfono y
-- descripción obligatorios, patente normalizada y obligatoria con cuenta,
-- vehículo escrito, monto, `FOR UPDATE` antes del `before`, y sin cambios no
-- hay entrada en el log.
--
-- ── LOS 8 GUARDRAILS ─────────────────────────────────────────────────────────
--
--   1. Vive en `migrations/`.
--   2. SECURITY INVOKER (el default).
--   3. `SET search_path` fijo.
--   4. `p_actor_id` sale de la sesión, jamás del payload.
--   5. `ops.action_log` dentro de la función, `before`/`after` = la fila
--      REDACTADA (`_redact_quote_request`, 011) + el vehículo escrito.
--   6. Ninguna FK cruza a `public` (no se crea ninguna tabla).
--   7. `ops._lock_quote_request` (FOR UPDATE) antes de leer el `before`.
--   8. `quote_requests.updated_at` lo mueve `trg_quote_requests_updated_at`.
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION ops.update_quote_request(uuid, uuid, text, text, text, text, text, text, numeric, text, text, text, text);

CREATE FUNCTION ops.update_quote_request(
  p_quote_request_id uuid,
  p_actor_id         uuid,
  p_contact_phone    text,
  p_description      text,
  p_contact_name     text    DEFAULT NULL,
  p_contact_email    text    DEFAULT NULL,
  p_plate            text    DEFAULT NULL,
  p_vehicle_text     text    DEFAULT NULL,
  p_declared_amount  numeric DEFAULT NULL,
  p_note             text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before        jsonb;
  v_after         jsonb;
  v_contact_phone text := btrim(coalesce(p_contact_phone, ''));
  v_description   text := btrim(coalesce(p_description, ''));
  v_contact_name  text := nullif(btrim(coalesce(p_contact_name, '')), '');
  v_contact_email text := nullif(btrim(coalesce(p_contact_email, '')), '');
  v_plate         text;
  v_vehicle_text  text;
  v_amount        numeric;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  -- Guardrail 7: el lock ANTES de leer el `before`.
  v_before := ops._quote_request_snapshot(ops._lock_quote_request(p_quote_request_id), p_quote_request_id);

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

  -- chk_quote_requests_user_has_plate, traducido.
  IF v_plate IS NULL AND v_before->>'user_id' IS NOT NULL THEN
    RAISE EXCEPTION 'PLATE_REQUIRED_FOR_ACCOUNT'
      USING HINT = 'chk_quote_requests_user_has_plate: un pedido con cuenta de AutoLibre necesita patente.';
  END IF;

  -- Ninguna columna location_*: la ubicación se corrige por
  -- PUT /admin/quote-requests/:id/location (ver la cabecera).
  UPDATE quote_requests
     SET contact_phone   = v_contact_phone,
         contact_name    = v_contact_name,
         contact_email   = v_contact_email,
         plate           = v_plate,
         description     = v_description,
         declared_amount = v_amount
   WHERE id = p_quote_request_id
     AND (contact_phone, contact_name, contact_email, plate, description, declared_amount)
         IS DISTINCT FROM
         (v_contact_phone, v_contact_name, v_contact_email, v_plate, v_description, v_amount);

  PERFORM ops._set_quote_request_vehicle_text(p_quote_request_id, p_actor_id, v_vehicle_text);

  v_after := ops._quote_request_snapshot(ops._read_quote_request(p_quote_request_id), p_quote_request_id);

  IF (v_after - 'updated_at') IS DISTINCT FROM (v_before - 'updated_at') THEN
    PERFORM ops.log_action(
      p_actor_id, 'quote_request.update', 'public.quote_requests', p_quote_request_id,
      v_before, v_after, p_note
    );
  END IF;

  RETURN v_after;
END;
$$;
