-- ═══════════════════════════════════════════════════════════════════════════
-- 007 — Las primeras acciones de escritura del panel.
--
-- ── POR QUÉ ESTO EXISTE, Y POR QUÉ NO ES UN ATAJO ─────────────────────────
--
-- Hasta acá `ops` sólo leía. Esta migración es la primera que ESCRIBE sobre
-- tablas de `public`, que es del backend. Eso pide una justificación fuerte, y
-- la hay — verificada en el código del backend, no supuesta:
--
--   1. `IPartnerRepository` (marketplace/partner/application/port/) expone
--      SOLO `findActive()` y `findActiveById()`. No hay `save`, no hay
--      `update`. Los únicos casos de uso son `get-partner` y `list-partners`.
--      **El backend no puede editar un partner.** No es que convenga que lo
--      haga el panel: no existe otro camino.
--
--   2. `ILeadRepository` tiene `save()`, pero el único caso de uso que lo usa
--      es `submit-lead`, que crea el lead en `new`. Nada lo mueve de ahí.
--
--   3. Y el propio backend lo dice, en `lead-status.vo.ts`:
--
--        "La app solo crea leads en `new`; el resto del recorrido lo mueve el
--         equipo desde SQL, igual que el pipeline de las solicitudes."
--
--      O sea que este SQL **ya estaba designado**. Lo que cambia es dónde vive:
--      deja de ser una sentencia pegada a mano en DBeaver y pasa a estar
--      versionada, revisada y auditada. Ese es exactamente el problema que este
--      repo existe para eliminar.
--
-- ── LO QUE ESTO NO HABILITA ───────────────────────────────────────────────
--
-- Sigue vigente la condición que el backend le puso a
-- `approve_partner_application()`: **mueven estado y copian datos, no deciden
-- nada.** Cada función de acá valida que la operación sea REPRESENTABLE (el
-- destino existe, la latitud está en rango, el estado es del enum) y nada más.
-- No hay reglas de negocio: no decide si un partner "merece" estar activo, ni
-- si un lead "debería" darse por perdido. Eso lo decide la persona; la función
-- ejecuta.
--
-- Y no se agrega una función acá para reintentar procesos del backend
-- (notificaciones, consultas VTV). Eso NO es mover estado: es disparar trabajo
-- de otro sistema, con índices únicos parciales y facturación de proveedores
-- de por medio. → .claude/rules/ops-metrics.md
--
-- ── NINGUNA FK CRUZA A `public` ───────────────────────────────────────────
--
-- `ops.action_log.actor_id` y `.target_id` son UUID PELADOS. Una FK acá volvería
-- a atar los dos schemas justo en lo que se quiso desatar, y haría que un
-- `DELETE` del backend fallara por una fila de auditoría nuestra.
--
-- ── SECURITY INVOKER (el default), NUNCA DEFINER ──────────────────────────
--
-- `SECURITY DEFINER` haría que estas funciones corran con los permisos del
-- dueño, convirtiendo cada una en una escalada de privilegios disponible para
-- cualquiera que pueda ejecutarlas. El control de acceso vive en
-- `adminMiddleware`, del lado de la app, donde está la sesión de Clerk.
--
-- `search_path` fijo en cada función: sin eso, un `search_path` manipulado en la
-- sesión puede hacer que `partners` resuelva a otra tabla.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Auditoría ──────────────────────────────────────────────────────────────
--
-- `public` NO tiene rastro de quién cambió qué desde el panel: `partners` y
-- `leads` sólo tienen `updated_at`, que dice cuándo y no dice quién. Sin esta
-- tabla, "¿quién pausó este taller?" no tiene respuesta.
--
-- Guarda `before` Y `after` completos en jsonb. Guardar sólo el delta parecía
-- más prolijo y es peor: el día que haga falta reconstruir el estado previo, un
-- delta sin base no alcanza.

CREATE TABLE IF NOT EXISTS ops.action_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- `users.id` del admin que ejecutó. UUID pelado, sin FK: ver arriba.
  actor_id     uuid        NOT NULL,
  action       text        NOT NULL,
  target_table text        NOT NULL,
  target_id    uuid        NOT NULL,
  before       jsonb,
  after        jsonb,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- "¿Qué le pasó a ESTA fila?" — la consulta que se va a hacer siempre.
