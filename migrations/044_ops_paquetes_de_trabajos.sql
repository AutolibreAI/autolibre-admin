-- ═══════════════════════════════════════════════════════════════════════════
-- 044 — Paquetes de trabajos: el proveedor paga por adelantado N trabajos.
--
-- Modelo de cobro desde el 2026-11-26 (Nicolás): sin suscripciones ni tope de
-- respuestas; se cobra por trabajo confirmado, el primero de cada proveedor es
-- gratis, y un proveedor puede comprar un paquete (por defecto 5 trabajos, 90
-- días, precio reducido). Por ahora se carga a mano desde el panel.
--
-- ── QUÉ DECIDE EL PANEL Y QUÉ GUARDA ESTA MIGRACIÓN ──────────────────────
--
-- La regla (gratis → paquete que vence primero → fee) la aplica el panel
-- (`~/lib/partner-fees`, `~/lib/partner-packages`). Acá se guarda:
--
--   * `ops.partner_job_package`: el paquete. Nunca se borra: se ANULA con
--     motivo. `expires_on` = compra + vigencia (columna generada).
--   * `ops.partner_job_package_allocation`: la imputación trabajo → paquete.
--     Se DESHACE con motivo (`undone_*`), nunca se borra: queda el historial.
--     A lo sumo una imputación activa por trabajo (índice único parcial).
--     Una fila deshecha (y no reabierta) sin una activa dice «este trabajo NO
--     va a paquete»: el panel no lo vuelve a imputar solo.
--
-- Los SP validan representabilidad (existe, no anulado, saldo, trabajo libre),
-- no la regla de fechas: si el día del trabajo cae en la vigencia lo decide el
-- panel antes de llamar, con los datos del pedido.
--
-- `ops`, sin FK a `public` (guardrail 6): partner y pedido por UUID pelado,
-- validados con EXISTS. Log en `ops.action_log` (guardrail 5).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ops.partner_job_package (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id      uuid          NOT NULL,
  jobs            integer       NOT NULL,
  validity_days   integer       NOT NULL,
  purchased_on    date          NOT NULL,
  expires_on      date          GENERATED ALWAYS AS (purchased_on + validity_days) STORED,
  price_paid      numeric(12,2) NOT NULL,
  payment_method  text          NOT NULL,
  note            text,
  created_by      uuid          NOT NULL,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  voided_at       timestamptz,
  voided_by       uuid,
  void_reason     text,

  CONSTRAINT chk_ops_pjp_jobs CHECK (jobs BETWEEN 1 AND 100),
  CONSTRAINT chk_ops_pjp_validity CHECK (validity_days BETWEEN 1 AND 3650),
  CONSTRAINT chk_ops_pjp_price CHECK (price_paid >= 0 AND price_paid < 10000000000),
  CONSTRAINT chk_ops_pjp_method CHECK (payment_method IN ('mercado_pago', 'transferencia', 'efectivo')),
  CONSTRAINT chk_ops_pjp_note CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 1000)),
  CONSTRAINT chk_ops_pjp_void CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND btrim(void_reason) <> '' AND length(void_reason) <= 1000)
  )
);

CREATE INDEX IF NOT EXISTS idx_ops_pjp_partner ON ops.partner_job_package (partner_id, expires_on);

