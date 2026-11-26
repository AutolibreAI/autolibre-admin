-- ═══════════════════════════════════════════════════════════════════════════
-- 042 — Aviso del cambio del plan gratis: qué proveedor ya está avisado.
--
-- El plan gratis cambió de modalidad (2026-11-26): el PRIMER trabajo que les
-- llevamos es gratis, y desde el SEGUNDO se cobra un fee fijo por trabajo
-- (`PARTNER_FEE_CONFIG.FEE_POR_TRABAJO`, hoy ARS 20.000). El equipo le avisa a
-- cada proveedor con plan gratis y marca acá que ya está avisado: quién, cuándo,
-- por qué canal y una nota.
--
-- ── POR QUÉ EN `ops` ──────────────────────────────────────────────────────
--
-- Es dato de operación del equipo, nadie de la app lo lee, y `ops` es del
-- panel (decisión 3 del CLAUDE.md). El partner va por UUID pelado (guardrail 6:
-- ninguna FK cruza a `public`); que exista lo valida el SP con un EXISTS.
--
-- ── NO DECIDE QUIÉN TIENE PLAN GRATIS ─────────────────────────────────────
--
-- El plan efectivo sale del billing del backend y lo calcula el panel
-- (`effectivePlans` de `~/lib/partner-plans`). El SP sólo guarda el aviso: no
-- valida el plan (un proveedor que pasó a pago conserva su aviso, y uno que
-- vuelve a gratis lo recupera). Valida representabilidad, nada más.
--
-- ── VIGENTE + HISTORIAL ───────────────────────────────────────────────────
--
-- `ops.partner_free_plan_notice` es el aviso VIGENTE (una fila por partner;
-- sin fila = sin avisar). `ops.partner_free_plan_notice_log` es append-only:
-- cada tilde y cada destilde, con quién y cuándo. Destildar borra la vigente
-- y deja el historial. Además va a `ops.action_log` (guardrail 5).
--
-- ── CONTROL DE PISADA ─────────────────────────────────────────────────────
--
-- `p_expected_notified` es lo que el operador VIO. Si cambió mientras tanto →
-- `FREE_PLAN_NOTICE_CHANGED` y la pantalla relee (mismo patrón que
-- `SOURCER_CHANGED` de la 035). Mismo estado que el pedido = no-op sin log:
-- para corregir el canal o la nota se destilda y se vuelve a tildar.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ops.partner_free_plan_notice (
  -- `partners.id`, UUID pelado (guardrail 6).
  partner_id   uuid PRIMARY KEY,
  channel      text        NOT NULL,
  note         text,
  notified_by  uuid        NOT NULL,
  notified_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_ops_pfpn_channel CHECK (channel IN ('whatsapp', 'llamada', 'en_persona')),
  CONSTRAINT chk_ops_pfpn_note CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 1000))
);

CREATE TABLE IF NOT EXISTS ops.partner_free_plan_notice_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id       uuid        NOT NULL,
  before_notified  boolean     NOT NULL,
  after_notified   boolean     NOT NULL,
  -- Canal y nota del aviso cuando se tilda; al destildar, la nota (opcional)
  -- es el motivo.
  channel          text,
  note             text,
  actor_id         uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_ops_pfpnl_change CHECK (before_notified <> after_notified),
  CONSTRAINT chk_ops_pfpnl_channel CHECK (
    (after_notified AND channel IN ('whatsapp', 'llamada', 'en_persona'))
    OR (NOT after_notified AND channel IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ops_pfpnl_partner
  ON ops.partner_free_plan_notice_log (partner_id, created_at DESC);

CREATE OR REPLACE FUNCTION ops._partner_free_plan_notice_json(p_partner_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, ops
AS $$
  SELECT to_jsonb(n) FROM ops.partner_free_plan_notice n WHERE n.partner_id = p_partner_id;
$$;

/**
 * Tilda (`p_notified = true`) o destilda el aviso del plan gratis de un partner.
 *
 * - `p_expected_notified`: lo que vio el operador. Si cambió → `FREE_PLAN_NOTICE_CHANGED`.
 * - Tildar exige canal (`CHANNEL_REQUIRED` / `INVALID_CHANNEL`); nota opcional,
 *   recortada, `''` = sin nota, más de 1000 → `NOTE_TOO_LONG`.
 * - Destildar ignora el canal; la nota, si viene, queda en el historial.
 * - Mismo estado que el actual → no-op, sin historial ni log.
 */
CREATE OR REPLACE FUNCTION ops.set_partner_free_plan_notice(
  p_partner_id        uuid,
  p_notified          boolean,
  p_channel           text,
  p_note              text,
  p_expected_notified boolean,
  p_actor_id          uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before  jsonb;
  v_after   jsonb;
  v_current boolean;
  v_channel text := nullif(btrim(coalesce(p_channel, '')), '');
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF p_partner_id IS NULL OR NOT EXISTS (SELECT 1 FROM partners WHERE id = p_partner_id) THEN
    RAISE EXCEPTION 'PARTNER_NOT_FOUND: %', p_partner_id;
  END IF;
  IF p_notified IS NULL THEN RAISE EXCEPTION 'NOTIFIED_REQUIRED'; END IF;
  IF p_expected_notified IS NULL THEN RAISE EXCEPTION 'EXPECTED_NOTIFIED_REQUIRED'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN RAISE EXCEPTION 'NOTE_TOO_LONG'; END IF;
  IF p_notified THEN
    IF v_channel IS NULL THEN RAISE EXCEPTION 'CHANNEL_REQUIRED'; END IF;
    IF v_channel NOT IN ('whatsapp', 'llamada', 'en_persona') THEN
      RAISE EXCEPTION 'INVALID_CHANNEL: %', v_channel;
    END IF;
  ELSE
    v_channel := NULL;
  END IF;

  -- Serializa dos operadores sobre el mismo partner. Advisory lock de
  -- TRANSACCIÓN: sin aviso no hay fila previa que tomar con FOR UPDATE.
  PERFORM pg_advisory_xact_lock(hashtext('ops.partner_free_plan_notice'), hashtext(p_partner_id::text));

  SELECT to_jsonb(n) INTO v_before
    FROM ops.partner_free_plan_notice n
   WHERE n.partner_id = p_partner_id
     FOR UPDATE;
  v_current := v_before IS NOT NULL;

  IF v_current <> p_expected_notified THEN
    RAISE EXCEPTION 'FREE_PLAN_NOTICE_CHANGED: %', v_current;
  END IF;

  IF p_notified = v_current THEN
    RETURN jsonb_build_object('partner_id', p_partner_id, 'notified', v_current, 'changed', false);
  END IF;

  IF p_notified THEN
    INSERT INTO ops.partner_free_plan_notice (partner_id, channel, note, notified_by, notified_at)
    VALUES (p_partner_id, v_channel, v_note, p_actor_id, now());
  ELSE
    DELETE FROM ops.partner_free_plan_notice WHERE partner_id = p_partner_id;
  END IF;

  INSERT INTO ops.partner_free_plan_notice_log
    (partner_id, before_notified, after_notified, channel, note, actor_id)
  VALUES (p_partner_id, v_current, p_notified, v_channel, v_note, p_actor_id);

  v_after := ops._partner_free_plan_notice_json(p_partner_id);
  PERFORM ops.log_action(
    p_actor_id, 'partner.set_free_plan_notice', 'public.partners', p_partner_id,
    v_before, v_after, CASE WHEN p_notified THEN NULL ELSE v_note END
  );

  RETURN jsonb_build_object('partner_id', p_partner_id, 'notified', p_notified, 'changed', true);
END;
$$;
