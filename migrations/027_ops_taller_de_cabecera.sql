-- ═══════════════════════════════════════════════════════════════════════════
-- 027 — Cuánto aporta cada taller de cabecera (Partners › Taller de cabecera).
--
-- Para qué: medir cuántas personas (y autos) trae cada proveedor que reparte
-- un código de referido (Ser May y los que vengan). Sólo lectura.
--
-- ── QUÉ TABLAS SON, RELEVADO EL 2026-11-06 ────────────────────────────────
--
-- El pedido decía "cruzar `partner_referral_codes` con `partner_claim_codes`
-- para contar cuántos reclamaron cada código". Leyendo el esquema real (y el
-- backend, `partner-referral-codes.schema.ts` / `preferred-partners.schema.ts`)
-- el canje de un código de referido NO está en `partner_claim_codes`:
--
--   * `partner_referral_codes` (backend 0126) — la OFERTA: el código que un
--     partner reparte en un flyer o un QR. `status` active | disabled.
--   * `preferred_partners` — el CANJE: una persona que cargó ese código y tiene
--     al partner como taller de cabecera. `referral_code_id` NOT NULL (la
--     atribución), `removed_at` = se desvinculó (baja lógica; re-canjear crea
--     otra fila).
--   * `partner_claim_codes` (0144) es OTRA cosa: el código de un solo uso con
--     el que el DUEÑO reclama el taller en la app (`.claude/rules/
--     partner-members.md`). No tiene relación con los códigos de referido.
--
-- Así que el conteo de "cuántos lo canjearon" sale de `preferred_partners`, y
-- de `partner_claim_codes` sólo se trae si el taller ya fue RECLAMADO por su
-- dueño (un código canjeado), que es un dato útil al lado pero distinto.
--
-- ── QUÉ CUENTA ────────────────────────────────────────────────────────────
--
--   * Sin cuentas internas: dominio del email en `ops.excluded_email_domains`,
--     el MISMO predicado que `INTERNAL_PREDICATE` de `ops.repo.ts` y
--     `ops.v_ai_usage`.
--   * `links_total`: canjes de siempre (vigentes + desvinculados).
--   * `users_current`: personas distintas con el vínculo VIGENTE.
--   * `vehicles_current`: autos NO archivados de esas personas. Es "autos de
--     quien tiene este taller de cabecera", no "autos atendidos ahí".
--   * `active_current`: de `users_current`, cuántas están en
--     `p_active_user_ids`. La definición de "activo" NO vive acá: es la de
--     Métricas (las ramas del feed de `/actividad` + el refresh del token push,
--     `activity-feed.repo.ts`), que es TS. El panel arma ese conjunto y lo
--     pasa; sin él, `active_current` sale NULL ("no se midió"), nunca 0.
--   * Nunca devuelve ids de personas: sólo conteos.
--   * Fechas en hora de Buenos Aires.
--
-- ── POR QUÉ `plpgsql` ─────────────────────────────────────────────────────
--
-- Mismo motivo que la 025: resuelve las tablas de `public` recién al
-- ejecutar, así que se aplica en una base sin la 0126 del backend (el
-- `vercel-build` no se cae) y no deja dependencias en `pg_depend` que frenen
-- una migración de Drizzle. Sin las tablas, tira
-- `PARTNER_REFERRALS_UNAVAILABLE` con lo que falta.
--
-- Guardrails que aplican a una función de lectura (los de la 025): vive en
-- `migrations/`, SECURITY INVOKER, `search_path` fijo. No escribe nada.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION ops._partner_referrals_assert_available()
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(rel) INTO v_missing
    FROM (VALUES
      ('public.partner_referral_codes'),
      ('public.preferred_partners'),
      ('public.partner_claim_codes'),
      ('public.partners'),
      ('public.users'),
      ('public.vehicles')
    ) AS t(rel)
   WHERE to_regclass(rel) IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'PARTNER_REFERRALS_UNAVAILABLE: %', array_to_string(v_missing, ', ')
      USING HINT = 'Faltan migraciones del backend (0126 referidos, 0144 códigos de reclamo).';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION ops.partner_referral_summary(p_active_user_ids uuid[] DEFAULT NULL)
