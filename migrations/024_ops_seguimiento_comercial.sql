-- ═══════════════════════════════════════════════════════════════════════════
-- 024 — Seguimiento comercial: los proveedores que contacta el equipo.
--
-- Tobías (y a veces Nicolás) sale a buscar proveedores para el marketplace:
-- llama, va en persona, vuelve a llamar. Hasta hoy eso vivía en un tablero
-- suelto sólo para la Ruta 2. Esta migración le da una tabla a TODOS los
-- contactos, de cualquier origen.
--
-- ── POR QUÉ ACÁ Y NO EN UNA TABLA QUE YA EXISTA ───────────────────────────
--
-- Se relevaron las dos candidatas el 2026-10-29 y ninguna sirve:
--
--   * `public.partner_applications` es el proveedor VINIENDO HACIA NOSOTROS
--     (se postuló por el formulario). Esto es lo opuesto: nosotros yendo hacia
--     él. Además exige `email` y `address` (NOT NULL), que un contacto de una
--     base scrapeada no tiene, y su `status` es otro embudo. Mezclarlos
--     ensuciaría las métricas de Solicitudes sin que nada lo delate.
--   * `public.leads` es el USUARIO yendo hacia un proveedor.
--
-- Y el backend no tiene ningún camino para esto (no hay nada de "prospectos"
-- en `marketplace/`). Es dato de OPERACIÓN del equipo comercial: nadie de la
-- app lo lee. Mismo criterio que `ops.quote_request_response` (015): vive en
-- `ops`, el schema de este panel, y el repo del backend no se entera.
--
-- ── VOCABULARIO: `partner_prospect` ───────────────────────────────────────
--
-- Regla dura 7: se dice `Partner`, nunca `Provider` (ese sufijo es de las
-- integraciones externas). Un prospecto es alguien que TODAVÍA no es partner.
-- La UI dice "contacto" y "proveedor", que es como habla el equipo.
--
-- ── LOS 8 GUARDRAILS, IGUAL QUE 007–022 ───────────────────────────────────
--
--   1. Vive en `migrations/`, nunca DDL a mano.
--   2. SECURITY INVOKER (el default). El control de acceso es de `adminMiddleware`.
--   3. `SET search_path` fijo en cada función.
--   4. `p_actor_id` sale de la sesión de Clerk, JAMÁS del payload.
--   5. Escribe `ops.action_log` DENTRO de la función, con `before`/`after`.
--   6. **Ninguna FK cruza a `public`**: `partner_id`, `owner_id`, `created_by`
--      son UUID pelados, y las categorías son slugs validados por la función.
--      La FK a `ops.partner_prospect_origin` sí existe: es ops → ops.
--   7. `SELECT … FOR UPDATE` antes de editar. El alta no lockea (no hay fila).
--   8. `updated_at` lo escribe la función: en `ops` no hay trigger.
--
-- ── LA EDICIÓN ES UN PARCHE, NO UN REEMPLAZO — y es a propósito ───────────
--
-- Las otras escrituras de `ops` mandan el formulario entero. Ésta no puede:
-- la pantalla AUTOGUARDA campo por campo (con debounce en los textos). Si cada
-- guardado mandara la fila completa, una nota que se tipea en la tarjeta y un
-- cambio de estado que se guarda medio segundo antes se pisarían entre sí con
-- el valor viejo del otro. Con parche, cada guardado toca sólo su clave
-- (`p_patch ? 'x'`): una clave ausente no se toca, una presente con `''` o
-- `null` borra.
--
-- ── EL TELÉFONO SE NORMALIZA ACÁ, Y ES LA VERDAD ──────────────────────────
--
-- `phone` guarda lo que se tipeó; `phone_digits` la forma canónica
-- `549` + 10 dígitos (la de `wa.me`). Los duplicados se detectan sobre
-- `phone_digits` con un índice ÚNICO: un mismo proveedor no puede estar dos
-- veces, ni por el alta manual ni por una importación. La normalización vive
-- en `ops.normalize_ar_phone` y `~/lib/partner-prospects` tiene un ESPEJO
-- para la vista previa del CSV y el botón de WhatsApp. Si divergen, la vista
-- previa dice "nuevo" y la función lo rechaza como duplicado: falla fuerte,
-- nunca guarda dos veces.
--
-- Nunca se adivina una característica: un número de 8 dígitos o un "15"
-- suelto sin código de área quedan sin `phone_digits` (sin WhatsApp y sin
-- chequeo de duplicado), y la tarjeta lo dice.
--
-- ── LO QUE NO DECIDE ──────────────────────────────────────────────────────
--
--   * **No exige el vínculo con el proveedor para pasar a `registered`.** La
--     pantalla lo pide en ese momento; la función sólo valida que el partner
--     exista si viene.
--   * **No exige que el comercial sea admin**, sólo que exista en `users`.
--   * **No mueve fechas solas** (no sella "último contacto" al cambiar de
--     estado). Las carga la persona.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Orígenes: la lista se amplía desde el panel, sin tocar código ─────────

