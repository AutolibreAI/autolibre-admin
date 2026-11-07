-- Suite de la 027 (taller de cabecera). Todo adentro de BEGIN … ROLLBACK.
-- Crea su propio partner, código, usuarios y canjes; no toca filas reales.
-- Requiere las tablas del backend (0126 y 0144) y `ops.excluded_email_domains`.

BEGIN;

DO $$
DECLARE
  v_partner uuid := gen_random_uuid();
  v_code    uuid := gen_random_uuid();
  v_code2   uuid := gen_random_uuid();
  u1 uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  u3 uuid := gen_random_uuid();
  u_int uuid := gen_random_uuid();
  r record;
  n int;
BEGIN
  INSERT INTO ops.excluded_email_domains (domain, note)
  VALUES ('test-027.internal', 'suite 027') ON CONFLICT DO NOTHING;

  INSERT INTO partners (id, name, coverage_zone, status, tier)
  VALUES (v_partner, 'Taller 027', 'Test', 'active', 'standard');

  INSERT INTO users (id, email, role, auth_provider, external_auth_id) VALUES
    (u1, 'a@test-027.example', 'user', 'clerk', 'c027-1'),
    (u2, 'b@test-027.example', 'user', 'clerk', 'c027-2'),
    (u3, 'c@test-027.example', 'user', 'clerk', 'c027-3'),
    (u_int, 'z@test-027.internal', 'user', 'clerk', 'c027-4');

  INSERT INTO partner_referral_codes (id, code, partner_id, label) VALUES
    (v_code, 'T027AAAA', v_partner, 'flyer'),
    (v_code2, 'T027BBBB', v_partner, 'sin canjes');

  -- u1 vigente, u2 desvinculado, u3 vigente, interno vigente (no cuenta).
  INSERT INTO preferred_partners (user_id, partner_id, referral_code_id, created_at, removed_at) VALUES
    (u1, v_partner, v_code, '2026-11-02 12:00-03', NULL),
    (u2, v_partner, v_code, '2026-11-03 12:00-03', '2026-11-05 12:00-03'),
    (u3, v_partner, v_code, '2026-11-04 23:30-03', NULL),
    (u_int, v_partner, v_code, '2026-11-04 12:00-03', NULL);

  -- 01: sin el conjunto de activos, active_current es NULL (no se midió).
  SELECT * INTO r FROM ops.partner_referral_summary() s WHERE s.referral_code_id = v_code;
  IF r.links_total <> 3 THEN RAISE EXCEPTION '01 links_total=%', r.links_total; END IF;
  IF r.links_removed <> 1 THEN RAISE EXCEPTION '01 links_removed=%', r.links_removed; END IF;
  IF r.users_current <> 2 THEN RAISE EXCEPTION '01 users_current=%', r.users_current; END IF;
  IF r.active_current IS NOT NULL THEN RAISE EXCEPTION '01 active_current no es NULL'; END IF;
  IF r.first_link_on <> '2026-11-02' THEN RAISE EXCEPTION '01 first=%', r.first_link_on; END IF;
  -- 23:30 de Buenos Aires sigue siendo el 04 (en UTC sería el 05).
  IF r.last_link_on <> '2026-11-04' THEN RAISE EXCEPTION '01 last=%', r.last_link_on; END IF;
  IF r.partner_claimed THEN RAISE EXCEPTION '01 partner_claimed'; END IF;

  -- 02: con el conjunto, cuenta sólo los vigentes que están en él.
  SELECT * INTO r FROM ops.partner_referral_summary(ARRAY[u1, u2]) s WHERE s.referral_code_id = v_code;
  IF r.active_current <> 1 THEN RAISE EXCEPTION '02 active_current=%', r.active_current; END IF;

  -- 03: un código sin canjes aparece en cero.
  SELECT * INTO r FROM ops.partner_referral_summary() s WHERE s.referral_code_id = v_code2;
  IF r.links_total <> 0 OR r.users_current <> 0 THEN RAISE EXCEPTION '03 sin canjes no da cero'; END IF;

  -- 04: serie semanal: 3 altas reales (sin el interno) y 1 baja.
  SELECT sum(links), sum(removals) INTO r FROM ops.partner_referral_links_series('week') s WHERE s.partner_id = v_partner;
  IF r.sum <> 3 THEN RAISE EXCEPTION '04 altas=%', r.sum; END IF;

  -- 05: unidad inválida.
  BEGIN
    PERFORM ops.partner_referral_links_series('day');
    RAISE EXCEPTION '05 aceptó day';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'INVALID_UNIT%' THEN RAISE; END IF;
  END;

  -- 06: mensual, bucket = día 1 del mes.
  SELECT count(*) INTO n FROM ops.partner_referral_links_series('month') s
   WHERE s.partner_id = v_partner AND s.bucket = '2026-11-01';
  IF n <> 1 THEN RAISE EXCEPTION '06 bucket mensual'; END IF;

  RAISE NOTICE '027: 6/6 ok';
END $$;

ROLLBACK;
