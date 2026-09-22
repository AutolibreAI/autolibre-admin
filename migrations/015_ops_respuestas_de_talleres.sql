-- ═══════════════════════════════════════════════════════════════════════════
-- 015 — Lo que cada taller contestó para un pedido de presupuesto.
--
-- El operador llama o escribe a los talleres, y cada uno contesta algo: a
-- veces un precio, a veces "traelo que lo vemos sin cargo", a veces una
-- hipótesis del problema y un turno. Con eso arma UN mensaje de WhatsApp para
-- que la persona elija y coordine ella misma el turno.
--
-- Hasta hoy eso vivía en `quote_requests.internal_notes` (texto libre) y en
-- `proposals_count` (un número suelto). Los seis `[corchetes]` de la plantilla
-- "Presupuesto" de `~/lib/quote-templates` existían exactamente por esto.
--
-- ── POR QUÉ ACÁ Y NO EN `public.quote_request_proposals` ───────────────────
--
-- El backend tiene una tabla parecida —`public.quote_request_proposals`,
-- relevada en producción el 2026-09-22: existe, 0 filas— y esta migración
-- **deliberadamente NO la usa**. Una primera versión sí la usaba; se descartó
-- al ver un mensaje real del operador. Los dos motivos, y cualquiera alcanza:
--
--   1. **No admite una respuesta sin precio.** `amount_min` y `amount_max`
--      son NOT NULL y `chk_quote_request_proposals_amount_min_positive` exige
--      `amount_min > 0` — ESTRICTO, así que ni siquiera se puede cargar 0.
--      En el mensaje real que motivó este cambio, los TRES talleres
--      contestaron sin precio: era un diagnóstico. No es un caso de borde.
--   2. **No tiene dónde guardar el contacto de un taller de afuera.** Sólo
--      `partner_id` o `provider_name`. Para los del directorio la dirección y
--      el teléfono salen de `partners`; para el resto no hay columna, y el
--      mensaje los necesita — es lo que hace que la persona pueda avanzar
--      sola.
--
-- Que la tabla del backend exista no la vuelve la tabla del dominio de ESTO:
-- describe *una oferta con precio*, y lo que el panel maneja es *la respuesta
-- de un taller*, de la cual el precio es un atributo a veces ausente. Son
-- conceptos distintos y por eso el nombre también lo es (ver abajo).
--
-- Al 2026-09-22 **nada lee `quote_request_proposals`**: 0 filas en producción,
-- y todo lo que la persona recibe se lo manda el operador por WhatsApp a mano.
-- Así que no hay dos verdades que sincronizar — hay una, y es ésta.
--
-- ── EL CAMINO DE VUELTA, PARA QUE NO SE PIERDA ────────────────────────────
--
-- El día que el backend acepte precio nulo y sume el contacto del taller de
-- afuera, esto se retira y el subconjunto con precio se backfillea:
--
--   INSERT INTO quote_request_proposals
--     (quote_request_id, partner_id, provider_name, amount_min, amount_max,
--      currency, description, internal_notes, valid_until, created_at)
--   SELECT quote_request_id, partner_id, provider_name, amount_min, amount_max,
--          currency::quote_request_proposal_currency, detail, internal_notes,
--          valid_until, created_at
--     FROM ops.quote_request_response
--    WHERE amount_min IS NOT NULL AND amount_min > 0;
--
-- Las columnas de acá se eligieron para que ese INSERT sea posible: mismos
-- nombres y mismos tipos donde el backend ya los definió.
--
-- ── VOCABULARIO: `response`, no `proposal` ────────────────────────────────
--
-- Regla dura 7 (el vocabulario es el del backend) no obliga a llamar igual a
-- dos cosas distintas — obliga a lo contrario. `proposal` es el sustantivo del
-- backend para una oferta con precio (`quote_requests.proposals_count`), y una
-- fila de acá puede no tenerlo. Llamarla `proposal` haría que dos tablas casi
-- homónimas signifiquen cosas distintas, que es el peor de los mundos.
--
-- La UI dice "Presupuestos" porque es la palabra del equipo. Es la misma
-- divergencia deliberada que `tier` ↔ "Aliado" y `service_categories` ↔
-- "Rubro", y está anotada en `.claude/rules/leads.md`.
--
-- ── LOS 8 GUARDRAILS, IGUAL QUE 007–013 ───────────────────────────────────
--
--   1. Vive en `migrations/`, nunca DDL a mano.
--   2. SECURITY INVOKER (el default). El control de acceso es de `adminMiddleware`.
--   3. `SET search_path` fijo.
--   4. `p_actor_id` sale de la sesión de Clerk, JAMÁS del payload.
--   5. Escribe `ops.action_log` DENTRO de la función, con `before`/`after` jsonb.
--   6. **Ninguna FK cruza a `public`**: `quote_request_id`, `partner_id` y
--      `actor_id` son UUID pelados. El nombre y el contacto del partner se
--      resuelven con `LEFT JOIN` al leer — si el backend borra un partner, la
--      respuesta que dio sigue existiendo.
--   7. `SELECT … FOR UPDATE` antes de editar o borrar. En el ALTA no aplica
--      (no hay fila previa), igual que en la 012.
--   8. `updated_at` lo escriben estas funciones y NADIE más: no hay trigger de
--      `updated_at` en `ops` para esta tabla, así que no hay duplicación que
--      pueda divergir. Es la diferencia con `partners`/`leads`, donde el
--      trigger existe y por eso el SP no lo toca.
--
-- ── EL PRECIO TIENE TRES ESTADOS, Y LOS TRES SIGNIFICAN COSAS DISTINTAS ───
--
--   NULL  → el taller no pasó precio (un diagnóstico, "traelo y vemos").
--   0     → sin cargo / bonificado. Es un precio, y se muestra como tal.
--   > 0   → el precio, cerrado (`min = max`) o rango.
--
-- Por eso `amount_min >= 0` y no `> 0` como el backend: "diagnóstico sin
-- cargo" es literalmente lo que dijo uno de los talleres del mensaje que
-- motivó esta migración, y `NULL` ya está tomado por "no dijo nada".
--
-- ── LO QUE NO DECIDE ──────────────────────────────────────────────────────
--
-- Sólo valida REPRESENTABILIDAD. En particular, y a propósito:
--
--   * **No exige que el pedido esté abierto.** Una respuesta que llegó tarde
--     es un hecho real. La máquina de estados es de `quote_requests` (011).
--   * **No exige que el partner esté `active`.** Un taller pausado igual pudo
--     contestar ayer. Se valida que EXISTA, no que esté publicado.
--   * **No toca `quote_requests.proposals_count`.** Esa columna la escribe
--     `ops.mark_quote_request_answered` (011), que la exige para pasar a
--     `answered`. Sincronizarla con un `count(*)` sería mover el estado del
--     pedido de costado, sin pasar por su guarda de estado.
--   * **No marca "el elegido".** No hay columna, y `quote_requests.outcome` ya
--     dice si contrató, sin decir a quién. Agregarlo es una decisión aparte.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ops.quote_request_response (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- UUID pelados, sin FK (guardrail 6).
  quote_request_id uuid        NOT NULL,
  partner_id       uuid,
  actor_id         uuid        NOT NULL,

  -- Orden en el mensaje. NO es el orden de carga ni el de precio: el operador
  -- decide cuál conviene mostrar primero (en el mensaje que motivó esto, el
  -- primero era el que daba diagnóstico sin cargo, no el más barato — de
  -- hecho ninguno tenía precio).
  position         int         NOT NULL,

  -- El taller de AFUERA: nombre, y el contacto que la persona necesita para
  -- coordinar sola. Para un partner del directorio esto va NULL y los datos
  -- se leen de `partners` al mostrar, así que siguen al directorio si cambian.
  provider_name    text,
  provider_address text,
  provider_phone   text,

  -- NULL = no pasó precio. 0 = sin cargo. Ver la cabecera.
  amount_min       numeric(12,2),
  amount_max       numeric(12,2),
  currency         text        NOT NULL DEFAULT 'ARS',

  -- Lo que le contamos a la persona sobre ESTE taller: qué ofrece, qué dijo
  -- del problema, cuándo lo puede ver. Es el párrafo del mensaje.
  detail           text        NOT NULL,

  valid_until      date,
  -- Para el operador. NO sale en el mensaje.
  internal_notes   text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- Mismo invariante que el CHECK del backend: o es del directorio, o es de
  -- afuera con nombre. Nunca los dos, nunca ninguno.
  CONSTRAINT chk_ops_qrr_provider_identified
    CHECK (num_nonnulls(partner_id, provider_name) = 1),

  -- El contacto tipeado sólo tiene sentido para un taller de afuera: el del
  -- directorio lo tiene en `partners`, y guardar una copia acá sería una
  -- segunda verdad que envejece sola.
  CONSTRAINT chk_ops_qrr_contact_only_for_outsiders
    CHECK (partner_id IS NULL OR (provider_address IS NULL AND provider_phone IS NULL)),

  CONSTRAINT chk_ops_qrr_texts_not_blank
    CHECK (btrim(detail) <> ''
       AND (provider_name IS NULL    OR btrim(provider_name) <> '')
       AND (provider_address IS NULL OR btrim(provider_address) <> '')
       AND (provider_phone IS NULL   OR btrim(provider_phone) <> '')
       AND (internal_notes IS NULL   OR btrim(internal_notes) <> '')),

  -- Las dos puntas van juntas o ninguna: "de 80.000 a NULL" no es un rango.
  CONSTRAINT chk_ops_qrr_amounts_paired
    CHECK ((amount_min IS NULL) = (amount_max IS NULL)),
  -- `>= 0` y no `> 0`: 0 es "sin cargo", que es un precio. NULL es "no dijo".
  CONSTRAINT chk_ops_qrr_amount_range
    CHECK (amount_min IS NULL OR (amount_min >= 0 AND amount_min <= amount_max)),

  -- Nuestro, no el enum de `public`: esta tabla no depende del deploy del
  -- backend (mismo motivo por el que los SP toman `text`, ver la 011).
  CONSTRAINT chk_ops_qrr_currency
    CHECK (currency IN ('ARS', 'USD'))
);

