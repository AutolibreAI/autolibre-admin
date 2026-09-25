-- ═══════════════════════════════════════════════════════════════════════════
-- 017 — Plantillas de mensaje editables desde el panel.
--
-- Hasta acá `QUOTE_TEMPLATES` (`~/lib/quote-templates.ts`) era una constante
-- de código: cuatro plantillas fijas, y cambiar una palabra era un commit.
-- El pedido de producto del 2026-09-25
-- (`.claude/plans/pedidos-ficha-2026-09-25.md`) es que el equipo pueda
-- editarlas —y crear nuevas— desde la ficha, sin tocar el repo.
--
-- ── Versión, no fila mutable ────────────────────────────────────────────────
--
-- `ops.quote_message_template_version` es APPEND-ONLY: "editar" es insertar
-- una fila nueva con el mismo `template_key`. La vigente es la más reciente
-- (no archivada) de cada `template_key`. "Volver a una versión anterior" no
-- necesita un SP propio: el cliente relee el `content` de esa versión vieja y
-- lo manda como si fuera una edición nueva — el historial queda intacto y
-- dice quién y cuándo hizo cada cambio, incluida la vuelta atrás.
--
-- ── La semilla queda en CÓDIGO, esta tabla es la ficha del que edita ───────
--
-- Las 4 plantillas de `QUOTE_TEMPLATES` siguen viviendo en TypeScript. Si un
-- `template_key` no tiene ninguna versión en esta tabla, el panel usa la
-- semilla. La primera edición crea la versión 1 y desde ahí la tabla manda
-- para esa clave. Una plantilla nueva ("Nueva plantilla" en la UI) nace acá
-- directamente, sin semilla — `p_template_key` llega NULL y el SP le genera
-- una clave.
--
-- ── `archived`: la mitad que la UI de hoy no expone ────────────────────────
--
-- El plan (Fase 3, punto 2) pide la columna y la capacidad de archivar
-- ("versión nueva con `archived = true`, no hay borrado"), pero la UI de la
-- Fase 3 (punto 6: Editar / Nueva plantilla / historial con "usar esta
-- versión") no pide un botón de archivar todavía. La columna y el parámetro
-- quedan escritos y probados — una `UPDATE ops.quote_message_template_version
-- SET archived = true` a mano, o un SP futuro, alcanzan para retirar una
-- plantilla sin esperar a otra migración.
--
-- ── Los 8 guardrails, con dos matices ──────────────────────────────────────
--
--   1. Vive en `migrations/`, nunca DDL a mano.
--   2. SECURITY INVOKER (el default).
--   3. `SET search_path` fijo.
--   4. `p_actor_id` sale de la sesión de Clerk, JAMÁS del payload.
--   5. `ops.action_log` DENTRO de la función. `before` es la versión vigente
--      ANTERIOR de esa clave (o NULL si es la primera vez que se guarda algo
--      con esa clave) — no `NULL` siempre, porque acá SÍ hay algo útil que
--      comparar: qué decía la plantilla antes de este cambio.
--   6. Ninguna FK cruza a `public`: `actor_id` es UUID pelado. El nombre del
--      autor se resuelve con `LEFT JOIN users` al leer.
--   7. `SELECT … FOR UPDATE` sobre la versión vigente anterior (si la hay)
--      ANTES de insertar la nueva — mismo motivo que la 013/015: dos
--      ediciones concurrentes de la misma clave se serializan en vez de
--      correr una carrera invisible.
--   8. No hay `updated_at`: las filas de esta tabla no se editan nunca
--      (append-only), así que no hay nada que ese guardrail proteja acá.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ops.quote_message_template_version (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identidad de la plantilla a través de sus versiones. Para las 4 de
  -- semilla, coincide con `QuoteTemplate.id` en TS (`apertura`,
  -- `presupuestos`, `cotizacion_red`, `cotizacion_nuevo`). Para una nueva,
  -- la genera el SP.
  template_key text        NOT NULL,

  title        text        NOT NULL,
  audience     text        NOT NULL,
  content      text        NOT NULL,

  -- `true` retira esta clave de la lista activa — ver la nota de arriba.
  archived     boolean     NOT NULL DEFAULT false,

  actor_id     uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_ops_qmtv_audience CHECK (audience IN ('persona', 'taller')),
  CONSTRAINT chk_ops_qmtv_texts_not_blank
    CHECK (btrim(template_key) <> '' AND btrim(title) <> '' AND btrim(content) <> ''),
  -- La única forma de trazar un pedido en un mensaje días después. Mismo
  -- guardrail que ya corre en tiempo de módulo sobre `QUOTE_TEMPLATES`
  -- (`~/lib/quote-templates.ts`) — acá se repite del lado de la base porque
  -- una plantilla nueva se puede crear SIN pasar por ese archivo.
  CONSTRAINT chk_ops_qmtv_has_codigo CHECK (content LIKE '%{{codigo}}%')
);

-- "La vigente de esta clave" es la última fila NO archivada — el índice
-- sostiene exactamente esa consulta.
CREATE INDEX IF NOT EXISTS idx_ops_qmtv_key_created
  ON ops.quote_message_template_version (template_key, created_at DESC);

/**
 * Guardar una versión nueva de una plantilla — alta si `p_template_key` es
 * NULL, edición si ya existe.
 *
 * Sólo valida REPRESENTABILIDAD: título y contenido no vacíos, audiencia del
 * catálogo cerrado, `{{codigo}}` presente. Qué variables usa el contenido
 * (`{{presupuestos}}`, `{{vehiculo_taller}}`, …) se valida en TypeScript
 * contra `TEMPLATE_VARIABLES` (`~/lib/quote-templates.ts`) ANTES de llegar
 * acá — el SP no conoce esa lista porque vive en código, no en la base, y
 * duplicarla sería una tercera copia para mantener sincronizada.
 */
CREATE OR REPLACE FUNCTION ops.save_quote_message_template(
  p_actor_id     uuid,
  p_title        text,
  p_audience     text,
  p_content      text,
  p_template_key text    DEFAULT NULL,
  p_archived     boolean DEFAULT false,
  p_note         text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_key      text := nullif(btrim(coalesce(p_template_key, '')), '');
  v_title    text := nullif(btrim(coalesce(p_title, '')), '');
  v_audience text := nullif(btrim(coalesce(p_audience, '')), '');
  v_content  text := nullif(btrim(coalesce(p_content, '')), '');
  v_before   jsonb;
  v_after    jsonb;
  v_id       uuid;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF v_title IS NULL THEN
    RAISE EXCEPTION 'TITLE_REQUIRED';
  END IF;
  IF v_audience IS NULL OR v_audience NOT IN ('persona', 'taller') THEN
    RAISE EXCEPTION 'INVALID_AUDIENCE: %', coalesce(v_audience, '')
      USING HINT = 'Valores válidos: persona, taller.';
  END IF;
  IF v_content IS NULL THEN
    RAISE EXCEPTION 'CONTENT_REQUIRED';
  END IF;
  IF v_content NOT LIKE '%{{codigo}}%' THEN
    RAISE EXCEPTION 'MISSING_CODIGO_PLACEHOLDER'
      USING HINT = 'El mensaje tiene que incluir {{codigo}} en algún lugar — es la única forma de trazar el pedido después.';
  END IF;

  -- Sin clave: es una plantilla nueva. Se genera una que no colisione con
  -- ninguna semilla ni con otra ya creada.
  IF v_key IS NULL THEN
    v_key := 'custom_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  END IF;

  -- Lockea la versión vigente ANTERIOR de esta clave (si la hay) antes de
  -- leer el `before` — guardrail 7. Sin fila previa no hay nada que lockear:
  -- el `INSERT` de abajo no compite con nadie por esa clave todavía.
  SELECT to_jsonb(t) INTO v_before
    FROM ops.quote_message_template_version t
   WHERE t.template_key = v_key
   ORDER BY t.created_at DESC
   LIMIT 1
     FOR UPDATE;

  INSERT INTO ops.quote_message_template_version (template_key, title, audience, content, archived, actor_id)
  VALUES (v_key, v_title, v_audience, v_content, coalesce(p_archived, false), p_actor_id)
  RETURNING id INTO v_id;

  SELECT to_jsonb(t) INTO v_after FROM ops.quote_message_template_version t WHERE t.id = v_id;

  PERFORM ops.log_action(
    p_actor_id, 'quote_message_template.save', 'ops.quote_message_template_version', v_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;
