-- ═══════════════════════════════════════════════════════════════════════════
-- 021 — La coordenada de un pedido con la dirección TIPEADA.
--
-- Un pedido que llega por la app trae el GPS del teléfono
-- (`location_source = 'device'`). Uno cargado a mano, o al que el operador le
-- escribió la dirección después (018/019), es `typed`: tiene dirección y
-- localidad, pero NO coordenadas. Sin coordenadas no hay pin en el mapa de
-- candidatos ni distancia a cada taller.
--
-- ── Por qué en `ops` y no en `quote_requests` ──────────────────────────────
--
-- `chk_quote_requests_location_coordinates_only_device` (del backend) prohíbe
-- coordenadas con `location_source = 'typed'`. No es un descuido: para el
-- backend la coordenada de un pedido ES el GPS de la persona. Un punto que
-- sacamos geocodificando un texto es OTRO dato —una aproximación nuestra— y
-- vive en una tabla nuestra, sin tocar el contrato ajeno. Mismo criterio que
-- el vehículo escrito (018).
--
-- ── El geocoder NO corre acá ─────────────────────────────────────────────────
--
-- Ningún SQL llama a una API externa. El panel geocodifica del lado del
-- servidor (`src/server/geocode.ts`: Google si hay key, si no Nominatim) y
-- guarda el resultado con esta función. `query` es el texto exacto que se
-- geocodificó: si después cambia la dirección del pedido, la fila queda vieja
-- y el panel la IGNORA al leer (no pinta un pin en el lugar equivocado) hasta
-- que se vuelva a geocodificar.
--
-- `precise` distingue un punto de calle y altura de un centroide de localidad
-- ("Palermo"). Los dos sirven para ordenar candidatos; el mapa dice cuál es.
--
-- ── LOS 8 GUARDRAILS ────────────────────────────────────────────────────────
--
--   1. vive en `migrations/`;  2. SECURITY INVOKER;  3. `search_path` fijo;
--   4. actor de la sesión (`ops.assert_actor`);
--   5. `ops.action_log` adentro, con UNA salvedad deliberada: el log NO lleva
--      las coordenadas. Es la misma decisión que `_redact_quote_request` (011):
--      la ubicación de la persona es deuda BLOQUEANTE de Ley 25.326, y copiarla
--      a un log que crece solo suma un lugar más que limpiar ante una
--      supresión. El log guarda `query`, `precise` y `provider` — qué se
--      geocodificó y con qué, no dónde quedó;
--   6. sin FK a `public` (`quote_request_id` es un UUID pelado; el pedido se
--      valida con `EXISTS`, igual que la 013);
--   7. el alta no lockea (no hay fila previa); el reemplazo lockea la fila de
--      `ops` antes de leer el `before`;
--   8. en `ops` no hay trigger: `updated_at` lo escribe la función.
--
-- Llamarla con las dos coordenadas en NULL BORRA la fila (la dirección dejó de
-- existir, o el geocoder ya no la encuentra). Llamarla con el mismo `query` y el
-- mismo punto no hace nada ni loguea.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ops.quote_request_geocode (
  quote_request_id uuid PRIMARY KEY,
  query            text             NOT NULL,
  latitude         double precision NOT NULL,
  longitude        double precision NOT NULL,
  precise          boolean          NOT NULL,
  provider         text             NOT NULL,
  actor_id         uuid             NOT NULL,
  created_at       timestamptz      NOT NULL DEFAULT now(),
  updated_at       timestamptz      NOT NULL DEFAULT now(),

  CONSTRAINT chk_ops_qrg_query_not_blank CHECK (btrim(query) <> ''),
  CONSTRAINT chk_ops_qrg_latitude  CHECK (latitude  BETWEEN -90  AND 90),
  CONSTRAINT chk_ops_qrg_longitude CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT chk_ops_qrg_provider  CHECK (provider IN ('google', 'nominatim'))
);

