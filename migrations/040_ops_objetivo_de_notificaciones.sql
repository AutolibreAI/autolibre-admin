-- ═══════════════════════════════════════════════════════════════════════════
-- 040 — El «Objetivo» de un envío de notificaciones: la acción que se busca
-- que la persona haga (cargar el seguro, crear un pedido…). Lo mide la pantalla
-- de efecto (`/notificaciones/envios/efecto`).
--
-- Hasta acá vivía en un mock en memoria (`~/mocks/notification-targets`) y se
-- perdía al recargar, esperando `notification_sends.targetAction` del backend
-- (`docs/pedido-backend-notificaciones.md`). Es dato de operación del panel:
-- nadie de la app lo lee. Va en `ops`.
--
-- - `envio`: un envío puntual, por su `broadcastId` (el `source_id` de sus filas
--   de `notifications`).
-- - `programado`: una regla del panel (`ops.notification_schedule`). Cada envío
--   que dispara la hereda: la corrida (`ops.notification_schedule_run.id`) es el
--   `batch_id`, y el backend lo pone como `source_id` de cada notificación. Lo
--   resuelve `ops.notification_target_for(broadcast_id)`.
--
-- La lista de acciones vive en el código (`EFFECT_ACTIONS`, sólo las que se
-- pueden medir); acá se valida la forma, no el catálogo. Sin FK a `public`.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ops.notification_target (
  kind        text        NOT NULL,
  ref_id      uuid        NOT NULL,
  action      text        NOT NULL,
  set_by      uuid        NOT NULL,
  set_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref_id),
  CONSTRAINT chk_ops_nt_kind CHECK (kind IN ('envio', 'programado')),
  CONSTRAINT chk_ops_nt_action CHECK (action ~ '^[a-z_]{1,40}$')
);

/** Guarda (o borra, con `p_action` NULL) el objetivo. Mismo valor = no-op sin log. */
CREATE OR REPLACE FUNCTION ops.set_notification_target(
  p_kind     text,
  p_ref_id   uuid,
  p_action   text,
  p_actor_id uuid
)
RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before text;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  IF p_kind IS NULL OR p_kind NOT IN ('envio', 'programado') THEN
    RAISE EXCEPTION 'INVALID_TARGET_KIND: %', p_kind;
  END IF;
  IF p_ref_id IS NULL THEN RAISE EXCEPTION 'TARGET_REF_REQUIRED'; END IF;
  IF p_action IS NOT NULL AND p_action !~ '^[a-z_]{1,40}$' THEN
    RAISE EXCEPTION 'INVALID_TARGET_ACTION: %', p_action;
  END IF;
  IF p_kind = 'programado' AND NOT EXISTS (SELECT 1 FROM ops.notification_schedule WHERE id = p_ref_id) THEN
    RAISE EXCEPTION 'SCHEDULE_NOT_FOUND: %', p_ref_id;
  END IF;

  SELECT action INTO v_before FROM ops.notification_target WHERE kind = p_kind AND ref_id = p_ref_id FOR UPDATE;
  IF v_before IS NOT DISTINCT FROM p_action THEN RETURN p_action; END IF;

  IF p_action IS NULL THEN
    DELETE FROM ops.notification_target WHERE kind = p_kind AND ref_id = p_ref_id;
  ELSE
    INSERT INTO ops.notification_target (kind, ref_id, action, set_by)
    VALUES (p_kind, p_ref_id, p_action, p_actor_id)
    ON CONFLICT (kind, ref_id) DO UPDATE SET action = EXCLUDED.action, set_by = EXCLUDED.set_by, set_at = now();
  END IF;

  PERFORM ops.log_action(p_actor_id, 'notification_target.set', 'ops.notification_target', p_ref_id,
                         jsonb_build_object('kind', p_kind, 'action', v_before),
                         jsonb_build_object('kind', p_kind, 'action', p_action), NULL);
  RETURN p_action;
END;
$$;

/**
 * El objetivo de un envío por su `broadcastId`: el suyo si lo tiene; si no, el
 * de la regla que lo disparó (corrida → regla). Devuelve también de dónde salió.
 */
CREATE OR REPLACE FUNCTION ops.notification_target_for(p_broadcast_id uuid)
RETURNS TABLE (action text, source text)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, ops
AS $$
  SELECT t.action, 'envio'::text
    FROM ops.notification_target t
   WHERE t.kind = 'envio' AND t.ref_id = p_broadcast_id
  UNION ALL
  SELECT t.action, 'programado'::text
    FROM ops.notification_schedule_run r
    JOIN ops.notification_target t ON t.kind = 'programado' AND t.ref_id = r.schedule_id
   WHERE r.id = p_broadcast_id
     AND NOT EXISTS (SELECT 1 FROM ops.notification_target e WHERE e.kind = 'envio' AND e.ref_id = p_broadcast_id)
  LIMIT 1;
$$;
