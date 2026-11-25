-- ═══════════════════════════════════════════════════════════════════════════
-- 041 — Seguimiento de pedidos (`/leads/pedidos/seguimiento`): "a esta persona
-- ya le escribimos por estos pedidos", con fecha y quién.
--
-- Reemplaza el `localStorage` y la base del prototipo
-- (https://claude.ai/artifact/29GyDSkTxsbLuk9QVydxWV), que el resto del equipo
-- no veía. Es operación del panel: nadie de la app lo lee. Va en `ops`, por
-- pedido (el pedido por UUID pelado, sin FK).
--
-- La pantalla agrupa por PERSONA (teléfono normalizado): una persona está
-- «enviada» si TODOS sus pedidos sin resultado tienen fila acá; si apareció un
-- pedido nuevo después del mensaje, vuelve a pendiente con «Pedido nuevo». Esa
-- regla es de la pantalla (`~/lib/quote-followup`), no de esta tabla.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ops.quote_followup_send (
  quote_request_id uuid PRIMARY KEY,
  sent_at          timestamptz NOT NULL DEFAULT now(),
  sent_by          uuid        NOT NULL
);

/**
 * Marca (o desmarca, con `p_sent` false) como enviados los pedidos de una
 * persona. Uno ya marcado conserva su fecha original; no hace log si no cambió
 * nada.
 */
CREATE OR REPLACE FUNCTION ops.set_quote_followup_sent(
  p_quote_request_ids uuid[],
  p_sent              boolean,
  p_actor_id          uuid
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_n integer := 0;
  v_id uuid;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  IF p_quote_request_ids IS NULL OR cardinality(p_quote_request_ids) = 0 THEN
    RAISE EXCEPTION 'FOLLOWUP_JOBS_REQUIRED';
  END IF;
  IF cardinality(p_quote_request_ids) > 100 THEN RAISE EXCEPTION 'FOLLOWUP_TOO_MANY'; END IF;

  FOREACH v_id IN ARRAY p_quote_request_ids LOOP
    IF NOT EXISTS (SELECT 1 FROM quote_requests WHERE id = v_id) THEN
      RAISE EXCEPTION 'QUOTE_REQUEST_NOT_FOUND: %', v_id;
    END IF;
    IF coalesce(p_sent, false) THEN
      INSERT INTO ops.quote_followup_send (quote_request_id, sent_by)
      VALUES (v_id, p_actor_id)
      ON CONFLICT (quote_request_id) DO NOTHING;
      IF FOUND THEN
        v_n := v_n + 1;
        PERFORM ops.log_action(p_actor_id, 'quote_followup.sent', 'public.quote_requests', v_id, NULL,
                               jsonb_build_object('sent', true), NULL);
      END IF;
    ELSE
      DELETE FROM ops.quote_followup_send WHERE quote_request_id = v_id;
      IF FOUND THEN
        v_n := v_n + 1;
        PERFORM ops.log_action(p_actor_id, 'quote_followup.unsent', 'public.quote_requests', v_id,
                               jsonb_build_object('sent', true), jsonb_build_object('sent', false), NULL);
      END IF;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;
