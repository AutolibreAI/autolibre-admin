-- ═══════════════════════════════════════════════════════════════════════════
-- 043 — Revisión de cuentas: «Marcar revisado» en la cola de Usuarios.
--
-- La cola «Revisar cuentas» (`/usuarios/revisar`) lista dos casos que el panel
-- NO puede arreglar, porque el backend no tiene un camino para vincular una
-- cuenta a un taller desde el admin (relevado el 2026-11-26: sólo hay códigos
-- de reclamo, que canjea la persona, y revocar) y ninguno actualiza
-- `users.role`:
--
--   (a) `possible_partner`: cuenta `user` sin membresía cuyo mail o teléfono
--       coincide con un taller o una solicitud.
--   (b) `stale_role`: cuenta vinculada a un taller cuyo rol no es `partner`
--       ni `admin`.
--
-- El pedido está en `docs/pedido-backend-cuentas-partner.md`. Mientras tanto,
-- el equipo marca que ya miró cada caso: quién, cuándo y una nota. Es dato de
-- operación del panel (`ops`). La cuenta va por UUID pelado (guardrail 6); que
-- exista lo valida el SP con un EXISTS. No escribe nada de `public`.
--
-- Una fila por (cuenta, tipo): sin fila = pendiente. «Volver a pendiente»
-- borra la fila. Todo pasa por `ops.action_log` (guardrail 5).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ops.account_review (
  user_id      uuid        NOT NULL,
  kind         text        NOT NULL,
  note         text,
  reviewed_by  uuid        NOT NULL,
  reviewed_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, kind),
  CONSTRAINT chk_ops_ar_kind CHECK (kind IN ('possible_partner', 'stale_role')),
  CONSTRAINT chk_ops_ar_note CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 1000))
);

CREATE OR REPLACE FUNCTION ops.set_account_reviewed(
  p_user_id  uuid,
  p_kind     text,
  p_reviewed boolean,
  p_note     text,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: %', p_user_id;
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('possible_partner', 'stale_role') THEN
    RAISE EXCEPTION 'INVALID_REVIEW_KIND: %', p_kind;
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN
    RAISE EXCEPTION 'REVIEW_NOTE_TOO_LONG';
  END IF;

  SELECT to_jsonb(r) INTO v_before FROM ops.account_review r
   WHERE r.user_id = p_user_id AND r.kind = p_kind FOR UPDATE;

  IF NOT coalesce(p_reviewed, false) THEN
    IF v_before IS NULL THEN RETURN NULL; END IF;
    DELETE FROM ops.account_review WHERE user_id = p_user_id AND kind = p_kind;
    PERFORM ops.log_action(p_actor_id, 'account_review.reopen', 'public.users', p_user_id,
                           v_before, NULL, v_note);
    RETURN NULL;
  END IF;

  IF v_before IS NOT NULL AND (v_before->>'note') IS NOT DISTINCT FROM v_note THEN
    RETURN v_before;
  END IF;

  INSERT INTO ops.account_review (user_id, kind, note, reviewed_by)
  VALUES (p_user_id, p_kind, v_note, p_actor_id)
  ON CONFLICT (user_id, kind) DO UPDATE
    SET note = EXCLUDED.note, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now();

  SELECT to_jsonb(r) INTO v_after FROM ops.account_review r
   WHERE r.user_id = p_user_id AND r.kind = p_kind;
  PERFORM ops.log_action(p_actor_id, 'account_review.mark', 'public.users', p_user_id,
                         v_before, v_after, NULL);
  RETURN v_after;
END;
$$;
