-- ═══════════════════════════════════════════════════════════════════════════
-- 005 — Excluir el consumo de cuentas internas.
--
-- EL PROBLEMA
--
-- Al 2026-08-27, 2.986 cuentas tienen email `@autolibre.app` y NINGUNA es una
-- persona: son todas generadas por los E2E (`lead-`, `owner-`, `cal-reject-`,
-- `reborn-`, `webhook-e2e`, `feedback-`, `marketplace-`…), sin `name` y con
-- sufijo aleatorio. Entre ellas producen 799 de los 938 eventos medidos — el
-- 85% del panel era ruido de tests.
--
-- POR QUÉ SE FILTRA POR IDENTIDAD Y NO POR NOMBRE DE MODELO
--
-- El atajo era excluir `fake-model` y `fake-diagnosis-model`, que da el MISMO
-- resultado (esos 799 eventos son exactamente los de esos dos modelos). Se
-- descartó: es una regla escrita contra strings inventados, que no significa
-- nada en producción y que el día que un modelo real se llame parecido esconde
-- gasto de verdad.
--
-- "Esta cuenta es nuestra" sigue siendo cierto en producción y no puede tapar
-- el consumo de un cliente. Es la misma exclusión, sostenida por algo real.
--
-- SE MARCA, NO SE BORRA
--
-- La vista gana una columna `internal` y son las funciones las que filtran.
-- Sacarlos de la vista habría sido más corto y es la versión equivocada: el
-- panel no podría decir cuánto está dejando afuera, y un total que oculta
-- consumo sin avisar es el modo de falla que este schema entero está diseñado
-- para no tener. Mismo criterio que `unpriced`: se excluye del total, y el
-- total viaja con el contador de lo excluido.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Qué dominio es "nuestro" ───────────────────────────────────────────────
--
-- Tabla y no constante en el SQL: sumar otro dominio interno tiene que ser un
-- INSERT, no una migración que reescriba tres vistas.
--
-- El match es sobre el dominio EXACTO (`split_part(email, '@', 2)`), no un
-- `LIKE '%autolibre.app'`. Con LIKE, un `@no-autolibre.app` entraría por la
-- ventana. Si algún día hace falta cubrir subdominios, se agrega la fila
-- `mail.autolibre.app` — explícito, no por accidente de patrón.
CREATE TABLE IF NOT EXISTS ops.excluded_email_domains (
  domain     text PRIMARY KEY,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ops.excluded_email_domains IS
  'Dominios de email cuyo consumo de IA NO cuenta como gasto del producto. '
  'Se excluye del total pero se sigue contando aparte: ver `internal_events`.';

INSERT INTO ops.excluded_email_domains (domain, note)
SELECT * FROM (VALUES
  ('autolibre.app',
   'Cuentas internas y de E2E. Al 2026-08-27: 2.986 usuarios, ninguno una persona real.')
) AS seed(domain, note)
WHERE NOT EXISTS (
  SELECT 1 FROM ops.excluded_email_domains d WHERE d.domain = seed.domain
);

-- ── La vista, ahora con `internal` ─────────────────────────────────────────
--
-- Se une `public.users` para leer el email. Sigue siendo LECTURA y sigue sin
-- haber FK: la ley del schema no cambia.
--
-- `COALESCE(..., false)` importa: un evento cuyo `user_id` es NULL (o apunta a
-- un usuario ya borrado) da `NULL IN (...)` → NULL. Sin el COALESCE ese evento
-- se caería del `WHERE NOT internal` de las funciones y desaparecería del
-- panel. Desconocido NO es interno: en la duda, el consumo CUENTA.
CREATE OR REPLACE VIEW ops.v_ai_usage AS
  SELECT
    'assistant'::text                              AS surface,
    cm.id                                          AS event_id,
    cm.model                                       AS model,
    cm.prompt_tokens                               AS input_tokens,
    cm.completion_tokens                           AS output_tokens,
    cm.sent_at                                     AS occurred_at,
    c.user_id                                      AS user_id,
    c.vehicle_id                                   AS vehicle_id,
    COALESCE(array_length(cm.rag_docs_used, 1), 0) AS rag_docs,
    COALESCE(
      split_part(lower(u.email), '@', 2) IN (SELECT d.domain FROM ops.excluded_email_domains d),
      false
    )                                              AS internal
  FROM public.conversation_messages cm
  JOIN public.conversations c ON c.id = cm.conversation_id
  LEFT JOIN public.users u    ON u.id = c.user_id
  WHERE cm.author = 'ai'
    AND cm.model IS NOT NULL
    AND cm.prompt_tokens IS NOT NULL

  UNION ALL

  SELECT
    'diagnostics'::text,
    d.id,
    d.model,
    d.prompt_tokens,
    d.completion_tokens,
    d.created_at,
    d.user_id,
    d.vehicle_id,
    COALESCE(array_length(d.rag_docs_used, 1), 0),
    COALESCE(
      split_part(lower(du.email), '@', 2) IN (SELECT x.domain FROM ops.excluded_email_domains x),
      false
    )
  FROM public.ai_diagnostics d
  LEFT JOIN public.users du ON du.id = d.user_id
  WHERE d.model IS NOT NULL
    AND d.prompt_tokens IS NOT NULL;

-- `internal` se propaga a la vista con costo. Va al final de la lista de
-- columnas porque CREATE OR REPLACE VIEW solo admite agregar columnas ahí.
CREATE OR REPLACE VIEW ops.v_ai_usage_costed AS
  SELECT
    u.surface,
    u.event_id,
    u.model,
    u.input_tokens,
    u.output_tokens,
    u.occurred_at,
    u.user_id,
    u.vehicle_id,
    u.rag_docs,
    p.provider,
    p.input_usd_per_mtok,
    p.output_usd_per_mtok,
    (u.input_tokens  / 1e6) * p.input_usd_per_mtok   AS input_usd,
    (u.output_tokens / 1e6) * p.output_usd_per_mtok  AS output_usd,
      (u.input_tokens  / 1e6) * p.input_usd_per_mtok
    + (u.output_tokens / 1e6) * p.output_usd_per_mtok AS total_usd,
    (p.id IS NULL)                                    AS unpriced,
    u.internal                                        AS internal
  FROM ops.v_ai_usage u
  LEFT JOIN ops.ai_model_pricing p
         ON p.model = u.model
        AND u.occurred_at >= p.valid_from
        AND (p.valid_to IS NULL OR u.occurred_at < p.valid_to);

-- ── Las funciones, filtrando ───────────────────────────────────────────────
--
-- Van con DROP + CREATE y no CREATE OR REPLACE: `ai_usage_summary` suma una
-- columna al RETURNS TABLE, y Postgres rechaza cambiar el tipo de retorno de
-- una función existente. Se dropean las cinco por uniformidad — que dos se
-- reemplacen de una forma y tres de otra es la clase de asimetría que después
-- nadie recuerda por qué está.

DROP FUNCTION IF EXISTS ops.ai_usage_summary(timestamptz, timestamptz, text);
DROP FUNCTION IF EXISTS ops.ai_usage_by_model(timestamptz, timestamptz, text);
DROP FUNCTION IF EXISTS ops.ai_usage_daily(timestamptz, timestamptz, text);
DROP FUNCTION IF EXISTS ops.ai_usage_by_user(timestamptz, timestamptz, text, integer);
DROP FUNCTION IF EXISTS ops.ai_surface_coverage();

/*
 * `internal_events` es la contracara de `unpriced_events`: el total de arriba
 * ya NO los incluye, y este número es la única forma de saber cuánto se sacó.
 * Mostrar el total sin él sería volver a ocultar consumo en silencio.
 */
CREATE FUNCTION ops.ai_usage_summary(
  p_from    timestamptz DEFAULT NULL,
  p_to      timestamptz DEFAULT NULL,
  p_surface text        DEFAULT NULL
)
RETURNS TABLE (
  events          bigint,
  input_tokens    bigint,
  output_tokens   bigint,
  total_usd       numeric,
  priced_events   bigint,
  unpriced_events bigint,
  models          bigint,
  users           bigint,
  first_event     timestamptz,
  last_event      timestamptz,
  internal_events bigint
)
LANGUAGE sql STABLE AS $$
  SELECT
    count(*) FILTER (WHERE NOT c.internal)::bigint,
    COALESCE(sum(c.input_tokens)  FILTER (WHERE NOT c.internal), 0)::bigint,
    COALESCE(sum(c.output_tokens) FILTER (WHERE NOT c.internal), 0)::bigint,
    sum(c.total_usd)                        FILTER (WHERE NOT c.internal),
    count(*)                                FILTER (WHERE NOT c.internal AND NOT c.unpriced)::bigint,
    count(*)                                FILTER (WHERE NOT c.internal AND c.unpriced)::bigint,
    count(DISTINCT c.model)                 FILTER (WHERE NOT c.internal)::bigint,
    count(DISTINCT c.user_id)               FILTER (WHERE NOT c.internal)::bigint,
    min(c.occurred_at)                      FILTER (WHERE NOT c.internal),
    max(c.occurred_at)                      FILTER (WHERE NOT c.internal),
    count(*)                                FILTER (WHERE c.internal)::bigint
  FROM ops.v_ai_usage_costed c
  WHERE (p_from    IS NULL OR c.occurred_at >= p_from)
    AND (p_to      IS NULL OR c.occurred_at <  p_to)
    AND (p_surface IS NULL OR c.surface      = p_surface);
$$;

CREATE FUNCTION ops.ai_usage_by_model(
  p_from    timestamptz DEFAULT NULL,
  p_to      timestamptz DEFAULT NULL,
  p_surface text        DEFAULT NULL
)
RETURNS TABLE (
  model               text,
  provider            text,
  events              bigint,
  input_tokens        bigint,
  output_tokens       bigint,
  total_usd           numeric,
  unpriced            boolean,
  input_usd_per_mtok  numeric,
  output_usd_per_mtok numeric
)
LANGUAGE sql STABLE AS $$
  SELECT
    c.model,
    max(c.provider),
    count(*)::bigint,
    COALESCE(sum(c.input_tokens), 0)::bigint,
    COALESCE(sum(c.output_tokens), 0)::bigint,
    sum(c.total_usd),
    bool_or(c.unpriced),
    max(c.input_usd_per_mtok),
    max(c.output_usd_per_mtok)
  FROM ops.v_ai_usage_costed c
  WHERE NOT c.internal
    AND (p_from    IS NULL OR c.occurred_at >= p_from)
    AND (p_to      IS NULL OR c.occurred_at <  p_to)
    AND (p_surface IS NULL OR c.surface      = p_surface)
  GROUP BY c.model
  ORDER BY sum(c.total_usd) DESC NULLS LAST, count(*) DESC;
$$;

CREATE FUNCTION ops.ai_usage_daily(
  p_from    timestamptz DEFAULT NULL,
  p_to      timestamptz DEFAULT NULL,
  p_surface text        DEFAULT NULL
)
RETURNS TABLE (
  day             date,
  events          bigint,
  input_tokens    bigint,
  output_tokens   bigint,
  total_usd       numeric,
  unpriced_events bigint
)
LANGUAGE sql STABLE AS $$
  SELECT
    (date_trunc('day', c.occurred_at AT TIME ZONE 'UTC'))::date,
    count(*)::bigint,
    COALESCE(sum(c.input_tokens), 0)::bigint,
    COALESCE(sum(c.output_tokens), 0)::bigint,
    sum(c.total_usd),
    count(*) FILTER (WHERE c.unpriced)::bigint
  FROM ops.v_ai_usage_costed c
  WHERE NOT c.internal
    AND (p_from    IS NULL OR c.occurred_at >= p_from)
    AND (p_to      IS NULL OR c.occurred_at <  p_to)
    AND (p_surface IS NULL OR c.surface      = p_surface)
  GROUP BY 1
  ORDER BY 1;
$$;

CREATE FUNCTION ops.ai_usage_by_user(
  p_from    timestamptz DEFAULT NULL,
  p_to      timestamptz DEFAULT NULL,
  p_surface text        DEFAULT NULL,
  p_limit   integer     DEFAULT 20
)
RETURNS TABLE (
  user_id       uuid,
  user_name     text,
  user_email    text,
  events        bigint,
  input_tokens  bigint,
  output_tokens bigint,
  total_usd     numeric
)
LANGUAGE sql STABLE AS $$
  SELECT
    c.user_id,
    max(u.name),
    max(u.email),
    count(*)::bigint,
    COALESCE(sum(c.input_tokens), 0)::bigint,
    COALESCE(sum(c.output_tokens), 0)::bigint,
    sum(c.total_usd)
  FROM ops.v_ai_usage_costed c
  LEFT JOIN public.users u ON u.id = c.user_id
  WHERE NOT c.internal
    AND (p_from    IS NULL OR c.occurred_at >= p_from)
    AND (p_to      IS NULL OR c.occurred_at <  p_to)
    AND (p_surface IS NULL OR c.surface      = p_surface)
  GROUP BY c.user_id
  ORDER BY sum(c.total_usd) DESC NULLS LAST, count(*) DESC
  LIMIT GREATEST(p_limit, 1);
$$;

/*
 * `measured_events` también excluye internos, para que cuadre con el resto del
 * panel: si el resumen dice 139 llamadas y esta tabla dijera 766, la primera
 * reacción sería desconfiar de las dos.
 *
 * `total_rows` NO se toca: es el conteo crudo de la tabla de origen, y su
 * trabajo es justamente contrastar contra `measured_events`. Filtrarlo taparía
 * el agujero que esta función existe para mostrar.
 */
CREATE FUNCTION ops.ai_surface_coverage()
RETURNS TABLE (
  surface           text,
  label             text,
  source_table      text,
  tracked           boolean,
  has_token_columns boolean,
  total_rows        bigint,
  measured_events   bigint,
  note              text
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r      record;
  v_rel  regclass;
  v_rows bigint;
BEGIN
  FOR r IN
    SELECT reg.surface, reg.label, reg.source_table, reg.tracked, reg.note
      FROM ops.ai_surface_registry reg
     ORDER BY reg.tracked DESC, reg.surface
  LOOP
    v_rel  := to_regclass(r.source_table);
    v_rows := NULL;

    IF v_rel IS NOT NULL THEN
      EXECUTE format('SELECT count(*)::bigint FROM %s', v_rel) INTO v_rows;
    END IF;

    surface      := r.surface;
    label        := r.label;
    source_table := r.source_table;
    tracked      := r.tracked;
    note         := r.note;
    total_rows   := v_rows;

    has_token_columns := v_rel IS NOT NULL AND EXISTS (
      SELECT 1
        FROM information_schema.columns col
       WHERE col.table_schema || '.' || col.table_name = r.source_table
         AND col.column_name IN ('prompt_tokens', 'completion_tokens')
    );

    SELECT count(*)::bigint
      INTO measured_events
      FROM ops.v_ai_usage v
     WHERE v.surface = r.surface
       AND NOT v.internal;

    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION ops.ai_surface_coverage() IS
  'De qué superficies de IA NO tenemos medición. has_token_columns se deriva de '
  'information_schema, así que se corrige solo cuando el backend instrumenta. '
  'measured_events excluye cuentas internas; total_rows es el conteo crudo.';