-- "Las respuestas de ESTE pedido, en orden" — la única consulta que se hace.
CREATE INDEX IF NOT EXISTS idx_ops_qrr_request
  ON ops.quote_request_response (quote_request_id, position, created_at);

-- ── Piezas compartidas ──────────────────────────────────────────────────────

/** La fila bloqueada, como jsonb. Guardrail 7, camino de editar/borrar. */
CREATE OR REPLACE FUNCTION ops._lock_quote_response(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_row jsonb;
BEGIN
  SELECT to_jsonb(r) INTO v_row
    FROM ops.quote_request_response r
   WHERE r.id = p_id
     FOR UPDATE;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'QUOTE_RESPONSE_NOT_FOUND: %', p_id
      USING HINT = 'Se busca por el id de la respuesta, no por el del pedido.';
  END IF;

  RETURN v_row;
END;
$$;

/**
 * Valida y normaliza lo que comparten el alta y la edición, y devuelve los
 * valores limpios.
 *
 * Está en una función aparte para que las dos no puedan divergir: un `IF` que
 * sólo esté en una de las dos es un dato que entra por el otro camino, y no
 * hay nada que lo delate. El caso de la suite que edita con un rango invertido
 * verifica justamente eso.
 *
 * `p_created_on` es la fecha contra la que se mide la vigencia: hoy al dar de
 * alta, el `created_at` de la fila al editar — así, corregirle el texto a una
 * respuesta de la semana pasada no obliga a moverle la vigencia al futuro.
 */
CREATE OR REPLACE FUNCTION ops._normalize_quote_response(
  p_partner_id       uuid,
  p_provider_name    text,
  p_provider_address text,
  p_provider_phone   text,
  p_amount_min       numeric,
  p_amount_max       numeric,
  p_currency         text,
  p_detail           text,
  p_valid_until      text,
  p_internal_notes   text,
  p_created_on       date
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_name        text;
  v_address     text;
  v_phone       text;
  v_detail      text;
  v_notes       text;
  v_currency    text;
  v_valid_until date;
  v_min         numeric;
  v_max         numeric;
BEGIN
  -- `''` → NULL antes de contar proveedores: el import del legacy sheet dejó
  -- strings vacíos por todos lados, y un `''` contaría como "hay nombre".
  v_name    := nullif(btrim(coalesce(p_provider_name, '')), '');
  v_address := nullif(btrim(coalesce(p_provider_address, '')), '');
  v_phone   := nullif(btrim(coalesce(p_provider_phone, '')), '');
  v_detail  := nullif(btrim(coalesce(p_detail, '')), '');
  v_notes   := nullif(btrim(coalesce(p_internal_notes, '')), '');

  -- Los dos lados se traducen por separado: "no elegiste taller" y "elegiste
  -- dos cosas" son errores distintos para quien opera.
  IF p_partner_id IS NULL AND v_name IS NULL THEN
    RAISE EXCEPTION 'PROVIDER_REQUIRED'
      USING HINT = 'O un partner del directorio, o el nombre de un taller de afuera.';
  END IF;
  IF p_partner_id IS NOT NULL AND v_name IS NOT NULL THEN
    RAISE EXCEPTION 'PROVIDER_AMBIGUOUS'
      USING HINT = 'Es uno o el otro: la tabla exige num_nonnulls(partner_id, provider_name) = 1.';
  END IF;
  IF p_partner_id IS NOT NULL AND (v_address IS NOT NULL OR v_phone IS NOT NULL) THEN
    RAISE EXCEPTION 'PROVIDER_CONTACT_NOT_EDITABLE'
      USING HINT = 'La dirección y el teléfono de un partner salen de `partners`. Corregilos en su ficha.';
  END IF;

  -- Que EXISTA, no que esté `active`: un taller pausado igual pudo contestar.
  IF p_partner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM partners WHERE id = p_partner_id) THEN
    RAISE EXCEPTION 'PARTNER_NOT_FOUND: %', p_partner_id;
  END IF;

  IF v_detail IS NULL THEN
    RAISE EXCEPTION 'DETAIL_REQUIRED'
      USING HINT = 'Qué contestó el taller. Es el párrafo que lee la persona.';
  END IF;

  -- Las dos puntas, o ninguna. Sin precio se manda NULL en las dos: es lo que
  -- distingue "no pasó precio" de "sin cargo" (que es 0).
  v_min := p_amount_min;
  v_max := p_amount_max;
  IF (v_min IS NULL) <> (v_max IS NULL) THEN
    RAISE EXCEPTION 'AMOUNT_INCOMPLETE'
      USING HINT = 'Las dos puntas del rango, o ninguna. Para un precio cerrado, el mismo número dos veces.';
  END IF;
  IF v_min IS NOT NULL THEN
    IF v_min < 0 THEN
      RAISE EXCEPTION 'INVALID_AMOUNT: %', v_min
        USING HINT = 'Un precio no puede ser negativo. Cero es válido: significa sin cargo.';
    END IF;
    IF v_min > v_max THEN
      RAISE EXCEPTION 'INVALID_AMOUNT_RANGE: % > %', v_min, v_max;
    END IF;
    -- numeric(12,2). Sin esto el error sería un `numeric field overflow` crudo.
    IF v_max > 9999999999.99 THEN
      RAISE EXCEPTION 'AMOUNT_TOO_LARGE: %', v_max
        USING HINT = 'El máximo que entra en numeric(12,2) es 9.999.999.999,99.';
    END IF;
  END IF;

  v_currency := upper(nullif(btrim(coalesce(p_currency, '')), ''));
  IF v_currency IS NULL THEN
    v_currency := 'ARS';
  END IF;
  IF v_currency NOT IN ('ARS', 'USD') THEN
    RAISE EXCEPTION 'INVALID_CURRENCY: %', v_currency
      USING HINT = 'Valores válidos: ARS, USD.';
  END IF;

  -- Parseada ANTES de escribir, para traducir el error de formato. Mismo
  -- patrón que `follow_up_date` en la 010.
  BEGIN
    v_valid_until := nullif(btrim(coalesce(p_valid_until, '')), '')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'INVALID_VALID_UNTIL: %', p_valid_until
      USING HINT = 'Usá YYYY-MM-DD, o vacío para dejarlo sin vencimiento.';
  END;

  IF v_valid_until IS NOT NULL AND v_valid_until < p_created_on THEN
    RAISE EXCEPTION 'VALID_UNTIL_IN_PAST: % < %', v_valid_until, p_created_on
      USING HINT = 'La vigencia se mide contra la fecha de carga de la respuesta, no contra hoy.';
  END IF;

  RETURN jsonb_build_object(
    'partner_id',       p_partner_id,
    'provider_name',    v_name,
    'provider_address', v_address,
    'provider_phone',   v_phone,
    'amount_min',       v_min,
    'amount_max',       v_max,
    'currency',         v_currency,
    'detail',           v_detail,
    'valid_until',      v_valid_until,
    'internal_notes',   v_notes
  );
END;
$$;

-- ── Alta ────────────────────────────────────────────────────────────────────

/**
 * Cargar lo que contestó un taller.
 *
 * `position` se asigna al final de la lista de ESE pedido. El orden lo cambia
 * después `ops.reorder_quote_request_responses`, porque el orden del mensaje
 * es editorial —cuál conviene mostrar primero— y no el orden de carga ni el
 * de precio.
 */
CREATE OR REPLACE FUNCTION ops.add_quote_request_response(
  p_quote_request_id uuid,
  p_actor_id         uuid,
  p_detail           text,
  p_partner_id       uuid    DEFAULT NULL,
  p_provider_name    text    DEFAULT NULL,
  p_provider_address text    DEFAULT NULL,
  p_provider_phone   text    DEFAULT NULL,
  p_amount_min       numeric DEFAULT NULL,
  p_amount_max       numeric DEFAULT NULL,
  p_currency         text    DEFAULT 'ARS',
  p_valid_until      text    DEFAULT NULL,
  p_internal_notes   text    DEFAULT NULL,
  p_note             text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_clean jsonb;
  v_after jsonb;
  v_id    uuid;
  v_pos   int;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  -- Sin FK que lo garantice (guardrail 6), así que se chequea acá. Mismo
  -- patrón que la 013.
  IF NOT EXISTS (SELECT 1 FROM quote_requests WHERE id = p_quote_request_id) THEN
    RAISE EXCEPTION 'QUOTE_REQUEST_NOT_FOUND: %', p_quote_request_id
      USING HINT = 'Se busca por id (UUID), no por el código AL-n.';
  END IF;

  v_clean := ops._normalize_quote_response(
    p_partner_id, p_provider_name, p_provider_address, p_provider_phone,
    p_amount_min, p_amount_max, p_currency, p_detail, p_valid_until,
    p_internal_notes, (now() AT TIME ZONE 'UTC')::date
  );

  SELECT coalesce(max(position), 0) + 1 INTO v_pos
    FROM ops.quote_request_response
   WHERE quote_request_id = p_quote_request_id;

  INSERT INTO ops.quote_request_response (
    quote_request_id, actor_id, position,
    partner_id, provider_name, provider_address, provider_phone,
    amount_min, amount_max, currency, detail, valid_until, internal_notes
  )
  VALUES (
    p_quote_request_id, p_actor_id, v_pos,
    (v_clean->>'partner_id')::uuid,
    v_clean->>'provider_name',
    v_clean->>'provider_address',
    v_clean->>'provider_phone',
    (v_clean->>'amount_min')::numeric,
    (v_clean->>'amount_max')::numeric,
    v_clean->>'currency',
    v_clean->>'detail',
    (v_clean->>'valid_until')::date,
    v_clean->>'internal_notes'
  )
  RETURNING id INTO v_id;

  SELECT to_jsonb(r) INTO v_after FROM ops.quote_request_response r WHERE r.id = v_id;

  -- `before` NULL: no había fila. Mismo criterio que el alta de la 012.
  PERFORM ops.log_action(
    p_actor_id, 'quote_request_response.add', 'ops.quote_request_response', v_id,
    NULL, v_after, p_note
  );

  RETURN v_after;
END;
$$;

-- ── Edición ─────────────────────────────────────────────────────────────────

/**
 * Corregir una respuesta ya cargada.
 *
 * **Reemplazo completo, no parche.** Lo que llega es exactamente lo que queda
 * guardado — misma decisión que el formulario de `set_partner_contact`: un
 * form que manda parches parciales es más eficiente y es imposible de leer
 * cuando algo sale mal. Un campo opcional que no viene se BORRA.
 *
 * `quote_request_id` y `position` NO se tocan acá: el primero porque una
 * respuesta pertenece al pedido en el que se cargó (si se cargó en el
 * equivocado, se borra y se carga en el que va, y quedan las dos cosas en el
 * log); el segundo porque tiene su propia función.
 */
CREATE OR REPLACE FUNCTION ops.update_quote_request_response(
  p_id               uuid,
  p_actor_id         uuid,
  p_detail           text,
  p_partner_id       uuid    DEFAULT NULL,
  p_provider_name    text    DEFAULT NULL,
  p_provider_address text    DEFAULT NULL,
  p_provider_phone   text    DEFAULT NULL,
  p_amount_min       numeric DEFAULT NULL,
  p_amount_max       numeric DEFAULT NULL,
  p_currency         text    DEFAULT 'ARS',
  p_valid_until      text    DEFAULT NULL,
  p_internal_notes   text    DEFAULT NULL,
  p_note             text    DEFAULT NULL
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
  v_before := ops._lock_quote_response(p_id);

  v_clean := ops._normalize_quote_response(
    p_partner_id, p_provider_name, p_provider_address, p_provider_phone,
    p_amount_min, p_amount_max, p_currency, p_detail, p_valid_until,
    p_internal_notes,
    ((v_before->>'created_at')::timestamptz AT TIME ZONE 'UTC')::date
  );

  UPDATE ops.quote_request_response
     SET partner_id       = (v_clean->>'partner_id')::uuid,
         provider_name    = v_clean->>'provider_name',
         provider_address = v_clean->>'provider_address',
         provider_phone   = v_clean->>'provider_phone',
         amount_min       = (v_clean->>'amount_min')::numeric,
         amount_max       = (v_clean->>'amount_max')::numeric,
         currency         = v_clean->>'currency',
         detail           = v_clean->>'detail',
         valid_until      = (v_clean->>'valid_until')::date,
         internal_notes   = v_clean->>'internal_notes',
         -- Guardrail 8 al revés que en `public`: acá NO hay trigger, así que
         -- lo escribe la función. `created_at` no se toca nunca.
         updated_at       = now()
   WHERE id = p_id;

  SELECT to_jsonb(r) INTO v_after FROM ops.quote_request_response r WHERE r.id = p_id;

  PERFORM ops.log_action(
    p_actor_id, 'quote_request_response.update', 'ops.quote_request_response', p_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;

-- ── Baja ────────────────────────────────────────────────────────────────────

/**
 * Borrar una respuesta cargada mal.
 *
 * La fila entera queda en `ops.action_log.before`, así que un borrado por
 * error se puede reconstruir leyendo el log.
 *
 * NO renumera las posiciones de las que quedan: los huecos no molestan porque
 * el orden se lee por `position ASC` y no por su valor absoluto. Renumerar
 * acá obligaría a tocar filas que nadie pidió tocar, y cada una dejaría su
 * entrada en el log.
 */
CREATE OR REPLACE FUNCTION ops.delete_quote_request_response(
  p_id       uuid,
  p_actor_id uuid,
  p_note     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);
  v_before := ops._lock_quote_response(p_id);

  DELETE FROM ops.quote_request_response WHERE id = p_id;

  PERFORM ops.log_action(
    p_actor_id, 'quote_request_response.delete', 'ops.quote_request_response', p_id,
    v_before, NULL, p_note
  );

  RETURN v_before;
END;
$$;

-- ── Orden ───────────────────────────────────────────────────────────────────

/**
 * Reordenar las respuestas de un pedido.
 *
 * El orden del mensaje es EDITORIAL: en el mensaje real que motivó esta
 * migración, el primero era el que daba diagnóstico sin cargo y en el día, no
 * el más barato — de hecho ninguno de los tres tenía precio. Ordenar por
 * `amount_min` habría dado un orden arbitrario.
 *
 * Recibe la lista COMPLETA de ids en el orden deseado, no un "mové éste una
 * posición". Con un movimiento relativo, dos operadores reordenando a la vez
 * dejan un orden que ninguno de los dos pidió; con la lista entera, el último
 * que guarda gana y el resultado es el que vio en pantalla.
 *
 * Una sola entrada en `ops.action_log` para todo el reordenamiento: es UN acto
 * de edición, igual que el perfil de un partner en la 008.
 */
CREATE OR REPLACE FUNCTION ops.reorder_quote_request_responses(
  p_quote_request_id uuid,
  p_ids              uuid[],
  p_actor_id         uuid,
  p_note             text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_actual int;
  v_given  int;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RAISE EXCEPTION 'REORDER_EMPTY'
      USING HINT = 'Mandá la lista completa de ids en el orden deseado.';
  END IF;

  -- Lockea las filas del pedido antes de leer el `before` (guardrail 7).
  SELECT jsonb_agg(jsonb_build_object('id', r.id, 'position', r.position) ORDER BY r.position, r.created_at)
    INTO v_before
    FROM (
      SELECT id, position, created_at
        FROM ops.quote_request_response
       WHERE quote_request_id = p_quote_request_id
       ORDER BY position, created_at
         FOR UPDATE
    ) r;

  IF v_before IS NULL THEN
    RAISE EXCEPTION 'QUOTE_REQUEST_NOT_FOUND: %', p_quote_request_id
      USING HINT = 'Ese pedido no tiene respuestas cargadas.';
  END IF;

  -- La lista tiene que ser EXACTAMENTE el conjunto de ese pedido: ni de menos
  -- (quedarían con su posición vieja, mezcladas), ni de más (ids de otro
  -- pedido, que este UPDATE ignoraría en silencio).
  SELECT count(*) INTO v_actual
    FROM ops.quote_request_response WHERE quote_request_id = p_quote_request_id;
  SELECT count(DISTINCT x) INTO v_given FROM unnest(p_ids) AS x;

  IF v_given <> cardinality(p_ids) THEN
    RAISE EXCEPTION 'REORDER_DUPLICATE_IDS';
  END IF;
  IF v_given <> v_actual
     OR EXISTS (
          SELECT 1 FROM unnest(p_ids) AS x
           WHERE NOT EXISTS (
             SELECT 1 FROM ops.quote_request_response
              WHERE id = x AND quote_request_id = p_quote_request_id))
  THEN
    RAISE EXCEPTION 'REORDER_MISMATCH: se esperaban % ids de este pedido, llegaron %', v_actual, v_given
      USING HINT = 'Mandá la lista COMPLETA de ids del pedido, sin ajenos.';
  END IF;

  UPDATE ops.quote_request_response r
     SET position = o.ord,
         updated_at = now()
    FROM unnest(p_ids) WITH ORDINALITY AS o(id, ord)
   WHERE r.id = o.id;

  SELECT jsonb_agg(jsonb_build_object('id', r.id, 'position', r.position) ORDER BY r.position)
    INTO v_after
    FROM ops.quote_request_response r
   WHERE r.quote_request_id = p_quote_request_id;

  PERFORM ops.log_action(
    p_actor_id, 'quote_request_response.reorder', 'ops.quote_request_response', p_quote_request_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;