CREATE INDEX IF NOT EXISTS idx_ops_action_log_target
  ON ops.action_log (target_table, target_id, created_at DESC);

-- "¿Qué hizo ESTA persona?" — la segunda, y la que importa en una auditoría.
CREATE INDEX IF NOT EXISTS idx_ops_action_log_actor
  ON ops.action_log (actor_id, created_at DESC);

/**
 * Chequeo de integridad del actor, no de autorización.
 *
 * La autorización es de `adminMiddleware`. Esto sólo evita que quede un
 * `actor_id` que no corresponde a nadie: un log de auditoría con actores
 * fantasma no sirve para auditar, que es su única razón de existir.
 *
 * NO valida que sea admin a propósito. El rol puede cambiar con el tiempo y la
 * auditoría tiene que registrar lo que pasó, no re-litigarlo.
 */
CREATE OR REPLACE FUNCTION ops.assert_actor(p_actor_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_REQUIRED'
      USING HINT = 'El actor sale de la sesión de Clerk, nunca del payload.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_actor_id) THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND: %', p_actor_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION ops.log_action(
  p_actor_id     uuid,
  p_action       text,
  p_target_table text,
  p_target_id    uuid,
  p_before       jsonb,
  p_after        jsonb,
  p_note         text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, public, ops
AS $$
  INSERT INTO ops.action_log (
    actor_id, action, target_table, target_id, before, after, note
  )
  VALUES (
    p_actor_id, p_action, p_target_table, p_target_id, p_before, p_after,
    nullif(btrim(p_note), '')
  );
$$;

-- ── Partners ───────────────────────────────────────────────────────────────
--
-- Las tres funciones comparten forma: leen el estado previo, escriben, loguean
-- y devuelven el estado nuevo como jsonb.
--
-- Devuelven `jsonb` y no un tipo compuesto a propósito. Un `RETURNS TABLE(...)`
-- con la lista de columnas obliga a un `DROP FUNCTION` + `CREATE` cada vez que
-- el backend agregue una columna a `partners` — una migración nuestra
-- disparada por un cambio del otro repo, que es justo el acoplamiento que
-- separar los schemas vino a evitar.
--
-- `updated_at` NO se toca en ningún UPDATE: `trg_partners_updated_at` ya lo
-- hace. Escribirlo a mano acá y en el trigger es la clase de duplicación que
-- diverge en silencio.

/**
 * Mover un partner entre `active | paused | archived`.
 *
 * Qué significa cada uno para la app: `idx_partners_active_tier_name` es parcial
 * sobre `status = 'active'`, y `findActive()` del backend filtra por lo mismo.
 * Pausar es sacarlo del marketplace sin borrar nada; archivar es lo mismo con
 * intención de no volver.
 *
 * NO valida transiciones (no hay máquina de estados en el dominio: el enum es
 * plano). Cualquiera de los tres a cualquiera de los tres.
 */
CREATE OR REPLACE FUNCTION ops.set_partner_status(
  p_partner_id uuid,
  p_status     text,
  p_actor_id   uuid,
  p_note       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_status partner_status;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  -- El cast valida contra el enum. Se captura para dar un error legible en vez
  -- del `invalid input value for enum` crudo de Postgres.
  BEGIN
    v_status := p_status::partner_status;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'INVALID_STATUS: %', p_status
      USING HINT = 'Valores válidos: active, paused, archived.';
  END;

  -- FOR UPDATE: dos admins tocando el mismo partner se serializan. Sin esto, el
  -- `before` del log puede ser de un estado que ya no existía al escribir.
  SELECT to_jsonb(p) INTO v_before FROM partners p WHERE p.id = p_partner_id FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'PARTNER_NOT_FOUND: %', p_partner_id;
  END IF;

  UPDATE partners SET status = v_status WHERE id = p_partner_id;

  SELECT to_jsonb(p) INTO v_after FROM partners p WHERE p.id = p_partner_id;
  PERFORM ops.log_action(
    p_actor_id, 'partner.set_status', 'public.partners', p_partner_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;

/**
 * Cargar (o borrar) las coordenadas de un partner.
 *
 * El caso que motiva esta función: al 2026-08-30, los 34 partners activos de
 * producción tienen `latitude IS NULL`. El marketplace no puede ordenar por
 * cercanía a nadie — el usuario ve un taller a 400 km arriba de uno a seis
 * cuadras.
 *
 * LAS DOS COORDENADAS VIAJAN JUNTAS, siempre. Un partner con `latitude` y sin
 * `longitude` no es "medio geolocalizado": es una fila corrupta que cualquier
 * cálculo de distancia va a leer como (lat, 0) — un punto en el Golfo de
 * Guinea. Por eso se rechaza el par incompleto en vez de aceptarlo a medias.
 *
 * Pasar (NULL, NULL) borra la geo. Es deliberado: si alguien cargó mal una
 * coordenada, poder dejarla vacía es mejor que dejarla mal.
 */
CREATE OR REPLACE FUNCTION ops.set_partner_location(
  p_partner_id uuid,
  p_latitude   double precision,
  p_longitude  double precision,
  p_actor_id   uuid,
  p_note       text DEFAULT NULL
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

  IF (p_latitude IS NULL) <> (p_longitude IS NULL) THEN
    RAISE EXCEPTION 'INCOMPLETE_COORDINATES'
      USING HINT = 'Mandá las dos coordenadas, o las dos en NULL para borrarlas.';
  END IF;

  IF p_latitude IS NOT NULL AND (p_latitude < -90 OR p_latitude > 90) THEN
    RAISE EXCEPTION 'LATITUDE_OUT_OF_RANGE: %', p_latitude;
  END IF;

  IF p_longitude IS NOT NULL AND (p_longitude < -180 OR p_longitude > 180) THEN
    RAISE EXCEPTION 'LONGITUDE_OUT_OF_RANGE: %', p_longitude;
  END IF;

  SELECT to_jsonb(p) INTO v_before FROM partners p WHERE p.id = p_partner_id FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'PARTNER_NOT_FOUND: %', p_partner_id;
  END IF;

  UPDATE partners
     SET latitude = p_latitude, longitude = p_longitude
   WHERE id = p_partner_id;

  SELECT to_jsonb(p) INTO v_after FROM partners p WHERE p.id = p_partner_id;
  PERFORM ops.log_action(
    p_actor_id, 'partner.set_location', 'public.partners', p_partner_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;

/**
 * Completar la ficha de contacto de un partner.
 *
 * NORMALIZA '' A NULL, y no es cosmético: el import del `legacy_sheet` escribió
 * strings vacíos donde no había dato, y por eso todo chequeo de "falta este
 * campo" en este repo se escribe `coalesce(x,'') = ''` en vez de `x IS NULL`.
 * Normalizando en la escritura, las filas nuevas dejan de sumar al problema.
 *
 * NO exige que quede al menos un canal de contacto, aunque un partner activo
 * sin WhatsApp, sin email y sin link es una ficha rota. Eso es una REGLA DE
 * NEGOCIO, y esta función no decide reglas de negocio — la pantalla de Inicio
 * ya cuenta esas fichas y las muestra como pendiente. Si el equipo decide que
 * es inaceptable, el lugar de impedirlo es el formulario, donde se puede
 * cambiar de opinión sin una migración.
 *
 * Cada parámetro en NULL significa "no tocar este campo"; para BORRAR un campo
 * se manda ''. Sin esa distinción no habría forma de limpiar un dato mal
 * cargado sin reescribir los otros cinco.
 */
CREATE OR REPLACE FUNCTION ops.set_partner_contact(
  p_partner_id    uuid,
  p_actor_id      uuid,
  p_whatsapp      text DEFAULT NULL,
  p_email         text DEFAULT NULL,
  p_redirect_link text DEFAULT NULL,
  p_hours         text DEFAULT NULL,
  p_address       text DEFAULT NULL,
  p_note          text DEFAULT NULL
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

  SELECT to_jsonb(p) INTO v_before FROM partners p WHERE p.id = p_partner_id FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'PARTNER_NOT_FOUND: %', p_partner_id;
  END IF;

  UPDATE partners SET
    whatsapp      = CASE WHEN p_whatsapp      IS NULL THEN whatsapp      ELSE nullif(btrim(p_whatsapp), '')      END,
    email         = CASE WHEN p_email         IS NULL THEN email         ELSE nullif(btrim(p_email), '')         END,
    redirect_link = CASE WHEN p_redirect_link IS NULL THEN redirect_link ELSE nullif(btrim(p_redirect_link), '') END,
    hours         = CASE WHEN p_hours         IS NULL THEN hours         ELSE nullif(btrim(p_hours), '')         END,
    address       = CASE WHEN p_address       IS NULL THEN address       ELSE nullif(btrim(p_address), '')       END
  WHERE id = p_partner_id;

  SELECT to_jsonb(p) INTO v_after FROM partners p WHERE p.id = p_partner_id;
  PERFORM ops.log_action(
    p_actor_id, 'partner.set_contact', 'public.partners', p_partner_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;

-- ── Leads ──────────────────────────────────────────────────────────────────

/**
 * Mover un lead por el embudo: new → contacted → won | lost.
 *
 * ── LA MINA: idx_leads_open_user_partner_vehicle_unique ────────────────────
 *
 * Es un índice UNIQUE PARCIAL sobre
 * `(user_id, partner_id, coalesce(vehicle_id, '000…'))` WHERE
 * `status IN ('new','contacted')`. Existe para que un usuario no genere dos
 * contactos abiertos contra el mismo taller por el mismo auto — es la mitad de
 * base del dedupe cuya mitad de aplicación es `Lead.isOpenStatus()`.
 *
 * Consecuencia para esta función: cerrar un lead (→ won/lost) SIEMPRE es
 * seguro, porque lo saca del índice. **REABRIRLO no**: si mientras tanto se
 * creó otro lead abierto para el mismo trío, el UPDATE choca.
 *
 * Se captura `unique_violation` y se traduce. Sin eso, el panel mostraría el
 * texto crudo de Postgres con el nombre del índice, que no le dice nada a quien
 * está atendiendo el lead.
 *
 * ── LAS MARCAS DE TIEMPO ──────────────────────────────────────────────────
 *
 * `contacted_at` se sella la PRIMERA vez y no se vuelve a pisar: es "cuándo lo
 * contactamos", y sobrescribirlo en cada cambio de estado destruiría la única
 * métrica de tiempo de respuesta que tenemos.
 *
 * `won_at` se limpia al salir de `won`. Un lead marcado `lost` con `won_at`
 * cargado es una fila que se contradice a sí misma.
 *
 * ── LO QUE NO DECIDE ──────────────────────────────────────────────────────
 *
 * No exige `lost_reason` para cerrar como perdido, aunque un "perdido" sin
 * motivo no sirve para nada. La columna es NULLABLE en el schema del backend, y
 * esta función no está para endurecer un contrato ajeno. Si el equipo quiere
 * que sea obligatorio, va en el formulario del panel.
 */
CREATE OR REPLACE FUNCTION ops.advance_lead(
  p_lead_id     uuid,
  p_status      text,
  p_actor_id    uuid,
  p_lost_reason text DEFAULT NULL,
  p_note        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_status lead_status;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  BEGIN
    v_status := p_status::lead_status;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'INVALID_STATUS: %', p_status
      USING HINT = 'Valores válidos: new, contacted, won, lost.';
  END;

  SELECT to_jsonb(l) INTO v_before FROM leads l WHERE l.id = p_lead_id FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'LEAD_NOT_FOUND: %', p_lead_id;
  END IF;

  BEGIN
    UPDATE leads SET
      status       = v_status,
      -- Se sella la primera vez. `contacted` y los dos cierres implican que
      -- hubo contacto; volver a `new` no lo borra, porque pasó igual.
      contacted_at = CASE
                       WHEN contacted_at IS NOT NULL THEN contacted_at
                       WHEN v_status IN ('contacted', 'won', 'lost') THEN now()
                       ELSE NULL
                     END,
      won_at       = CASE WHEN v_status = 'won' THEN coalesce(won_at, now()) ELSE NULL END,
      lost_reason  = CASE
                       WHEN v_status = 'lost' THEN nullif(btrim(p_lost_reason), '')
                       -- Sale de `lost`: el motivo de pérdida deja de aplicar.
                       ELSE NULL
                     END,
      note         = CASE WHEN p_note IS NULL THEN note ELSE nullif(btrim(p_note), '') END
    WHERE id = p_lead_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'LEAD_ALREADY_OPEN'
      USING HINT =
        'Ya hay otro lead abierto de este usuario con este partner por el mismo '
        || 'vehículo. Cerrá ese primero, o dejá este cerrado.';
  END;

  SELECT to_jsonb(l) INTO v_after FROM leads l WHERE l.id = p_lead_id;
  PERFORM ops.log_action(
    p_actor_id, 'lead.advance', 'public.leads', p_lead_id, v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;
