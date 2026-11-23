-- ═══════════════════════════════════════════════════════════════════════════
-- 035 — "Alta por": quién del equipo trajo cada solicitud de alta de
-- proveedor, y el catálogo de personas del equipo.
--
-- Para qué: tener el historial, contar altas por persona (semana / mes) y
-- liquidar comisiones. Vale para las solicitudes nuevas y para las viejas: los
-- comerciales recorren las del pasado y se asignan las suyas.
--
-- ── POR QUÉ EN `ops` ──────────────────────────────────────────────────────
--
-- Es dato de operación del equipo, nadie de la app lo lee, y `ops` es del
-- panel (decisión 3 del CLAUDE.md): sin tocar `public` ni el backend. La
-- solicitud se referencia por UUID pelado (guardrail 6: ninguna FK cruza a
-- `public`); las FKs ops → ops sí van.
--
-- ── NO ES `reviewed_by_id` NI `how_found` ─────────────────────────────────
--
-- `partner_applications.reviewed_by_id` es quién la REVISÓ en el panel, y
-- `how_found` es lo que DECLARÓ el proveedor en el formulario. "Alta por" es
-- otra pregunta —quién del equipo lo trajo— y no se deriva de ninguna de las
-- dos. No se pisan ni se reutilizan.
--
-- ── EL CATÁLOGO NO DEPENDE DE TENER CUENTA ────────────────────────────────
--
-- `ops.team_member.user_id` es OPCIONAL: no todo comercial entra al panel.
-- Cuando está, sirve para el botón "Es mío" y para que Comercial ofrezca a
-- esa persona como "Conseguido por" (`ops.partner_prospect.owner_id` sigue
-- siendo un `users.id`: decidido el 2026-11-20, opción A).
--
-- Una persona inactiva no se ofrece para asignar altas NUEVAS, pero sigue
-- apareciendo en las que ya tiene. El SP lo hace cumplir (`MEMBER_INACTIVE`).
--
-- ── EL HISTORIAL ──────────────────────────────────────────────────────────
--
-- `ops.partner_application_sourcer` es la asignación VIGENTE (una fila por
-- solicitud). `ops.partner_application_sourcer_log` es append-only: cada
-- cambio, con antes → después, quién y cuándo. Además va a `ops.action_log`
-- como todo SP de `ops` (guardrail 5).
--
-- ── EL CONTROL DE "PISADA" ────────────────────────────────────────────────
--
-- `ops.set_application_sourcer` recibe la asignación que el operador VIO
-- (`p_expected_member_id`, NULL = "sin asignar"). Si cambió mientras tanto
-- devuelve `SOURCER_CHANGED` y la pantalla vuelve a preguntar: así el botón
-- "Es mío" nunca pisa en silencio lo que otro cargó un segundo antes.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Catálogo de personas del equipo ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS ops.team_member (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL,
  role            text        NOT NULL,
  active          boolean     NOT NULL DEFAULT true,
  -- Fechas en hora de Buenos Aires (son días, no instantes).
  active_since    date        NOT NULL DEFAULT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
  inactive_since  date,
  -- `users.id` del panel, opcional. Sin FK (guardrail 6).
  user_id         uuid,
  -- NULL = sembrada por la migración.
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_ops_tm_role CHECK (role IN ('fundador', 'comercial', 'otro')),
  CONSTRAINT chk_ops_tm_name CHECK (btrim(name) <> '' AND length(name) <= 120),
  CONSTRAINT chk_ops_tm_inactive CHECK ((active AND inactive_since IS NULL) OR (NOT active AND inactive_since IS NOT NULL))
);

-- Dos personas con el mismo nombre se confunden en un selector: se impide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_tm_name ON ops.team_member (lower(btrim(name)));
-- Un usuario del panel es, a lo sumo, una persona del catálogo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_tm_user ON ops.team_member (user_id) WHERE user_id IS NOT NULL;

-- Semilla pedida el 2026-11-20. Sin `user_id`: el vínculo se hace desde
-- Comercial › Equipo (no se escriben emails ni ids de personas en una migración).
INSERT INTO ops.team_member (name, role, active, active_since, inactive_since)
VALUES
  ('Nicolás', 'fundador', true, DATE '2026-11-20', NULL),
  ('Tobías Argonz', 'comercial', true, DATE '2026-11-20', NULL),
  ('Lautaro', 'comercial', false, DATE '2026-11-20', DATE '2026-11-20')
ON CONFLICT DO NOTHING;

-- ── Asignación vigente y su historial ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS ops.partner_application_sourcer (
  -- `partner_applications.id`, UUID pelado (guardrail 6).
  application_id  uuid PRIMARY KEY,
  member_id       uuid        NOT NULL REFERENCES ops.team_member (id),
  assigned_by     uuid        NOT NULL,
  assigned_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_pas_member ON ops.partner_application_sourcer (member_id);

CREATE TABLE IF NOT EXISTS ops.partner_application_sourcer_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid        NOT NULL,
  before_member_id uuid       REFERENCES ops.team_member (id),
  after_member_id  uuid       REFERENCES ops.team_member (id),
  actor_id        uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ops_pasl_change CHECK (before_member_id IS DISTINCT FROM after_member_id)
);