CREATE TABLE IF NOT EXISTS ops.partner_prospect_origin (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text        NOT NULL UNIQUE,
  label      text        NOT NULL,
  position   int         NOT NULL DEFAULT 100,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_ops_ppo_slug CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT chk_ops_ppo_label CHECK (btrim(label) <> '')
);

INSERT INTO ops.partner_prospect_origin (slug, label, position) VALUES
  ('ruta-2',     'Ruta 2',            10),
  ('referido',   'Referido',          20),
  ('meli',       'Contactos de MeLi', 30),
  ('gps-taller', 'Red GPS Taller',    40),
  ('scrapeo',    'Scrapeo',           50),
  ('otro',       'Otro',              90)
ON CONFLICT (slug) DO NOTHING;

-- ── Los contactos ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ops.partner_prospect (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- La ficha.
  name              text        NOT NULL,
  phone             text,
  phone_digits      text,
  locality          text,
  short_note        text,

  -- Rubros: slugs de `public.service_categories`, validados por la función
  -- (sin FK, guardrail 6). Los mismos 17 del marketplace, no una lista nuestra.
  category_slugs    text[]      NOT NULL DEFAULT '{}',
  origin_slug       text        NOT NULL REFERENCES ops.partner_prospect_origin (slug),

  -- El seguimiento.
  status            text        NOT NULL DEFAULT 'pending',
  owner_id          uuid,
  talked_to         text,
  plan              text        NOT NULL DEFAULT 'undecided',
  last_contact_on   date,
  next_follow_up_on date,
  notes             text,

  -- El proveedor real del marketplace, cuando se registró.
  partner_id        uuid,

  created_by        uuid        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_ops_pp_status CHECK (status IN (
    'pending', 'no_answer', 'visit', 'thinking', 'interested', 'registered', 'not_interested'
  )),
  CONSTRAINT chk_ops_pp_plan CHECK (plan IN ('free', 'plus', 'undecided')),
  CONSTRAINT chk_ops_pp_phone_digits CHECK (phone_digits IS NULL OR phone_digits ~ '^549[0-9]{10}$'),
  CONSTRAINT chk_ops_pp_texts_not_blank CHECK (
        btrim(name) <> ''
    AND (phone IS NULL      OR btrim(phone) <> '')
    AND (locality IS NULL   OR btrim(locality) <> '')
    AND (short_note IS NULL OR btrim(short_note) <> '')
    AND (talked_to IS NULL  OR btrim(talked_to) <> '')
    AND (notes IS NULL      OR btrim(notes) <> '')
  )
);

-- La detección de duplicados. Parcial: un contacto sin teléfono reconocible no
-- choca con nada (no hay con qué compararlo).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_pp_phone_digits_unique
  ON ops.partner_prospect (phone_digits)
  WHERE phone_digits IS NOT NULL;

-- La vista "Hoy": seguimientos con fecha, de contactos que siguen abiertos.
CREATE INDEX IF NOT EXISTS idx_ops_pp_follow_up
  ON ops.partner_prospect (next_follow_up_on)
  WHERE next_follow_up_on IS NOT NULL AND status NOT IN ('registered', 'not_interested');

-- ── Teléfono ──────────────────────────────────────────────────────────────

/**
 * `549` + 10 dígitos, o NULL. Acepta lo que se tipea de verdad:
 * `11 2512-0472`, `011 2512 0472`, `+54 9 11 2512 0472`, `54 11 2512 0472`,
 * `11 15 2512 0472` (el "15" sólo se saca con el 11, donde el código de área
 * no es ambiguo). Cualquier otra cosa es NULL: completar una característica
 * sería adivinar, y adivinar mal le escribe a otra persona.
 *
 * Espejado en `normalizeArPhone` de `~/lib/partner-prospects`.
 */
