-- ═══════════════════════════════════════════════════════════════════════════
-- 038 — Liquidaciones a proveedores: el fee por trabajo confirmado.
--
-- Para qué: saber cuánto nos debe cada proveedor por los trabajos que le
-- llegaron por AutoLibre, avisarle y registrar el cobro. Es plata que el
-- proveedor le paga a AutoLibre. → `.claude/rules/partner-fees.md`
--
-- ── POR QUÉ EN `ops` ──────────────────────────────────────────────────────
--
-- El cobro es operación del equipo: nadie de la app lo lee y el backend no
-- tiene nada de esto. `ops` es del panel (decisión 3 del CLAUDE.md). Pedido,
-- partner y actor van por UUID pelado (guardrail 6).
--
-- ── LA ATRIBUCIÓN ES UN PARCHE, Y ES A PROPÓSITO ──────────────────────────
--
-- El proveedor de un trabajo es, por regla, el de la propuesta elegida
-- (`quote_requests.selected_proposal_id` → `partner_id`). Al 2026-11-25 de 11
-- pedidos `hired` en producción sólo 1 lo tiene: los 11 están CERRADOS (el
-- backend no deja elegir en un pedido cerrado) y 6 ni siquiera tienen
-- propuestas (son anteriores a las propuestas en la app). Decidido con
-- Nicolás el 2026-11-25: una tabla parche de `ops` donde el equipo anota qué
-- proveedor hizo el trabajo (sacado de la nota del cierre), y un pedido al
-- backend para que deje elegir en los cerrados
-- (`docs/pedido-backend-liquidaciones-proveedores.md`).
--
-- **Si el pedido tiene propuesta elegida, ésa manda** y esta tabla se ignora
-- (la pantalla avisa si dicen distinto). Cuando el backend permita asignar en
-- los cerrados, se backfillea por HTTP y esta tabla se retira.
--
-- ── EL COBRO ──────────────────────────────────────────────────────────────
--
-- `ops.partner_fee_charge`: una fila por trabajo que salió de "pendiente".
-- Sin fila = pendiente. El MONTO se congela al avisar o cobrar: si mañana
-- cambia `FEE_POR_TRABAJO`, lo ya avisado o cobrado no cambia solo. El
-- partner también se congela: no se puede reatribuir un trabajo avisado o
-- cobrado sin volverlo antes a pendiente (`FEE_ALREADY_CHARGED`).
--
-- Los SP NO deciden qué es liquidable (eso es la regla del panel,
-- `~/lib/partner-fees`, parametrizable): validan representabilidad.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ops.partner_fee_attribution (
  quote_request_id uuid PRIMARY KEY,
  partner_id       uuid        NOT NULL,
  note             text,
  attributed_by    uuid        NOT NULL,
  attributed_at    timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ops_pfa_note CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 1000))
);

CREATE INDEX IF NOT EXISTS idx_ops_pfa_partner ON ops.partner_fee_attribution (partner_id);

CREATE TABLE IF NOT EXISTS ops.partner_fee_charge (
  quote_request_id uuid PRIMARY KEY,
  partner_id       uuid          NOT NULL,
  status           text          NOT NULL,
  amount           numeric(12,2),
  notified_at      timestamptz,
  paid_on          date,
  payment_method   text,
  note             text,
  void_reason      text,
  updated_by       uuid          NOT NULL,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT chk_ops_pfc_status CHECK (status IN ('pendiente', 'avisado', 'cobrado', 'anulado')),
  CONSTRAINT chk_ops_pfc_method CHECK (payment_method IS NULL OR payment_method IN ('mercado_pago', 'transferencia', 'efectivo')),
  CONSTRAINT chk_ops_pfc_amount CHECK (amount IS NULL OR amount > 0),
  CONSTRAINT chk_ops_pfc_paid CHECK (
    (status = 'cobrado' AND paid_on IS NOT NULL AND payment_method IS NOT NULL AND amount IS NOT NULL)
    OR (status <> 'cobrado' AND paid_on IS NULL AND payment_method IS NULL)
  ),
  CONSTRAINT chk_ops_pfc_void CHECK (
    (status = 'anulado' AND void_reason IS NOT NULL AND btrim(void_reason) <> '')
    OR (status <> 'anulado' AND void_reason IS NULL)
  ),
  CONSTRAINT chk_ops_pfc_notified CHECK (status <> 'avisado' OR (notified_at IS NOT NULL AND amount IS NOT NULL)),
  CONSTRAINT chk_ops_pfc_note CHECK (note IS NULL OR length(note) <= 1000)
);