COMMENT ON TABLE ops.quote_request_geocode IS
  'Coordenada APROXIMADA de un pedido con ubicación tipeada, geocodificada por el panel. No es el GPS de la persona. 021.';

CREATE OR REPLACE FUNCTION ops.set_quote_request_geocode(
  p_quote_request_id uuid,
  p_actor_id         uuid,
  p_query            text,
  p_latitude         double precision,
  p_longitude        double precision,
  p_precise          boolean DEFAULT false,
  p_provider         text    DEFAULT 'nominatim'
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_query  text := nullif(btrim(p_query), '');
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF p_quote_request_id IS NULL OR NOT EXISTS (SELECT 1 FROM quote_requests WHERE id = p_quote_request_id) THEN
    RAISE EXCEPTION 'QUOTE_REQUEST_NOT_FOUND: %', p_quote_request_id;
  END IF;

  IF (p_latitude IS NULL) <> (p_longitude IS NULL) THEN
    RAISE EXCEPTION 'INCOMPLETE_COORDINATES'
      USING HINT = 'Latitud y longitud van juntas, o las dos en NULL para borrar.';
  END IF;

  IF p_latitude IS NOT NULL THEN
    IF p_latitude NOT BETWEEN -90 AND 90 OR p_longitude NOT BETWEEN -180 AND 180 THEN
      RAISE EXCEPTION 'COORDINATES_OUT_OF_RANGE';
    END IF;
    IF v_query IS NULL THEN
      RAISE EXCEPTION 'GEOCODE_QUERY_REQUIRED';
    END IF;
    IF coalesce(p_provider, '') NOT IN ('google', 'nominatim') THEN
      RAISE EXCEPTION 'INVALID_GEOCODE_PROVIDER: %', p_provider;
    END IF;
  END IF;

  -- `before`/`after` SIN coordenadas — ver el guardrail 5 de la cabecera.
  SELECT jsonb_build_object('query', g.query, 'precise', g.precise, 'provider', g.provider)
    INTO v_before
    FROM ops.quote_request_geocode g
   WHERE g.quote_request_id = p_quote_request_id
     FOR UPDATE;

  IF p_latitude IS NULL THEN
    IF v_before IS NULL THEN
      RETURN NULL;
    END IF;
    DELETE FROM ops.quote_request_geocode WHERE quote_request_id = p_quote_request_id;
    PERFORM ops.log_action(
      p_actor_id, 'quote_request.geocode', 'ops.quote_request_geocode',
      p_quote_request_id, v_before, NULL, NULL);
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ops.quote_request_geocode g
     WHERE g.quote_request_id = p_quote_request_id
       AND g.query = v_query
       AND g.latitude = p_latitude
       AND g.longitude = p_longitude
       AND g.precise = coalesce(p_precise, false)
       AND g.provider = p_provider
  ) THEN
    RETURN v_before;
  END IF;

  INSERT INTO ops.quote_request_geocode
    (quote_request_id, query, latitude, longitude, precise, provider, actor_id)
  VALUES
    (p_quote_request_id, v_query, p_latitude, p_longitude, coalesce(p_precise, false), p_provider, p_actor_id)
  ON CONFLICT (quote_request_id) DO UPDATE
     SET query      = excluded.query,
         latitude   = excluded.latitude,
         longitude  = excluded.longitude,
         precise    = excluded.precise,
         provider   = excluded.provider,
         actor_id   = excluded.actor_id,
         updated_at = now();

  v_after := jsonb_build_object('query', v_query, 'precise', coalesce(p_precise, false), 'provider', p_provider);

  PERFORM ops.log_action(
    p_actor_id, 'quote_request.geocode', 'ops.quote_request_geocode',
    p_quote_request_id, v_before, v_after, NULL);

  RETURN v_after;
END;
$$;

COMMENT ON FUNCTION ops.set_quote_request_geocode(uuid, uuid, text, double precision, double precision, boolean, text) IS
  'Guarda (o borra, con coordenadas NULL) la coordenada geocodificada de un pedido con ubicación tipeada. El log no lleva coordenadas. 021.';