CREATE TABLE IF NOT EXISTS ops.partner_job_package_allocation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_request_id  uuid        NOT NULL,
  package_id        uuid        NOT NULL REFERENCES ops.partner_job_package (id),
  created_by        uuid        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  undone_at         timestamptz,
  undone_by         uuid,
  undo_reason       text,
  -- «Volver a imputar automático»: levanta la marca de una deshecha.
  reopened_at       timestamptz,
  reopened_by       uuid,

  CONSTRAINT chk_ops_pjpa_reopen CHECK (
    (reopened_at IS NULL AND reopened_by IS NULL)
    OR (reopened_at IS NOT NULL AND reopened_by IS NOT NULL AND undone_at IS NOT NULL)
  ),
  CONSTRAINT chk_ops_pjpa_undo CHECK (
    (undone_at IS NULL AND undone_by IS NULL AND undo_reason IS NULL)
    OR (undone_at IS NOT NULL AND undone_by IS NOT NULL AND btrim(undo_reason) <> '' AND length(undo_reason) <= 1000)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_pjpa_active_job
  ON ops.partner_job_package_allocation (quote_request_id) WHERE undone_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ops_pjpa_package
  ON ops.partner_job_package_allocation (package_id) WHERE undone_at IS NULL;

-- ── Cargar un paquete ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ops.create_partner_job_package(
  p_partner_id     uuid,
  p_jobs           integer,
  p_validity_days  integer,
  p_purchased_on   date,
  p_price_paid     numeric,
  p_payment_method text,
  p_note           text,
  p_actor_id       uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_id    uuid;
  v_after jsonb;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  IF p_partner_id IS NULL OR NOT EXISTS (SELECT 1 FROM partners WHERE id = p_partner_id) THEN
    RAISE EXCEPTION 'PARTNER_NOT_FOUND: %', p_partner_id;
  END IF;
  IF p_jobs IS NULL OR p_jobs < 1 OR p_jobs > 100 THEN RAISE EXCEPTION 'INVALID_PACKAGE_JOBS: %', p_jobs; END IF;
  IF p_validity_days IS NULL OR p_validity_days < 1 OR p_validity_days > 3650 THEN
    RAISE EXCEPTION 'INVALID_PACKAGE_VALIDITY: %', p_validity_days;
  END IF;
  IF p_purchased_on IS NULL THEN RAISE EXCEPTION 'PACKAGE_PURCHASED_ON_REQUIRED'; END IF;
  IF p_purchased_on > (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date THEN
    RAISE EXCEPTION 'PACKAGE_PURCHASED_ON_IN_FUTURE';
  END IF;
  IF p_price_paid IS NULL OR p_price_paid < 0 THEN RAISE EXCEPTION 'INVALID_PACKAGE_PRICE'; END IF;
  IF p_price_paid >= 10000000000 THEN RAISE EXCEPTION 'PACKAGE_PRICE_TOO_LARGE'; END IF;
  IF p_payment_method IS NULL OR p_payment_method NOT IN ('mercado_pago', 'transferencia', 'efectivo') THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_METHOD: %', p_payment_method;
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN RAISE EXCEPTION 'PACKAGE_NOTE_TOO_LONG'; END IF;

  INSERT INTO ops.partner_job_package (partner_id, jobs, validity_days, purchased_on, price_paid, payment_method, note, created_by)
  VALUES (p_partner_id, p_jobs, p_validity_days, p_purchased_on, p_price_paid, p_payment_method, v_note, p_actor_id)
  RETURNING id INTO v_id;

  SELECT to_jsonb(k) INTO v_after FROM ops.partner_job_package k WHERE k.id = v_id;
  PERFORM ops.log_action(p_actor_id, 'partner_job_package.create', 'public.partners', p_partner_id,
                         NULL, v_after, NULL);
  RETURN v_after;
END;
$$;

-- ── Anular un paquete (nunca se borra) ──────────────────────────────────────

CREATE OR REPLACE FUNCTION ops.void_partner_job_package(
  p_package_id uuid,
  p_reason     text,
  p_actor_id   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  SELECT to_jsonb(k) INTO v_before FROM ops.partner_job_package k WHERE k.id = p_package_id FOR UPDATE;
  IF v_before IS NULL THEN RAISE EXCEPTION 'PACKAGE_NOT_FOUND: %', p_package_id; END IF;
  IF v_before->>'voided_at' IS NOT NULL THEN RETURN v_before; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'PACKAGE_VOID_REASON_REQUIRED'; END IF;
  IF length(v_reason) > 1000 THEN RAISE EXCEPTION 'PACKAGE_NOTE_TOO_LONG'; END IF;
  IF EXISTS (SELECT 1 FROM ops.partner_job_package_allocation a
              WHERE a.package_id = p_package_id AND a.undone_at IS NULL) THEN
    RAISE EXCEPTION 'PACKAGE_HAS_ALLOCATIONS: %', p_package_id;
  END IF;

  UPDATE ops.partner_job_package
     SET voided_at = now(), voided_by = p_actor_id, void_reason = v_reason
   WHERE id = p_package_id;

  SELECT to_jsonb(k) INTO v_after FROM ops.partner_job_package k WHERE k.id = p_package_id;
  PERFORM ops.log_action(p_actor_id, 'partner_job_package.void', 'public.partners',
                         (v_before->>'partner_id')::uuid, v_before, v_after, v_reason);
  RETURN v_after;
END;
$$;

-- ── Imputar un trabajo a un paquete ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION ops.allocate_job_to_package(
  p_quote_request_id uuid,
  p_package_id       uuid,
  p_actor_id         uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_pkg    ops.partner_job_package%ROWTYPE;
  v_active ops.partner_job_package_allocation%ROWTYPE;
  v_used   integer;
  v_after  jsonb;
  v_id     uuid;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  IF p_quote_request_id IS NULL OR NOT EXISTS (SELECT 1 FROM quote_requests WHERE id = p_quote_request_id) THEN
    RAISE EXCEPTION 'QUOTE_REQUEST_NOT_FOUND: %', p_quote_request_id;
  END IF;

  -- El paquete primero (serializa dos imputaciones al mismo paquete).
  SELECT * INTO v_pkg FROM ops.partner_job_package WHERE id = p_package_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PACKAGE_NOT_FOUND: %', p_package_id; END IF;
  IF v_pkg.voided_at IS NOT NULL THEN RAISE EXCEPTION 'PACKAGE_VOIDED: %', p_package_id; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ops.package_allocation'), hashtext(p_quote_request_id::text));
  SELECT * INTO v_active FROM ops.partner_job_package_allocation
   WHERE quote_request_id = p_quote_request_id AND undone_at IS NULL;
  IF FOUND THEN
    IF v_active.package_id = p_package_id THEN RETURN to_jsonb(v_active); END IF;
    RAISE EXCEPTION 'JOB_ALREADY_ALLOCATED: %', p_quote_request_id;
  END IF;

  SELECT count(*) INTO v_used FROM ops.partner_job_package_allocation
   WHERE package_id = p_package_id AND undone_at IS NULL;
  IF v_used >= v_pkg.jobs THEN RAISE EXCEPTION 'PACKAGE_EXHAUSTED: %', p_package_id; END IF;

  INSERT INTO ops.partner_job_package_allocation (quote_request_id, package_id, created_by)
  VALUES (p_quote_request_id, p_package_id, p_actor_id)
  RETURNING id INTO v_id;

  SELECT to_jsonb(a) INTO v_after FROM ops.partner_job_package_allocation a WHERE a.id = v_id;
  PERFORM ops.log_action(p_actor_id, 'partner_job_package.allocate', 'public.quote_requests', p_quote_request_id,
                         NULL, v_after, NULL);
  RETURN v_after;
END;
$$;

-- ── Deshacer (o rechazar) una imputación, con motivo ───────────────────────
--
-- Con una imputación activa: la marca deshecha. Sin una activa (el panel la
-- había propuesto y nunca se guardó): deja una fila ya deshecha a ese paquete,
-- que dice «este trabajo no va a paquete».

CREATE OR REPLACE FUNCTION ops.undo_job_package_allocation(
  p_quote_request_id uuid,
  p_package_id       uuid,
  p_reason           text,
  p_actor_id         uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_before jsonb;
  v_after  jsonb;
  v_id     uuid;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  IF v_reason IS NULL THEN RAISE EXCEPTION 'ALLOCATION_UNDO_REASON_REQUIRED'; END IF;
  IF length(v_reason) > 1000 THEN RAISE EXCEPTION 'PACKAGE_NOTE_TOO_LONG'; END IF;
  IF p_quote_request_id IS NULL OR NOT EXISTS (SELECT 1 FROM quote_requests WHERE id = p_quote_request_id) THEN
    RAISE EXCEPTION 'QUOTE_REQUEST_NOT_FOUND: %', p_quote_request_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ops.package_allocation'), hashtext(p_quote_request_id::text));
  SELECT to_jsonb(a), a.id INTO v_before, v_id FROM ops.partner_job_package_allocation a
   WHERE a.quote_request_id = p_quote_request_id AND a.undone_at IS NULL FOR UPDATE;

  IF v_id IS NOT NULL THEN
    UPDATE ops.partner_job_package_allocation
       SET undone_at = now(), undone_by = p_actor_id, undo_reason = v_reason
     WHERE id = v_id;
  ELSE
    IF p_package_id IS NULL OR NOT EXISTS (SELECT 1 FROM ops.partner_job_package WHERE id = p_package_id) THEN
      RAISE EXCEPTION 'PACKAGE_NOT_FOUND: %', p_package_id;
    END IF;
    INSERT INTO ops.partner_job_package_allocation
      (quote_request_id, package_id, created_by, undone_at, undone_by, undo_reason)
    VALUES (p_quote_request_id, p_package_id, p_actor_id, now(), p_actor_id, v_reason)
    RETURNING id INTO v_id;
  END IF;

  SELECT to_jsonb(a) INTO v_after FROM ops.partner_job_package_allocation a WHERE a.id = v_id;
  PERFORM ops.log_action(p_actor_id, 'partner_job_package.undo_allocation', 'public.quote_requests',
                         p_quote_request_id, v_before, v_after, v_reason);
  RETURN v_after;
END;
$$;

-- ── Volver a permitir la imputación automática ─────────────────────────────
--
-- Un trabajo con una imputación deshecha (y no reabierta) queda fuera de la
-- regla automática. Si fue un error, se reabre: `reopened_*` en las deshechas.
-- No se borra nada.

CREATE OR REPLACE FUNCTION ops.reopen_job_package_allocation(
  p_quote_request_id uuid,
  p_actor_id         uuid
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_n      integer;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  PERFORM pg_advisory_xact_lock(hashtext('ops.package_allocation'), hashtext(p_quote_request_id::text));
  IF EXISTS (SELECT 1 FROM ops.partner_job_package_allocation
              WHERE quote_request_id = p_quote_request_id AND undone_at IS NULL) THEN
    RETURN 0;
  END IF;
  SELECT jsonb_agg(to_jsonb(a)) INTO v_before FROM ops.partner_job_package_allocation a
   WHERE a.quote_request_id = p_quote_request_id;
  UPDATE ops.partner_job_package_allocation
     SET reopened_at = now(), reopened_by = p_actor_id
   WHERE quote_request_id = p_quote_request_id AND undone_at IS NOT NULL AND reopened_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    PERFORM ops.log_action(p_actor_id, 'partner_job_package.reopen', 'public.quote_requests',
                           p_quote_request_id, v_before, NULL, NULL);
  END IF;
  RETURN v_n;
END;
$$;

-- ── Corregir el precio pagado de un paquete ────────────────────────────────
--
-- Cada paquete se vende al precio que se pacte con ese proveedor: el de
-- referencia de la config es sólo el default del formulario. Corregirlo
-- después (se cargó mal, hubo un ajuste) queda en el log con el antes y el
-- motivo. Un anulado no se corrige.

CREATE OR REPLACE FUNCTION ops.set_partner_job_package_price(
  p_package_id uuid,
  p_price_paid numeric,
  p_reason     text,
  p_actor_id   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  SELECT to_jsonb(k) INTO v_before FROM ops.partner_job_package k WHERE k.id = p_package_id FOR UPDATE;
  IF v_before IS NULL THEN RAISE EXCEPTION 'PACKAGE_NOT_FOUND: %', p_package_id; END IF;
  IF v_before->>'voided_at' IS NOT NULL THEN RAISE EXCEPTION 'PACKAGE_VOIDED: %', p_package_id; END IF;
  IF p_price_paid IS NULL OR p_price_paid < 0 THEN RAISE EXCEPTION 'INVALID_PACKAGE_PRICE'; END IF;
  IF p_price_paid >= 10000000000 THEN RAISE EXCEPTION 'PACKAGE_PRICE_TOO_LARGE'; END IF;
  IF v_reason IS NOT NULL AND length(v_reason) > 1000 THEN RAISE EXCEPTION 'PACKAGE_NOTE_TOO_LONG'; END IF;
  IF (v_before->>'price_paid')::numeric = p_price_paid THEN RETURN v_before; END IF;

  UPDATE ops.partner_job_package SET price_paid = p_price_paid WHERE id = p_package_id;
  SELECT to_jsonb(k) INTO v_after FROM ops.partner_job_package k WHERE k.id = p_package_id;
  PERFORM ops.log_action(p_actor_id, 'partner_job_package.set_price', 'public.partners',
                         (v_before->>'partner_id')::uuid, v_before, v_after, v_reason);
  RETURN v_after;
END;
$$;
