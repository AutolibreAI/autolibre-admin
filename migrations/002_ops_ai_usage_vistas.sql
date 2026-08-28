-- ═══════════════════════════════════════════════════════════════════════════
-- 002 — La ingesta: vistas sobre `public`, sin copia.
--
-- DECISIÓN: VISTA, NO SNAPSHOT.
--
-- La alternativa era un SP que copia incrementalmente a `ops.ai_usage_raw`.
-- Se descartó por ahora y el motivo es concreto: como el precio tiene vigencia,
-- el costo histórico ya sale correcto calculándolo AL LEER. No hay nada que
-- congelar. Un snapshot agregaría una parte móvil (algo que lo dispare) que hoy
-- no tiene dónde correr — el deploy es serverless, no hay cron.
--
-- Se justifica migrar a snapshot el día que pase UNA de estas dos cosas:
--   1. el backend empiece a purgar historial de conversaciones, o
--   2. el volumen haga lento el UNION en vivo.
-- Ninguna de las dos pasa hoy (14 eventos).
--
-- EFECTO SECUNDARIO BUSCADO: la vista lee `public` en vivo, así que si el
-- backend renombra una columna, esto se rompe. Se rompe RUIDOSAMENTE, en la
-- cara, en vez de devolver un total silenciosamente incompleto. Es el modo de
-- falla que se eligió.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Qué superficies de IA existen ──────────────────────────────────────────
--
-- Registro declarado a mano, y a propósito: es la lista de "dónde gastamos
-- plata en IA", que es conocimiento del equipo, no algo derivable del schema.
--
-- `tracked` dice si `ops.v_ai_usage` la lee. Las que están en FALSE son el
-- agujero de cobertura, y existen como fila justamente para que el panel pueda
-- mostrarlas. Un panel de costos que oculta un costo genera confianza falsa:
-- preferimos un "40 imágenes, 0 medidas" bien visible antes que un total
-- prolijo que miente por omisión.
CREATE TABLE IF NOT EXISTS ops.ai_surface_registry (
  surface      text PRIMARY KEY,
  label        text NOT NULL,
  source_table text NOT NULL,   -- 'schema.tabla' — sin FK, es solo un nombre
  tracked      boolean NOT NULL DEFAULT false,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ops.ai_surface_registry (surface, label, source_table, tracked, note)
SELECT * FROM (VALUES
  ('assistant', 'Asistente conversacional', 'public.conversation_messages', true,
   'Graba model + prompt_tokens + completion_tokens en cada mensaje con author = ''ai''.'),
  ('diagnostics', 'Diagnóstico IA', 'public.ai_diagnostics', true,
   'Mismas tres columnas que el asistente.'),
  ('catalog_images', 'Generación de imágenes de catálogo', 'public.vehicle_catalog_images', false,
   'SIN INSTRUMENTAR. Guarda prompt_used pero ningún dato de consumo: ni modelo, ni tokens, ni costo. No se arregla desde este repo — el dato lo devuelve el proveedor en la llamada, y esa llamada la hace el backend.'),
  ('telemetry_analysis', 'Análisis de telemetría', 'public.driving_telemetry_analysis', false,
   'SIN INSTRUMENTAR. Guarda summary/anomalies/metrics en jsonb, ningún dato de consumo.')
) AS seed(surface, label, source_table, tracked, note)
WHERE NOT EXISTS (
  SELECT 1 FROM ops.ai_surface_registry r WHERE r.surface = seed.surface
);

-- ── El uso, normalizado ────────────────────────────────────────────────────
--
-- Dos tablas de `public` graban lo mismo con distinta forma. La vista las
-- unifica en un solo vocabulario: `input_tokens` / `output_tokens`, y
-- `occurred_at` (que en una es `sent_at` y en la otra `created_at`).
--
-- El filtro `author = 'ai'` no es cosmético: `conversation_messages` guarda
-- también el turno del usuario, y esas filas tienen model y tokens en NULL.
-- Verificado sobre la base: 14 filas 'ai' con las tres columnas cargadas, 14
-- filas 'user' con las tres en NULL. Sin ese WHERE la cuenta de eventos
-- duplicaría.
--
-- Los NOT NULL sobre model y prompt_tokens quedan igual, y no son redundantes:
-- una fila 'ai' escrita por una versión del backend que todavía no medía
-- entraría con NULLs y ensuciaría el promedio con un evento de cero tokens.
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
    COALESCE(array_length(cm.rag_docs_used, 1), 0) AS rag_docs
  FROM public.conversation_messages cm
  JOIN public.conversations c ON c.id = cm.conversation_id
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
    COALESCE(array_length(d.rag_docs_used, 1), 0)
  FROM public.ai_diagnostics d
  WHERE d.model IS NOT NULL
    AND d.prompt_tokens IS NOT NULL;

COMMENT ON VIEW ops.v_ai_usage IS
  'Uso de IA normalizado desde public. Solo lee: no copia ni escribe nada.';

-- ── El uso, con costo ──────────────────────────────────────────────────────
--
-- EL LEFT JOIN ES LA DECISIÓN IMPORTANTE DE TODO ESTE ARCHIVO.
--
-- Un INNER JOIN haría desaparecer de la vista cualquier evento cuyo modelo no
-- tenga precio cargado. El panel mostraría un total menor y absolutamente
-- creíble, sin una sola señal de que faltan filas. Es el peor resultado
-- posible: no es un error, es un número equivocado con aspecto de correcto.
--
-- Con LEFT JOIN, un modelo sin precio da costo NULL — nunca 0 — y levanta la
-- bandera `unpriced`. NULL se propaga a los SUM() de la capa de arriba, así que
-- ahí se usa SUM(...) FILTER + un contador de no-preciados: el total se muestra
-- junto a cuántos eventos no pudo incluir.
--
-- Regla derivada, para el que venga después: si alguna vez ves un COALESCE(...,
-- 0) sobre una de estas columnas de costo, es un bug. Cero es un precio; NULL
-- es "no sabemos". No son lo mismo.
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
    (p.id IS NULL)                                    AS unpriced
  FROM ops.v_ai_usage u
  LEFT JOIN ops.ai_model_pricing p
         ON p.model = u.model
        AND u.occurred_at >= p.valid_from
        AND (p.valid_to IS NULL OR u.occurred_at < p.valid_to);

COMMENT ON VIEW ops.v_ai_usage_costed IS
  'v_ai_usage + el precio vigente al MOMENTO de cada llamada. Un modelo sin '
  'precio da costo NULL y unpriced = true. Nunca 0.';