CREATE INDEX IF NOT EXISTS idx_ops_pasl_application
  ON ops.partner_application_sourcer_log (application_id, created_at DESC);

-- ── SP: personas del equipo ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ops._team_member_json(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, ops
AS $$
  SELECT to_jsonb(m) FROM ops.team_member m WHERE m.id = p_id;
$$;

/**
 * Alta de una persona. Valida representabilidad: nombre no vacío y no
 * repetido, rol del catálogo, usuario existente y no vinculado a otra.
 */
CREATE OR REPLACE FUNCTION ops.create_team_member(
  p_actor_id uuid,
  p_name     text,
  p_role     text,
  p_user_id  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_name  text := btrim(coalesce(p_name, ''));
  v_id    uuid;
  v_after jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF v_name = '' THEN RAISE EXCEPTION 'MEMBER_NAME_REQUIRED'; END IF;
  IF length(v_name) > 120 THEN RAISE EXCEPTION 'MEMBER_NAME_TOO_LONG'; END IF;
  IF p_role IS NULL OR p_role NOT IN ('fundador', 'comercial', 'otro') THEN
    RAISE EXCEPTION 'INVALID_MEMBER_ROLE: %', p_role;
  END IF;
  IF EXISTS (SELECT 1 FROM ops.team_member WHERE lower(btrim(name)) = lower(v_name)) THEN
    RAISE EXCEPTION 'MEMBER_NAME_TAKEN: %', v_name;
  END IF;
  IF p_user_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user_id) THEN
      RAISE EXCEPTION 'USER_NOT_FOUND: %', p_user_id;
    END IF;
    IF EXISTS (SELECT 1 FROM ops.team_member WHERE user_id = p_user_id) THEN
      RAISE EXCEPTION 'USER_ALREADY_LINKED: %', p_user_id;
    END IF;
  END IF;

  INSERT INTO ops.team_member (name, role, user_id, created_by)
  VALUES (v_name, p_role, p_user_id, p_actor_id)
  RETURNING id INTO v_id;

  v_after := ops._team_member_json(v_id);
  PERFORM ops.log_action(p_actor_id, 'team_member.create', 'ops.team_member', v_id, NULL, v_after, NULL);
  RETURN v_after;
END;
$$;

/**
 * Edición por PARCHE: sólo las claves que vienen (`name`, `role`, `active`,
 * `user_id`). `user_id: null` desvincula. Desactivar estampa `inactive_since`
 * con el día de hoy en Buenos Aires; reactivar lo borra. Una clave
 * desconocida es `UNKNOWN_FIELD` (un typo no puede "guardar" sin guardar).
 */
CREATE OR REPLACE FUNCTION ops.update_team_member(
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
  v_after  jsonb;
  v_row    ops.team_member%ROWTYPE;
  v_key    text;
  v_name   text;
  v_user   uuid;
  v_today  date := (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_PATCH';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF v_key NOT IN ('name', 'role', 'active', 'user_id') THEN
      RAISE EXCEPTION 'UNKNOWN_FIELD: %', v_key;
    END IF;
  END LOOP;

  SELECT * INTO v_row FROM ops.team_member WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEMBER_NOT_FOUND: %', p_id; END IF;
  v_before := to_jsonb(v_row);

  IF p_patch ? 'name' THEN
    v_name := btrim(coalesce(p_patch->>'name', ''));
    IF v_name = '' THEN RAISE EXCEPTION 'MEMBER_NAME_REQUIRED'; END IF;
    IF length(v_name) > 120 THEN RAISE EXCEPTION 'MEMBER_NAME_TOO_LONG'; END IF;
    IF EXISTS (SELECT 1 FROM ops.team_member WHERE lower(btrim(name)) = lower(v_name) AND id <> p_id) THEN
      RAISE EXCEPTION 'MEMBER_NAME_TAKEN: %', v_name;
    END IF;
    v_row.name := v_name;
  END IF;

  IF p_patch ? 'role' THEN
    IF coalesce(p_patch->>'role', '') NOT IN ('fundador', 'comercial', 'otro') THEN
      RAISE EXCEPTION 'INVALID_MEMBER_ROLE: %', p_patch->>'role';
    END IF;
    v_row.role := p_patch->>'role';
  END IF;

  IF p_patch ? 'active' THEN
    IF jsonb_typeof(p_patch->'active') <> 'boolean' THEN
      RAISE EXCEPTION 'INVALID_ACTIVE';
    END IF;
    IF (p_patch->>'active')::boolean AND NOT v_row.active THEN
      v_row.active := true;
      v_row.inactive_since := NULL;
    ELSIF NOT (p_patch->>'active')::boolean AND v_row.active THEN
      v_row.active := false;
      v_row.inactive_since := v_today;
    END IF;
  END IF;

  IF p_patch ? 'user_id' THEN
    IF jsonb_typeof(p_patch->'user_id') = 'null' THEN
      v_row.user_id := NULL;
    ELSE
      BEGIN
        v_user := (p_patch->>'user_id')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'USER_NOT_FOUND: %', p_patch->>'user_id';
      END;
      IF NOT EXISTS (SELECT 1 FROM users WHERE id = v_user) THEN
        RAISE EXCEPTION 'USER_NOT_FOUND: %', v_user;
      END IF;
      IF EXISTS (SELECT 1 FROM ops.team_member WHERE user_id = v_user AND id <> p_id) THEN
        RAISE EXCEPTION 'USER_ALREADY_LINKED: %', v_user;
      END IF;
      v_row.user_id := v_user;
    END IF;
  END IF;

  -- Sin cambios: no se escribe ni se loguea.
  IF to_jsonb(v_row) = v_before THEN
    RETURN v_before;
  END IF;

  UPDATE ops.team_member
     SET name = v_row.name,
         role = v_row.role,
         active = v_row.active,
         inactive_since = v_row.inactive_since,
         user_id = v_row.user_id,
         updated_at = now()
   WHERE id = p_id;

  v_after := ops._team_member_json(p_id);
  PERFORM ops.log_action(p_actor_id, 'team_member.update', 'ops.team_member', p_id, v_before, v_after, NULL);
  RETURN v_after;
END;
$$;

-- ── SP: asignar "Alta por" ────────────────────────────────────────────────

/**
 * Asigna (o quita, con `p_member_id` NULL) la persona que trajo la solicitud.
 *
 * - `p_expected_member_id` es lo que el operador vio. Si la asignación vigente
 *   es otra → `SOURCER_CHANGED` (la pantalla vuelve a preguntar).
 * - Persona inactiva → `MEMBER_INACTIVE`, salvo que ya fuera la asignada
 *   (re-guardar lo mismo es un no-op, no un error).
 * - Misma persona que ya tenía → no-op, sin log.
 *
 * No toca `partner_applications`: ni el estado, ni `reviewed_by_id`, ni
 * `how_found`. No bloquea nada del embudo.
 */
CREATE OR REPLACE FUNCTION ops.set_application_sourcer(
  p_application_id     uuid,
  p_member_id          uuid,
  p_expected_member_id uuid,
  p_actor_id           uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_current uuid;
  v_active  boolean;
  v_result  jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF p_application_id IS NULL OR NOT EXISTS (SELECT 1 FROM partner_applications WHERE id = p_application_id) THEN
    RAISE EXCEPTION 'APPLICATION_NOT_FOUND: %', p_application_id;
  END IF;

  -- Serializa dos asignaciones de la misma solicitud. Un advisory lock de
  -- TRANSACCIÓN (se suelta solo al terminar, también detrás de un pooler):
  -- no hay fila previa que lockear cuando la solicitud está sin asignar.
  PERFORM pg_advisory_xact_lock(hashtext('ops.partner_application_sourcer'), hashtext(p_application_id::text));

  SELECT member_id INTO v_current
    FROM ops.partner_application_sourcer
   WHERE application_id = p_application_id
     FOR UPDATE;

  IF v_current IS DISTINCT FROM p_expected_member_id THEN
    RAISE EXCEPTION 'SOURCER_CHANGED: %', coalesce(v_current::text, 'none');
  END IF;

  IF p_member_id IS NOT NULL THEN
    SELECT active INTO v_active FROM ops.team_member WHERE id = p_member_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'MEMBER_NOT_FOUND: %', p_member_id; END IF;
    IF NOT v_active AND p_member_id IS DISTINCT FROM v_current THEN
      RAISE EXCEPTION 'MEMBER_INACTIVE: %', p_member_id;
    END IF;
  END IF;

  IF p_member_id IS NOT DISTINCT FROM v_current THEN
    RETURN jsonb_build_object('application_id', p_application_id, 'member_id', v_current, 'changed', false);
  END IF;

  IF p_member_id IS NULL THEN
    DELETE FROM ops.partner_application_sourcer WHERE application_id = p_application_id;
  ELSE
    INSERT INTO ops.partner_application_sourcer (application_id, member_id, assigned_by, assigned_at)
    VALUES (p_application_id, p_member_id, p_actor_id, now())
    ON CONFLICT (application_id) DO UPDATE
      SET member_id = EXCLUDED.member_id,
          assigned_by = EXCLUDED.assigned_by,
          assigned_at = EXCLUDED.assigned_at;
  END IF;

  INSERT INTO ops.partner_application_sourcer_log (application_id, before_member_id, after_member_id, actor_id)
  VALUES (p_application_id, v_current, p_member_id, p_actor_id);

  v_result := jsonb_build_object('application_id', p_application_id, 'member_id', p_member_id, 'changed', true);
  PERFORM ops.log_action(
    p_actor_id, 'partner_application.set_sourcer', 'public.partner_applications', p_application_id,
    jsonb_build_object('member_id', v_current), jsonb_build_object('member_id', p_member_id), NULL
  );
  RETURN v_result;
END;
$$;