CREATE OR REPLACE FUNCTION ops.normalize_ar_phone(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN v ~ '^549[0-9]{10}$'        THEN v
    WHEN v ~ '^54[0-9]{10}$'         THEN '549' || substr(v, 3)
    WHEN v ~ '^0?1115[0-9]{8}$'      THEN '54911' || right(v, 8)
    WHEN v ~ '^0[0-9]{10}$'          THEN '549' || substr(v, 2)
    WHEN v ~ '^(11[0-9]{8}|[23][0-9]{9})$' THEN '549' || v
    ELSE NULL
  END
  FROM (SELECT regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') AS v) d
$$;

-- ── Piezas compartidas ────────────────────────────────────────────────────

/**
 * Aplica un parche sobre una fila (o sobre los defaults, en el alta), valida
 * el resultado y lo devuelve limpio.
 *
 * Una sola función para el alta, la edición y la importación: un `IF` que sólo
 * esté en una de las tres es un dato que entra por las otras dos.
 *
 * `p_self_id` es el id de la fila que se edita (NULL en el alta), para que el
 * chequeo de duplicado no choque consigo mismo.
 */
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
  v        jsonb := p_base;
  v_key    text;
  v_text   text;
  v_slugs  text[];
  v_bad    text;
  v_dup    uuid;
  v_date   date;
BEGIN
  -- `jsonb_set` es STRICT: con un valor NULL devuelve NULL y se lleva la fila
  -- entera. Por eso cada valor que puede faltar va con `coalesce(…, 'null')`.
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_PATCH'
      USING HINT = 'Se espera un objeto jsonb con las claves a cambiar.';
  END IF;

  -- Claves desconocidas: un typo en el nombre de una clave sería un guardado
  -- que "funciona" y no guarda nada.
  SELECT k INTO v_bad
    FROM jsonb_object_keys(p_patch) k
   WHERE k NOT IN ('name', 'phone', 'locality', 'short_note', 'category_slugs', 'origin_slug',
                   'status', 'owner_id', 'talked_to', 'plan', 'last_contact_on',
                   'next_follow_up_on', 'notes', 'partner_id')
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'UNKNOWN_FIELD: %', v_bad;
  END IF;

  -- Textos: `''` y null borran. `name` no se puede borrar.
  FOREACH v_key IN ARRAY ARRAY['name', 'phone', 'locality', 'short_note', 'talked_to', 'notes'] LOOP
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

  IF p_patch ? 'status' THEN
    v := jsonb_set(v, '{status}', to_jsonb(btrim(coalesce(p_patch->>'status', ''))));
  END IF;
  IF (v->>'status') NOT IN ('pending', 'no_answer', 'visit', 'thinking', 'interested',
                            'registered', 'not_interested') THEN
    RAISE EXCEPTION 'INVALID_PROSPECT_STATUS: %', v->>'status';
  END IF;

  IF p_patch ? 'plan' THEN
    v := jsonb_set(v, '{plan}', to_jsonb(btrim(coalesce(p_patch->>'plan', ''))));
  END IF;
  IF (v->>'plan') NOT IN ('free', 'plus', 'undecided') THEN
    RAISE EXCEPTION 'INVALID_PLAN: %', v->>'plan'
      USING HINT = 'Valores válidos: free, plus, undecided.';
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

  -- UUIDs: que existan. El cast inválido se traduce a la misma sentinela.
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
  FOREACH v_key IN ARRAY ARRAY['last_contact_on', 'next_follow_up_on'] LOOP
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

  -- Duplicado: se busca antes para devolver QUIÉN es el otro; el índice único
  -- es la red por si dos altas corren a la vez.
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

-- Los defaults del alta, en un solo lugar (el parche se aplica encima).
CREATE OR REPLACE FUNCTION ops._partner_prospect_defaults()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'name', NULL, 'phone', NULL, 'locality', NULL, 'short_note', NULL,
    'category_slugs', '[]'::jsonb, 'origin_slug', NULL, 'status', 'pending',
    'owner_id', NULL, 'talked_to', NULL, 'plan', 'undecided',
    'last_contact_on', NULL, 'next_follow_up_on', NULL, 'notes', NULL, 'partner_id', NULL
  )
$$;

/** INSERT de una fila ya normalizada. Compartido por el alta y la importación. */
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
      partner_id, created_by
    ) VALUES (
      p_clean->>'name', p_clean->>'phone', p_clean->>'phone_digits', p_clean->>'locality',
      p_clean->>'short_note',
      ARRAY(SELECT jsonb_array_elements_text(p_clean->'category_slugs')),
      p_clean->>'origin_slug', p_clean->>'status', (p_clean->>'owner_id')::uuid,
      p_clean->>'talked_to', p_clean->>'plan', (p_clean->>'last_contact_on')::date,
      (p_clean->>'next_follow_up_on')::date, p_clean->>'notes',
      (p_clean->>'partner_id')::uuid, p_actor_id
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

-- ── Alta ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ops.create_partner_prospect(
  p_actor_id uuid,
  p_data     jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  RETURN ops._insert_partner_prospect(
    ops._normalize_partner_prospect(ops._partner_prospect_defaults(), p_data, NULL),
    p_actor_id,
    NULL
  );
END;
$$;

-- ── Edición (parche) ──────────────────────────────────────────────────────

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
      name              = v_clean->>'name',
      phone             = v_clean->>'phone',
      phone_digits      = v_clean->>'phone_digits',
      locality          = v_clean->>'locality',
      short_note        = v_clean->>'short_note',
      category_slugs    = ARRAY(SELECT jsonb_array_elements_text(v_clean->'category_slugs')),
      origin_slug       = v_clean->>'origin_slug',
      status            = v_clean->>'status',
      owner_id          = (v_clean->>'owner_id')::uuid,
      talked_to         = v_clean->>'talked_to',
      plan              = v_clean->>'plan',
      last_contact_on   = (v_clean->>'last_contact_on')::date,
      next_follow_up_on = (v_clean->>'next_follow_up_on')::date,
      notes             = v_clean->>'notes',
      partner_id        = (v_clean->>'partner_id')::uuid,
      updated_at        = now()
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

-- ── Importación ───────────────────────────────────────────────────────────

/**
 * Importar una tanda (un CSV de una base scrapeada).
 *
 * Los DUPLICADOS por teléfono no cortan la tanda: se saltean y se devuelven
 * con el id del contacto existente (contra la base y contra filas anteriores
 * de la misma tanda — se insertan en orden, así que es el mismo chequeo). Un
 * error de VALIDACIÓN sí corta todo, con el número de fila: la vista previa ya
 * validó, así que una fila inválida acá es un bug y no se importa a medias.
 *
 * Cada alta queda en `ops.action_log` con la nota `import`.
 */
CREATE OR REPLACE FUNCTION ops.import_partner_prospects(
  p_actor_id uuid,
  p_rows     jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_row     jsonb;
  v_index   int := 0;
  v_clean   jsonb;
  v_created jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_after   jsonb;
  v_msg     text;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_IMPORT'
      USING HINT = 'Se espera un array de objetos.';
  END IF;
  IF jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'IMPORT_EMPTY';
  END IF;
  IF jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'IMPORT_TOO_LARGE: %', jsonb_array_length(p_rows)
      USING HINT = 'Hasta 2000 filas por tanda.';
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    BEGIN
      v_clean := ops._normalize_partner_prospect(ops._partner_prospect_defaults(), v_row, NULL);
      v_after := ops._insert_partner_prospect(v_clean, p_actor_id, 'import');
      v_created := v_created || jsonb_build_array(v_after->>'id');
    EXCEPTION WHEN raise_exception THEN
      v_msg := SQLERRM;
      IF v_msg LIKE 'DUPLICATE_PHONE:%' THEN
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'index', v_index,
          'existing_id', btrim(substr(v_msg, length('DUPLICATE_PHONE:') + 1))
        ));
      ELSE
        RAISE EXCEPTION 'IMPORT_ROW_INVALID: %: %', v_index, v_msg;
      END IF;
    END;
    v_index := v_index + 1;
  END LOOP;

  RETURN jsonb_build_object('created', v_created, 'skipped', v_skipped);
END;
$$;

-- ── Orígenes ──────────────────────────────────────────────────────────────

/** Sumar un origen. Idempotente por slug: si ya existe, lo devuelve sin loguear. */
CREATE OR REPLACE FUNCTION ops.add_partner_prospect_origin(
  p_actor_id uuid,
  p_slug     text,
  p_label    text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_slug  text := btrim(coalesce(p_slug, ''));
  v_label text := btrim(coalesce(p_label, ''));
  v_row   jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF v_label = '' THEN
    RAISE EXCEPTION 'ORIGIN_LABEL_REQUIRED';
  END IF;
  IF v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'INVALID_ORIGIN_SLUG: %', v_slug;
  END IF;

  SELECT to_jsonb(o) INTO v_row FROM ops.partner_prospect_origin o WHERE o.slug = v_slug;
  IF v_row IS NOT NULL THEN
    RETURN v_row;
  END IF;

  INSERT INTO ops.partner_prospect_origin (slug, label, created_by)
  VALUES (v_slug, v_label, p_actor_id)
  RETURNING to_jsonb(partner_prospect_origin.*) INTO v_row;

  PERFORM ops.log_action(
    p_actor_id, 'partner_prospect_origin.create', 'ops.partner_prospect_origin',
    (v_row->>'id')::uuid, NULL, v_row, NULL
  );
  RETURN v_row;
END;
$$;
