-- ═══════════════════════════════════════════════════════════════════════════
-- 012 — Cargar un pedido de presupuesto a mano desde el panel.
--
-- Hasta acá `quote_requests` sólo se llenaba por los tres canales digitales
-- (`app`, `web`, `whatsapp` — vía el endpoint público del backend). Un pedido
-- que llega de forma INFORMAL —alguien llama por teléfono, se acerca a un
-- local, lo deriva un conocido— no pasa por ninguno de esos tres, y hasta
-- ahora no tenía dónde quedar registrado: se perdía, o el operador lo
-- gestionaba por fuera del sistema.
--
-- Esta migración agrega el SP que lo carga: una fila nueva en `quote_requests`,
-- con la misma auditoría que el resto de las escrituras del panel.
--
-- ── POR QUÉ UN SP Y NO EL ENDPOINT PÚBLICO DE CREACIÓN ─────────────────────
--
-- El backend SÍ tiene un camino para crear un `quote_request` — el POST
-- público que usan app/web/whatsapp (mencionado en `.claude/rules/leads.md`:
-- "un POST público con `channel = app` tampoco [tiene cuenta]"). Pero ese
-- endpoint es ANÓNIMO por diseño (así se auto-atienden usuarios sin cuenta), y
-- eso es exactamente lo que lo descarta para esta pantalla: no hay forma de
-- pasarle QUIÉN del equipo cargó el pedido, así que no queda auditoría de
-- autoría — y sin eso, un pedido cargado mal no tiene a quién preguntarle.
-- Mismo argumento de fondo que llevó a los SP de 007-011, aplicado al revés:
-- ahí el backend no tenía NINGÚN camino; acá tiene uno, pero es el camino
-- equivocado para un admin autenticado. `ops.action_log` es storage que el
-- panel controla; el endpoint público no lo sabe ni le importa.
--
-- **El `grep` al backend tampoco se pudo correr para esta migración** — mismo
-- estado que la 010 y la 011: `autolibre-backend-hex` no está clonado acá.
-- Antes de que esto llegue a producción, sigue pendiente confirmar que no
-- exista una variante AdminGuard del alta (`rg -n "AdminGuard" ../autolibre-
-- backend-hex/src/quotes`) que hiciera esto innecesario.
--
-- ── LOS 8 GUARDRAILS, CON UNA SALVEDAD ──────────────────────────────────────
--
--   1. Vive en `migrations/`, nunca DDL a mano.
--   2. SECURITY INVOKER (el default).
--   3. `SET search_path` fijo.
--   4. `p_actor_id` sale de la sesión de Clerk, JAMÁS del payload.
--   5. Escribe `ops.action_log` DENTRO de la función — acá con `before = NULL`
--      (no hay estado previo: la fila no existía) y `after` la fila completa.
--   6. Ninguna FK cruza a `public`.
--   7. **No hay `SELECT … FOR UPDATE`** — es la salvedad, y es porque no
--      aplica: ese guardrail serializa a dos admins editando la MISMA fila
--      existente. Acá no hay fila previa que lockear; el único punto de
--      contención es la nueva `id`, que genera Postgres (`gen_random_uuid()`
--      default de la columna) y no puede colisionar.
--   8. `updated_at` NO se toca a mano: como es un INSERT (no un UPDATE), el
--      trigger `trg_quote_requests_updated_at` ni siquiera dispara — la
--      columna toma su propio `DEFAULT now()`, igual que `created_at`.
--
-- ── LO QUE ESTO NO DECIDE ────────────────────────────────────────────────────
--
-- Sólo valida REPRESENTABILIDAD (columnas NOT NULL de `quote_requests`:
-- `channel`, `contact_phone`, `plate`, `description`). No decide si el pedido
-- "vale la pena", no infiere un `vehicle_id` ni un `user_id` — vincularlos a
-- un vehículo o una cuenta existente es un paso aparte, no distinto del
-- vínculo que ya hace el operador a mano en un pedido llegado por los canales
-- digitales (`.claude/rules/leads.md`, "El vehículo lo vincula el operador").
--
-- `status` arranca en `received` (el `DEFAULT` de la columna) y
-- `public_number` lo asigna la identity de la columna — ninguno de los dos se
-- setea acá. Desde ahí, `ops.advance_quote_request` (migración 011) es lo que
-- mueve el pedido por el embudo, igual que a uno que entró solo.
--
-- ── EL CANAL, Y POR QUÉ NO HAY UNO "INFORMAL" ───────────────────────────────
--
-- `quote_request_channel` tiene sólo `app | web | whatsapp` (relevado con
-- `pg_enum`, no asumido) y es un enum de `public`, del backend — este repo no
-- lo puede ampliar. No existe un valor "teléfono" ni "manual". El formulario
-- del panel pide elegir uno de los tres igual (default `whatsapp`, el más
-- parecido a un contacto informal) en vez de inventar un valor que rompería
-- el enum. La fila queda marcada aparte como cargada a mano — ver abajo — así
-- que el canal elegido no es una mentira sobre CÓMO se enteró el operador,
-- es sólo la aproximación más cercana disponible en el dominio del backend.
--
-- ── `raw_submission` documenta que esto NO es una submission real ─────────
--
-- La columna es NOT NULL: los tres canales digitales la llenan con el body
-- crudo que mandó el cliente. Acá no hay body — lo completa el operador a
-- mano — así que en vez de mandar `'{}'::jsonb` (que se leería como "vino
-- vacía, raro") se guarda `{"source": "admin_manual_entry", "enteredBy": …,
-- "enteredAt": …}`. Es metadata real sobre el origen de la fila, no un dato
-- inventado: permite que el repo derive `enteredManually` (columna nueva de
-- lectura, ver `quote-requests.repo.ts`) sin necesitar una columna aparte que
-- el backend tendría que agregar.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION ops.create_quote_request(
  p_actor_id        uuid,
  p_channel         text,
  p_contact_phone   text,
  p_plate           text,
  p_description     text,
  p_contact_name    text    DEFAULT NULL,
  p_contact_email   text    DEFAULT NULL,
  p_declared_amount numeric DEFAULT NULL,
  p_note            text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_channel        quote_request_channel;
  v_contact_phone  text := btrim(coalesce(p_contact_phone, ''));
  v_plate          text := upper(btrim(coalesce(p_plate, '')));
  v_description    text := btrim(coalesce(p_description, ''));
  v_id             uuid;
  v_after          jsonb;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  BEGIN
    v_channel := p_channel::quote_request_channel;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'INVALID_CHANNEL: %', p_channel
      USING HINT = 'Valores válidos: app, web, whatsapp.';
  END;

  IF v_contact_phone = '' THEN
    RAISE EXCEPTION 'CONTACT_PHONE_REQUIRED'
      USING HINT = 'contact_phone es NOT NULL en public.quote_requests.';
  END IF;
  IF v_plate = '' THEN
    RAISE EXCEPTION 'PLATE_REQUIRED'
      USING HINT = 'plate es NOT NULL en public.quote_requests.';
  END IF;
  IF v_description = '' THEN
    RAISE EXCEPTION 'DESCRIPTION_REQUIRED'
      USING HINT = 'description es NOT NULL en public.quote_requests.';
  END IF;

  INSERT INTO quote_requests (
    channel, contact_name, contact_phone, contact_email, plate, description,
    declared_amount, raw_submission
  ) VALUES (
    v_channel,
    nullif(btrim(coalesce(p_contact_name, '')), ''),
    v_contact_phone,
    nullif(btrim(coalesce(p_contact_email, '')), ''),
    v_plate,
    v_description,
    p_declared_amount,
    jsonb_build_object(
      'source', 'admin_manual_entry',
      'enteredBy', p_actor_id,
      'enteredAt', now()
    )
  )
  RETURNING id INTO v_id;

  SELECT to_jsonb(q) INTO v_after FROM quote_requests q WHERE q.id = v_id;
  PERFORM ops.log_action(
    p_actor_id, 'quote_request.create', 'public.quote_requests', v_id,
    NULL, v_after, p_note
  );

  RETURN v_after;
END;
$$;
