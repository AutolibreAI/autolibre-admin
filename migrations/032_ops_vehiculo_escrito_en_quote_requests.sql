-- ═══════════════════════════════════════════════════════════════════════════
-- 032 — El vehículo escrito se muda a `public.quote_requests.vehicle_description`.
--
-- La 018 guardó el vehículo que tipea el operador ("Peugeot 208 1.6 2019") en
-- `ops.quote_request_vehicle_text` porque el backend no tenía columna, y dejó
-- escrito el camino de vuelta para el día que la tuviera. Ese día llegó: la
-- migración 0160 del backend (`autolibre-backend-hex`,
-- `drizzle/0160_quote_requests_vehicle_description.sql`) suma
--
--   quote_requests.vehicle_description text NULL
--     chk_quote_requests_vehicle_description_not_blank   (NULL o btrim <> '')
--     chk_quote_requests_vehicle_description_max_length  (char_length <= 200)
--
-- y la USA: el despacho a talleres por WhatsApp arma el label del vehículo con
-- esa columna cuando el pedido no tiene `vehicle_catalog_id`, y el bloqueo de
-- readiness `missing_vehicle_catalog` sólo salta si no hay catálogo NI
-- descripción. El backend nunca lee `ops`: mientras el texto viviera acá, al
-- despacho no le llegaba.
--
-- El backend NO tiene endpoint para escribirla (grep del 2026-11-12): la
-- escribe el panel, por los mismos SPs de siempre.
--
-- ── PRECONDICIÓN: EL BACKEND SE DESPLIEGA PRIMERO ───────────────────────────
--
-- Esta migración necesita la 0160 del backend aplicada en la MISMA base. Si la
-- columna no está, corta con `VEHICLE_DESCRIPTION_COLUMN_MISSING` antes de
-- tocar nada (el runner corre cada migración en una transacción: no queda nada
-- a medias). En producción eso hace fallar `vercel-build` y el deploy del panel
-- no sale — que es lo correcto: un panel que escribe una columna inexistente
-- se cae en el primer «Guardar».
--
-- ── QUÉ HACE ────────────────────────────────────────────────────────────────
--
--   1. Precondición (arriba).
--   2. Copia los textos de `ops.quote_request_vehicle_text` a
--      `vehicle_description`, normalizados igual que `_normalize_quote_vehicle_text`
--      (btrim, `\s+` → ' ', vacío → NULL, ≤ 200), SÓLO donde la columna esté NULL.
--   3. `ops.create_quote_request` (firma de la 019) y `ops.update_quote_request`
--      (firma de la 028) escriben la columna en su mismo INSERT/UPDATE.
--      CREATE OR REPLACE con la firma EXACTA: no cambia ningún parámetro (sigue
--      siendo `p_vehicle_text`), así que no hay sobrecarga posible (trampa de
--      la 009) y `quote-requests.repo.ts` no cambia la llamada.
--   4. `ops._quote_request_snapshot` deja de leer la tabla de `ops`: la fila ya
--      trae `vehicle_description`, y se conserva la clave `vehicle_text` como
--      alias para que el `ops.action_log` y lo que devuelven los SPs sigan
--      teniendo la forma de siempre (las entradas viejas del log la usan).
--   5. Se DROPEA `ops._set_quote_request_vehicle_text`: era el único que
--      escribía la tabla de `ops`, y dejarlo vivo es dejar una segunda puerta
--      de escritura que desincroniza los dos lugares.
--
-- ── LO QUE NO HACE ──────────────────────────────────────────────────────────
--
--   * NO dropea `ops.quote_request_vehicle_text`. Queda SIN USO (nadie la
--     escribe ni la lee) y con sus filas como respaldo, hasta confirmar en
--     producción que la copia y el despacho andan. El DROP va en una migración
--     propia, después.
--   * No loguea la copia en `ops.action_log`: no es una acción de un operador
--     (no hay actor) sino una mudanza de dato que ya estaba auditado.
--
-- ── EFECTO LATERAL CONOCIDO ─────────────────────────────────────────────────
--
-- El UPDATE de la copia dispara `trg_quote_requests_updated_at` (del backend):
-- los pedidos copiados quedan con `updated_at = now()` del momento de migrar.
-- Evitarlo exigiría deshabilitar un trigger de `public`, y este repo no hace DDL
-- sobre `public`. Son pocos pedidos y `updated_at` no ordena ninguna pantalla
-- del panel.
--
-- ── LOS 8 GUARDRAILS ────────────────────────────────────────────────────────
--
--   1. Vive en `migrations/`.
--   2. SECURITY INVOKER (el default).
--   3. `SET search_path` fijo en cada función.
--   4. `p_actor_id` sale de la sesión, jamás del payload.
--   5. `ops.action_log` dentro de las funciones, `before`/`after` = la fila
--      REDACTADA (que ahora trae `vehicle_description`) + `vehicle_text`.
--   6. Ninguna FK cruza a `public` (no se crea ninguna tabla).
--   7. `update` sigue tomando el `FOR UPDATE` antes del `before`.
--   8. `quote_requests.updated_at` lo mueve `trg_quote_requests_updated_at`.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Precondición ─────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'quote_requests'
       AND column_name  = 'vehicle_description'
  ) THEN
    RAISE EXCEPTION 'VEHICLE_DESCRIPTION_COLUMN_MISSING'
      USING HINT = 'Falta public.quote_requests.vehicle_description: aplicá antes la migración 0160 '
                   'de autolibre-backend-hex (desplegá el backend) en esta base y volvé a migrar.';
  END IF;
