-- ═══════════════════════════════════════════════════════════════════════════
-- 009 — El nombre del partner entra a `set_partner_profile`.
--
-- Continúa la 008. Misma justificación, mismos 8 guardrails.
-- → .claude/rules/ops-write-actions.md
--
-- ── POR QUÉ EL NOMBRE VA ADENTRO DEL PERFIL Y NO EN UN SP PROPIO ──────────
--
-- Porque es lo mismo que zona, descripción y tier: **cómo se presenta el
-- partner en la tarjeta del marketplace.** Se edita en la misma sentada y con
-- el mismo criterio. Un `ops.set_partner_name` separado daría dos entradas de
-- `ops.action_log` para un solo acto de edición — el mismo problema que la 008
-- evitó al agrupar los otros tres.
--
-- ── ⚠ POR QUÉ ESTO ES DROP + CREATE Y NO UN `CREATE OR REPLACE` ───────────
--
-- Porque `CREATE OR REPLACE FUNCTION` **no puede cambiar la lista de
-- argumentos**. Postgres identifica una función por `(nombre, tipos de
-- argumentos)`: agregarle un parámetro no la reemplaza, crea una SOBRECARGA y
-- deja la vieja viva al lado.
--
-- Y el modo de falla es peor que "quedó una función de más". Con las dos
-- existiendo, una llamada por parámetros nombrados —que es exactamente como la
-- llama `partners.repo.ts`— puede matchear las dos y Postgres responde
-- `function ops.set_partner_profile(...) is not unique`. Eso aparece en
-- runtime, en el primer guardado de un operador, no en la migración.
--
-- Así que se dropea la firma vieja EXPLÍCITAMENTE, con sus tipos, y recién
-- después se crea la nueva.
--
-- ── LO QUE SIGUE SIN DECIDIR ──────────────────────────────────────────────
--
-- **No valida que el nombre sea único.** `partners.name` no tiene índice único
-- en el schema del backend, así que dos partners con el mismo nombre son
-- REPRESENTABLES — y esta función valida representabilidad, no reglas de
-- negocio. Que dos talleres no deban llamarse igual en el marketplace es una
-- decisión de producto, y su lugar es el formulario, donde cambiar de opinión
-- no cuesta una migración. La ficha avisa después de guardar.
-- ═══════════════════════════════════════════════════════════════════════════

-- La firma vieja de la 008, con sus tipos exactos. Sin este DROP, lo de abajo
-- crea una sobrecarga en vez de reemplazar.
DROP FUNCTION IF EXISTS ops.set_partner_profile(uuid, uuid, text, text, text, text);

/**
 * Nombre, zona de cobertura, descripción y tier.
 *
 * ── `name` es NOT NULL, igual que `coverage_zone` ─────────────────────────
 *
 * Así que `''` no es "borralo": es un valor que la columna no puede
 * representar, y se rechaza con una sentinela propia. Sin el chequeo, el error
 * sería un `null value in column "name"` crudo, con el nombre de la constraint
 * adentro y sin decirle al operador qué campo revisar.
 *
 * `description` sigue siendo la excepción: es nullable, y ahí `''` sí borra.
 *
 * ── RENOMBRAR MUEVE AL PARTNER DE LUGAR EN EL MARKETPLACE ─────────────────
 *
 * `idx_partners_active_tier_name` es `(tier, name) WHERE status = 'active'`:
 * el nombre ES la clave de orden del listado dentro de cada tier. No es un
 * efecto colateral a corregir, es cómo funciona el índice del backend — pero
 * conviene saberlo antes de renombrar un partner de "AA Taller" a "Zzz".
 *
 * Nada hace JOIN por nombre, verificado: `partner_applications.business_name`
 * es una columna aparte y no se toca. Renombrar no rompe ninguna referencia.
 */
CREATE OR REPLACE FUNCTION ops.set_partner_profile(
  p_partner_id    uuid,
  p_actor_id      uuid,
  p_name          text,
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
  v_name   text := btrim(coalesce(p_name, ''));
  v_zone   text := btrim(coalesce(p_coverage_zone, ''));
BEGIN
  PERFORM ops.assert_actor(p_actor_id);

  IF v_name = '' THEN
    RAISE EXCEPTION 'NAME_REQUIRED'
      USING HINT = 'name es NOT NULL en public.partners: no se puede vaciar.';
  END IF;

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
    name          = v_name,
    coverage_zone = v_zone,
    -- '' borra; NULL deja como está. Mismo contrato que set_partner_contact.
    description   = CASE WHEN p_description IS NULL THEN description
                         ELSE nullif(btrim(p_description), '') END,
    tier          = CASE WHEN p_tier IS NULL THEN tier
                         ELSE p_tier::partner_tier END
  WHERE id = p_partner_id;
  -- updated_at NO se toca: trg_partners_updated_at ya lo hace.

  SELECT to_jsonb(p) INTO v_after FROM partners p WHERE p.id = p_partner_id;
  PERFORM ops.log_action(
    p_actor_id, 'partner.set_profile', 'public.partners', p_partner_id,
    v_before, v_after, p_note
  );

  RETURN v_after;
END;
$$;
