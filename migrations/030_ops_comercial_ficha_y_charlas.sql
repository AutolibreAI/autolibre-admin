-- ═══════════════════════════════════════════════════════════════════════════
-- 030 — Comercial: la ficha completa del contacto y el historial de charlas.
--
-- Plan: `.claude/plans/comercial-fichas-charlas-chasis.md` (aprobado el
-- 2026-11-11). Se apoya entera en la 024 y no repite su justificación: es dato
-- de operación del equipo comercial, vive en `ops`, el backend no se entera.
--
-- ── QUÉ CAMBIA ────────────────────────────────────────────────────────────
--
--   1. La ficha suma: frente (Ruta 2 · Corredor Norte · Por pedido, con el
--      pedido), lo que se sabe del proveedor (conocía AutoLibre, cómo consigue
--      clientes, canal preferido, capacidad, sistema de gestión, red), los 4
--      checks de verificación, el motivo de descarte, el próximo paso y la
--      fecha de alta en el marketplace.
--   2. Los estados pasan a ser el embudo nuevo (ver el mapeo abajo).
--   3. Tabla nueva `ops.partner_prospect_interaction`: cada llamado, WhatsApp
--      o visita es una fila. APPEND-ONLY: no hay SP que edite ni borre una
--      charla. Una mal cargada se corrige cargando otra (decidido el
--      2026-11-11; si hace falta corregir, es una migración aparte).
--
-- ── "VERIFICADO" NO ES UNA COLUMNA ────────────────────────────────────────
--
-- Son los 4 checks en `true`. Se deriva al leer: una columna además sería una
-- segunda verdad que se desincroniza el día que alguien destilda un check.
--
-- ── LA CHARLA MUEVE EL CONTACTO, EN LA MISMA TRANSACCIÓN ──────────────────
--
-- `ops.add_partner_prospect_interaction` inserta la charla y actualiza el
-- contacto (estado, último contacto, próximo paso, próximo seguimiento) por
-- `ops.update_partner_prospect`, o sea por la MISMA normalización y con su
-- propia entrada de log. Así "Hoy", los contadores y el filtro "último
-- contacto" de Partners › Propuestas siguen leyendo las columnas de siempre.
--
-- **Sólo la charla MÁS RECIENTE mueve el contacto.** Cargar hoy un llamado de
-- la semana pasada la suma al historial pero no le pisa el estado ni el
-- próximo paso a lo que se habló ayer. `last_contact_on` tampoco retrocede.
--
-- ── LA FECHA DE ALTA ──────────────────────────────────────────────────────
--
-- Decidido el 2026-11-11: el alta es cuando el proveedor EXISTE en el
-- marketplace (`partners.created_at`, que para los que vienen de una
-- solicitud es el momento de la aprobación), en hora de Buenos Aires. Se fija
-- sola al vincular el contacto con un proveedor y se borra al desvincular;
-- se puede corregir a mano (`partner_registered_on`). Es la fecha con la que
-- se liquida a fin de mes, por eso se GUARDA y no se recalcula al leer.
--
-- ── EL MAPEO DE ESTADOS ───────────────────────────────────────────────────
--
--   pending          → to_contact
--   no_answer        → to_contact   (próximo paso "Volver a llamar" si no hay)
--   visit            → to_contact   (próximo paso "Ir en persona" si no hay)
--   thinking         → contacted
--   interested       → interested
--   registered       → registered
--   not_interested   → discarded    (motivo "No le interesa (estado anterior)")
--
-- Al 2026-11-11 en producción los 47 contactos están en `pending`.
--
-- ── LA ETIQUETA DE LA NOTA ────────────────────────────────────────────────
--
-- La importación de Ruta 2 escribió el frente al principio de la nota corta:
-- `[Ruta 2 · GPS Taller · km 121] Dirección: …`. El backfill lo pasa a los
-- campos: frente `ruta-2` (o `corredor-norte`), origen `gps-taller` cuando la
-- etiqueta dice "GPS Taller" y el origen era `scrapeo`, y la nota queda
-- empezando por lo que sobra de la etiqueta (`km 121 · Dirección: …`). No se
-- pierde nada. Es un UPDATE de migración, sin actor: no pasa por
-- `ops.action_log` (no hay sesión de la que sacar quién), y está escrito acá.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Columnas nuevas ───────────────────────────────────────────────────────

ALTER TABLE ops.partner_prospect
  ADD COLUMN IF NOT EXISTS front                   text,
  ADD COLUMN IF NOT EXISTS front_quote_request_id  uuid,
  ADD COLUMN IF NOT EXISTS knew_autolibre          boolean,
  ADD COLUMN IF NOT EXISTS client_acquisition      text,
  ADD COLUMN IF NOT EXISTS preferred_channel       text,
  ADD COLUMN IF NOT EXISTS has_capacity            boolean,
  ADD COLUMN IF NOT EXISTS management_system       text,
  ADD COLUMN IF NOT EXISTS network                 text,
  ADD COLUMN IF NOT EXISTS verify_test_response    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verify_identity         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verify_payment          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verify_reputation       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS discard_reason          text,
  ADD COLUMN IF NOT EXISTS next_step               text,
  ADD COLUMN IF NOT EXISTS partner_registered_on   date;

