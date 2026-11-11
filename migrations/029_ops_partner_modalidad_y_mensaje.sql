-- ═══════════════════════════════════════════════════════════════════════════
-- 029 — Lo que faltaba editar de la ficha de un partner: la MODALIDAD de
-- atención y el MENSAJE de WhatsApp.
--
-- Relevado el 2026-11-11 contra `public.partners` (producción, `doadmin`,
-- puerto 25060): de las columnas que el equipo puede querer corregir, la ficha
-- ya editaba nombre, zona, descripción, tier (008/009), estado, coordenadas y
-- contacto (007), links (008) y logo (HTTP). Quedaban dos:
--
--   * `modality` — texto libre. En producción: NULL (119), 'Taller fijo' (17),
--     'Mixto' (9), 'A distancia' (4), 'A domicilio' (3). Lo leen los
--     candidatos de un pedido (`isRemoteModality`), el mapa de cobertura y,
--     del lado del backend, el perfil público y el scoring.
--   * `whatsapp_message` — el texto que se precarga cuando alguien toca
--     "escribir por WhatsApp" (el backend arma el link con `whatsapp` + este
--     campo al leer). Se copia de la solicitud al aprobar; hasta acá sólo se
--     podía corregir ANTES de aprobar (023). 17 partners lo tienen.
--
-- Lo que deliberadamente NO se edita, y por qué:
--   * `whatsapp_opt_in_at` / `whatsapp_opted_out_at`: es CONSENTIMIENTO. Lo
--     escribe el backend (la palabra BAJA, `OptOutPartnerWhatsappCommand`). Un
--     admin no puede dar de alta o de baja a un taller por él.
--   * `source`, `application_id`, `legacy_sheet_row_id`, `created_at`: de dónde
--     vino la fila. Son hechos, no datos que se corrijan.
--   * `updated_at`: lo mueve `trg_partners_updated_at` (guardrail 8).
--
-- El `grep` al backend se corrió el 2026-11-11 (clon de lectura, 4a1f216): los
-- únicos `.update(partners)` son el logo (`PUT|DELETE /admin/partners/:id/logo`),
-- el consentimiento de WhatsApp y la aprobación de una solicitud. Ningún
-- endpoint edita la modalidad ni el mensaje: la excepción de
-- `.claude/rules/ops-write-actions.md` aplica.
--
-- ── 1. `ops.set_partner_modality`, una función nueva ──────────────────────
--
-- Va sola y no adentro del perfil: cambia a qué pedidos se lo ofrece (los
-- remotos van aparte, sin distancia) y cómo lo ve la gente en su perfil. Es una
-- consecuencia propia y merece su entrada en `ops.action_log`, igual que
-- estado y ubicación en la 007. Además así no se reescribe
-- `set_partner_profile` (009) por cuarta vez.
--
-- La columna es texto libre y la función NO cierra la lista (valida
-- representabilidad, no decide): recorta, '' / NULL borra, y un tope de largo.
-- El catálogo de valores —los cuatro que ya existen en la base— lo impone el
-- formulario, igual que el idioma de los manuales.
--
-- ── 2. `ops.set_partner_contact` suma `p_whatsapp_message` ────────────────
--
-- Agregar un parámetro es la trampa de la 009: `CREATE OR REPLACE` crearía una
-- SOBRECARGA y una llamada por parámetros nombrados respondería "function is
-- not unique". DROP con la firma EXACTA de la 007 + CREATE. El parámetro nuevo
-- va con DEFAULT NULL ("no tocar"), así un llamador que no lo manda sigue
-- funcionando igual. Todo lo demás es idéntico a la 007, y la suite lo
-- re-verifica entero.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION ops.set_partner_modality(
  p_partner_id uuid,
  p_actor_id   uuid,
  p_modality   text,
  p_note       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before   jsonb;
  v_after    jsonb;
  v_modality text := nullif(btrim(coalesce(p_modality, '')), '');
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF v_modality IS NOT NULL AND length(v_modality) > 60 THEN
    RAISE EXCEPTION 'MODALITY_TOO_LONG: %', length(v_modality)
      USING HINT = 'La modalidad es una etiqueta corta (Taller fijo, A domicilio, Mixto, A distancia).';
  END IF;

  SELECT to_jsonb(p) INTO v_before FROM partners p WHERE p.id = p_partner_id FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'PARTNER_NOT_FOUND: %', p_partner_id;
  END IF;

  -- Guardar sin cambios no es un hecho: ni UPDATE ni entrada de log.
  IF (v_before ->> 'modality') IS NOT DISTINCT FROM v_modality THEN
    RETURN v_before;
  END IF;

  UPDATE partners SET modality = v_modality WHERE id = p_partner_id;
  -- updated_at NO se toca: trg_partners_updated_at ya lo hace.

  SELECT to_jsonb(p) INTO v_after FROM partners p WHERE p.id = p_partner_id;
  PERFORM ops.log_action(
    p_actor_id, 'partner.set_modality', 'public.partners', p_partner_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;

DROP FUNCTION ops.set_partner_contact(uuid, uuid, text, text, text, text, text, text);

/**
 * Igual que en la 007: cada parámetro en NULL significa "no tocar este campo";
 * para BORRAR se manda ''. Normaliza '' a NULL. No exige que quede algún canal
 * de contacto (regla de negocio, la avisa el formulario).
 *
 * Nuevo en la 029: `p_whatsapp_message`, mismo contrato. Va al final y con
 * default, así las llamadas que no lo conocen siguen resolviendo.
 */
CREATE FUNCTION ops.set_partner_contact(
  p_partner_id       uuid,
  p_actor_id         uuid,
  p_whatsapp         text DEFAULT NULL,
  p_email            text DEFAULT NULL,
  p_redirect_link    text DEFAULT NULL,
  p_hours            text DEFAULT NULL,
  p_address          text DEFAULT NULL,
  p_note             text DEFAULT NULL,
  p_whatsapp_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF p_whatsapp_message IS NOT NULL AND length(btrim(p_whatsapp_message)) > 1000 THEN
    RAISE EXCEPTION 'WHATSAPP_MESSAGE_TOO_LONG: %', length(btrim(p_whatsapp_message))
      USING HINT = 'El mensaje precargado de WhatsApp admite hasta 1000 caracteres.';
  END IF;

  SELECT to_jsonb(p) INTO v_before FROM partners p WHERE p.id = p_partner_id FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'PARTNER_NOT_FOUND: %', p_partner_id;
  END IF;

  UPDATE partners SET
    whatsapp         = CASE WHEN p_whatsapp         IS NULL THEN whatsapp         ELSE nullif(btrim(p_whatsapp), '')         END,
    email            = CASE WHEN p_email            IS NULL THEN email            ELSE nullif(btrim(p_email), '')            END,
    redirect_link    = CASE WHEN p_redirect_link    IS NULL THEN redirect_link    ELSE nullif(btrim(p_redirect_link), '')    END,
    hours            = CASE WHEN p_hours            IS NULL THEN hours            ELSE nullif(btrim(p_hours), '')            END,
    address          = CASE WHEN p_address          IS NULL THEN address          ELSE nullif(btrim(p_address), '')          END,
    whatsapp_message = CASE WHEN p_whatsapp_message IS NULL THEN whatsapp_message ELSE nullif(btrim(p_whatsapp_message), '') END
  WHERE id = p_partner_id;
  -- updated_at NO se toca: trg_partners_updated_at ya lo hace.

  SELECT to_jsonb(p) INTO v_after FROM partners p WHERE p.id = p_partner_id;
  PERFORM ops.log_action(
    p_actor_id, 'partner.set_contact', 'public.partners', p_partner_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;