RETURNS TABLE (
  referral_code_id uuid,
  code             text,
  code_label       text,
  code_status      text,
  code_created_on  date,
  partner_id       uuid,
  partner_name     text,
  partner_status   text,
  partner_tier     text,
  partner_claimed  boolean,
  links_total      int,
  links_removed    int,
  users_current    int,
  vehicles_current int,
  active_current   int,
  first_link_on    date,
  last_link_on     date
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, ops
AS $$
#variable_conflict use_column
BEGIN
  PERFORM ops._partner_referrals_assert_available();

  RETURN QUERY
  WITH links AS (
    SELECT pp.referral_code_id AS l_code_id,
           pp.user_id          AS l_user_id,
           pp.created_at       AS l_created_at,
           pp.removed_at       AS l_removed_at
      FROM public.preferred_partners pp
      JOIN public.users u ON u.id = pp.user_id
     WHERE NOT coalesce(
             split_part(lower(u.email), '@', 2) IN (SELECT d.domain FROM ops.excluded_email_domains d),
             false)
  ),
  current_users AS (
    SELECT DISTINCT l.l_code_id AS c_code_id, l.l_user_id AS c_user_id
      FROM links l
     WHERE l.l_removed_at IS NULL
  ),
  per_code AS (
    SELECT l.l_code_id                                       AS g_code_id,
           count(*)                                          AS g_total,
           count(*) FILTER (WHERE l.l_removed_at IS NOT NULL) AS g_removed,
           min(l.l_created_at)                               AS g_first,
           max(l.l_created_at)                               AS g_last
      FROM links l
     GROUP BY 1
  ),
  per_code_current AS (
    SELECT cu.c_code_id                                       AS h_code_id,
           count(*)                                           AS h_users,
           count(*) FILTER (WHERE cu.c_user_id = ANY (p_active_user_ids)) AS h_active,
           sum((SELECT count(*) FROM public.vehicles v
                 WHERE v.user_id = cu.c_user_id AND NOT v.archived))       AS h_vehicles
      FROM current_users cu
     GROUP BY 1
  )
  SELECT rc.id,
         rc.code,
         rc.label,
         rc.status::text,
         (rc.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
         rc.partner_id,
         pa.name,
         pa.status::text,
         pa.tier::text,
         EXISTS (SELECT 1 FROM public.partner_claim_codes cc
                  WHERE cc.partner_id = rc.partner_id AND cc.redeemed_at IS NOT NULL),
         coalesce(pc.g_total, 0)::int,
         coalesce(pc.g_removed, 0)::int,
         coalesce(cur.h_users, 0)::int,
         coalesce(cur.h_vehicles, 0)::int,
         CASE WHEN p_active_user_ids IS NULL THEN NULL ELSE coalesce(cur.h_active, 0)::int END,
         (pc.g_first AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
         (pc.g_last  AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
    FROM public.partner_referral_codes rc
    JOIN public.partners pa ON pa.id = rc.partner_id
    LEFT JOIN per_code pc ON pc.g_code_id = rc.id
    LEFT JOIN per_code_current cur ON cur.h_code_id = rc.id
   ORDER BY coalesce(cur.h_users, 0) DESC, coalesce(pc.g_total, 0) DESC, pa.name, rc.code;
END;
$$;

-- Altas (canjes) y bajas (desvinculaciones) por semana o mes, por partner.
-- `bucket` = el lunes de la semana o el día 1 del mes, `YYYY-MM-DD`, en hora
-- de Buenos Aires (mismo patrón que `growthSeries` de Métricas: se trunca la
-- hora de PARED y se formatea sin volver a pasar por timestamptz).
CREATE OR REPLACE FUNCTION ops.partner_referral_links_series(p_unit text)
RETURNS TABLE (
  bucket     text,
  partner_id uuid,
  links      int,
  removals   int
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, ops
AS $$
#variable_conflict use_column
BEGIN
  IF p_unit IS NULL OR p_unit NOT IN ('week', 'month') THEN
    RAISE EXCEPTION 'INVALID_UNIT: %', p_unit USING HINT = 'week | month';
  END IF;
  PERFORM ops._partner_referrals_assert_available();

  RETURN QUERY
  WITH links AS (
    SELECT pp.partner_id AS l_partner_id, pp.created_at AS l_created_at, pp.removed_at AS l_removed_at
      FROM public.preferred_partners pp
      JOIN public.users u ON u.id = pp.user_id
     WHERE NOT coalesce(
             split_part(lower(u.email), '@', 2) IN (SELECT d.domain FROM ops.excluded_email_domains d),
             false)
  ),
  events AS (
    SELECT l.l_partner_id AS e_partner_id,
           date_trunc(p_unit, l.l_created_at AT TIME ZONE 'America/Argentina/Buenos_Aires') AS e_bucket,
           1 AS e_link, 0 AS e_removal
      FROM links l
    UNION ALL
    SELECT l.l_partner_id,
           date_trunc(p_unit, l.l_removed_at AT TIME ZONE 'America/Argentina/Buenos_Aires'),
           0, 1
      FROM links l
     WHERE l.l_removed_at IS NOT NULL
  )
  SELECT to_char(e.e_bucket, 'YYYY-MM-DD'),
         e.e_partner_id,
         sum(e.e_link)::int,
         sum(e.e_removal)::int
    FROM events e
   GROUP BY e.e_bucket, e.e_partner_id
   ORDER BY e.e_bucket, e.e_partner_id;
END;
$$;
