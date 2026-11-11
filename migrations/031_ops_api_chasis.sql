-- ═══════════════════════════════════════════════════════════════════════════
-- 031 — API Chasis: las agencias a las que se les ofrece la API de datos
-- vehiculares, y las charlas con cada una.
--
-- Plan: `.claude/plans/comercial-fichas-charlas-chasis.md`, Parte 2 (aprobado
-- el 2026-11-11). Es la misma clase de dato que la 024/030 —el seguimiento del
-- equipo comercial—, así que vive en `ops`, con los mismos 8 guardrails y el
-- mismo patrón: la ficha se edita por PARCHE (autoguardado campo por campo) y
-- las charlas son APPEND-ONLY.
--
-- ── POR QUÉ NO VA EN `ops.partner_prospect` ───────────────────────────────
--
-- Una agencia no es un proveedor del marketplace: no se registra, no recibe
-- pedidos y su embudo es otro (contactada → vio informe de ejemplo → propuesta
-- enviada → cliente). Meterla en la tabla de proveedores ensuciaría los conteos
-- y las altas de Contactos sin que nada lo delate. Lo que SÍ las une es una
-- agencia con taller propio: "Crear contacto de proveedor" crea (o encuentra
-- por teléfono) el contacto y deja el link `prospect_id`.
--
-- ── "CHASIS" ──────────────────────────────────────────────────────────────
--
-- Es el sistema donde se carga al referido para que se cobre la comisión. El
-- panel no habla con él: `referral_loaded` es un check que tilda una persona,
-- y la pantalla avisa en ámbar si una agencia "cliente" lo tiene vacío.
--
-- ── CARBUFY ───────────────────────────────────────────────────────────────
--
-- Decidido en el plan: si la agencia ya usa Carbufy, se descarta con ese
-- motivo, en la MISMA operación que marca el check (si el parche no trae otro
-- motivo). La pantalla lo avisa antes de guardar.
-- ═══════════════════════════════════════════════════════════════════════════

-- El origen de los contactos que nacen de una agencia.
INSERT INTO ops.partner_prospect_origin (slug, label, position) VALUES
  ('api-chasis', 'Agencia (API Chasis)', 60)
ON CONFLICT (slug) DO NOTHING;

-- ── Las agencias ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ops.chasis_agency (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  name                text        NOT NULL,
  contact_name        text,
  phone               text,
  phone_digits        text,
  locality            text,

  talked_to_decider   boolean,
  uses_carbufy        boolean,
  use_case            text,
  data_interests      text[]      NOT NULL DEFAULT '{}',
  data_interests_other text,
  monthly_volume      int,
  current_solution    text,
  current_provider    text,
  integration_mode    text,
  other_interest      text,
  has_workshop        boolean,

  status              text        NOT NULL DEFAULT 'contacted',
  discard_reason      text,
  referral_loaded     boolean     NOT NULL DEFAULT false,
  owner_id            uuid,
  next_step           text,
  last_contact_on     date,
  next_follow_up_on   date,
  notes               text,

  -- El contacto de proveedor que salió de esta agencia (ops → ops: FK sí).
  prospect_id         uuid        REFERENCES ops.partner_prospect (id),

  created_by          uuid        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_ops_ca_status CHECK (status IN ('contacted', 'saw_sample', 'proposal_sent', 'client', 'discarded')),
  CONSTRAINT chk_ops_ca_discard CHECK (status <> 'discarded' OR discard_reason IS NOT NULL),
  CONSTRAINT chk_ops_ca_integration CHECK (integration_mode IS NULL OR integration_mode IN ('api', 'web')),
  CONSTRAINT chk_ops_ca_interests CHECK (data_interests <@ ARRAY['fines', 'debt', 'vtv', 'domain', 'other']::text[]),
  CONSTRAINT chk_ops_ca_volume CHECK (monthly_volume IS NULL OR monthly_volume BETWEEN 0 AND 10000000),
  CONSTRAINT chk_ops_ca_phone_digits CHECK (phone_digits IS NULL OR phone_digits ~ '^549[0-9]{10}$'),
  CONSTRAINT chk_ops_ca_texts_not_blank CHECK (
        btrim(name) <> ''
    AND (contact_name IS NULL         OR btrim(contact_name) <> '')
    AND (phone IS NULL                OR btrim(phone) <> '')
    AND (locality IS NULL             OR btrim(locality) <> '')
    AND (use_case IS NULL             OR btrim(use_case) <> '')
    AND (data_interests_other IS NULL OR btrim(data_interests_other) <> '')
    AND (current_solution IS NULL     OR btrim(current_solution) <> '')
    AND (current_provider IS NULL     OR btrim(current_provider) <> '')
    AND (other_interest IS NULL       OR btrim(other_interest) <> '')
    AND (discard_reason IS NULL       OR btrim(discard_reason) <> '')
    AND (next_step IS NULL            OR btrim(next_step) <> '')
    AND (notes IS NULL                OR btrim(notes) <> '')
  )
);

