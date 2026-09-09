-- ═══════════════════════════════════════════════════════════════════════════
-- 010 — Editar la solicitud entera desde el panel.
--
-- Hasta acá `partner_applications` sólo se tocaba por STATUS: la función de
-- aprobación del backend, y los dos UPDATE directos de `partners.repo.ts`
-- (`updateApplicationStatus`, `unstickApplication`). La ficha de una solicitud
-- (`/solicitudes/$applicationId`) mostraba todo lo demás —contacto, lo que el
-- taller declaró, notas— en SOLO LECTURA.
--
-- Esta migración agrega el SP que le falta a esa pantalla: editar cualquier
-- campo del formulario del taller.
--
-- ── POR QUÉ ESTO PUEDE ESCRIBIR `public.partner_applications` ─────────────────
--
-- Mismo caso que partners (migración 007) y por el mismo motivo, no por
-- conveniencia:
--
--   1. El backend no tiene camino para editar una solicitud. `IPartnerApplication
--      Repository` no expone un `update` de campos; el único movimiento que hace
--      es el de la función de aprobación, que copia datos y mueve estado.
--      (Verificado para partners con `grep`; para solicitudes se asume lo mismo
--      — el repo del backend no está clonado en esta máquina. Antes de ampliar
--      este SP conviene correr ese `grep`.)
--
--   2. El propio backend lo dejó designado, en `marketplace/.../lead-status.vo.ts`:
--        "el resto del recorrido lo mueve el equipo desde SQL, igual que el
--         pipeline de las solicitudes."
--
--      O sea que el SQL a mano ya estaba previsto. Lo que cambia es dónde vive:
--      deja de ser un UPDATE pegado en DBeaver y pasa a estar versionado,
--      revisado y AUDITADO en `ops.action_log`.
--
-- ── LOS 8 GUARDRAILS, IGUAL QUE 007/008/009 ─────────────────────────────────
--
--   1. Vive en `migrations/`, nunca DDL a mano.
--   2. SECURITY INVOKER (el default). El control de acceso es de `adminMiddleware`.
--   3. `SET search_path` fijo.
--   4. `p_actor_id` sale de la sesión de Clerk, JAMÁS del payload (ver `src/fn/`).
--   5. Escribe `ops.action_log` DENTRO de la función, con `before`/`after` jsonb.
--   6. Ninguna FK cruza a `public`: `actor_id`/`target_id` son UUID pelados.
--   7. `SELECT ... FOR UPDATE` antes de leer el `before`.
--   8. `updated_at` NO se toca: `trg_partner_applications_updated_at` ya lo hace.
--
-- ── LO QUE NO DECIDE ────────────────────────────────────────────────────────
--
-- Sólo valida REPRESENTABILIDAD: los cuatro campos NOT NULL no pueden quedar
-- vacíos, la fecha tiene que parsear. Nada de reglas de negocio — no decide si
-- una solicitud "está lista", ni normaliza marcas, ni valida que un rubro
-- declarado exista en el catálogo (eso lo resuelve la pantalla de aprobación,
-- que ya sabe leer slugs heterogéneos).
--
-- `status` NO se toca acá: tiene su propio editor y el lock de `verbal_agreement`
-- de la función de aprobación. `first_contacted_at`, `reviewed_*`,
-- `raw_submission` y `legacy_sheet_row_id` tampoco — no son datos que el
-- operador corrija a mano.
--
-- ── EL PATCH ────────────────────────────────────────────────────────────────
--
-- `p_patch` es un jsonb con TODOS los campos editables (el formulario del panel
-- manda siempre el juego completo — misma filosofía que `set_partner_contact`).
-- Los escalares se leen incondicionalmente. Los cuatro arrays se guardan con la
-- guarda `p_patch ? 'campo'`: si un llamador omite uno, se deja como estaba en
-- vez de vaciarlo en silencio.
-- ═══════════════════════════════════════════════════════════════════════════

/**
 * jsonb array → text[], descartando elementos vacíos y espacios de borde.
 *
 * Devuelve NULL si el jsonb NO es un array (así el CASE de abajo cae al `ELSE` y
 * deja la columna como estaba, en vez de romper). Un array vacío `[]` sí es
 * válido y devuelve `{}` — vaciar `declared_brands` a propósito es una edición
 * legítima.
 *
 * `IMMUTABLE`: depende sólo del argumento. `STRICT`: NULL in → NULL out.
 * Se define ANTES de `update_partner_application` porque el validador de plpgsql
 * resuelve las funciones que el cuerpo referencia al momento del CREATE.
 */
CREATE OR REPLACE FUNCTION ops._jsonb_text_array(p jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN jsonb_typeof(p) = 'array' THEN
    coalesce(
      (SELECT array_agg(s.x)
         FROM (SELECT nullif(btrim(value), '') AS x
                 FROM jsonb_array_elements_text(p) AS value) s
        WHERE s.x IS NOT NULL),
      '{}'::text[])
  END
$$;

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

  -- Los cuatro NOT NULL: '' no es "borralo", es un valor que la columna no puede
  -- representar. Se rechaza con una sentinela propia para que la UI diga qué
  -- campo revisar en vez de mostrar el `null value in column` crudo de Postgres.
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

  -- La fecha se parsea acá, ANTES del UPDATE, para poder traducir el error de
  -- formato a una sentinela legible. '' / ausente → NULL (la columna es
  -- nullable).
  BEGIN
    v_follow_up := nullif(btrim(coalesce(p_patch->>'follow_up_date', '')), '')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'INVALID_FOLLOW_UP_DATE: %', p_patch->>'follow_up_date'
      USING HINT = 'Usá YYYY-MM-DD, o vacío para borrar la fecha.';
  END;

  -- FOR UPDATE: dos admins sobre la misma solicitud se serializan. Sin esto el
  -- `before` del log puede describir un estado que ya no existía al escribir el
  -- `after`.
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
    -- Nullable text: '' borra, cualquier otra cosa se guarda con btrim.
    service_other     = nullif(btrim(coalesce(p_patch->>'service_other', '')), ''),
    how_found         = nullif(btrim(coalesce(p_patch->>'how_found', '')), ''),
    how_found_other   = nullif(btrim(coalesce(p_patch->>'how_found_other', '')), ''),
    contact_channel   = nullif(btrim(coalesce(p_patch->>'contact_channel', '')), ''),
    next_step         = nullif(btrim(coalesce(p_patch->>'next_step', '')), ''),
    agreement_type    = nullif(btrim(coalesce(p_patch->>'agreement_type', '')), ''),
    agreement_detail  = nullif(btrim(coalesce(p_patch->>'agreement_detail', '')), ''),
    internal_notes    = nullif(btrim(coalesce(p_patch->>'internal_notes', '')), ''),
    review_note       = nullif(btrim(coalesce(p_patch->>'review_note', '')), ''),
    follow_up_date    = v_follow_up,
    -- Los cuatro arrays: sólo si el patch trae la clave. Un elemento vacío se
    -- descarta (btrim + filtro), igual que el resto del repo normaliza '' → nada.
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
