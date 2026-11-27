-- ═══════════════════════════════════════════════════════════════════════════
-- 045 — Liquidaciones a comerciales: «Cobra premio» y el premio por alta.
--
-- Regla (Nicolás, 2026-11-26), la calcula el panel (`~/lib/commercial-commissions`):
-- el comercial que dio el alta de un proveedor («Alta por», 035) cobra un
-- premio cuando ese taller tiene su PRIMER trabajo confirmado (misma definición
-- que Liquidaciones, 038; cuenta aunque ese trabajo sea gratis para el taller).
-- Ya no se venden suscripciones: se terminó el «pago inmediato por alta con
-- plan pago» de la 039. El monto por alta vive en `partner-fees-config.ts`.
--
--   * `ops.team_member.earns_award`: si la persona cobra premio. El equipo
--     fundador no (Nicolás Leunda, Ramiro Sarasola, Mateo Ghidini, Matías
--     Vidal, Matías García Guevara): se apaga para el rol `fundador` y para
--     esos nombres. Una persona nueva arranca en `true`; se cambia desde
--     Comercial › Equipo (`ops.set_team_member_earns_award`).
--   * `ops.commercial_award`: el estado del premio por proveedor. Sin fila =
--     pendiente (si ya hubo primer trabajo) o esperando. `pagado` congela
--     monto, comercial, referencia y fecha; `anulado` exige motivo.
--
-- `ops.commercial_commission_payment` (039) no se toca: queda como histórico
-- del régimen anterior (0 filas en producción al 2026-11-26).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ops.team_member ADD COLUMN IF NOT EXISTS earns_award boolean NOT NULL DEFAULT true;

UPDATE ops.team_member
   SET earns_award = false
 WHERE role = 'fundador'
    OR lower(translate(btrim(name), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) IN (
         'nicolas leunda', 'ramiro sarasola', 'mateo ghidini', 'matias vidal', 'matias garcia guevara');

CREATE OR REPLACE FUNCTION ops.set_team_member_earns_award(
  p_id       uuid,
  p_value    boolean,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  IF p_value IS NULL THEN RAISE EXCEPTION 'INVALID_EARNS_AWARD'; END IF;
  SELECT to_jsonb(m) INTO v_before FROM ops.team_member m WHERE m.id = p_id FOR UPDATE;
  IF v_before IS NULL THEN RAISE EXCEPTION 'MEMBER_NOT_FOUND: %', p_id; END IF;
  IF (v_before->>'earns_award')::boolean = p_value THEN RETURN v_before; END IF;

  UPDATE ops.team_member SET earns_award = p_value, updated_at = now() WHERE id = p_id;
  SELECT to_jsonb(m) INTO v_after FROM ops.team_member m WHERE m.id = p_id;
  PERFORM ops.log_action(p_actor_id, 'team_member.earns_award', 'ops.team_member', p_id, v_before, v_after, NULL);
  RETURN v_after;
END;
$$;

CREATE TABLE IF NOT EXISTS ops.commercial_award (
  -- `partners.id`, UUID pelado (guardrail 6).
  partner_id   uuid PRIMARY KEY,
  member_id    uuid          NOT NULL REFERENCES ops.team_member (id),
  status       text          NOT NULL,
  amount       numeric(12,2),
  -- AL-n del primer trabajo confirmado.
  reference    text,
  paid_on      date,
  note         text,
  void_reason  text,
  updated_by   uuid          NOT NULL,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT chk_ops_ca_status CHECK (status IN ('pagado', 'anulado')),
  CONSTRAINT chk_ops_ca_paid CHECK (
    status <> 'pagado' OR (amount IS NOT NULL AND amount > 0 AND amount < 10000000000 AND paid_on IS NOT NULL)
  ),
  CONSTRAINT chk_ops_ca_void CHECK (
    (status = 'anulado' AND void_reason IS NOT NULL AND btrim(void_reason) <> '' AND length(void_reason) <= 1000)
    OR (status <> 'anulado' AND void_reason IS NULL)
  ),
  CONSTRAINT chk_ops_ca_note CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 1000)),
  CONSTRAINT chk_ops_ca_reference CHECK (reference IS NULL OR length(reference) <= 120)
);

CREATE INDEX IF NOT EXISTS idx_ops_ca_member ON ops.commercial_award (member_id, status);

/**
 * Mueve el premio de un alta: `pendiente` (borra la fila), `pagado` (monto,
 * fecha, comercial y referencia congelados) o `anulado` (motivo obligatorio).
 * Mismo dato = no-op sin log. No decide CUÁNTO ni A QUIÉN: lo recalcula el
 * panel antes de llamar; acá se valida representabilidad.
 */