-- ── Estados: el CHECK viejo se va, los datos se mapean, entra el nuevo ────

ALTER TABLE ops.partner_prospect DROP CONSTRAINT IF EXISTS chk_ops_pp_status;
ALTER TABLE ops.partner_prospect ALTER COLUMN status SET DEFAULT 'to_contact';

UPDATE ops.partner_prospect SET
  next_step = CASE
    WHEN next_step IS NOT NULL THEN next_step
    WHEN status = 'no_answer' THEN 'Volver a llamar'
    WHEN status = 'visit'     THEN 'Ir en persona'
    ELSE NULL
  END,
  discard_reason = CASE
    WHEN status = 'not_interested' THEN coalesce(discard_reason, 'No le interesa (estado anterior)')
    ELSE discard_reason
  END,
  status = CASE status
    WHEN 'pending'        THEN 'to_contact'
    WHEN 'no_answer'      THEN 'to_contact'
    WHEN 'visit'          THEN 'to_contact'
    WHEN 'thinking'       THEN 'contacted'
    WHEN 'not_interested' THEN 'discarded'
    ELSE status
  END
WHERE status IN ('pending', 'no_answer', 'visit', 'thinking', 'not_interested');

-- ── Backfill del frente desde la etiqueta de la nota ──────────────────────

WITH tagged AS (
  SELECT id, origin_slug,
         string_to_array(substring(short_note FROM '^\[([^\]]*)\]'), ' · ') AS parts,
         btrim(regexp_replace(short_note, '^\[[^\]]*\]\s*', '')) AS rest
    FROM ops.partner_prospect
   WHERE short_note ~ '^\[[^\]]*\]' AND front IS NULL
), parsed AS (
  SELECT id, origin_slug, rest,
         CASE WHEN 'Ruta 2' = ANY (parts) THEN 'ruta-2'
              WHEN 'Corredor Norte' = ANY (parts) THEN 'corredor-norte' END AS front,
         'GPS Taller' = ANY (parts) AS gps,
         array_to_string(ARRAY(
           SELECT p FROM unnest(parts) WITH ORDINALITY AS u(p, i)
            WHERE p NOT IN ('Ruta 2', 'Corredor Norte', 'GPS Taller') ORDER BY i
         ), ' · ') AS leftover
    FROM tagged
)
UPDATE ops.partner_prospect pp SET
  front = parsed.front,
  origin_slug = CASE WHEN parsed.gps AND pp.origin_slug = 'scrapeo'
                       AND EXISTS (SELECT 1 FROM ops.partner_prospect_origin WHERE slug = 'gps-taller')
                     THEN 'gps-taller' ELSE pp.origin_slug END,
  short_note = nullif(btrim(concat_ws(' · ', nullif(parsed.leftover, ''), nullif(parsed.rest, ''))), '')
  FROM parsed
 WHERE pp.id = parsed.id AND parsed.front IS NOT NULL;

-- ── Restricciones nuevas ──────────────────────────────────────────────────

ALTER TABLE ops.partner_prospect
  ADD CONSTRAINT chk_ops_pp_status CHECK (status IN (
    'to_contact', 'contacted', 'interested', 'registered', 'first_order', 'job_confirmed', 'discarded'
  )),
  ADD CONSTRAINT chk_ops_pp_front CHECK (front IS NULL OR front IN ('ruta-2', 'corredor-norte', 'por-pedido')),
  ADD CONSTRAINT chk_ops_pp_front_quote CHECK (front_quote_request_id IS NULL OR front = 'por-pedido'),
  ADD CONSTRAINT chk_ops_pp_preferred_channel CHECK (preferred_channel IS NULL OR preferred_channel IN ('whatsapp', 'app_web')),
  ADD CONSTRAINT chk_ops_pp_discard_reason CHECK (status <> 'discarded' OR discard_reason IS NOT NULL),
  ADD CONSTRAINT chk_ops_pp_registered_on CHECK (partner_registered_on IS NULL OR partner_id IS NOT NULL),
  ADD CONSTRAINT chk_ops_pp_texts2_not_blank CHECK (
        (client_acquisition IS NULL OR btrim(client_acquisition) <> '')
    AND (management_system  IS NULL OR btrim(management_system)  <> '')
    AND (network            IS NULL OR btrim(network)            <> '')
    AND (discard_reason     IS NULL OR btrim(discard_reason)     <> '')
    AND (next_step          IS NULL OR btrim(next_step)          <> '')
  );

-- "Hoy": cerrados son ahora trabajo confirmado y descartado. Un registrado
-- todavía se sigue (falta que reciba su primer pedido).
DROP INDEX IF EXISTS ops.idx_ops_pp_follow_up;
CREATE INDEX IF NOT EXISTS idx_ops_pp_follow_up
  ON ops.partner_prospect (next_follow_up_on)
  WHERE next_follow_up_on IS NOT NULL AND status NOT IN ('job_confirmed', 'discarded');

