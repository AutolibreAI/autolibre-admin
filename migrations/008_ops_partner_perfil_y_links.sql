-- ═══════════════════════════════════════════════════════════════════════════
-- 008 — El resto de la ficha del partner: perfil y links.
--
-- Continúa la 007 y se apoya en su justificación entera, que no se repite acá:
-- `IPartnerRepository` del backend expone SÓLO `findActive()` y
-- `findActiveById()`, no hay ningún caso de uso que edite un partner, y por eso
-- el panel escribe `public` desde stored procedures de `ops`.
-- → .claude/rules/ops-write-actions.md
--
-- Los 8 guardrails de esa rule valen igual acá y están aplicados: viven en
-- migrations/, SECURITY INVOKER, search_path fijo, actor desde la sesión,
-- action_log adentro de la función, sin FK cruzada, FOR UPDATE antes de
-- escribir, y updated_at lo pone el trigger.
--
-- ── LO QUE ESTAS DOS FUNCIONES NO DECIDEN ─────────────────────────────────
--
-- Sigue vigente la condición del backend: mueven estado y copian datos, no
-- deciden nada. En concreto, y son omisiones deliberadas:
--
--   · `set_partner_profile` NO exige que la descripción entre en 90 caracteres.
--     Ese es el largo ideal para la tarjeta del marketplace, y hoy 25 de los 34
--     partners con descripción ya lo pasan (promedio 114, máximo 248). Una
--     validación dura acá haría imposible guardar cualquier cambio en tres
--     cuartos del directorio. El contador vive en el formulario, que es donde
--     cambiar de opinión no cuesta una migración.
--
--   · `set_partner_links` NO valida que la URL sea alcanzable ni que el link de
--     Instagram apunte a Instagram. Validar que un string parezca una URL es
--     representabilidad y va en zod; validar que exista es una llamada de red
--     adentro de una transacción, que es exactamente lo que no se hace.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Perfil ─────────────────────────────────────────────────────────────────

/**
 * Zona de cobertura, descripción y tier, en una sola operación.
 *
 * ── POR QUÉ LOS TRES JUNTOS Y NO TRES FUNCIONES ───────────────────────────
 *
 * La 007 separó estado, ubicación y contacto en tres SP porque son tres
 * decisiones con consecuencias distintas: pausar saca al taller del
 * marketplace, cargar coordenadas lo hace ordenable, completar el contacto lo
 * hace contactable. Cada una merece su propia entrada de auditoría.
 *
 * Estos tres campos son lo mismo: **cómo se PRESENTA el partner en la tarjeta
 * del marketplace.** Se editan juntos, se miran juntos y se cambian en la misma
 * sentada. Tres funciones acá producirían tres entradas de `action_log` para un
 * solo acto de edición, que es tan malo para auditar como una sola entrada que
 * dice "cambió algo".
 *
 * ── coverage_zone es NOT NULL en el schema del backend ────────────────────
 *
 * Así que un string vacío no es "borralo": es un valor inválido que la columna
 * no puede representar, y hay que rechazarlo con un mensaje que se entienda.
 * Sin este chequeo el error sería un `null value in column "coverage_zone"`
 * crudo de Postgres, con el nombre de la constraint adentro.
 *
 * `description` SÍ es nullable, así que ahí '' significa borrar y se normaliza
 * a NULL — mismo criterio que `set_partner_contact`, y por el mismo motivo: el
 * import del `legacy_sheet` dejó strings vacíos, y por eso todo chequeo de
 * "falta este campo" en este repo se escribe `coalesce(x,'') = ''`.
 *
 * ── El tier ES el badge de aliado ─────────────────────────────────────────
 *
 * `partner_tier` es `founding | standard`. El panel lo muestra como "badge de
 * aliado" porque es como lo llama el equipo, pero el CÓDIGO dice `tier` y
 * `founding` — el vocabulario es el del backend, y una función que se llamara
 * `set_partner_aliado` sería intraducible el día que alguien lea el schema.
 */
