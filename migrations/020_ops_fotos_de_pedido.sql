-- ═══════════════════════════════════════════════════════════════════════════
-- 020 — Adjuntar fotos a un pedido de presupuesto desde el panel.
--
-- La persona puede adjuntar fotos del problema al pedir desde la APP
-- (`public.quote_request_files`, `purpose = 'problem_photo'`). Por WhatsApp
-- las manda en la charla, a medida que avanza: el operador las tiene en el
-- teléfono y no hay dónde guardarlas junto al pedido. Esta función ata al
-- pedido un archivo QUE YA EXISTE en `files`.
--
-- ── El archivo NO lo sube esta función ──────────────────────────────────────
--
-- Ninguna cantidad de SQL sube un archivo a un bucket (`vehicle-manuals.md`).
-- La foto va del navegador a DigitalOcean Spaces con el flujo de subida directa
-- del backend (`POST /files/upload-url` → PUT → `POST /files/confirm`), que
-- crea la fila de `files` a nombre del admin y verifica los magic bytes. Recién
-- con ese `file_id` el panel llama acá. Por eso la función exige que el archivo
-- exista y sea una imagen: no crea `files`, sólo la referencia.
--
-- ── Por qué un SP y no un endpoint ──────────────────────────────────────────
--
-- El `grep` se corrió el 2026-10-03 sobre `main` del backend (69aa193, un
-- clon de lectura): `src/quotes` NO tiene ningún `AdminGuard`. Sus únicas
-- escrituras son `POST /` (público, anónimo), `POST app`, `:id/cancel` y
-- `:id/user-outcome` (del usuario). Los archivos de un pedido los adjunta sólo
-- la app, al crearlo, y el caso de uso exige que el archivo sea DEL usuario.
-- No hay camino admin: la excepción aplica. Antes de ampliar esto:
--
--   rg -n "AdminGuard|quoteRequestFiles|quote_request_files" ../autolibre-backend-hex/src/quotes
--
-- Si aparece un endpoint admin para adjuntar archivos, esto va por HTTP y la
-- función se retira. Está preguntado en `docs/pedido-backend-2026-10-03.md`.
--
-- ── LOS 8 GUARDRAILS ────────────────────────────────────────────────────────
--
--   1. vive en `migrations/`;  2. SECURITY INVOKER;  3. `search_path` fijo;
--   4. actor de la sesión (`ops.assert_actor`);  5. `ops.action_log` adentro,
--   `before` NULL (es un alta) y `after` la fila de `quote_request_files`;
--   6. sin FK nueva (la tabla es del backend, sus FK son suyas);
--   7. `FOR UPDATE` sobre el PEDIDO (`ops._lock_quote_request`, 011): serializa
--      contra la app y contra otro admin, y de paso dice si el pedido existe;
--   8. `quote_request_files` no tiene `updated_at`.
--
-- `p_purpose` es `text` y el cast al enum va en el cuerpo, igual que los SP de
-- la 011: plpgsql resuelve las sentencias recién al ejecutarlas, así que la
-- migración se aplica aunque la tabla no exista en esa base.
--
-- Idempotente: atar dos veces el mismo archivo al mismo pedido choca
-- `idx_quote_request_files_request_file_unique` y devuelve la fila que ya
-- estaba, sin una segunda entrada de log. Se puede adjuntar en un pedido
-- cerrado: una foto que llegó tarde es un hecho real, mismo criterio que los
-- presupuestos (015).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION ops.add_quote_request_file(
  p_quote_request_id uuid,
  p_file_id          uuid,
  p_actor_id         uuid,
  p_purpose          text DEFAULT 'problem_photo'
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_purpose quote_request_file_purpose;
  v_mime    text;
  v_row     jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF p_file_id IS NULL THEN
    RAISE EXCEPTION 'FILE_REQUIRED';
  END IF;

  BEGIN
    v_purpose := coalesce(p_purpose, 'problem_photo')::quote_request_file_purpose;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'INVALID_FILE_PURPOSE: %', p_purpose
      USING HINT = 'Valores válidos: problem_photo, budget.';
  END;

  PERFORM ops._lock_quote_request(p_quote_request_id);

  SELECT f.mime_type INTO v_mime FROM files f WHERE f.id = p_file_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FILE_NOT_FOUND: %', p_file_id
      USING HINT = 'El archivo se registra con POST /files/confirm antes de atarlo.';
  END IF;

  -- La MISMA regla que el backend (`isMimeTypeAllowedForPurpose` en
  -- `quote-request-file.vo.ts`): foto = jpeg/png/webp; presupuesto = eso o PDF.
  -- `mime_type` NULL no alcanza para ninguno: no prueba que sea una foto.
  IF v_purpose = 'problem_photo' AND coalesce(v_mime, '') NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
    RAISE EXCEPTION 'FILE_NOT_IMAGE: %', coalesce(v_mime, 'sin tipo');
  END IF;
  IF v_purpose = 'budget' AND coalesce(v_mime, '') NOT IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') THEN
    RAISE EXCEPTION 'FILE_TYPE_NOT_ALLOWED: %', coalesce(v_mime, 'sin tipo');
  END IF;

  SELECT to_jsonb(x) INTO v_row
    FROM quote_request_files x
   WHERE x.quote_request_id = p_quote_request_id AND x.file_id = p_file_id;
  IF v_row IS NOT NULL THEN
    RETURN v_row;
  END IF;

  INSERT INTO quote_request_files (quote_request_id, file_id, purpose)
  VALUES (p_quote_request_id, p_file_id, v_purpose)
  RETURNING to_jsonb(quote_request_files.*) INTO v_row;

  PERFORM ops.log_action(
    p_actor_id, 'add_quote_request_file', 'quote_request_files',
    (v_row->>'id')::uuid, NULL, v_row, NULL);

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION ops.add_quote_request_file(uuid, uuid, uuid, text) IS
  'Ata a un pedido un archivo ya subido (files). La subida va por el backend; esto sólo referencia y audita. 020.';