-- Una agencia no puede estar dos veces (mismo criterio que la 024).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_ca_phone_digits_unique
  ON ops.chasis_agency (phone_digits)
  WHERE phone_digits IS NOT NULL;

-- "Hoy": seguimientos de agencias abiertas (cliente y descartada no se siguen).
CREATE INDEX IF NOT EXISTS idx_ops_ca_follow_up
  ON ops.chasis_agency (next_follow_up_on)
  WHERE next_follow_up_on IS NOT NULL AND status NOT IN ('client', 'discarded');

-- ── Las charlas ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ops.chasis_agency_interaction (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id          uuid        NOT NULL REFERENCES ops.chasis_agency (id),
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  channel            text        NOT NULL,
  answered           boolean,
  talked_to_decider  boolean,
  offered_model      text,
  offered_amount     text,
  reaction           text,
  questions_answers  text,
  objection          text,
  objection_other    text,
  pitch_notes        text,
  status_after       text        NOT NULL,
  discard_reason     text,
  next_step          text        NOT NULL,
  next_follow_up_on  date,
  actor_id           uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_ops_cai_channel CHECK (channel IN ('call', 'whatsapp', 'visit')),
  CONSTRAINT chk_ops_cai_model CHECK (offered_model IS NULL OR offered_model IN ('subscription', 'report_pack')),
  CONSTRAINT chk_ops_cai_reaction CHECK (reaction IS NULL OR reaction IN ('positive', 'neutral', 'negative')),
  CONSTRAINT chk_ops_cai_objection CHECK (objection IS NULL OR objection IN (
    'price', 'has_provider', 'low_volume', 'tech_integration', 'data_doubts', 'not_now', 'other'
  )),
  CONSTRAINT chk_ops_cai_objection_other CHECK ((objection = 'other') = (objection_other IS NOT NULL)),
  CONSTRAINT chk_ops_cai_status CHECK (status_after IN ('contacted', 'saw_sample', 'proposal_sent', 'client', 'discarded')),
  CONSTRAINT chk_ops_cai_discard CHECK (status_after <> 'discarded' OR discard_reason IS NOT NULL),
  CONSTRAINT chk_ops_cai_texts_not_blank CHECK (
        btrim(next_step) <> ''
    AND (offered_amount    IS NULL OR btrim(offered_amount)    <> '')
    AND (questions_answers IS NULL OR btrim(questions_answers) <> '')
    AND (objection_other   IS NULL OR btrim(objection_other)   <> '')
    AND (pitch_notes       IS NULL OR btrim(pitch_notes)       <> '')
    AND (discard_reason    IS NULL OR btrim(discard_reason)    <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_ops_cai_agency
  ON ops.chasis_agency_interaction (agency_id, occurred_at DESC);

-- ── Normalización (alta y edición) ────────────────────────────────────────

CREATE OR REPLACE FUNCTION ops._normalize_chasis_agency(
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
  v_bad    text;
  v_dup    uuid;
  v_date   date;
  v_int    int;
  v_arr    text[];
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_PATCH';
  END IF;

  SELECT k INTO v_bad
    FROM jsonb_object_keys(p_patch) k
   WHERE k NOT IN ('name', 'contact_name', 'phone', 'locality', 'talked_to_decider', 'uses_carbufy',
                   'use_case', 'data_interests', 'data_interests_other', 'monthly_volume',
                   'current_solution', 'current_provider', 'integration_mode', 'other_interest',
                   'has_workshop', 'status', 'discard_reason', 'referral_loaded', 'owner_id',
                   'next_step', 'last_contact_on', 'next_follow_up_on', 'notes')
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'UNKNOWN_FIELD: %', v_bad;
  END IF;

  FOREACH v_key IN ARRAY ARRAY['name', 'contact_name', 'phone', 'locality', 'use_case',
                               'data_interests_other', 'current_solution', 'current_provider',
                               'other_interest', 'discard_reason', 'next_step', 'notes'] LOOP
    IF p_patch ? v_key THEN
      v_text := nullif(btrim(coalesce(p_patch->>v_key, '')), '');
      v := jsonb_set(v, ARRAY[v_key], coalesce(to_jsonb(v_text), 'null'::jsonb));
    END IF;
  END LOOP;

  IF nullif(btrim(coalesce(v->>'name', '')), '') IS NULL THEN
    RAISE EXCEPTION 'NAME_REQUIRED';
  END IF;

  v := jsonb_set(v, '{phone_digits}', coalesce(to_jsonb(ops.normalize_ar_phone(v->>'phone')), 'null'::jsonb));

  FOREACH v_key IN ARRAY ARRAY['talked_to_decider', 'uses_carbufy', 'has_workshop'] LOOP
    IF p_patch ? v_key THEN
      IF jsonb_typeof(p_patch->v_key) NOT IN ('boolean', 'null') THEN
        RAISE EXCEPTION 'INVALID_BOOLEAN: %', v_key;
      END IF;
      v := jsonb_set(v, ARRAY[v_key], p_patch->v_key);
    END IF;
  END LOOP;
  IF p_patch ? 'referral_loaded' THEN
    IF jsonb_typeof(p_patch->'referral_loaded') NOT IN ('boolean', 'null') THEN
      RAISE EXCEPTION 'INVALID_BOOLEAN: referral_loaded';
    END IF;
    v := jsonb_set(v, '{referral_loaded}', to_jsonb(coalesce((p_patch->>'referral_loaded')::boolean, false)));
  END IF;

  IF p_patch ? 'data_interests' THEN
    IF jsonb_typeof(p_patch->'data_interests') <> 'array' THEN
      RAISE EXCEPTION 'INVALID_DATA_INTERESTS';
    END IF;
    SELECT coalesce(array_agg(DISTINCT s ORDER BY s), '{}') INTO v_arr
      FROM (SELECT nullif(btrim(x), '') AS s FROM jsonb_array_elements_text(p_patch->'data_interests') x) t
     WHERE s IS NOT NULL;
    SELECT s INTO v_bad FROM unnest(v_arr) s
     WHERE s NOT IN ('fines', 'debt', 'vtv', 'domain', 'other') LIMIT 1;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'INVALID_DATA_INTEREST: %', v_bad;
    END IF;
    v := jsonb_set(v, '{data_interests}', to_jsonb(v_arr));
  END IF;
  -- El "otros" sólo existe con "otros" tildado.
  IF NOT ((v->'data_interests') ? 'other') THEN
    v := jsonb_set(v, '{data_interests_other}', 'null'::jsonb);
  END IF;

  IF p_patch ? 'monthly_volume' THEN
    BEGIN
      v_int := nullif(btrim(coalesce(p_patch->>'monthly_volume', '')), '')::int;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'INVALID_MONTHLY_VOLUME: %', p_patch->>'monthly_volume';
    END;
    IF v_int IS NOT NULL AND (v_int < 0 OR v_int > 10000000) THEN
      RAISE EXCEPTION 'INVALID_MONTHLY_VOLUME: %', v_int;
    END IF;
    v := jsonb_set(v, '{monthly_volume}', coalesce(to_jsonb(v_int), 'null'::jsonb));
  END IF;

  IF p_patch ? 'integration_mode' THEN
    v := jsonb_set(v, '{integration_mode}',
                   coalesce(to_jsonb(nullif(btrim(coalesce(p_patch->>'integration_mode', '')), '')), 'null'::jsonb));
  END IF;
  IF v->>'integration_mode' IS NOT NULL AND (v->>'integration_mode') NOT IN ('api', 'web') THEN
    RAISE EXCEPTION 'INVALID_INTEGRATION_MODE: %', v->>'integration_mode';
  END IF;

  IF p_patch ? 'status' THEN
    v := jsonb_set(v, '{status}', to_jsonb(btrim(coalesce(p_patch->>'status', ''))));
  END IF;
  -- Carbufy: marcarlo en sí descarta, con ese motivo salvo que venga otro.
  IF p_patch ? 'uses_carbufy' AND coalesce((p_patch->>'uses_carbufy')::boolean, false)
     AND NOT (p_patch ? 'status') THEN
    v := jsonb_set(v, '{status}', '"discarded"'::jsonb);
    IF NOT (p_patch ? 'discard_reason') OR v->>'discard_reason' IS NULL THEN
      v := jsonb_set(v, '{discard_reason}', '"Usa Carbufy"'::jsonb);
    END IF;
  END IF;
  IF (v->>'status') NOT IN ('contacted', 'saw_sample', 'proposal_sent', 'client', 'discarded') THEN
    RAISE EXCEPTION 'INVALID_AGENCY_STATUS: %', v->>'status';
  END IF;
  IF (v->>'status') <> 'discarded' THEN
    v := jsonb_set(v, '{discard_reason}', 'null'::jsonb);
  ELSIF v->>'discard_reason' IS NULL THEN
    RAISE EXCEPTION 'DISCARD_REASON_REQUIRED';
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

  FOREACH v_key IN ARRAY ARRAY['last_contact_on', 'next_follow_up_on'] LOOP
    IF p_patch ? v_key THEN
      BEGIN
        v_date := nullif(btrim(coalesce(p_patch->>v_key, '')), '')::date;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'INVALID_DATE: % = %', v_key, p_patch->>v_key;
      END;
      v := jsonb_set(v, ARRAY[v_key], coalesce(to_jsonb(v_date), 'null'::jsonb));
    END IF;
  END LOOP;

  IF v->>'phone_digits' IS NOT NULL THEN
    SELECT id INTO v_dup FROM ops.chasis_agency
     WHERE phone_digits = v->>'phone_digits' AND (p_self_id IS NULL OR id <> p_self_id) LIMIT 1;
    IF v_dup IS NOT NULL THEN
      RAISE EXCEPTION 'DUPLICATE_PHONE: %', v_dup;
    END IF;
  END IF;

  RETURN v;
END;
$$;

-- ── Alta ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ops.create_chasis_agency(p_actor_id uuid, p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_clean jsonb;
  v_id    uuid;
  v_after jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  v_clean := ops._normalize_chasis_agency(jsonb_build_object(
    'name', NULL, 'contact_name', NULL, 'phone', NULL, 'locality', NULL,
    'talked_to_decider', NULL, 'uses_carbufy', NULL, 'use_case', NULL,
    'data_interests', '[]'::jsonb, 'data_interests_other', NULL, 'monthly_volume', NULL,
    'current_solution', NULL, 'current_provider', NULL, 'integration_mode', NULL,
    'other_interest', NULL, 'has_workshop', NULL, 'status', 'contacted', 'discard_reason', NULL,
    'referral_loaded', false, 'owner_id', NULL, 'next_step', NULL, 'last_contact_on', NULL,
    'next_follow_up_on', NULL, 'notes', NULL
  ), p_data, NULL);

  BEGIN
    INSERT INTO ops.chasis_agency (
      name, contact_name, phone, phone_digits, locality, talked_to_decider, uses_carbufy, use_case,
      data_interests, data_interests_other, monthly_volume, current_solution, current_provider,
      integration_mode, other_interest, has_workshop, status, discard_reason, referral_loaded,
      owner_id, next_step, last_contact_on, next_follow_up_on, notes, created_by
    ) VALUES (
      v_clean->>'name', v_clean->>'contact_name', v_clean->>'phone', v_clean->>'phone_digits',
      v_clean->>'locality', (v_clean->>'talked_to_decider')::boolean, (v_clean->>'uses_carbufy')::boolean,
      v_clean->>'use_case', ARRAY(SELECT jsonb_array_elements_text(v_clean->'data_interests')),
      v_clean->>'data_interests_other', (v_clean->>'monthly_volume')::int, v_clean->>'current_solution',
      v_clean->>'current_provider', v_clean->>'integration_mode', v_clean->>'other_interest',
      (v_clean->>'has_workshop')::boolean, v_clean->>'status', v_clean->>'discard_reason',
      (v_clean->>'referral_loaded')::boolean, (v_clean->>'owner_id')::uuid, v_clean->>'next_step',
      (v_clean->>'last_contact_on')::date, (v_clean->>'next_follow_up_on')::date, v_clean->>'notes',
      p_actor_id
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_PHONE: %',
      (SELECT id FROM ops.chasis_agency WHERE phone_digits = v_clean->>'phone_digits' LIMIT 1);
  END;

  SELECT to_jsonb(a) INTO v_after FROM ops.chasis_agency a WHERE a.id = v_id;
  PERFORM ops.log_action(p_actor_id, 'chasis_agency.create', 'ops.chasis_agency', v_id, NULL, v_after, NULL);
  RETURN v_after;
END;
$$;

-- ── Edición (parche) ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ops.update_chasis_agency(p_id uuid, p_actor_id uuid, p_patch jsonb)
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
  SELECT to_jsonb(a) INTO v_before FROM ops.chasis_agency a WHERE a.id = p_id FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'AGENCY_NOT_FOUND: %', p_id;
  END IF;

  v_clean := ops._normalize_chasis_agency(v_before, p_patch, p_id);

  BEGIN
    UPDATE ops.chasis_agency SET
      name                 = v_clean->>'name',
      contact_name         = v_clean->>'contact_name',
      phone                = v_clean->>'phone',
      phone_digits         = v_clean->>'phone_digits',
      locality             = v_clean->>'locality',
      talked_to_decider    = (v_clean->>'talked_to_decider')::boolean,
      uses_carbufy         = (v_clean->>'uses_carbufy')::boolean,
      use_case             = v_clean->>'use_case',
      data_interests       = ARRAY(SELECT jsonb_array_elements_text(v_clean->'data_interests')),
      data_interests_other = v_clean->>'data_interests_other',
      monthly_volume       = (v_clean->>'monthly_volume')::int,
      current_solution     = v_clean->>'current_solution',
      current_provider     = v_clean->>'current_provider',
      integration_mode     = v_clean->>'integration_mode',
      other_interest       = v_clean->>'other_interest',
      has_workshop         = (v_clean->>'has_workshop')::boolean,
      status               = v_clean->>'status',
      discard_reason       = v_clean->>'discard_reason',
      referral_loaded      = (v_clean->>'referral_loaded')::boolean,
      owner_id             = (v_clean->>'owner_id')::uuid,
      next_step            = v_clean->>'next_step',
      last_contact_on      = (v_clean->>'last_contact_on')::date,
      next_follow_up_on    = (v_clean->>'next_follow_up_on')::date,
      notes                = v_clean->>'notes',
      updated_at           = now()
    WHERE id = p_id
      AND (to_jsonb(chasis_agency) - 'updated_at') IS DISTINCT FROM (v_clean - 'updated_at');
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_PHONE: %',
      (SELECT id FROM ops.chasis_agency WHERE phone_digits = v_clean->>'phone_digits' AND id <> p_id LIMIT 1);
  END;

  SELECT to_jsonb(a) INTO v_after FROM ops.chasis_agency a WHERE a.id = p_id;
  IF (v_after - 'updated_at') IS DISTINCT FROM (v_before - 'updated_at') THEN
    PERFORM ops.log_action(p_actor_id, 'chasis_agency.update', 'ops.chasis_agency', p_id, v_before, v_after, NULL);
  END IF;
  RETURN v_after;
END;
$$;

-- ── Una charla ────────────────────────────────────────────────────────────

/**
 * Mismo contrato que `ops.add_partner_prospect_interaction` (030): obligatorios
 * canal, estado y próximo paso; sólo la charla más reciente mueve la agencia;
 * `last_contact_on` no retrocede. Devuelve `{interaction, agency}`.
 */
CREATE OR REPLACE FUNCTION ops.add_chasis_agency_interaction(
  p_agency_id uuid,
  p_actor_id  uuid,
  p_data      jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_bad       text;
  v_key       text;
  v_agency    jsonb;
  v_at        timestamptz;
  v_day       date;
  v_next      date;
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
    RAISE EXCEPTION 'INVALID_INTERACTION';
  END IF;

  SELECT k INTO v_bad FROM jsonb_object_keys(p_data) k
   WHERE k NOT IN ('occurred_at', 'channel', 'answered', 'talked_to_decider', 'offered_model',
                   'offered_amount', 'reaction', 'questions_answers', 'objection', 'objection_other',
                   'pitch_notes', 'status_after', 'discard_reason', 'next_step', 'next_follow_up_on')
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'UNKNOWN_FIELD: %', v_bad;
  END IF;

  SELECT to_jsonb(a) INTO v_agency FROM ops.chasis_agency a WHERE a.id = p_agency_id FOR UPDATE;
  IF v_agency IS NULL THEN
    RAISE EXCEPTION 'AGENCY_NOT_FOUND: %', p_agency_id;
  END IF;

  IF coalesce(p_data->>'channel', '') NOT IN ('call', 'whatsapp', 'visit') THEN
    RAISE EXCEPTION 'INVALID_CHANNEL: %', coalesce(p_data->>'channel', '(vacío)');
  END IF;

  v_status := btrim(coalesce(p_data->>'status_after', ''));
  IF v_status NOT IN ('contacted', 'saw_sample', 'proposal_sent', 'client', 'discarded') THEN
    RAISE EXCEPTION 'INVALID_AGENCY_STATUS: %', v_status;
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

  FOREACH v_key IN ARRAY ARRAY['answered', 'talked_to_decider'] LOOP
    IF p_data ? v_key AND jsonb_typeof(p_data->v_key) NOT IN ('boolean', 'null') THEN
      RAISE EXCEPTION 'INVALID_BOOLEAN: %', v_key;
    END IF;
  END LOOP;

  IF nullif(p_data->>'offered_model', '') IS NOT NULL
     AND (p_data->>'offered_model') NOT IN ('subscription', 'report_pack') THEN
    RAISE EXCEPTION 'INVALID_OFFERED_MODEL: %', p_data->>'offered_model';
  END IF;
  IF nullif(p_data->>'reaction', '') IS NOT NULL
     AND (p_data->>'reaction') NOT IN ('positive', 'neutral', 'negative') THEN
    RAISE EXCEPTION 'INVALID_REACTION: %', p_data->>'reaction';
  END IF;

  v_objection := nullif(btrim(coalesce(p_data->>'objection', '')), '');
  v_other := nullif(btrim(coalesce(p_data->>'objection_other', '')), '');
  IF v_objection IS NOT NULL AND v_objection NOT IN ('price', 'has_provider', 'low_volume',
                                                     'tech_integration', 'data_doubts', 'not_now', 'other') THEN
    RAISE EXCEPTION 'INVALID_OBJECTION: %', v_objection;
  END IF;
  IF v_objection = 'other' AND v_other IS NULL THEN
    RAISE EXCEPTION 'OBJECTION_OTHER_REQUIRED';
  END IF;
  IF v_objection IS DISTINCT FROM 'other' THEN
    v_other := NULL;
  END IF;

  BEGIN
    v_at := coalesce(nullif(btrim(coalesce(p_data->>'occurred_at', '')), '')::timestamptz, now());
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'INVALID_DATE: occurred_at = %', p_data->>'occurred_at';
  END;
  IF v_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'INTERACTION_IN_FUTURE';
  END IF;

  BEGIN
    v_next := nullif(btrim(coalesce(p_data->>'next_follow_up_on', '')), '')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'INVALID_DATE: next_follow_up_on = %', p_data->>'next_follow_up_on';
  END;

  SELECT max(occurred_at) INTO v_latest FROM ops.chasis_agency_interaction WHERE agency_id = p_agency_id;

  INSERT INTO ops.chasis_agency_interaction (
    agency_id, occurred_at, channel, answered, talked_to_decider, offered_model, offered_amount,
    reaction, questions_answers, objection, objection_other, pitch_notes, status_after,
    discard_reason, next_step, next_follow_up_on, actor_id
  ) VALUES (
    p_agency_id, v_at, p_data->>'channel', (p_data->>'answered')::boolean,
    (p_data->>'talked_to_decider')::boolean, nullif(p_data->>'offered_model', ''),
    nullif(btrim(coalesce(p_data->>'offered_amount', '')), ''), nullif(p_data->>'reaction', ''),
    nullif(btrim(coalesce(p_data->>'questions_answers', '')), ''), v_objection, v_other,
    nullif(btrim(coalesce(p_data->>'pitch_notes', '')), ''), v_status, v_reason, v_step, v_next,
    p_actor_id
  )
  RETURNING id INTO v_id;

  SELECT to_jsonb(i) INTO v_row FROM ops.chasis_agency_interaction i WHERE i.id = v_id;
  PERFORM ops.log_action(p_actor_id, 'chasis_agency_interaction.create', 'ops.chasis_agency_interaction',
                         v_id, NULL, v_row, NULL);

  v_day := (v_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
  IF v_latest IS NULL OR v_at >= v_latest THEN
    v_patch := jsonb_build_object('status', v_status, 'discard_reason', v_reason,
                                  'next_step', v_step, 'next_follow_up_on', v_next);
    -- "Habló con quien decide" de la ficha sigue a la última charla que lo dice.
    IF p_data ? 'talked_to_decider' AND jsonb_typeof(p_data->'talked_to_decider') = 'boolean' THEN
      v_patch := v_patch || jsonb_build_object('talked_to_decider', p_data->'talked_to_decider');
    END IF;
  ELSE
    v_patch := '{}'::jsonb;
  END IF;
  IF (v_agency->>'last_contact_on') IS NULL OR v_day > (v_agency->>'last_contact_on')::date THEN
    v_patch := v_patch || jsonb_build_object('last_contact_on', v_day);
  END IF;
  IF v_patch <> '{}'::jsonb THEN
    v_agency := ops.update_chasis_agency(p_agency_id, p_actor_id, v_patch);
  END IF;

  RETURN jsonb_build_object('interaction', v_row, 'agency', v_agency);
END;
$$;

-- ── De agencia a contacto de proveedor ────────────────────────────────────

/**
 * La agencia tiene taller, lubricentro o gomería: se crea su contacto en
 * Comercial (frente Corredor Norte, origen "Agencia (API Chasis)", con nombre,
 * teléfono, zona y conseguido por copiados) y queda el link `prospect_id`.
 *
 * Si ya hay un contacto con ese teléfono, NO se duplica: se linkea a ése y se
 * devuelve `created = false`, para que la pantalla lo diga. Si la agencia ya
 * tenía contacto linkeado, es `AGENCY_ALREADY_LINKED`.
 */
CREATE OR REPLACE FUNCTION ops.create_prospect_from_chasis_agency(p_agency_id uuid, p_actor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_agency   jsonb;
  v_existing uuid;
  v_prospect jsonb;
  v_created  boolean := false;
  v_after    jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  SELECT to_jsonb(a) INTO v_agency FROM ops.chasis_agency a WHERE a.id = p_agency_id FOR UPDATE;
  IF v_agency IS NULL THEN
    RAISE EXCEPTION 'AGENCY_NOT_FOUND: %', p_agency_id;
  END IF;
  IF v_agency->>'prospect_id' IS NOT NULL THEN
    RAISE EXCEPTION 'AGENCY_ALREADY_LINKED: %', v_agency->>'prospect_id';
  END IF;

  IF v_agency->>'phone_digits' IS NOT NULL THEN
    SELECT id INTO v_existing FROM ops.partner_prospect WHERE phone_digits = v_agency->>'phone_digits' LIMIT 1;
  END IF;

  IF v_existing IS NULL THEN
    v_prospect := ops.create_partner_prospect(p_actor_id, jsonb_build_object(
      'name', v_agency->>'name',
      'phone', v_agency->>'phone',
      'locality', v_agency->>'locality',
      'talked_to', v_agency->>'contact_name',
      'owner_id', v_agency->'owner_id',
      'origin_slug', 'api-chasis',
      'front', 'corredor-norte',
      'short_note', 'Agencia de API Chasis con taller, lubricentro o gomería propios.'
    ));
    v_existing := (v_prospect->>'id')::uuid;
    v_created := true;
  END IF;

  UPDATE ops.chasis_agency SET prospect_id = v_existing, updated_at = now() WHERE id = p_agency_id;
  SELECT to_jsonb(a) INTO v_after FROM ops.chasis_agency a WHERE a.id = p_agency_id;
  PERFORM ops.log_action(p_actor_id, 'chasis_agency.link_prospect', 'ops.chasis_agency', p_agency_id,
                         v_agency, v_after, CASE WHEN v_created THEN 'created' ELSE 'existing' END);
  RETURN jsonb_build_object('prospect_id', v_existing, 'created', v_created);
END;
$$;