-- ── Las charlas ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ops.partner_prospect_interaction (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ops → ops: la FK sí va (guardrail 6 es sobre `public`).
  prospect_id            uuid        NOT NULL REFERENCES ops.partner_prospect (id),
  occurred_at            timestamptz NOT NULL DEFAULT now(),

  channel                text        NOT NULL,
  answered               boolean,
  talked_to_decider      boolean,

  told_how_orders        boolean     NOT NULL DEFAULT false,
  told_profile           boolean     NOT NULL DEFAULT false,
  told_zone_demand       boolean     NOT NULL DEFAULT false,
  told_asistir24         boolean     NOT NULL DEFAULT false,

  offered_model          text,
  offered_amount         text,
  reaction               text,
  questions_answers      text,
  objection              text,
  objection_other        text,
  jobs_per_month_to_pay  int,
  pitch_notes            text,

  status_after           text        NOT NULL,
  discard_reason         text,
  next_step              text        NOT NULL,
  next_follow_up_on      date,

  actor_id               uuid        NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_ops_ppi_channel CHECK (channel IN ('call', 'whatsapp', 'visit')),
  CONSTRAINT chk_ops_ppi_model CHECK (offered_model IS NULL OR offered_model IN ('fee_per_job', 'free_plan', 'other')),
  CONSTRAINT chk_ops_ppi_reaction CHECK (reaction IS NULL OR reaction IN ('positive', 'neutral', 'negative')),
  CONSTRAINT chk_ops_ppi_objection CHECK (objection IS NULL OR objection IN (
    'not_enough_work', 'price', 'no_apps', 'distrust', 'enough_clients', 'not_now', 'other'
  )),
  CONSTRAINT chk_ops_ppi_objection_other CHECK ((objection = 'other') = (objection_other IS NOT NULL)),
  CONSTRAINT chk_ops_ppi_jobs CHECK (jobs_per_month_to_pay IS NULL OR jobs_per_month_to_pay BETWEEN 0 AND 10000),
  CONSTRAINT chk_ops_ppi_status CHECK (status_after IN (
    'to_contact', 'contacted', 'interested', 'registered', 'first_order', 'job_confirmed', 'discarded'
  )),
  CONSTRAINT chk_ops_ppi_discard CHECK (status_after <> 'discarded' OR discard_reason IS NOT NULL),
  CONSTRAINT chk_ops_ppi_texts_not_blank CHECK (
        btrim(next_step) <> ''
    AND (offered_amount    IS NULL OR btrim(offered_amount)    <> '')
    AND (questions_answers IS NULL OR btrim(questions_answers) <> '')
    AND (objection_other   IS NULL OR btrim(objection_other)   <> '')
    AND (pitch_notes       IS NULL OR btrim(pitch_notes)       <> '')
    AND (discard_reason    IS NULL OR btrim(discard_reason)    <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_ops_ppi_prospect
  ON ops.partner_prospect_interaction (prospect_id, occurred_at DESC);

-- ── La normalización, con las claves nuevas ───────────────────────────────
--
-- Misma firma que la 024: `CREATE OR REPLACE` reemplaza (no hay sobrecarga).
-- Reescribe la función ENTERA; las validaciones de la 024 se re-verifican en
-- la suite de la 030 (un reemplazo es donde se cae un `IF` sin que se note).

CREATE OR REPLACE FUNCTION ops._normalize_partner_prospect(
  p_base    jsonb,
  p_patch   jsonb,
  p_self_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v           jsonb := p_base;
  v_key       text;
  v_text      text;
  v_slugs     text[];
  v_bad       text;
  v_dup       uuid;
  v_date      date;
  v_bool      boolean;
  v_exists    boolean;
  v_old_partner text := p_base->>'partner_id';
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_PATCH'
      USING HINT = 'Se espera un objeto jsonb con las claves a cambiar.';
  END IF;

  SELECT k INTO v_bad
    FROM jsonb_object_keys(p_patch) k
   WHERE k NOT IN ('name', 'phone', 'locality', 'short_note', 'category_slugs', 'origin_slug',
                   'status', 'owner_id', 'talked_to', 'plan', 'last_contact_on',
                   'next_follow_up_on', 'notes', 'partner_id',
                   -- 030
                   'front', 'front_quote_request_id', 'knew_autolibre', 'client_acquisition',
                   'preferred_channel', 'has_capacity', 'management_system', 'network',
                   'verify_test_response', 'verify_identity', 'verify_payment', 'verify_reputation',
                   'discard_reason', 'next_step', 'partner_registered_on')
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'UNKNOWN_FIELD: %', v_bad;
  END IF;

  -- Textos: `''` y null borran. `name` no se puede borrar.
  FOREACH v_key IN ARRAY ARRAY['name', 'phone', 'locality', 'short_note', 'talked_to', 'notes',
                               'client_acquisition', 'management_system', 'network',
                               'discard_reason', 'next_step'] LOOP
    IF p_patch ? v_key THEN
      v_text := nullif(btrim(coalesce(p_patch->>v_key, '')), '');
      v := jsonb_set(v, ARRAY[v_key], coalesce(to_jsonb(v_text), 'null'::jsonb));
    END IF;
  END LOOP;

  IF nullif(btrim(coalesce(v->>'name', '')), '') IS NULL THEN
    RAISE EXCEPTION 'NAME_REQUIRED'
      USING HINT = 'El nombre del proveedor es lo único obligatorio.';
  END IF;

  v := jsonb_set(v, '{phone_digits}', coalesce(to_jsonb(ops.normalize_ar_phone(v->>'phone')), 'null'::jsonb));

  -- Booleanos que pueden no saberse (null = no se sabe).
  FOREACH v_key IN ARRAY ARRAY['knew_autolibre', 'has_capacity'] LOOP
    IF p_patch ? v_key THEN
      IF jsonb_typeof(p_patch->v_key) NOT IN ('boolean', 'null') THEN
        RAISE EXCEPTION 'INVALID_BOOLEAN: %', v_key;
      END IF;
      v := jsonb_set(v, ARRAY[v_key], p_patch->v_key);
    END IF;
  END LOOP;

  -- Los checks de verificación: null cuenta como no tildado.
  FOREACH v_key IN ARRAY ARRAY['verify_test_response', 'verify_identity', 'verify_payment',
                               'verify_reputation'] LOOP
    IF p_patch ? v_key THEN
      IF jsonb_typeof(p_patch->v_key) NOT IN ('boolean', 'null') THEN
        RAISE EXCEPTION 'INVALID_BOOLEAN: %', v_key;
      END IF;
      v_bool := coalesce((p_patch->>v_key)::boolean, false);
      v := jsonb_set(v, ARRAY[v_key], to_jsonb(v_bool));
    END IF;
  END LOOP;

  IF p_patch ? 'status' THEN
    v := jsonb_set(v, '{status}', to_jsonb(btrim(coalesce(p_patch->>'status', ''))));
  END IF;
  IF (v->>'status') NOT IN ('to_contact', 'contacted', 'interested', 'registered', 'first_order',
                            'job_confirmed', 'discarded') THEN
    RAISE EXCEPTION 'INVALID_PROSPECT_STATUS: %', v->>'status';
  END IF;
  -- Salir de descartado limpia el motivo; entrar lo exige.
  IF (v->>'status') <> 'discarded' THEN
    v := jsonb_set(v, '{discard_reason}', 'null'::jsonb);
  ELSIF v->>'discard_reason' IS NULL THEN
    RAISE EXCEPTION 'DISCARD_REASON_REQUIRED'
      USING HINT = 'Un contacto descartado lleva el motivo.';
  END IF;

  IF p_patch ? 'plan' THEN
    v := jsonb_set(v, '{plan}', to_jsonb(btrim(coalesce(p_patch->>'plan', ''))));
  END IF;
  IF (v->>'plan') NOT IN ('free', 'plus', 'undecided') THEN
    RAISE EXCEPTION 'INVALID_PLAN: %', v->>'plan'
      USING HINT = 'Valores válidos: free, plus, undecided.';
  END IF;

  IF p_patch ? 'preferred_channel' THEN
    v := jsonb_set(v, '{preferred_channel}',
                   coalesce(to_jsonb(nullif(btrim(coalesce(p_patch->>'preferred_channel', '')), '')), 'null'::jsonb));
  END IF;
  IF v->>'preferred_channel' IS NOT NULL AND (v->>'preferred_channel') NOT IN ('whatsapp', 'app_web') THEN
    RAISE EXCEPTION 'INVALID_PREFERRED_CHANNEL: %', v->>'preferred_channel';
  END IF;

  -- Frente. Dejar de ser "por pedido" suelta el pedido.
  IF p_patch ? 'front' THEN
    v := jsonb_set(v, '{front}', coalesce(to_jsonb(nullif(btrim(coalesce(p_patch->>'front', '')), '')), 'null'::jsonb));
  END IF;
  IF v->>'front' IS NOT NULL AND (v->>'front') NOT IN ('ruta-2', 'corredor-norte', 'por-pedido') THEN
    RAISE EXCEPTION 'INVALID_FRONT: %', v->>'front';
  END IF;
  IF p_patch ? 'front_quote_request_id' THEN
    v := jsonb_set(v, '{front_quote_request_id}', coalesce(p_patch->'front_quote_request_id', 'null'::jsonb));
  END IF;
  IF coalesce(v->>'front', '') <> 'por-pedido' THEN
    v := jsonb_set(v, '{front_quote_request_id}', 'null'::jsonb);
  ELSIF v->>'front_quote_request_id' IS NOT NULL THEN
    -- `quote_requests` es del backend y puede faltar en una base: se pregunta
    -- antes, y la consulta va por EXECUTE para que no se planifique sin tabla.
    IF to_regclass('public.quote_requests') IS NULL THEN
      RAISE EXCEPTION 'QUOTE_REQUEST_NOT_FOUND: %', v->>'front_quote_request_id';
    END IF;
    BEGIN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.quote_requests WHERE id = $1)'
        INTO v_exists USING (v->>'front_quote_request_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_exists := false;
    END;
    IF NOT v_exists THEN
      RAISE EXCEPTION 'QUOTE_REQUEST_NOT_FOUND: %', v->>'front_quote_request_id';
    END IF;
  END IF;

  IF p_patch ? 'origin_slug' THEN
    v := jsonb_set(v, '{origin_slug}', to_jsonb(btrim(coalesce(p_patch->>'origin_slug', ''))));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ops.partner_prospect_origin WHERE slug = v->>'origin_slug') THEN
    RAISE EXCEPTION 'INVALID_ORIGIN: %', v->>'origin_slug';
  END IF;

  IF p_patch ? 'category_slugs' THEN
    IF jsonb_typeof(p_patch->'category_slugs') <> 'array' THEN
      RAISE EXCEPTION 'INVALID_CATEGORY_SLUGS'
        USING HINT = 'Se espera un array de slugs de service_categories.';
    END IF;
    SELECT coalesce(array_agg(DISTINCT s ORDER BY s), '{}') INTO v_slugs
      FROM (SELECT nullif(btrim(x), '') AS s
              FROM jsonb_array_elements_text(p_patch->'category_slugs') x) t
     WHERE s IS NOT NULL;
    SELECT s INTO v_bad
      FROM unnest(v_slugs) s
     WHERE NOT EXISTS (SELECT 1 FROM service_categories sc WHERE sc.slug = s)
     LIMIT 1;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'INVALID_CATEGORY_SLUG: %', v_bad;
    END IF;
    v := jsonb_set(v, '{category_slugs}', to_jsonb(v_slugs));
  END IF;

  IF p_patch ? 'owner_id' THEN
    v := jsonb_set(v, '{owner_id}', coalesce(p_patch->'owner_id', 'null'::jsonb));
  END IF;
  BEGIN
    IF v->>'owner_id' IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM users WHERE id = (v->>'owner_id')::uuid) THEN
      RAISE EXCEPTION 'OWNER_NOT_FOUND: %', v->>'owner_id';
    END IF;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'OWNER_NOT_FOUND: %', v->>'owner_id';
  END;

  IF p_patch ? 'partner_id' THEN
    v := jsonb_set(v, '{partner_id}', coalesce(p_patch->'partner_id', 'null'::jsonb));
  END IF;
  BEGIN
    IF v->>'partner_id' IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM partners WHERE id = (v->>'partner_id')::uuid) THEN
      RAISE EXCEPTION 'PARTNER_NOT_FOUND: %', v->>'partner_id';
    END IF;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'PARTNER_NOT_FOUND: %', v->>'partner_id';
  END;

  -- Fechas, parseadas ANTES de escribir para traducir el error.
  FOREACH v_key IN ARRAY ARRAY['last_contact_on', 'next_follow_up_on', 'partner_registered_on'] LOOP
    IF p_patch ? v_key THEN
      BEGIN
        v_date := nullif(btrim(coalesce(p_patch->>v_key, '')), '')::date;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'INVALID_DATE: % = %', v_key, p_patch->>v_key
          USING HINT = 'Usá YYYY-MM-DD, o vacío para borrarla.';
      END;
      v := jsonb_set(v, ARRAY[v_key], coalesce(to_jsonb(v_date), 'null'::jsonb));
    END IF;
  END LOOP;

  -- La fecha de alta sigue al vínculo: sin proveedor no hay alta; al vincular
  -- (o cambiar de proveedor) se toma la del proveedor, salvo que el mismo
  -- parche traiga una a mano.
  IF v->>'partner_id' IS NULL THEN
    v := jsonb_set(v, '{partner_registered_on}', 'null'::jsonb);
  ELSIF (v->>'partner_id') IS DISTINCT FROM v_old_partner AND NOT (p_patch ? 'partner_registered_on') THEN
    v := jsonb_set(v, '{partner_registered_on}', coalesce((
      SELECT to_jsonb((pa.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)
        FROM partners pa WHERE pa.id = (v->>'partner_id')::uuid), 'null'::jsonb));
  END IF;

  IF v->>'phone_digits' IS NOT NULL THEN
    SELECT id INTO v_dup
      FROM ops.partner_prospect
     WHERE phone_digits = v->>'phone_digits'
       AND (p_self_id IS NULL OR id <> p_self_id)
     LIMIT 1;
    IF v_dup IS NOT NULL THEN
      RAISE EXCEPTION 'DUPLICATE_PHONE: %', v_dup
        USING HINT = 'Ya hay un contacto con ese teléfono.';
    END IF;
  END IF;

  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION ops._partner_prospect_defaults()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'name', NULL, 'phone', NULL, 'locality', NULL, 'short_note', NULL,
    'category_slugs', '[]'::jsonb, 'origin_slug', NULL, 'status', 'to_contact',
    'owner_id', NULL, 'talked_to', NULL, 'plan', 'undecided',
    'last_contact_on', NULL, 'next_follow_up_on', NULL, 'notes', NULL, 'partner_id', NULL,
    'front', NULL, 'front_quote_request_id', NULL, 'knew_autolibre', NULL,
    'client_acquisition', NULL, 'preferred_channel', NULL, 'has_capacity', NULL,
    'management_system', NULL, 'network', NULL,
    'verify_test_response', false, 'verify_identity', false, 'verify_payment', false,
    'verify_reputation', false, 'discard_reason', NULL, 'next_step', NULL,
    'partner_registered_on', NULL
  )
$$;

CREATE OR REPLACE FUNCTION ops._insert_partner_prospect(
  p_clean    jsonb,
  p_actor_id uuid,
  p_note     text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_id    uuid;
  v_after jsonb;
BEGIN
  BEGIN
    INSERT INTO ops.partner_prospect (
      name, phone, phone_digits, locality, short_note, category_slugs, origin_slug,
      status, owner_id, talked_to, plan, last_contact_on, next_follow_up_on, notes,
      partner_id, created_by,
      front, front_quote_request_id, knew_autolibre, client_acquisition, preferred_channel,
      has_capacity, management_system, network, verify_test_response, verify_identity,
      verify_payment, verify_reputation, discard_reason, next_step, partner_registered_on
    ) VALUES (
      p_clean->>'name', p_clean->>'phone', p_clean->>'phone_digits', p_clean->>'locality',
      p_clean->>'short_note',
      ARRAY(SELECT jsonb_array_elements_text(p_clean->'category_slugs')),
      p_clean->>'origin_slug', p_clean->>'status', (p_clean->>'owner_id')::uuid,
      p_clean->>'talked_to', p_clean->>'plan', (p_clean->>'last_contact_on')::date,
      (p_clean->>'next_follow_up_on')::date, p_clean->>'notes',
      (p_clean->>'partner_id')::uuid, p_actor_id,
      p_clean->>'front', (p_clean->>'front_quote_request_id')::uuid,
      (p_clean->>'knew_autolibre')::boolean, p_clean->>'client_acquisition',
      p_clean->>'preferred_channel', (p_clean->>'has_capacity')::boolean,
      p_clean->>'management_system', p_clean->>'network',
      (p_clean->>'verify_test_response')::boolean, (p_clean->>'verify_identity')::boolean,
      (p_clean->>'verify_payment')::boolean, (p_clean->>'verify_reputation')::boolean,
      p_clean->>'discard_reason', p_clean->>'next_step', (p_clean->>'partner_registered_on')::date
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_PHONE: %',
      (SELECT id FROM ops.partner_prospect WHERE phone_digits = p_clean->>'phone_digits' LIMIT 1);
  END;

  SELECT to_jsonb(p) INTO v_after FROM ops.partner_prospect p WHERE p.id = v_id;
  PERFORM ops.log_action(
    p_actor_id, 'partner_prospect.create', 'ops.partner_prospect', v_id, NULL, v_after, p_note
  );
  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION ops.update_partner_prospect(
  p_id       uuid,
  p_actor_id uuid,
  p_patch    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_clean  jsonb;
  v_after  jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  SELECT to_jsonb(p) INTO v_before FROM ops.partner_prospect p WHERE p.id = p_id FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'PROSPECT_NOT_FOUND: %', p_id;
  END IF;

  v_clean := ops._normalize_partner_prospect(v_before, p_patch, p_id);

  BEGIN
    UPDATE ops.partner_prospect SET
      name                   = v_clean->>'name',
      phone                  = v_clean->>'phone',
      phone_digits           = v_clean->>'phone_digits',
      locality               = v_clean->>'locality',
      short_note             = v_clean->>'short_note',
      category_slugs         = ARRAY(SELECT jsonb_array_elements_text(v_clean->'category_slugs')),
      origin_slug            = v_clean->>'origin_slug',
      status                 = v_clean->>'status',
      owner_id               = (v_clean->>'owner_id')::uuid,
      talked_to              = v_clean->>'talked_to',
      plan                   = v_clean->>'plan',
      last_contact_on        = (v_clean->>'last_contact_on')::date,
      next_follow_up_on      = (v_clean->>'next_follow_up_on')::date,
      notes                  = v_clean->>'notes',
      partner_id             = (v_clean->>'partner_id')::uuid,
      front                  = v_clean->>'front',
      front_quote_request_id = (v_clean->>'front_quote_request_id')::uuid,
      knew_autolibre         = (v_clean->>'knew_autolibre')::boolean,
      client_acquisition     = v_clean->>'client_acquisition',
      preferred_channel      = v_clean->>'preferred_channel',
      has_capacity           = (v_clean->>'has_capacity')::boolean,
      management_system      = v_clean->>'management_system',
      network                = v_clean->>'network',
      verify_test_response   = (v_clean->>'verify_test_response')::boolean,
      verify_identity        = (v_clean->>'verify_identity')::boolean,
      verify_payment         = (v_clean->>'verify_payment')::boolean,
      verify_reputation      = (v_clean->>'verify_reputation')::boolean,
      discard_reason         = v_clean->>'discard_reason',
      next_step              = v_clean->>'next_step',
      partner_registered_on  = (v_clean->>'partner_registered_on')::date,
      updated_at             = now()
    WHERE id = p_id
      -- Un autoguardado que no cambió nada no es un hecho: ni `updated_at` ni log.
      AND (to_jsonb(partner_prospect) - 'updated_at')
          IS DISTINCT FROM (v_clean - 'updated_at');
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_PHONE: %',
      (SELECT id FROM ops.partner_prospect
        WHERE phone_digits = v_clean->>'phone_digits' AND id <> p_id LIMIT 1);
  END;

  SELECT to_jsonb(p) INTO v_after FROM ops.partner_prospect p WHERE p.id = p_id;
  IF (v_after - 'updated_at') IS DISTINCT FROM (v_before - 'updated_at') THEN
    PERFORM ops.log_action(
      p_actor_id, 'partner_prospect.update', 'ops.partner_prospect', p_id,
      v_before, v_after, NULL
    );
  END IF;
  RETURN v_after;
END;
$$;

-- ── Cargar una charla ─────────────────────────────────────────────────────

/**
 * Una charla con el proveedor (llamado, WhatsApp o visita).
 *
 * Obligatorios: canal, estado en que queda el contacto y próximo paso. La
 * fecha es ahora salvo que venga `occurred_at` (cargar una de ayer), y no
 * puede ser futura. Devuelve `{interaction, prospect}`.
 *
 * Si es la más reciente del contacto, lo mueve (ver la cabecera). Valida
 * representabilidad, no decide nada: qué estado corresponde lo elige quien
 * habló con el proveedor.
 */
CREATE OR REPLACE FUNCTION ops.add_partner_prospect_interaction(
  p_prospect_id uuid,
  p_actor_id    uuid,
  p_data        jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_bad       text;
  v_key       text;
  v_prospect  jsonb;
  v_at        timestamptz;
  v_day       date;
  v_next      date;
  v_jobs      int;
  v_status    text;
  v_reason    text;
  v_step      text;
  v_objection text;
  v_other     text;
  v_latest    timestamptz;
  v_id        uuid;
  v_row       jsonb;
  v_patch     jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_INTERACTION'
      USING HINT = 'Se espera un objeto jsonb.';
  END IF;

  SELECT k INTO v_bad
    FROM jsonb_object_keys(p_data) k
   WHERE k NOT IN ('occurred_at', 'channel', 'answered', 'talked_to_decider', 'told_how_orders',
                   'told_profile', 'told_zone_demand', 'told_asistir24', 'offered_model',
                   'offered_amount', 'reaction', 'questions_answers', 'objection', 'objection_other',
                   'jobs_per_month_to_pay', 'pitch_notes', 'status_after', 'discard_reason',
                   'next_step', 'next_follow_up_on')
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'UNKNOWN_FIELD: %', v_bad;
  END IF;

  -- El contacto, bloqueado: dos charlas a la vez se serializan.
  SELECT to_jsonb(p) INTO v_prospect FROM ops.partner_prospect p WHERE p.id = p_prospect_id FOR UPDATE;
  IF v_prospect IS NULL THEN
    RAISE EXCEPTION 'PROSPECT_NOT_FOUND: %', p_prospect_id;
  END IF;

  IF coalesce(p_data->>'channel', '') NOT IN ('call', 'whatsapp', 'visit') THEN
    RAISE EXCEPTION 'INVALID_CHANNEL: %', coalesce(p_data->>'channel', '(vacío)')
      USING HINT = 'Canal: call, whatsapp o visit.';
  END IF;

  v_status := btrim(coalesce(p_data->>'status_after', ''));
  IF v_status NOT IN ('to_contact', 'contacted', 'interested', 'registered', 'first_order',
                      'job_confirmed', 'discarded') THEN
    RAISE EXCEPTION 'INVALID_PROSPECT_STATUS: %', v_status;
  END IF;
  v_reason := nullif(btrim(coalesce(p_data->>'discard_reason', '')), '');
  IF v_status = 'discarded' AND v_reason IS NULL THEN
    RAISE EXCEPTION 'DISCARD_REASON_REQUIRED';
  END IF;
  IF v_status <> 'discarded' THEN
    v_reason := NULL;
  END IF;

  v_step := nullif(btrim(coalesce(p_data->>'next_step', '')), '');
  IF v_step IS NULL THEN
    RAISE EXCEPTION 'NEXT_STEP_REQUIRED';
  END IF;

  FOREACH v_key IN ARRAY ARRAY['answered', 'talked_to_decider', 'told_how_orders', 'told_profile',
                               'told_zone_demand', 'told_asistir24'] LOOP
    IF p_data ? v_key AND jsonb_typeof(p_data->v_key) NOT IN ('boolean', 'null') THEN
      RAISE EXCEPTION 'INVALID_BOOLEAN: %', v_key;
    END IF;
  END LOOP;

  IF nullif(p_data->>'offered_model', '') IS NOT NULL
     AND (p_data->>'offered_model') NOT IN ('fee_per_job', 'free_plan', 'other') THEN
    RAISE EXCEPTION 'INVALID_OFFERED_MODEL: %', p_data->>'offered_model';
  END IF;
  IF nullif(p_data->>'reaction', '') IS NOT NULL
     AND (p_data->>'reaction') NOT IN ('positive', 'neutral', 'negative') THEN
    RAISE EXCEPTION 'INVALID_REACTION: %', p_data->>'reaction';
  END IF;

  v_objection := nullif(btrim(coalesce(p_data->>'objection', '')), '');
  v_other := nullif(btrim(coalesce(p_data->>'objection_other', '')), '');
  IF v_objection IS NOT NULL AND v_objection NOT IN ('not_enough_work', 'price', 'no_apps', 'distrust',
                                                     'enough_clients', 'not_now', 'other') THEN
    RAISE EXCEPTION 'INVALID_OBJECTION: %', v_objection;
  END IF;
  IF v_objection = 'other' AND v_other IS NULL THEN
    RAISE EXCEPTION 'OBJECTION_OTHER_REQUIRED'
      USING HINT = 'Con "Otra", escribí cuál.';
  END IF;
  IF v_objection IS DISTINCT FROM 'other' THEN
    v_other := NULL;
  END IF;

  BEGIN
    v_jobs := nullif(btrim(coalesce(p_data->>'jobs_per_month_to_pay', '')), '')::int;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'INVALID_JOBS_PER_MONTH: %', p_data->>'jobs_per_month_to_pay';
  END;
  IF v_jobs IS NOT NULL AND (v_jobs < 0 OR v_jobs > 10000) THEN
    RAISE EXCEPTION 'INVALID_JOBS_PER_MONTH: %', v_jobs;
  END IF;

  BEGIN
    v_at := coalesce(nullif(btrim(coalesce(p_data->>'occurred_at', '')), '')::timestamptz, now());
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'INVALID_DATE: occurred_at = %', p_data->>'occurred_at';
  END;
  -- Cinco minutos de tolerancia por relojes de teléfono adelantados.
  IF v_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'INTERACTION_IN_FUTURE'
      USING HINT = 'Una charla es algo que ya pasó.';
  END IF;

  BEGIN
    v_next := nullif(btrim(coalesce(p_data->>'next_follow_up_on', '')), '')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'INVALID_DATE: next_follow_up_on = %', p_data->>'next_follow_up_on';
  END;

  -- La más reciente hasta ahora (antes de insertar ésta).
  SELECT max(occurred_at) INTO v_latest
    FROM ops.partner_prospect_interaction WHERE prospect_id = p_prospect_id;

  INSERT INTO ops.partner_prospect_interaction (
    prospect_id, occurred_at, channel, answered, talked_to_decider,
    told_how_orders, told_profile, told_zone_demand, told_asistir24,
    offered_model, offered_amount, reaction, questions_answers, objection, objection_other,
    jobs_per_month_to_pay, pitch_notes, status_after, discard_reason, next_step,
    next_follow_up_on, actor_id
  ) VALUES (
    p_prospect_id, v_at, p_data->>'channel',
    (p_data->>'answered')::boolean, (p_data->>'talked_to_decider')::boolean,
    coalesce((p_data->>'told_how_orders')::boolean, false),
    coalesce((p_data->>'told_profile')::boolean, false),
    coalesce((p_data->>'told_zone_demand')::boolean, false),
    coalesce((p_data->>'told_asistir24')::boolean, false),
    nullif(p_data->>'offered_model', ''),
    nullif(btrim(coalesce(p_data->>'offered_amount', '')), ''),
    nullif(p_data->>'reaction', ''),
    nullif(btrim(coalesce(p_data->>'questions_answers', '')), ''),
    v_objection, v_other, v_jobs,
    nullif(btrim(coalesce(p_data->>'pitch_notes', '')), ''),
    v_status, v_reason, v_step, v_next, p_actor_id
  )
  RETURNING id INTO v_id;

  SELECT to_jsonb(i) INTO v_row FROM ops.partner_prospect_interaction i WHERE i.id = v_id;
  PERFORM ops.log_action(
    p_actor_id, 'partner_prospect_interaction.create', 'ops.partner_prospect_interaction', v_id,
    NULL, v_row, NULL
  );

  -- El contacto. Sólo si es la charla más reciente; `last_contact_on` nunca
  -- retrocede.
  v_day := (v_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
  IF v_latest IS NULL OR v_at >= v_latest THEN
    v_patch := jsonb_build_object(
      'status', v_status,
      'discard_reason', v_reason,
      'next_step', v_step,
      'next_follow_up_on', v_next
    );
  ELSE
    v_patch := '{}'::jsonb;
  END IF;
  IF (v_prospect->>'last_contact_on') IS NULL OR v_day > (v_prospect->>'last_contact_on')::date THEN
    v_patch := v_patch || jsonb_build_object('last_contact_on', v_day);
  END IF;

  IF v_patch <> '{}'::jsonb THEN
    v_prospect := ops.update_partner_prospect(p_prospect_id, p_actor_id, v_patch);
  END IF;

  RETURN jsonb_build_object('interaction', v_row, 'prospect', v_prospect);
END;
$$;
