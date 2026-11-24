-- ═══════════════════════════════════════════════════════════════════════════
-- 037 — «Formato de cada propuesta»: el renglón de cada taller dentro de
-- `{{presupuestos}}` pasa a ser una plantilla editable más.
--
-- Tarjeta de Trello bMtiAAQZ (B). Hasta acá ese bloque lo armaba el código
-- (`responsesBlock` en `~/lib/quote-templates.ts`) y no se podía tocar desde
-- el panel. Ahora es una versión de `ops.quote_message_template_version` con
-- audiencia `propuesta` y clave fija `propuesta_item`, con sus variables propias
-- (`{{taller}}`, `{{monto}}`, `{{whatsapp_taller}}`, `{{calificacion}}`, …).
-- Sin versión guardada se usa la semilla del código, que reproduce el formato
-- de siempre.
--
-- Cambia la 017 en tres cosas, todas aditivas:
--
--   1. `chk_ops_qmtv_audience` admite `propuesta`.
--   2. `chk_ops_qmtv_has_codigo` deja de exigir `{{codigo}}` a la audiencia
--      `propuesta`: es un pedazo del mensaje «Presupuestos», que ya lo lleva.
--      Para `persona` y `taller` sigue siendo obligatorio.
--   3. `ops.save_quote_message_template` (CREATE OR REPLACE con la firma EXACTA
--      de la 017: no hay sobrecarga posible) aplica las dos reglas de arriba y
--      una nueva: `propuesta` va SIEMPRE con la clave `propuesta_item`, y esa
--      clave sólo con esa audiencia (`PROPOSAL_TEMPLATE_KEY`). Hay un solo
--      formato de propuesta; sin esto, «Nueva plantilla» podría crear otro que
--      nadie usa, o mudar una plantilla de persona a pedazo de mensaje.
--
-- Idempotente: los CHECK se dropean con IF EXISTS y se recrean.
-- Los 8 guardrails son los de la 017 (la función no cambia de forma).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ops.quote_message_template_version
  DROP CONSTRAINT IF EXISTS chk_ops_qmtv_audience;
ALTER TABLE ops.quote_message_template_version
  ADD CONSTRAINT chk_ops_qmtv_audience CHECK (audience IN ('persona', 'taller', 'propuesta'));

ALTER TABLE ops.quote_message_template_version
  DROP CONSTRAINT IF EXISTS chk_ops_qmtv_has_codigo;
ALTER TABLE ops.quote_message_template_version
  ADD CONSTRAINT chk_ops_qmtv_has_codigo CHECK (audience = 'propuesta' OR content LIKE '%{{codigo}}%');

ALTER TABLE ops.quote_message_template_version
  DROP CONSTRAINT IF EXISTS chk_ops_qmtv_proposal_key;
ALTER TABLE ops.quote_message_template_version
  ADD CONSTRAINT chk_ops_qmtv_proposal_key CHECK ((audience = 'propuesta') = (template_key = 'propuesta_item'));

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
  IF v_audience IS NULL OR v_audience NOT IN ('persona', 'taller', 'propuesta') THEN
    RAISE EXCEPTION 'INVALID_AUDIENCE: %', coalesce(v_audience, '')
      USING HINT = 'Valores válidos: persona, taller, propuesta.';
  END IF;
  IF v_content IS NULL THEN
    RAISE EXCEPTION 'CONTENT_REQUIRED';
  END IF;
  IF v_audience <> 'propuesta' AND v_content NOT LIKE '%{{codigo}}%' THEN
    RAISE EXCEPTION 'MISSING_CODIGO_PLACEHOLDER'
      USING HINT = 'El mensaje tiene que incluir {{codigo}} en algún lugar — es la única forma de trazar el pedido después.';
  END IF;
  IF (v_audience = 'propuesta') <> (coalesce(v_key, '') = 'propuesta_item') THEN
    RAISE EXCEPTION 'PROPOSAL_TEMPLATE_KEY'
      USING HINT = 'El formato de cada propuesta es uno solo: audiencia propuesta con la clave propuesta_item.';
  END IF;

  IF v_key IS NULL THEN
    v_key := 'custom_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  END IF;

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
