-- ═══════════════════════════════════════════════════════════════════════════
-- 013 — Clasificar el rubro de un pedido de presupuesto, para poder derivarlo.
--
-- `.claude/plans/partners-derivacion.md` (Fase 2) agrega un panel de
-- candidatos en `/leads/pedidos/:id`: dado un pedido, qué partners activos
-- cubren el rubro que ese pedido necesita, ordenados por cercanía. Para poder
-- filtrar "partners que cubren ESTE rubro" hace falta saber cuál es el rubro
-- del pedido — y `quote_requests` no lo tiene: es texto libre
-- (`description`), no un slug de `service_categories`.
--
-- ── POR QUÉ SE GUARDA, Y POR QUÉ SÓLO ESTO ─────────────────────────────────
--
-- El plan tomó dos decisiones a propósito asimétricas (ver el plan, §2):
--
--   - La CLASIFICACIÓN (qué rubro era el pedido) se guarda como DATO, acá.
--     Habilita "¿qué rubros nos piden más?" con un `group by`.
--   - La DERIVACIÓN (a qué taller se lo mandó) se registra como NOTA INTERNA
--     de `quote_requests` (vía `ops.add_quote_request_internal_note`, 011),
--     no como una fila nueva. NO habilita "¿cuánto le mandamos a cada
--     taller?" con una consulta — esa respuesta queda en texto libre, y
--     recuperarla parseando notas sería inventar dominio (`leads.md`: "si
--     alguien arma 'ofertas' parseando las notas, está inventando dominio").
--     Si esa pregunta se vuelve importante, el arreglo es una tabla
--     `ops.quote_request_referrals` con su propio SP — no un parser.
--
-- ── POR QUÉ ACÁ Y NO EN `quote_requests.category_slug` ─────────────────────
--
-- `quote_requests` es del backend (bounded context `quotes/`), y este repo no
-- migra `public`. La clasificación es dato de OPERACIÓN del panel —nadie de
-- la app la lee, el backend no la necesita para nada— así que vive en `ops`,
-- mismo criterio que `ops.excluded_email_domains` o los precios de IA.
--
-- ── LOS 8 GUARDRAILS, CON LA MISMA SALVEDAD QUE LA 012 ─────────────────────
--
--   1. Vive en `migrations/`, nunca DDL a mano.
--   2. SECURITY INVOKER (el default).
--   3. `SET search_path` fijo.
--   4. `p_actor_id` sale de la sesión de Clerk, JAMÁS del payload.
--   5. Escribe `ops.action_log` DENTRO de la función, con `before`/`after`
--      completos (`before` es NULL la primera vez que se clasifica un
--      pedido — no había fila).
--   6. Ninguna FK cruza a `public`: `quote_request_id` es un UUID pelado, sin
--      constraint hacia `quote_requests`. `category_slug`/`service_slug` son
--      TEXTO, no un id de `service_categories`/`services` — tampoco hay FK
--      ahí, la representabilidad se valida en el CUERPO de la función.
--   7. **`SELECT … FOR UPDATE` no aplica en el ALTA**, igual que en la 012:
--      es un UPSERT sobre una tabla PROPIA de `ops`, no la edición de una
--      fila existente de `public`. En el camino de ACTUALIZAR una
--      clasificación previa sí se lockea la fila de `ops` antes del upsert
--      (ver el `SELECT … FOR UPDATE` antes del `INSERT … ON CONFLICT`).
--   8. `updated_at` sólo lo mueve el `ON CONFLICT DO UPDATE` de abajo, nunca
--      un trigger aparte — no hay trigger de `updated_at` en `ops` para esta
--      tabla, así que no hay duplicación que pueda divergir.
--
-- ── LOS PARÁMETROS SON `text`, NO EL ENUM ───────────────────────────────────
--
-- Mismo motivo que la 011: la función tiene que poder crearse en una base
-- donde `quote_requests` no exista todavía. El cast/validación contra
-- `service_categories`/`services` va en el CUERPO, a sentinela.
--
-- ── LO QUE ESTO NO DECIDE ────────────────────────────────────────────────────
--
-- La función NO valida que el rubro elegido tenga sentido para la
-- `description` del pedido — eso es juicio del operador, no una regla que la
-- base pueda verificar. Sólo valida REPRESENTABILIDAD: que `category_slug`
-- sea una categoría activa, y que `service_slug` (si se manda) sea un
-- servicio activo QUE CUELGUE de esa misma categoría — un servicio de otro
-- rubro ahí sería un dato contradictorio, no una opinión.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ops.quote_request_rubro (
  -- UUID pelado de `public.quote_requests.id`, sin FK (guardrail 6).
  quote_request_id uuid        PRIMARY KEY,
  category_slug    text        NOT NULL,
  service_slug     text,
  actor_id         uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION ops.set_quote_request_rubro(
  p_quote_request_id uuid,
  p_category_slug    text,
  p_actor_id         uuid,
  p_service_slug     text DEFAULT NULL,
  p_note             text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before   jsonb;
  v_after    jsonb;
  v_category text;
  v_service  text;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF NOT EXISTS (SELECT 1 FROM quote_requests WHERE id = p_quote_request_id) THEN
    RAISE EXCEPTION 'QUOTE_REQUEST_NOT_FOUND: %', p_quote_request_id;
  END IF;

  SELECT sc.slug INTO v_category
    FROM service_categories sc
   WHERE sc.slug = p_category_slug AND sc.active;
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'INVALID_CATEGORY_SLUG: %', p_category_slug
      USING HINT = 'Tiene que ser un slug activo de service_categories.';
  END IF;

  IF p_service_slug IS NOT NULL AND btrim(p_service_slug) <> '' THEN
    SELECT s.slug INTO v_service
      FROM services s
      JOIN service_categories sc ON sc.id = s.category_id
     WHERE s.slug = p_service_slug AND s.active AND sc.slug = v_category;
    IF v_service IS NULL THEN
      RAISE EXCEPTION 'INVALID_SERVICE_SLUG: %', p_service_slug
        USING HINT = 'Tiene que ser un servicio activo que cuelgue de ese mismo rubro.';
    END IF;
  END IF;

  -- Si ya había una clasificación, se lockea antes de pisarla (guardrail 7,
  -- camino de actualización). Si no había ninguna, no hay nada que lockear:
  -- el `INSERT … ON CONFLICT` de abajo es atómico igual.
  SELECT to_jsonb(r) INTO v_before
    FROM ops.quote_request_rubro r
   WHERE r.quote_request_id = p_quote_request_id
     FOR UPDATE;

  INSERT INTO ops.quote_request_rubro (quote_request_id, category_slug, service_slug, actor_id)
  VALUES (p_quote_request_id, v_category, v_service, p_actor_id)
  ON CONFLICT (quote_request_id) DO UPDATE SET
    category_slug = excluded.category_slug,
    service_slug  = excluded.service_slug,
    actor_id      = excluded.actor_id,
    updated_at    = now();
    -- `created_at` NO se pisa: cuándo se clasificó por primera vez es el dato
    -- con valor, mismo criterio que `upsertExcludedDomain` en `ops.repo.ts`.

  SELECT to_jsonb(r) INTO v_after
    FROM ops.quote_request_rubro r
   WHERE r.quote_request_id = p_quote_request_id;

  PERFORM ops.log_action(
    p_actor_id, 'quote_request.set_rubro', 'ops.quote_request_rubro', p_quote_request_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;
