-- ═══════════════════════════════════════════════════════════════════════════
-- 039 — Liquidaciones por comercial: el pago de la comisión por cada alta.
--
-- Regla vigente (Nicolás, 2026-11-25), la calcula el panel
-- (`~/lib/commercial-commissions`), no esta migración:
--
-- - Alta con suscripción paga: la PRIMERA cuota completa es del comercial que
--   trajo al proveedor («Alta por», 035), de inmediato.
-- - Alta en el plan gratis (pago por auto): el fee completo del PRIMER trabajo
--   confirmado de ese taller (038), sin vencimiento.
--
-- Una comisión por proveedor. Acá sólo se guarda que se PAGÓ: sin fila =
-- pendiente. Monto y comercial se congelan al pagar (si mañana cambia el
-- precio del plan o el «Alta por», lo pagado no se mueve).
--
-- Es `ops` (operación del equipo, nadie de la app lo lee). Partner, persona y
-- actor por UUID pelado, salvo la persona del equipo (ops → ops sí va).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ops.commercial_commission_payment (
  partner_id  uuid PRIMARY KEY,
  member_id   uuid          NOT NULL REFERENCES ops.team_member (id),
  kind        text          NOT NULL,
  amount      numeric(12,2) NOT NULL,
  -- AL-n del trabajo o código del plan: de qué sale la comisión.
  reference   text,
  paid_on     date          NOT NULL,
  note        text,
  paid_by     uuid          NOT NULL,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT chk_ops_ccp_kind CHECK (kind IN ('primera_cuota', 'fee_primer_trabajo')),
  CONSTRAINT chk_ops_ccp_amount CHECK (amount > 0),
  CONSTRAINT chk_ops_ccp_note CHECK (note IS NULL OR length(note) <= 1000),
  CONSTRAINT chk_ops_ccp_reference CHECK (reference IS NULL OR length(reference) <= 120)
);

CREATE INDEX IF NOT EXISTS idx_ops_ccp_member ON ops.commercial_commission_payment (member_id, paid_on);

/**
 * Marca pagada (o vuelve a pendiente, con `p_paid` false) la comisión del alta
 * de un proveedor. Mismo dato = no-op sin log. No decide CUÁNTO ni A QUIÉN:
 * valida representabilidad.
 */
CREATE OR REPLACE FUNCTION ops.set_commercial_commission_payment(
  p_partner_id uuid,
  p_paid       boolean,
  p_member_id  uuid,
  p_kind       text,
  p_amount     numeric,
  p_reference  text,
  p_paid_on    date,
  p_note       text,
  p_actor_id   uuid
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
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF p_partner_id IS NULL OR NOT EXISTS (SELECT 1 FROM partners WHERE id = p_partner_id) THEN
    RAISE EXCEPTION 'PARTNER_NOT_FOUND: %', p_partner_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ops.commercial_commission'), hashtext(p_partner_id::text));
  SELECT to_jsonb(c) INTO v_before FROM ops.commercial_commission_payment c
   WHERE partner_id = p_partner_id FOR UPDATE;

  IF NOT coalesce(p_paid, false) THEN
    IF v_before IS NULL THEN RETURN NULL; END IF;
    DELETE FROM ops.commercial_commission_payment WHERE partner_id = p_partner_id;
    PERFORM ops.log_action(p_actor_id, 'commercial_commission.unpay', 'public.partners', p_partner_id,
                           v_before, NULL, v_note);
    RETURN NULL;
  END IF;

  IF p_member_id IS NULL OR NOT EXISTS (SELECT 1 FROM ops.team_member WHERE id = p_member_id) THEN
    RAISE EXCEPTION 'MEMBER_NOT_FOUND: %', p_member_id;
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('primera_cuota', 'fee_primer_trabajo') THEN
    RAISE EXCEPTION 'INVALID_COMMISSION_KIND: %', p_kind;
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'COMMISSION_AMOUNT_REQUIRED'; END IF;
  IF p_amount >= 10000000000 THEN RAISE EXCEPTION 'COMMISSION_AMOUNT_TOO_LARGE'; END IF;
  IF p_paid_on IS NULL THEN RAISE EXCEPTION 'COMMISSION_PAID_ON_REQUIRED'; END IF;
  IF p_paid_on > (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date THEN
    RAISE EXCEPTION 'COMMISSION_PAID_ON_IN_FUTURE';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN RAISE EXCEPTION 'COMMISSION_NOTE_TOO_LONG'; END IF;
  IF v_ref IS NOT NULL AND length(v_ref) > 120 THEN RAISE EXCEPTION 'COMMISSION_REFERENCE_TOO_LONG'; END IF;

  IF v_before IS NOT NULL
     AND (v_before->>'member_id')::uuid = p_member_id
     AND v_before->>'kind' = p_kind
     AND (v_before->>'amount')::numeric = p_amount
     AND (v_before->>'paid_on')::date = p_paid_on
     AND (v_before->>'note') IS NOT DISTINCT FROM v_note
     AND (v_before->>'reference') IS NOT DISTINCT FROM v_ref THEN
    RETURN v_before;
  END IF;

  INSERT INTO ops.commercial_commission_payment (partner_id, member_id, kind, amount, reference, paid_on, note, paid_by)
  VALUES (p_partner_id, p_member_id, p_kind, p_amount, v_ref, p_paid_on, v_note, p_actor_id)
  ON CONFLICT (partner_id) DO UPDATE
    SET member_id = EXCLUDED.member_id,
        kind = EXCLUDED.kind,
        amount = EXCLUDED.amount,
        reference = EXCLUDED.reference,
        paid_on = EXCLUDED.paid_on,
        note = EXCLUDED.note,
        paid_by = EXCLUDED.paid_by,
        updated_at = now();

  SELECT to_jsonb(c) INTO v_after FROM ops.commercial_commission_payment c WHERE partner_id = p_partner_id;
  PERFORM ops.log_action(p_actor_id, 'commercial_commission.pay', 'public.partners', p_partner_id,
                         v_before, v_after, NULL);
  RETURN v_after;
END;
$$;