END $$;

-- ── 2. La copia ─────────────────────────────────────────────────────────────

UPDATE public.quote_requests q
   SET vehicle_description = t.normalized
  FROM (
    SELECT quote_request_id,
           nullif(btrim(regexp_replace(vehicle_text, '\s+', ' ', 'g')), '') AS normalized
      FROM ops.quote_request_vehicle_text
  ) t
 WHERE t.quote_request_id = q.id
   AND q.vehicle_description IS NULL
   AND t.normalized IS NOT NULL
   AND char_length(t.normalized) <= 200;

-- ── 3a. El alta (firma de la 019) ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION ops.create_quote_request(
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
    channel, contact_name, contact_phone, contact_email, plate, vehicle_description,
    description, declared_amount, location_source, location_address,
    location_locality, location_province, raw_submission
  ) VALUES (
    v_channel,
    nullif(btrim(coalesce(p_contact_name, '')), ''),
    v_contact_phone,
    nullif(btrim(coalesce(p_contact_email, '')), ''),
    v_plate,
    v_vehicle_text,
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

  v_after := ops._quote_request_snapshot(ops._read_quote_request(v_id), v_id);
  PERFORM ops.log_action(
    p_actor_id, 'quote_request.create', 'public.quote_requests', v_id,
    NULL, v_after, p_note
  );

  RETURN v_after;
END;
$$;

-- ── 3b. La edición (firma de la 028) ────────────────────────────────────────

CREATE OR REPLACE FUNCTION ops.update_quote_request(
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

  -- Ninguna columna de ubicación: se corrige por
  -- PUT /admin/quote-requests/:id/location (028).
  UPDATE quote_requests
     SET contact_phone       = v_contact_phone,
         contact_name        = v_contact_name,
         contact_email       = v_contact_email,
         plate               = v_plate,
         vehicle_description = v_vehicle_text,
         description         = v_description,
         declared_amount     = v_amount
   WHERE id = p_quote_request_id
     AND (contact_phone, contact_name, contact_email, plate, vehicle_description, description, declared_amount)
         IS DISTINCT FROM
         (v_contact_phone, v_contact_name, v_contact_email, v_plate, v_vehicle_text, v_description, v_amount);

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

-- ── 4. El snapshot ──────────────────────────────────────────────────────────
--
-- La firma no cambia (los dos SPs de arriba la llaman así); `p_quote_request_id`
-- queda sin uso. `vehicle_text` es un ALIAS de `vehicle_description`, para que
-- el log y el retorno conserven la clave que usaron desde la 018.

CREATE OR REPLACE FUNCTION ops._quote_request_snapshot(p_row jsonb, p_quote_request_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, ops
AS $$
  SELECT p_row || jsonb_build_object('vehicle_text', p_row->'vehicle_description')
$$;

-- ── 5. Sin segunda puerta de escritura ──────────────────────────────────────

DROP FUNCTION ops._set_quote_request_vehicle_text(uuid, uuid, text);

COMMENT ON TABLE ops.quote_request_vehicle_text IS
  'SIN USO desde la migración 032: el vehículo escrito vive en public.quote_requests.vehicle_description '
  '(0160 del backend). Nadie la escribe ni la lee; sus filas quedan como respaldo de la copia hasta '
  'confirmarla en producción, y después se dropea en una migración propia. Origen: migración 018.';
