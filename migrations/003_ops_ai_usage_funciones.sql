-- ═══════════════════════════════════════════════════════════════════════════
-- 003 — Las funciones que consume el panel.
--
-- Son el equivalente, del lado de `ops`, a lo que `approve_partner_application()`
-- es del lado de `public`: la unidad que el panel llama por nombre en vez de
-- armar SQL a mano en el repositorio.
--
-- LA CONDICIÓN QUE HEREDAN (misma que le puso el backend a su función): SE
-- MANTIENEN FLACAS. Agregan y devuelven. No deciden.
--
-- Concretamente, lo que NO va acá: qué se considera "gasto alto", qué modelo
-- conviene, cuándo alertar. Eso es política de producto y decide el caso de uso
-- o la UI, con la tabla de precios como dato. Una función SQL que decide es una
-- regla de negocio que no tiene tests y que nadie encuentra cuando cambia.
--
-- CONVENCIÓN DE PARÁMETROS, uniforme en las cuatro:
--   p_from    timestamptz  inclusive, NULL = sin límite inferior
--   p_to      timestamptz  EXCLUSIVO, NULL = sin límite superior
--   p_surface text         NULL = todas
--
-- `p_to` exclusivo evita el clásico de contar dos veces un evento justo en el
-- borde cuando se piden períodos consecutivos.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Totales del período ────────────────────────────────────────────────────
--
-- Devuelve UNA fila. Fijate que `total_usd` y `unpriced_events` viajan juntos y
-- eso es deliberado: SUM() de Postgres ignora los NULL, así que el total es
-- correcto para lo que SÍ tiene precio, pero por sí solo no dice cuánto se está
-- dejando afuera. Separarlos permitiría mostrar el total sin el asterisco, y el
-- asterisco es justamente lo que hace honesto al número.
CREATE OR REPLACE FUNCTION ops.ai_usage_summary(
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
  last_event      timestamptz
)
LANGUAGE sql STABLE AS $$
  SELECT
    count(*)::bigint,
    COALESCE(sum(c.input_tokens), 0)::bigint,
    COALESCE(sum(c.output_tokens), 0)::bigint,
    sum(c.total_usd),                                   -- NULL si nada tiene precio
    count(*) FILTER (WHERE NOT c.unpriced)::bigint,
    count(*) FILTER (WHERE c.unpriced)::bigint,
    count(DISTINCT c.model)::bigint,
    count(DISTINCT c.user_id)::bigint,
    min(c.occurred_at),
    max(c.occurred_at)
  FROM ops.v_ai_usage_costed c
  WHERE (p_from    IS NULL OR c.occurred_at >= p_from)
    AND (p_to      IS NULL OR c.occurred_at <  p_to)
    AND (p_surface IS NULL OR c.surface      = p_surface);
$$;

-- ── Desglose por modelo ────────────────────────────────────────────────────
--
-- Responde "cuál usamos y cuánto nos cuesta cada uno". Ordena por gasto
-- descendente, con NULLS LAST: un modelo sin precio no puede encabezar el
-- ranking de gasto (no sabemos cuánto gastó), pero tampoco puede desaparecer —
-- baja al fondo con su bandera puesta.
CREATE OR REPLACE FUNCTION ops.ai_usage_by_model(
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
    -- max() sobre provider/tarifa: dentro de un mismo modelo son constantes
    -- salvo que haya habido cambio de precio en el período. Si lo hubo, esto
    -- muestra la tarifa más alta de las vigentes — el total_usd sigue siendo
    -- exacto porque se calcula fila por fila con la tarifa que correspondía.
    max(c.provider),
    count(*)::bigint,
    COALESCE(sum(c.input_tokens), 0)::bigint,
    COALESCE(sum(c.output_tokens), 0)::bigint,
    sum(c.total_usd),
    bool_or(c.unpriced),
    max(c.input_usd_per_mtok),
    max(c.output_usd_per_mtok)
  FROM ops.v_ai_usage_costed c
  WHERE (p_from    IS NULL OR c.occurred_at >= p_from)
    AND (p_to      IS NULL OR c.occurred_at <  p_to)
    AND (p_surface IS NULL OR c.surface      = p_surface)
  GROUP BY c.model
  ORDER BY sum(c.total_usd) DESC NULLS LAST, count(*) DESC;
$$;

-- ── Serie diaria ───────────────────────────────────────────────────────────
--
-- `date_trunc` en UTC a propósito: los formatters del panel (src/lib/format.ts)
-- fijan timeZone 'UTC' para que el SSR y el cliente rindan el mismo string. Si
-- esto agrupara en America/Argentina y la UI formateara en UTC, un evento de
-- las 22h aparecería en el día siguiente y los totales por día no cerrarían con
-- el total del período.
CREATE OR REPLACE FUNCTION ops.ai_usage_daily(
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
  WHERE (p_from    IS NULL OR c.occurred_at >= p_from)
    AND (p_to      IS NULL OR c.occurred_at <  p_to)
    AND (p_surface IS NULL OR c.surface      = p_surface)
  GROUP BY 1
  ORDER BY 1;
$$;

-- ── Quién consume ──────────────────────────────────────────────────────────
--
-- ACÁ ESTÁ EL ÚNICO CRUCE A `public`, y es un LEFT JOIN de lectura — no una FK.
-- Esa es exactamente la frontera que el schema `ops` quiere sostener: leemos
-- `users` para poner un nombre en pantalla, pero no dependemos de su ciclo de
-- vida. Si el backend borra un usuario, esta fila sigue existiendo con el uuid
-- y sin nombre, en vez de desaparecer el gasto (o de bloquear el DELETE).
CREATE OR REPLACE FUNCTION ops.ai_usage_by_user(
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
  WHERE (p_from    IS NULL OR c.occurred_at >= p_from)
    AND (p_to      IS NULL OR c.occurred_at <  p_to)
    AND (p_surface IS NULL OR c.surface      = p_surface)
  GROUP BY c.user_id
  ORDER BY sum(c.total_usd) DESC NULLS LAST, count(*) DESC
  LIMIT GREATEST(p_limit, 1);
$$;

-- ── El informe de cobertura ────────────────────────────────────────────────
--
-- La función más importante del archivo, y la que no se le pidió a nadie.
--
-- Contesta "¿de qué NO tenemos datos?". Sin esto, el panel muestra el consumo
-- de dos superficies y calla que hay otras dos gastando plata sin medir — 40
-- imágenes generadas al día de hoy, cero tokens registrados. Un total prolijo
-- que omite eso es peor que no tener panel: da confianza falsa.
--
-- `has_token_columns` NO está hardcodeado: sale de information_schema. Así, el
-- día que el backend agregue las columnas de medición a una de esas tablas, el
-- panel lo detecta solo y deja de reportarla como agujero. Una lista escrita a
-- mano habría quedado desactualizada exactamente en el momento en que el
-- problema se arregla, que es el peor momento para mentir.
--
-- El count dinámico pasa por `::regclass`: valida que la tabla exista y la
-- re-renderiza calificada y escapada. `source_table` sale de nuestro propio
-- registry, pero eso no es razón para concatenar texto crudo en un EXECUTE.
CREATE OR REPLACE FUNCTION ops.ai_surface_coverage()
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
    v_rel  := to_regclass(r.source_table);   -- NULL si la tabla ya no existe
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
     WHERE v.surface = r.surface;

    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION ops.ai_surface_coverage() IS
  'De qué superficies de IA NO tenemos medición. has_token_columns se deriva de '
  'information_schema, así que se corrige solo cuando el backend instrumenta.';