CREATE INDEX IF NOT EXISTS idx_ops_pfc_partner ON ops.partner_fee_charge (partner_id, status);

-- ── SP: atribuir un trabajo a un proveedor ────────────────────────────────

/**
 * Anota (o quita, con `p_partner_id` NULL) qué proveedor hizo el trabajo de un
 * pedido. Mismo partner y misma nota = no-op sin log. No toca `quote_requests`.
 */
CREATE OR REPLACE FUNCTION ops.set_partner_fee_attribution(
  p_quote_request_id uuid,
  p_partner_id       uuid,
  p_note             text,
  p_actor_id         uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_before jsonb;
  v_after  jsonb;
  v_charge ops.partner_fee_charge%ROWTYPE;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF p_quote_request_id IS NULL OR NOT EXISTS (SELECT 1 FROM quote_requests WHERE id = p_quote_request_id) THEN
    RAISE EXCEPTION 'QUOTE_REQUEST_NOT_FOUND: %', p_quote_request_id;
  END IF;
  IF p_partner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM partners WHERE id = p_partner_id) THEN
    RAISE EXCEPTION 'PARTNER_NOT_FOUND: %', p_partner_id;
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN
    RAISE EXCEPTION 'FEE_NOTE_TOO_LONG';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ops.partner_fee'), hashtext(p_quote_request_id::text));

  SELECT to_jsonb(a) INTO v_before FROM ops.partner_fee_attribution a
   WHERE quote_request_id = p_quote_request_id FOR UPDATE;

  -- Un trabajo ya avisado o cobrado a OTRO proveedor no se reatribuye por
  -- debajo: primero se vuelve a pendiente (queda en el log).
  SELECT * INTO v_charge FROM ops.partner_fee_charge WHERE quote_request_id = p_quote_request_id;
  IF FOUND AND v_charge.status IN ('avisado', 'cobrado') AND v_charge.partner_id IS DISTINCT FROM p_partner_id THEN
    RAISE EXCEPTION 'FEE_ALREADY_CHARGED: %', v_charge.status;
  END IF;

  IF p_partner_id IS NULL THEN
    IF v_before IS NULL THEN RETURN NULL; END IF;
    DELETE FROM ops.partner_fee_attribution WHERE quote_request_id = p_quote_request_id;
    v_after := NULL;
  ELSE
    IF v_before IS NOT NULL
       AND (v_before->>'partner_id')::uuid = p_partner_id
       AND (v_before->>'note') IS NOT DISTINCT FROM v_note THEN
      RETURN v_before;
    END IF;
    INSERT INTO ops.partner_fee_attribution (quote_request_id, partner_id, note, attributed_by)
    VALUES (p_quote_request_id, p_partner_id, v_note, p_actor_id)
    ON CONFLICT (quote_request_id) DO UPDATE
      SET partner_id = EXCLUDED.partner_id,
          note = EXCLUDED.note,
          attributed_by = EXCLUDED.attributed_by,
          updated_at = now();
    SELECT to_jsonb(a) INTO v_after FROM ops.partner_fee_attribution a WHERE quote_request_id = p_quote_request_id;
  END IF;

  PERFORM ops.log_action(
    p_actor_id, 'partner_fee.attribute', 'public.quote_requests', p_quote_request_id, v_before, v_after, NULL
  );
  RETURN v_after;