CREATE OR REPLACE FUNCTION ops.set_partner_profile(
  p_partner_id    uuid,
  p_actor_id      uuid,
  p_coverage_zone text,
  p_description   text,
  p_tier          text,
  p_note          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_zone   text := btrim(coalesce(p_coverage_zone, ''));
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF v_zone = '' THEN
    RAISE EXCEPTION 'COVERAGE_ZONE_REQUIRED'
      USING HINT = 'coverage_zone es NOT NULL en public.partners: no se puede vaciar.';
  END IF;

  IF p_tier IS NOT NULL AND p_tier NOT IN ('founding', 'standard') THEN
    RAISE EXCEPTION 'INVALID_TIER: %', p_tier;
  END IF;

  -- FOR UPDATE antes de leer el `before`: dos admins sobre el mismo partner se
  -- serializan. Sin esto el `before` del log puede describir un estado que ya
  -- no existía cuando se escribió el `after`.
  SELECT to_jsonb(p) INTO v_before FROM partners p WHERE p.id = p_partner_id FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'PARTNER_NOT_FOUND: %', p_partner_id;
  END IF;

  UPDATE partners SET
    coverage_zone = v_zone,
    -- '' borra; NULL deja como está. Mismo contrato que set_partner_contact.
    description   = CASE WHEN p_description IS NULL THEN description
                         ELSE nullif(btrim(p_description), '') END,
    tier          = CASE WHEN p_tier IS NULL THEN tier
                         ELSE p_tier::partner_tier END
  WHERE id = p_partner_id;
  -- updated_at NO se toca: trg_partners_updated_at ya lo hace. Escribirlo a
  -- mano y por trigger es duplicación que diverge en silencio.

  SELECT to_jsonb(p) INTO v_after FROM partners p WHERE p.id = p_partner_id;
  PERFORM ops.log_action(
    p_actor_id, 'partner.set_profile', 'public.partners', p_partner_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;

-- ── Links ──────────────────────────────────────────────────────────────────

/**
 * El juego completo de links de un partner, en una sentada.
 *
 * Recibe un array jsonb de `{ "kind": "...", "url": "..." }` y deja la tabla
 * igual a eso: lo que no viene, se borra.
 *
 * ── LA MINA: idx_partner_links_kind_unique ────────────────────────────────
 *
 * Es UNIQUE PARCIAL sobre `(partner_id, kind)` WHERE `kind <> 'other'`. O sea:
 * un partner tiene COMO MÁXIMO un Instagram, un Facebook, un TikTok — pero
 * puede tener muchos `other`. Verificado contra producción: hoy ningún partner
 * repite un kind, y los 11 `other` incluyen 10 links de Google Maps.
 *
 * Esa asimetría es la que decide todo el diseño de abajo, y también el del
 * formulario: campo único para cada red, lista libre para `other`.
 *
 * ── POR QUÉ NO ES UN DELETE + INSERT ──────────────────────────────────────
 *
 * Porque borraría `created_at`. Es la misma lección que `upsertExcludedDomain`
 * en `ops.repo.ts`, donde el `ON CONFLICT DO UPDATE` deliberadamente no pisa
 * esa columna: **cuándo se cargó un link es el dato con valor**, y regenerarlo
 * en cada guardado de la ficha lo borra para siempre. Un operador que corrige
 * un typo en la descripción no debería resetear la antigüedad de nueve links
 * que no tocó.
 *
 * Así que:
 *   · los kinds únicos van por UPSERT — conservan `id` y `created_at`, y el
 *     trigger les mueve `updated_at` sólo si la URL cambió de verdad;
 *   · los `other` se matchean POR URL, porque no tienen clave natural: se borra
 *     lo que ya no está y se inserta lo que falta. Un `other` que sigue igual ni
 *     se toca.
 *
 * ── EL LOG GUARDA LOS LINKS, NO LA FILA DEL PARTNER ───────────────────────
 *
 * `before` y `after` son el conjunto de links. Guardar `to_jsonb(partners)` acá
 * sería registrar una fila que esta función no modifica — el log diría que no
 * pasó nada.
 */
CREATE OR REPLACE FUNCTION ops.set_partner_links(
  p_partner_id uuid,
  p_actor_id   uuid,
  p_links      jsonb,
  p_note       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, ops
AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_bad    text;
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF jsonb_typeof(p_links) <> 'array' THEN
    RAISE EXCEPTION 'LINKS_NOT_AN_ARRAY'
      USING HINT = 'Se espera un array jsonb de {kind, url}.';
  END IF;

  PERFORM 1 FROM partners WHERE id = p_partner_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PARTNER_NOT_FOUND: %', p_partner_id;
  END IF;

  /**
   * Se valida el kind ACÁ y no se deja que reviente el cast.
   *
   * `'tiktok2'::partner_link_kind` tira `invalid input value for enum`, que
   * menciona el tipo de Postgres y no dice cuál de los links del formulario
   * estaba mal. Con la sentinela, la UI puede decir qué campo revisar.
   */
  SELECT string_agg(DISTINCT l.kind, ', ') INTO v_bad
  FROM jsonb_to_recordset(p_links) AS l(kind text, url text)
  WHERE l.kind IS NULL
     OR l.kind NOT IN ('instagram','website','facebook','mercado_libre','x','tiktok','other');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'INVALID_LINK_KIND: %', v_bad;
  END IF;

  /**
   * El conjunto entrante se re-deriva con un CTE en CADA sentencia, en vez de
   * materializarse una vez en una tabla temporal.
   *
   * La versión con `CREATE TEMP TABLE _incoming ON COMMIT DROP` es la obvia y
   * está ROTA: la tabla vive hasta el fin de la TRANSACCIÓN, no de la llamada,
   * así que la segunda invocación en la misma transacción muere con
   * `relation "_incoming" already exists`. No se nota probando la función una
   * sola vez — se nota cuando la suite de pruebas la llama nueve veces seguidas,
   * o cuando alguien guarda dos partners adentro de una transacción.
   *
   * Cuatro `jsonb_to_recordset` sobre un array de a lo sumo 50 elementos no son
   * un costo: son cuatro escaneos de una lista que entra en una línea de caché.
   *
   * Una URL vacía no es un link y se descarta en silencio: el formulario manda
   * los campos que el operador dejó en blanco, y pedirle que no los mande sería
   * moverle el problema a quien llama.
   */
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', kind::text, 'url', url)
                            ORDER BY kind::text, url), '[]'::jsonb)
    INTO v_before
  FROM partner_links WHERE partner_id = p_partner_id;

  -- 1. Los kinds únicos que ya no vienen. `other` se maneja aparte, por URL.
  WITH incoming AS (
    SELECT l.kind, btrim(l.url) AS url
      FROM jsonb_to_recordset(p_links) AS l(kind text, url text)
     WHERE btrim(coalesce(l.url, '')) <> ''
  )
  DELETE FROM partner_links pl
   WHERE pl.partner_id = p_partner_id
     AND pl.kind <> 'other'
     AND NOT EXISTS (SELECT 1 FROM incoming i WHERE i.kind = pl.kind::text);

  -- 2. Los `other` que ya no vienen, matcheados por URL: sin clave natural, la
  --    URL ES la identidad.
  WITH incoming AS (
    SELECT l.kind, btrim(l.url) AS url
      FROM jsonb_to_recordset(p_links) AS l(kind text, url text)
     WHERE btrim(coalesce(l.url, '')) <> ''
  )
  DELETE FROM partner_links pl
   WHERE pl.partner_id = p_partner_id
     AND pl.kind = 'other'
     AND NOT EXISTS (SELECT 1 FROM incoming i WHERE i.kind = 'other' AND i.url = pl.url);

  -- 3. Upsert de los kinds únicos. Conserva id y created_at; el trigger mueve
  --    updated_at sólo si la URL cambió.
  --
  --    `DISTINCT ON (kind)` porque el payload podría traer dos veces el mismo
  --    kind: sin eso, `ON CONFLICT` tira `cannot affect row a second time`, que
  --    es un error de Postgres sobre la sentencia y no sobre el dato.
  INSERT INTO partner_links (partner_id, kind, url)
  SELECT DISTINCT ON (i.kind) p_partner_id, i.kind::partner_link_kind, i.url
    FROM jsonb_to_recordset(p_links) AS i(kind text, url text)
   WHERE btrim(coalesce(i.url, '')) <> ''
     AND i.kind <> 'other'
   ORDER BY i.kind, i.url
  ON CONFLICT (partner_id, kind) WHERE kind <> 'other'
  DO UPDATE SET url = excluded.url;

  -- 4. Los `other` que faltan. Los que ya estaban con la misma URL no se tocan.
  INSERT INTO partner_links (partner_id, kind, url)
  SELECT DISTINCT p_partner_id, 'other'::partner_link_kind, btrim(i.url)
    FROM jsonb_to_recordset(p_links) AS i(kind text, url text)
   WHERE btrim(coalesce(i.url, '')) <> ''
     AND i.kind = 'other'
     AND NOT EXISTS (
       SELECT 1 FROM partner_links pl
        WHERE pl.partner_id = p_partner_id
          AND pl.kind = 'other'
          AND pl.url = btrim(i.url)
     );

  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', kind::text, 'url', url)
                            ORDER BY kind::text, url), '[]'::jsonb)
    INTO v_after
  FROM partner_links WHERE partner_id = p_partner_id;

  PERFORM ops.log_action(
    p_actor_id, 'partner.set_links', 'public.partner_links', p_partner_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;
