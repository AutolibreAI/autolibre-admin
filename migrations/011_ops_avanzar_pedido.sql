-- ═══════════════════════════════════════════════════════════════════════════
-- 011 — Cambiar el estado de un pedido de presupuesto desde el panel.
--
-- Hasta acá `/leads/pedidos` y `/leads/pedidos/:id` eran READ-ONLY enteras: el
-- operador seguía moviendo `quote_requests.status` con cuatro scripts de
-- `autolibre-backend-hex/scripts/sql/` (`marcar-pedido-de-presupuesto-
-- contactado.sql`, `-respondido.sql`, `cerrar-pedido-de-presupuesto.sql`) más
-- el log de notas (`agregar-nota-interna-…sql`, que esta migración NO toca).
--
-- Esta migración agrega el SP que reemplaza los primeros tres: una función que
-- mueve `status` entre `received | contacted | answered | closed`.
--
-- ── POR QUÉ ESTO ESCRIBE `public.quote_requests` ────────────────────────────
--
-- Mismo caso que partners/leads (007) y solicitudes (010), y por el mismo
-- motivo — pero con una salvedad que hay que decir en voz alta:
--
--   `.claude/rules/leads.md` (sección Pedidos) ya documentaba, de una
--   verificación anterior: "El backend no tiene un endpoint con AdminGuard en
--   `src/quotes` para esas transiciones (sólo las del usuario: crear, cancelar,
--   declarar resultado)". Esa regla también dice: "Antes de escribirlos,
--   re-correr el grep al backend: si aparece el endpoint, va por HTTP."
--
--   **Ese grep NO se pudo re-correr para esta migración**: `autolibre-
--   backend-hex` no está clonado en esta máquina (mismo estado que dejó
--   constancia la migración 010 para `partner_applications`). Se asume que la
--   afirmación de `leads.md` sigue vigente porque es reciente (documentada el
--   2026-09-14, la misma semana) y porque el propio bounded context `quotes/`
--   sacó `quotes`/`quote_messages` del MVP — no hay ni el aggregate necesario
--   para que el backend ofrezca esas transiciones como caso de uso.
--
--   **Antes de que esto llegue a producción, correr**:
--     rg -n "AdminGuard" ../autolibre-backend-hex/src/quotes
--   Si aparece un endpoint de transición de estado, este SP sobra y hay que
--   usar `src/server/backend.ts` en su lugar — mismo criterio que manuales y
--   notificaciones (decisiones 4 y 4b del CLAUDE.md).
--
-- ── LOS 8 GUARDRAILS, IGUAL QUE 007/008/009/010 ─────────────────────────────
--
--   1. Vive en `migrations/`, nunca DDL a mano.
--   2. SECURITY INVOKER (el default). El control de acceso es de `adminMiddleware`.
--   3. `SET search_path` fijo.
--   4. `p_actor_id` sale de la sesión de Clerk, JAMÁS del payload.
--   5. Escribe `ops.action_log` DENTRO de la función, con `before`/`after` jsonb.
--   6. Ninguna FK cruza a `public`: `actor_id`/`target_id` son UUID pelados.
--   7. `SELECT ... FOR UPDATE` antes de leer el `before`.
--   8. `updated_at` NO se toca: `trg_quote_requests_updated_at` ya lo hace.
--
-- ── LO QUE ESTO NO DECIDE ────────────────────────────────────────────────────
--
-- Sólo valida REPRESENTABILIDAD contra los `CHECK` que la tabla YA tiene
-- (relevados con `pg_get_constraintdef`, no adivinados):
--
--   - `chk_quote_requests_contacted_has_timestamp`: `status IN (contacted,
--     answered)` exige `contacted_at`. Se sella la PRIMERA vez que se pasa por
--     ahí y nunca se pisa — mismo criterio que `contacted_at` en `advance_lead`.
--   - `chk_quote_requests_answered_has_timestamp` +
--     `chk_quote_requests_answered_after_contacted`: `answered_at` exige
--     `contacted_at` ya puesto y `>=` — como los dos se sellan con el MISMO
--     `now()` de la transacción cuando se salta directo a `answered`, quedan
--     iguales y la comparación `>=` pasa.
--   - `chk_quote_requests_answered_has_proposals_count`: si `answered_at`
--     queda no-nulo, `proposals_count` no puede ser NULL. Se exige la primera
--     vez que se entra a `answered`; una vez cargado, `coalesce()` lo conserva
--     en cualquier transición posterior (cerrar, o incluso retroceder).
--   - `chk_quote_requests_close_reason_code_iff_closed` +
--     `chk_quote_requests_closed_at_iff_closed`: son IFF, así que salir de
--     `closed` los vuelve a poner en NULL — mismo criterio que `won_at` /
--     `lost_reason` al salir de `won`/`lost` en `advance_lead`.
--   - `chk_quote_requests_cancellation_iff_cancelled`: `close_reason_code =
--     'cancelled_by_user'` exige `cancellation_reason`, que es LO QUE LA
--     PERSONA declaró al cancelar desde la app — el operador no puede
--     fabricarlo. Por eso esta función RECHAZA `cancelled_by_user` como motivo
--     de cierre: es el único de los cinco valores de `quote_request_close_
--     reason` que no puede venir de acá.
--
-- No hay máquina de estados que se imponga desde el SP: cualquier estado a
-- cualquier estado es representable (no hay, a diferencia de `leads`, un
-- índice único parcial sobre `quote_requests` que lo restrinja — relevado con
-- `pg_indexes`). La UI puede sugerir el orden natural; la función no lo exige.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION ops.advance_quote_request(
  p_quote_request_id  uuid,
  p_status             text,
  p_actor_id           uuid,
  p_proposals_count    int  DEFAULT NULL,
  p_close_reason_code  text DEFAULT NULL,
  p_closed_reason      text DEFAULT NULL,
  p_note               text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before            jsonb;
  v_after             jsonb;
  v_status            quote_request_status;
  v_close_reason_code quote_request_close_reason;
  v_proposals_count   int;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  BEGIN
    v_status := p_status::quote_request_status;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'INVALID_STATUS: %', p_status
      USING HINT = 'Valores válidos: received, contacted, answered, closed.';
  END;

  SELECT to_jsonb(q) INTO v_before
    FROM quote_requests q WHERE q.id = p_quote_request_id FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'QUOTE_REQUEST_NOT_FOUND: %', p_quote_request_id;
  END IF;

  -- `chk_quote_requests_answered_has_proposals_count`: si esta es la PRIMERA
  -- vez que se llega a `answered` (todavía sin proposals_count cargado en la
  -- fila ni en el parámetro), hace falta el número. Una vez cargado, queda
  -- sellado — no hace falta volver a mandarlo en cada llamada posterior.
  v_proposals_count := (v_before->>'proposals_count')::int;
  IF v_status = 'answered' AND coalesce(p_proposals_count, v_proposals_count) IS NULL THEN
    RAISE EXCEPTION 'PROPOSALS_COUNT_REQUIRED'
      USING HINT = 'Para marcar "respondido" hace falta cuántas propuestas se devolvieron.';
  END IF;

  IF v_status = 'closed' THEN
    IF p_close_reason_code IS NULL THEN
      RAISE EXCEPTION 'CLOSE_REASON_REQUIRED'
        USING HINT = 'Para cerrar un pedido hace falta el motivo.';
    END IF;
    -- Ver el comentario de cabecera: ese motivo lo declara la PERSONA al
    -- cancelar desde la app (junto con cancellation_reason/_comment), nunca
    -- el operador desde acá.
    IF p_close_reason_code = 'cancelled_by_user' THEN
      RAISE EXCEPTION 'CANNOT_CLOSE_AS_CANCELLED_BY_USER'
        USING HINT = 'Ese motivo lo pone la persona al cancelar desde la app, no el operador.';
    END IF;
    BEGIN
      v_close_reason_code := p_close_reason_code::quote_request_close_reason;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'INVALID_CLOSE_REASON: %', p_close_reason_code;
    END;
  END IF;

  UPDATE quote_requests SET
    status = v_status,
    -- Sellado: se pone la primera vez que el estado pasa por contacted/answered
    -- y no se vuelve a tocar — mismo criterio que `contacted_at` en `advance_lead`.
    contacted_at = CASE
                     WHEN contacted_at IS NOT NULL THEN contacted_at
                     WHEN v_status IN ('contacted', 'answered') THEN now()
                     ELSE contacted_at
                   END,
    answered_at = CASE
                    WHEN answered_at IS NOT NULL THEN answered_at
                    WHEN v_status = 'answered' THEN now()
                    ELSE answered_at
                  END,
    proposals_count = coalesce(p_proposals_count, proposals_count),
    -- Las tres del cierre son IFF con `status = 'closed'`: entrar las pone,
    -- salir las limpia. `closed_at` también se sella (no se pisa si ya estaba
    -- cerrado y se vuelve a cerrar).
    closed_at = CASE WHEN v_status = 'closed' THEN coalesce(closed_at, now()) ELSE NULL END,
    close_reason_code = CASE WHEN v_status = 'closed' THEN v_close_reason_code ELSE NULL END,
    closed_reason = CASE
                      WHEN v_status = 'closed'
                        THEN nullif(btrim(coalesce(p_closed_reason, closed_reason, '')), '')
                      ELSE NULL
                    END
  WHERE id = p_quote_request_id;
  -- updated_at NO se toca: trg_quote_requests_updated_at ya lo hace.

  SELECT to_jsonb(q) INTO v_after FROM quote_requests q WHERE q.id = p_quote_request_id;
  PERFORM ops.log_action(
    p_actor_id, 'quote_request.advance', 'public.quote_requests', p_quote_request_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;
