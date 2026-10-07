-- ═══════════════════════════════════════════════════════════════════════════
-- 020 — Mensaje de WhatsApp en la edición de la solicitud (AUT-120).
--
-- `ops.update_partner_application` (migración 010) ya maneja los campos de
-- texto libre nullable con el mismo patrón (`nullif(btrim(coalesce(...)), '')`,
-- siempre leído del patch, nunca con guarda `p_patch ? 'x'` porque el panel
-- manda siempre el juego completo). `whatsapp_message` entra en esa misma
-- categoría — no hace falta un parámetro nuevo en la firma de la función, sólo
-- sumar la columna al UPDATE.
--
-- Por qué no se toca `ops.set_partner_contact` (migración 007) en esta
-- migración: esta pantalla es la de REVISIÓN DE SOLICITUDES, pre-aprobación.
-- Editar el mensaje de un partner YA aprobado desde su ficha es una pantalla
-- distinta que no se mostró ni se confirmó — queda deliberadamente fuera de
-- esta migración (ver specs/002-whatsapp-link-derivation/tasks.md, T037 en
-- autolibre-backend-hex).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION ops.update_partner_application(
  p_application_id uuid,
  p_actor_id       uuid,
  p_patch          jsonb,
  p_note           text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before        jsonb;
  v_after         jsonb;
  v_business_name text := btrim(coalesce(p_patch->>'business_name', ''));
  v_email         text := btrim(coalesce(p_patch->>'email', ''));
  v_whatsapp      text := btrim(coalesce(p_patch->>'whatsapp', ''));
  v_address       text := btrim(coalesce(p_patch->>'address', ''));
  v_follow_up     date;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF v_business_name = '' THEN
    RAISE EXCEPTION 'BUSINESS_NAME_REQUIRED'
      USING HINT = 'business_name es NOT NULL en public.partner_applications.';
  END IF;
  IF v_email = '' THEN
    RAISE EXCEPTION 'EMAIL_REQUIRED'
      USING HINT = 'email es NOT NULL en public.partner_applications.';
  END IF;
  IF v_whatsapp = '' THEN
    RAISE EXCEPTION 'WHATSAPP_REQUIRED'
      USING HINT = 'whatsapp es NOT NULL en public.partner_applications.';
  END IF;
  IF v_address = '' THEN
    RAISE EXCEPTION 'ADDRESS_REQUIRED'
      USING HINT = 'address es NOT NULL en public.partner_applications.';
  END IF;

  BEGIN
    v_follow_up := nullif(btrim(coalesce(p_patch->>'follow_up_date', '')), '')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'INVALID_FOLLOW_UP_DATE: %', p_patch->>'follow_up_date'
      USING HINT = 'Usá YYYY-MM-DD, o vacío para borrar la fecha.';
  END;

  SELECT to_jsonb(a) INTO v_before
    FROM partner_applications a WHERE a.id = p_application_id FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'APPLICATION_NOT_FOUND: %', p_application_id;
  END IF;

  UPDATE partner_applications SET
    business_name     = v_business_name,
    email             = v_email,
    whatsapp          = v_whatsapp,
    address           = v_address,
    brand_specialized = coalesce((p_patch->>'brand_specialized')::boolean, brand_specialized),
    service_other     = nullif(btrim(coalesce(p_patch->>'service_other', '')), ''),
    how_found         = nullif(btrim(coalesce(p_patch->>'how_found', '')), ''),
    how_found_other   = nullif(btrim(coalesce(p_patch->>'how_found_other', '')), ''),
    contact_channel   = nullif(btrim(coalesce(p_patch->>'contact_channel', '')), ''),
    -- Nuevo (AUT-120). Mismo criterio que service_other/how_found: '' borra.
    whatsapp_message  = nullif(btrim(coalesce(p_patch->>'whatsapp_message', '')), ''),
    next_step         = nullif(btrim(coalesce(p_patch->>'next_step', '')), ''),
    agreement_type    = nullif(btrim(coalesce(p_patch->>'agreement_type', '')), ''),
    agreement_detail  = nullif(btrim(coalesce(p_patch->>'agreement_detail', '')), ''),
    internal_notes    = nullif(btrim(coalesce(p_patch->>'internal_notes', '')), ''),
    review_note       = nullif(btrim(coalesce(p_patch->>'review_note', '')), ''),
    follow_up_date    = v_follow_up,
    declared_services = CASE WHEN p_patch ? 'declared_services'
      THEN coalesce(ops._jsonb_text_array(p_patch->'declared_services'), declared_services)
      ELSE declared_services END,
    declared_brands = CASE WHEN p_patch ? 'declared_brands'
      THEN coalesce(ops._jsonb_text_array(p_patch->'declared_brands'), declared_brands)
      ELSE declared_brands END,
    declared_fuel_types = CASE WHEN p_patch ? 'declared_fuel_types'
      THEN coalesce(ops._jsonb_text_array(p_patch->'declared_fuel_types'), declared_fuel_types)
      ELSE declared_fuel_types END,
    vehicle_types = CASE WHEN p_patch ? 'vehicle_types'
      THEN coalesce(ops._jsonb_text_array(p_patch->'vehicle_types'), vehicle_types)
      ELSE vehicle_types END
  WHERE id = p_application_id;
  -- updated_at NO se toca: trg_partner_applications_updated_at ya lo hace.

  SELECT to_jsonb(a) INTO v_after
    FROM partner_applications a WHERE a.id = p_application_id;
  PERFORM ops.log_action(
    p_actor_id, 'application.edit', 'public.partner_applications', p_application_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;
