-- ═══════════════════════════════════════════════════════════════════════════
-- 018 — Editar un pedido de presupuesto, y cargarlo sin patente.
--
-- El pedido casi nunca llega completo. Por WhatsApp, sobre todo, la persona
-- escribe "hola, necesito un service" y el resto (el auto, la patente, dónde
-- está, cómo se llama) lo va soltando a lo largo de la charla. Hasta acá el
-- panel no tenía dónde anotarlo: la ficha era de sólo lectura en todo lo que
-- no fuera el recorrido, y el alta a mano (012) exigía una patente que la
-- persona muchas veces no da.
--
-- Tres cosas, en una migración porque son el mismo pedido de producto:
--
--   1. `ops.quote_request_vehicle_text` — el vehículo ESCRITO ("Peugeot 208
--      1.6 2019"), para cuando no hay un `vehicle_id` que vincular.
--   2. `ops.create_quote_request` — la patente pasa a ser opcional y se suma
--      el vehículo escrito. DROP + CREATE (trampa de la 009).
--   3. `ops.update_quote_request` — editar contacto, patente, vehículo
--      escrito, descripción, monto declarado y ubicación tipeada.
--
-- ── EL `grep` AL BACKEND ─────────────────────────────────────────────────────
--
-- No se pudo correr: `autolibre-backend-hex` no está clonado en esta máquina
-- (mismo estado que la 010). Lo que SÍ se relevó, contra producción el
-- 2026-09-27 (`autolibre` / `doadmin` / puerto 25060):
--
--   * `quote_requests.plate` es NULLABLE (`varchar(7)`), con
--     `chk_quote_requests_plate_not_blank` y
--     `chk_quote_requests_user_has_plate` (con cuenta ⇒ con patente). La
--     012 exigía la patente porque cuando se escribió la columna era NOT NULL;
--     el backend la relajó después. Hacerla opcional acá NO toca el backend:
--     es dejar de exigir algo que la base ya no exige.
--   * No hay ninguna columna para un vehículo descripto en texto. Lo más
--     parecido es `raw_submission->'vehicleLookup'` de los pedidos `web`, que
--     es la respuesta del proveedor de patentes y no algo que se edite.
--
-- La última vez que se corrió el grep (2026-09-15, `leads.md`), `src/quotes`
-- sólo tenía las escrituras del USUARIO (crear, cancelar, declarar resultado):
-- ninguna edición de campos con `AdminGuard`. Antes de ampliar este SP hay que
-- volver a correrlo:
--
--   rg -n "AdminGuard|update\(quoteRequests" ../autolibre-backend-hex/src/quotes
--
-- Si aparece un endpoint admin que edite un pedido, esto pasa a ir por HTTP y
-- `update_quote_request` se retira.
--
-- ── POR QUÉ EL VEHÍCULO ESCRITO ES UNA TABLA DE `ops` ────────────────────────
--
-- Mismo razonamiento que la 015 (`ops.quote_request_response`): `public` es del
-- backend y este repo no lo migra, y nada de la app lee este dato — es lo que
-- el operador anota para poder derivar y cotizar. `quote_request_id` es un UUID
-- pelado, sin FK (guardrail 6).
--
-- El camino de vuelta, para el día que el backend sume una columna (p. ej.
-- `quote_requests.vehicle_description text`):
--
--   UPDATE quote_requests q
--      SET vehicle_description = t.vehicle_text
--     FROM ops.quote_request_vehicle_text t
--    WHERE t.quote_request_id = q.id;
--
-- y esta tabla se retira.
--
-- ── LA UBICACIÓN: SÓLO LA TIPEADA ────────────────────────────────────────────
--
-- `update_quote_request` escribe `location_address/locality/province`, y la
-- 011 dejó una advertencia: "si un SP futuro de `quote_requests` llega a
-- escribir la ubicación, `_redact_quote_request` deja de alcanzar". Acá
-- ALCANZA, y es por diseño:
--
--   * Un pedido con `location_source = 'device'` trae el punto GPS del
--     teléfono. Ese bloque NO se edita: el SP exige que los tres textos lleguen
--     iguales a los que ya están (`LOCATION_FROM_DEVICE` si no). Pisarlo con
--     una dirección tipeada obligaría a borrar las coordenadas
--     (`chk_quote_requests_location_coordinates_only_device`) — perder el único
--     dato de cercanía que tiene el pedido.
--   * Sin ubicación, o con una `typed`, el operador la carga o la corrige. Un
--     `typed` nunca tiene coordenadas, así que este SP no escribe ninguna: el
--     redact sigue sacando del log todo lo que es GPS, y la dirección tipeada
--     queda en el log igual que ya quedaban localidad y provincia.
--
-- ── LO QUE NO SE TOCA ────────────────────────────────────────────────────────
--
--   * `raw_submission`: es lo que llegó. Editar el pedido NO lo reescribe, así
--     que el texto original de la persona siempre se puede ver en la ficha.
--   * `channel`, `user_id`, `vehicle_id`, estado y fechas: el canal es un
--     hecho (o, en un alta a mano, una aproximación ya elegida), la cuenta la
--     pone la app, el vínculo al vehículo es otra feature, y el estado lo mueven
--     los SP de la 011.
--   * `internal_notes`: tiene su propio SP y su propio formato.
--
-- Valida representabilidad y nada más, como el resto de `ops`: no decide si un
-- pedido "tiene que" tener patente — sólo lo exige cuando la base lo exige
-- (`chk_quote_requests_user_has_plate`).
--
-- ── LOS 8 GUARDRAILS ─────────────────────────────────────────────────────────
--
--   1. Vive en `migrations/`.
--   2. SECURITY INVOKER (el default).
--   3. `SET search_path` fijo en cada función.
--   4. `p_actor_id` sale de la sesión, jamás del payload.
--   5. `ops.action_log` dentro de la función, con `before`/`after` = la fila
--      redactada + el vehículo escrito (lo que el operador ve como UN pedido).
--   6. Ninguna FK cruza a `public`.
--   7. `update` toma el `FOR UPDATE` (`ops._lock_quote_request`, 011) antes de
--      leer el `before`. El alta no lockea: no hay fila previa (igual que 012).
--   8. `quote_requests.updated_at` lo mueve `trg_quote_requests_updated_at`.
--      La tabla de `ops` NO tiene trigger, así que ahí lo escribe la función
--      (mismo caso invertido que la 015).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE ops.quote_request_vehicle_text (
  quote_request_id uuid        PRIMARY KEY,
  vehicle_text     text        NOT NULL,
  created_by       uuid        NOT NULL,
  updated_by       uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ops_qrvt_not_blank CHECK (btrim(vehicle_text) <> ''),
  CONSTRAINT chk_ops_qrvt_max_length CHECK (char_length(vehicle_text) <= 200)
);

COMMENT ON TABLE ops.quote_request_vehicle_text IS
  'El vehículo de un pedido, escrito por el operador cuando no hay vehicle_id. Sin FK a public. Migración 018.';

/**
 * La patente normalizada: mayúsculas y sólo alfanuméricos. "ab 123 cd" y
 * "AB-123-CD" son la misma patente, y `plate` es `varchar(7)`: sin sacar los
 * separadores, una patente nueva con espacios no entra y vuelve un 22001 crudo.
 * `''` → NULL (la patente es opcional; `chk_quote_requests_plate_not_blank`
 * rechaza el string vacío).
 */
CREATE FUNCTION ops._normalize_quote_plate(p_plate text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_plate text := nullif(upper(regexp_replace(coalesce(p_plate, ''), '[^A-Za-z0-9]', '', 'g')), '');
BEGIN
  IF v_plate IS NOT NULL AND char_length(v_plate) > 7 THEN
    RAISE EXCEPTION 'INVALID_PLATE: %', p_plate
      USING HINT = 'plate es varchar(7) en public.quote_requests (AB123CD o ABC123).';
  END IF;
  RETURN v_plate;
END;
$$;

/** El vehículo escrito, normalizado. `''` → NULL; más de 200 caracteres → sentinela. */
CREATE FUNCTION ops._normalize_quote_vehicle_text(p_text text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_text text := nullif(btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g')), '');
BEGIN
  IF v_text IS NOT NULL AND char_length(v_text) > 200 THEN
    RAISE EXCEPTION 'VEHICLE_TEXT_TOO_LONG'
      USING HINT = 'Hasta 200 caracteres: marca, modelo, versión y año.';
  END IF;
  RETURN v_text;
END;
$$;

/** `numeric(12,2)` en `quote_requests`: ni negativo ni fuera de rango. */
CREATE FUNCTION ops._check_quote_declared_amount(p_amount numeric)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_amount IS NOT NULL AND p_amount < 0 THEN
    RAISE EXCEPTION 'INVALID_DECLARED_AMOUNT: %', p_amount;
  END IF;
  IF p_amount IS NOT NULL AND p_amount >= 10000000000 THEN
    RAISE EXCEPTION 'DECLARED_AMOUNT_TOO_LARGE: %', p_amount
      USING HINT = 'declared_amount es numeric(12,2).';
  END IF;
  RETURN p_amount;
END;
$$;

/**
 * Deja el vehículo escrito de un pedido como `p_text` dice: lo inserta, lo
 * actualiza o lo borra (NULL). `created_at`/`created_by` no se pisan al
 * editar — cuándo y quién lo cargó primero es el dato con valor, mismo
 * criterio que `upsertExcludedDomain`.
 *
 * No escribe `ops.action_log`: lo llaman el alta y la edición, que loguean el
 * pedido ENTERO (fila + vehículo escrito) en una sola entrada.
 */
CREATE FUNCTION ops._set_quote_request_vehicle_text(
  p_quote_request_id uuid,
  p_actor_id         uuid,
  p_text             text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
BEGIN
  IF p_text IS NULL THEN
    DELETE FROM ops.quote_request_vehicle_text WHERE quote_request_id = p_quote_request_id;
    RETURN;
  END IF;

  INSERT INTO ops.quote_request_vehicle_text AS t (quote_request_id, vehicle_text, created_by, updated_by)
  VALUES (p_quote_request_id, p_text, p_actor_id, p_actor_id)
  ON CONFLICT (quote_request_id) DO UPDATE
     SET vehicle_text = excluded.vehicle_text,
         updated_by   = excluded.updated_by,
         updated_at   = now()
   WHERE t.vehicle_text IS DISTINCT FROM excluded.vehicle_text;
END;
$$;

/** La fila redactada + el vehículo escrito: lo que se loguea y se devuelve. */
CREATE FUNCTION ops._quote_request_snapshot(p_row jsonb, p_quote_request_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, ops
AS $$
  SELECT p_row || jsonb_build_object(
    'vehicle_text',
    (SELECT t.vehicle_text FROM ops.quote_request_vehicle_text t WHERE t.quote_request_id = p_quote_request_id)
  )
$$;

-- ── 2. El alta, con la patente opcional ─────────────────────────────────────
--
-- Firma EXACTA de la 012. Sin este DROP, el CREATE de abajo sería una
-- SOBRECARGA y la llamada por parámetros nombrados del repo fallaría con
-- "is not unique" en el primer alta (trampa de la 009).

DROP FUNCTION ops.create_quote_request(uuid, text, text, text, text, text, text, numeric, text);

CREATE FUNCTION ops.create_quote_request(
  p_actor_id        uuid,
  p_channel         text,
  p_contact_phone   text,
  p_description     text,
  p_plate           text    DEFAULT NULL,
  p_vehicle_text    text    DEFAULT NULL,
  p_contact_name    text    DEFAULT NULL,
  p_contact_email   text    DEFAULT NULL,
  p_declared_amount numeric DEFAULT NULL,
  p_note            text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_channel       quote_request_channel;
  v_contact_phone text := btrim(coalesce(p_contact_phone, ''));
  v_description   text := btrim(coalesce(p_description, ''));
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

  INSERT INTO quote_requests (
    channel, contact_name, contact_phone, contact_email, plate, description,
    declared_amount, raw_submission
  ) VALUES (
    v_channel,
    nullif(btrim(coalesce(p_contact_name, '')), ''),
    v_contact_phone,
    nullif(btrim(coalesce(p_contact_email, '')), ''),
    v_plate,
    v_description,
    v_amount,
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

-- ── 3. Editar un pedido ya creado ───────────────────────────────────────────
--
-- REEMPLAZO COMPLETO, como el formulario de `set_partner_contact`: llegan
-- todos los campos, lo que llega es lo que queda, y un opcional en `''` o NULL
-- se BORRA. El formulario del panel siempre manda el juego entero.
--
-- Si nada cambió no escribe ni loguea: un "Guardar" sin tocar nada no es un
-- hecho que valga una entrada de auditoría.

CREATE FUNCTION ops.update_quote_request(
  p_quote_request_id  uuid,
  p_actor_id          uuid,
  p_contact_phone     text,
  p_description       text,
  p_contact_name      text    DEFAULT NULL,
  p_contact_email     text    DEFAULT NULL,
  p_plate             text    DEFAULT NULL,
  p_vehicle_text      text    DEFAULT NULL,
  p_declared_amount   numeric DEFAULT NULL,
  p_location_address  text    DEFAULT NULL,
  p_location_locality text    DEFAULT NULL,
  p_location_province text    DEFAULT NULL,
  p_note              text    DEFAULT NULL
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
  v_address       text := nullif(btrim(coalesce(p_location_address, '')), '');
  v_locality      text := nullif(btrim(coalesce(p_location_locality, '')), '');
  v_province      text := nullif(btrim(coalesce(p_location_province, '')), '');
  v_source        text;
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

  -- chk_quote_requests_user_has_plate: un pedido con cuenta tiene patente.
  -- Traducido, porque un 23514 con el nombre del constraint no le dice nada a
  -- quien opera.
  IF v_plate IS NULL AND v_before->>'user_id' IS NOT NULL THEN
    RAISE EXCEPTION 'PLATE_REQUIRED_FOR_ACCOUNT'
      USING HINT = 'chk_quote_requests_user_has_plate: un pedido con cuenta de AutoLibre necesita patente.';
  END IF;

  -- La ubicación. Ver la cabecera: la del GPS no se edita; la tipeada sí.
  IF v_before->>'location_source' = 'device' THEN
    IF v_address  IS DISTINCT FROM v_before->>'location_address'
    OR v_locality IS DISTINCT FROM v_before->>'location_locality'
    OR v_province IS DISTINCT FROM v_before->>'location_province' THEN
      RAISE EXCEPTION 'LOCATION_FROM_DEVICE'
        USING HINT = 'La ubicación vino del GPS del teléfono: editarla borraría las coordenadas.';
    END IF;
    v_source := 'device';
  ELSIF v_address IS NULL AND v_locality IS NULL AND v_province IS NULL THEN
    v_source := NULL;
  ELSE
    -- chk_quote_requests_location_typed_has_address
    IF v_address IS NULL THEN
      RAISE EXCEPTION 'LOCATION_ADDRESS_REQUIRED'
        USING HINT = 'Una ubicación tipeada necesita la dirección o zona.';
    END IF;
    -- chk_quote_requests_location_address_max_length
    IF char_length(v_address) > 300 THEN
      RAISE EXCEPTION 'LOCATION_ADDRESS_TOO_LONG';
    END IF;
    v_source := 'typed';
  END IF;

  UPDATE quote_requests
     SET contact_phone     = v_contact_phone,
         contact_name      = v_contact_name,
         contact_email     = v_contact_email,
         plate             = v_plate,
         description       = v_description,
         declared_amount   = v_amount,
         location_source   = v_source::quote_request_location_source,
         location_address  = v_address,
         location_locality = v_locality,
         location_province = v_province
   WHERE id = p_quote_request_id
     AND (contact_phone, contact_name, contact_email, plate, description, declared_amount,
          location_source::text, location_address, location_locality, location_province)
         IS DISTINCT FROM
         (v_contact_phone, v_contact_name, v_contact_email, v_plate, v_description, v_amount,
          v_source, v_address, v_locality, v_province);

  PERFORM ops._set_quote_request_vehicle_text(p_quote_request_id, p_actor_id, v_vehicle_text);

  v_after := ops._quote_request_snapshot(ops._read_quote_request(p_quote_request_id), p_quote_request_id);

  -- `updated_at` lo movió el trigger (o no, si el UPDATE no tocó nada): se
  -- compara sin él para saber si hubo un cambio real.
  IF (v_after - 'updated_at') IS DISTINCT FROM (v_before - 'updated_at') THEN
    PERFORM ops.log_action(
      p_actor_id, 'quote_request.update', 'public.quote_requests', p_quote_request_id,
      v_before, v_after, p_note
    );
  END IF;

  RETURN v_after;
END;
$$;