CREATE OR REPLACE FUNCTION ops.set_commercial_award(
  p_partner_id  uuid,
  p_status      text,
  p_member_id   uuid,
  p_amount      numeric,
  p_reference   text,
  p_paid_on     date,
  p_note        text,
  p_void_reason text,
  p_actor_id    uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_ref    text := nullif(btrim(coalesce(p_reference, '')), '');
  v_void   text := nullif(btrim(coalesce(p_void_reason, '')), '');
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  IF p_partner_id IS NULL OR NOT EXISTS (SELECT 1 FROM partners WHERE id = p_partner_id) THEN
    RAISE EXCEPTION 'PARTNER_NOT_FOUND: %', p_partner_id;
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('pendiente', 'pagado', 'anulado') THEN
    RAISE EXCEPTION 'INVALID_AWARD_STATUS: %', p_status;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ops.commercial_award'), hashtext(p_partner_id::text));
  SELECT to_jsonb(a) INTO v_before FROM ops.commercial_award a WHERE a.partner_id = p_partner_id FOR UPDATE;

  IF p_status = 'pendiente' THEN
    IF v_before IS NULL THEN RETURN NULL; END IF;
    DELETE FROM ops.commercial_award WHERE partner_id = p_partner_id;
    PERFORM ops.log_action(p_actor_id, 'commercial_award.reopen', 'public.partners', p_partner_id,
                           v_before, NULL, v_note);
    RETURN NULL;
  END IF;

  IF p_member_id IS NULL OR NOT EXISTS (SELECT 1 FROM ops.team_member WHERE id = p_member_id) THEN
    RAISE EXCEPTION 'MEMBER_NOT_FOUND: %', p_member_id;
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN RAISE EXCEPTION 'AWARD_NOTE_TOO_LONG'; END IF;
  IF v_ref IS NOT NULL AND length(v_ref) > 120 THEN RAISE EXCEPTION 'AWARD_REFERENCE_TOO_LONG'; END IF;

  IF p_status = 'pagado' THEN
    IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'AWARD_AMOUNT_REQUIRED'; END IF;
    IF p_amount >= 10000000000 THEN RAISE EXCEPTION 'AWARD_AMOUNT_TOO_LARGE'; END IF;
    IF p_paid_on IS NULL THEN RAISE EXCEPTION 'AWARD_PAID_ON_REQUIRED'; END IF;
    IF p_paid_on > (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date THEN
      RAISE EXCEPTION 'AWARD_PAID_ON_IN_FUTURE';
    END IF;
    v_void := NULL;
  ELSE
    IF v_void IS NULL THEN RAISE EXCEPTION 'AWARD_VOID_REASON_REQUIRED'; END IF;
    IF length(v_void) > 1000 THEN RAISE EXCEPTION 'AWARD_NOTE_TOO_LONG'; END IF;
  END IF;

  IF v_before IS NOT NULL
     AND v_before->>'status' = p_status
     AND (v_before->>'member_id')::uuid = p_member_id
     AND (v_before->>'amount')::numeric IS NOT DISTINCT FROM (CASE WHEN p_status = 'pagado' THEN p_amount END)
     AND (v_before->>'paid_on')::date IS NOT DISTINCT FROM (CASE WHEN p_status = 'pagado' THEN p_paid_on END)
     AND (v_before->>'reference') IS NOT DISTINCT FROM v_ref
     AND (v_before->>'note') IS NOT DISTINCT FROM v_note
     AND (v_before->>'void_reason') IS NOT DISTINCT FROM v_void THEN
    RETURN v_before;
  END IF;

  INSERT INTO ops.commercial_award (partner_id, member_id, status, amount, reference, paid_on, note, void_reason, updated_by)
  VALUES (p_partner_id, p_member_id, p_status,
          CASE WHEN p_status = 'pagado' THEN p_amount END, v_ref,
          CASE WHEN p_status = 'pagado' THEN p_paid_on END, v_note, v_void, p_actor_id)
  ON CONFLICT (partner_id) DO UPDATE
    SET member_id = EXCLUDED.member_id,
        status = EXCLUDED.status,
        amount = EXCLUDED.amount,
        reference = EXCLUDED.reference,
        paid_on = EXCLUDED.paid_on,
        note = EXCLUDED.note,
        void_reason = EXCLUDED.void_reason,
        updated_by = EXCLUDED.updated_by,
        updated_at = now();

  SELECT to_jsonb(a) INTO v_after FROM ops.commercial_award a WHERE a.partner_id = p_partner_id;
  PERFORM ops.log_action(p_actor_id, 'commercial_award.' || p_status, 'public.partners', p_partner_id,
                         v_before, v_after, coalesce(v_void, v_note));
  RETURN v_after;
END;
$$;