END;
$$;

-- ── SP: mover el estado de cobro de uno o varios trabajos ─────────────────

/**
 * Lleva los trabajos de `p_quote_request_ids` (todos del MISMO proveedor) a
 * `p_status`, en una transacción. Una entrada de `ops.action_log` por trabajo.
 *
 * - `pendiente`: vuelve atrás (borra monto, fechas y medio).
 * - `avisado`: congela el monto; estampa `notified_at` si no lo tenía.
 * - `cobrado`: exige monto, fecha y medio.
 * - `anulado`: exige motivo; conserva el monto que tenía (si tenía).
 *
 * Mismo estado y mismos datos = no-op para ese trabajo, sin log.
 */
CREATE OR REPLACE FUNCTION ops.set_partner_fee_charges(
  p_quote_request_ids uuid[],
  p_partner_id        uuid,
  p_status            text,
  p_amount            numeric,
  p_paid_on           date,
  p_payment_method    text,
  p_note              text,
  p_void_reason       text,
  p_actor_id          uuid
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_id      uuid;
  v_before  ops.partner_fee_charge%ROWTYPE;
  v_found   boolean;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_void    text := nullif(btrim(coalesce(p_void_reason, '')), '');
  v_amount  numeric(12,2);
  v_notified timestamptz;
  v_after   jsonb;
  v_changed integer := 0;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF p_quote_request_ids IS NULL OR cardinality(p_quote_request_ids) = 0 THEN
    RAISE EXCEPTION 'FEE_JOBS_REQUIRED';
  END IF;
  IF cardinality(p_quote_request_ids) > 200 THEN
    RAISE EXCEPTION 'FEE_TOO_MANY_JOBS';
  END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(p_quote_request_ids) x) <> cardinality(p_quote_request_ids) THEN
    RAISE EXCEPTION 'FEE_DUPLICATE_JOBS';
  END IF;
  IF p_partner_id IS NULL OR NOT EXISTS (SELECT 1 FROM partners WHERE id = p_partner_id) THEN
    RAISE EXCEPTION 'PARTNER_NOT_FOUND: %', p_partner_id;
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('pendiente', 'avisado', 'cobrado', 'anulado') THEN
    RAISE EXCEPTION 'INVALID_FEE_STATUS: %', p_status;
  END IF;
  IF p_status IN ('avisado', 'cobrado') AND (p_amount IS NULL OR p_amount <= 0) THEN
    RAISE EXCEPTION 'FEE_AMOUNT_REQUIRED';
  END IF;
  IF p_amount IS NOT NULL AND p_amount >= 10000000000 THEN
    RAISE EXCEPTION 'FEE_AMOUNT_TOO_LARGE';
  END IF;
  IF p_status = 'cobrado' AND p_paid_on IS NULL THEN
    RAISE EXCEPTION 'FEE_PAID_ON_REQUIRED';
  END IF;
  IF p_status = 'cobrado' AND p_paid_on > (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date THEN
    RAISE EXCEPTION 'FEE_PAID_ON_IN_FUTURE';
  END IF;
  IF p_status = 'cobrado' AND (p_payment_method IS NULL OR p_payment_method NOT IN ('mercado_pago', 'transferencia', 'efectivo')) THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_METHOD: %', p_payment_method;
  END IF;
  IF p_status = 'anulado' AND v_void IS NULL THEN
    RAISE EXCEPTION 'FEE_VOID_REASON_REQUIRED';
  END IF;
  IF (v_note IS NOT NULL AND length(v_note) > 1000) OR (v_void IS NOT NULL AND length(v_void) > 1000) THEN
    RAISE EXCEPTION 'FEE_NOTE_TOO_LONG';
  END IF;

  FOREACH v_id IN ARRAY p_quote_request_ids LOOP
    IF NOT EXISTS (SELECT 1 FROM quote_requests WHERE id = v_id) THEN
      RAISE EXCEPTION 'QUOTE_REQUEST_NOT_FOUND: %', v_id;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('ops.partner_fee'), hashtext(v_id::text));

    SELECT * INTO v_before FROM ops.partner_fee_charge WHERE quote_request_id = v_id FOR UPDATE;
    v_found := FOUND;

    -- Cambiar de proveedor un trabajo avisado o cobrado: antes, a pendiente.
    IF v_found AND v_before.status IN ('avisado', 'cobrado') AND v_before.partner_id <> p_partner_id
       AND p_status <> 'pendiente' THEN
      RAISE EXCEPTION 'FEE_ALREADY_CHARGED: %', v_before.status;
    END IF;

    IF p_status = 'pendiente' THEN
      IF NOT v_found THEN CONTINUE; END IF;
      DELETE FROM ops.partner_fee_charge WHERE quote_request_id = v_id;
      PERFORM ops.log_action(p_actor_id, 'partner_fee.set_status', 'public.quote_requests', v_id,
                             to_jsonb(v_before), jsonb_build_object('status', 'pendiente'), v_note);
      v_changed := v_changed + 1;
      CONTINUE;
    END IF;

    v_amount := CASE WHEN p_status = 'anulado' THEN coalesce(p_amount, CASE WHEN v_found THEN v_before.amount END)
                     ELSE p_amount END;
    v_notified := CASE
      WHEN v_found AND v_before.notified_at IS NOT NULL THEN v_before.notified_at
      WHEN p_status = 'avisado' THEN now()
      ELSE NULL
    END;

    IF v_found
       AND v_before.status = p_status
       AND v_before.partner_id = p_partner_id
       AND v_before.amount IS NOT DISTINCT FROM v_amount
       AND v_before.paid_on IS NOT DISTINCT FROM (CASE WHEN p_status = 'cobrado' THEN p_paid_on END)
       AND v_before.payment_method IS NOT DISTINCT FROM (CASE WHEN p_status = 'cobrado' THEN p_payment_method END)
       AND v_before.note IS NOT DISTINCT FROM v_note
       AND v_before.void_reason IS NOT DISTINCT FROM (CASE WHEN p_status = 'anulado' THEN v_void END) THEN
      CONTINUE;
    END IF;

    INSERT INTO ops.partner_fee_charge AS c (
      quote_request_id, partner_id, status, amount, notified_at, paid_on, payment_method, note, void_reason, updated_by
    ) VALUES (
      v_id, p_partner_id, p_status, v_amount, v_notified,
      CASE WHEN p_status = 'cobrado' THEN p_paid_on END,
      CASE WHEN p_status = 'cobrado' THEN p_payment_method END,
      v_note,
      CASE WHEN p_status = 'anulado' THEN v_void END,
      p_actor_id
    )
    ON CONFLICT (quote_request_id) DO UPDATE
      SET partner_id = EXCLUDED.partner_id,
          status = EXCLUDED.status,
          amount = EXCLUDED.amount,
          notified_at = EXCLUDED.notified_at,
          paid_on = EXCLUDED.paid_on,
          payment_method = EXCLUDED.payment_method,
          note = EXCLUDED.note,
          void_reason = EXCLUDED.void_reason,
          updated_by = EXCLUDED.updated_by,
          updated_at = now();

    SELECT to_jsonb(c) INTO v_after FROM ops.partner_fee_charge c WHERE quote_request_id = v_id;
    PERFORM ops.log_action(p_actor_id, 'partner_fee.set_status', 'public.quote_requests', v_id,
                           CASE WHEN v_found THEN to_jsonb(v_before) END, v_after, NULL);
    v_changed := v_changed + 1;
  END LOOP;

  RETURN v_changed;
END;
$$;
