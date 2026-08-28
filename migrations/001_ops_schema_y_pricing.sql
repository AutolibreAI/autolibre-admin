-- ═══════════════════════════════════════════════════════════════════════════
-- 001 — El schema `ops` y la tabla de precios.
--
-- POR QUÉ UN SCHEMA APARTE
--
-- `public` es del backend: lo migra Drizzle (ver el schema `drizzle`), y su
-- contenido es el DOMINIO — vehículos, partners, usuarios. Las métricas de
-- operación no son dominio: nadie de la app las lee, tienen otro ciclo de vida
-- (append-heavy, lectura agregada, retención acotada) y otro dueño.
--
-- `ops` es del panel. Este repo lo crea, lo migra y lo consulta. El repo del
-- backend no lo conoce y no tiene que conocerlo.
--
-- LA REGLA QUE SOSTIENE ESA SEPARACIÓN: NINGUNA FK CRUZA A `public`.
--
-- La tentación obvia es `user_id uuid references public.users(id)`. No. Una FK
-- cruzada vuelve a atar los dos schemas justo en lo que se quiso desatar: el
-- backend ya no podría tocar `users` sin romper el panel, y el panel pasaría a
-- ser un bloqueante de las migraciones del backend. Guardamos el uuid pelado y
-- resolvemos el nombre con LEFT JOIN al leer.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS ops;

COMMENT ON SCHEMA ops IS
  'Métricas y configuración de operación, propiedad del panel de administración '
  '(autolibre-admin). El backend no escribe acá. Ninguna FK cruza a public.';

-- Necesaria para la exclusion constraint de más abajo: permite mezclar `=`
-- sobre text con `&&` sobre un rango en el mismo índice GiST.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── Precios ────────────────────────────────────────────────────────────────
--
-- El precio VIVE ACÁ y no en el backend, y eso no es comodidad: el backend no
-- tiene nada que opinar sobre cuánto cuesta un millón de tokens. Es un dato
-- comercial del proveedor, cambia por fuera del sistema, y quien lo carga es el
-- admin.
--
-- LA VIGENCIA NO ES OPCIONAL, y es la única razón por la que esto es una tabla
-- y no una constante en TypeScript. Un precio sin `valid_from`/`valid_to` se
-- aplica retroactivamente a todo el historial: el día que el proveedor cambie
-- la tarifa, el panel te va a decir que el mes pasado gastaste otra cosa. Y lo
-- va a decir con cara de certeza, que es lo peor que puede hacer un panel de
-- costos.
CREATE TABLE IF NOT EXISTS ops.ai_model_pricing (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Provider explícito, NO inferido del string del modelo. Hoy alcanzaría con
  -- mirar el prefijo "claude-", pero esa inferencia se rompe callada el día que
  -- entre un modelo de otro proveedor con naming parecido, y un panel que
  -- atribuye mal el gasto es peor que uno que no lo atribuye.
  provider            text        NOT NULL,

  -- El identificador EXACTO tal como el proveedor lo devuelve y como la app lo
  -- graba. Ojo: la base tiene `claude-haiku-4-5-20251001` (variante con fecha),
  -- que es un string distinto de `claude-haiku-4-5`. Los dos necesitan fila.
  model               text        NOT NULL,

  input_usd_per_mtok  numeric(12,6) NOT NULL CHECK (input_usd_per_mtok  >= 0),
  output_usd_per_mtok numeric(12,6) NOT NULL CHECK (output_usd_per_mtok >= 0),

  valid_from          timestamptz NOT NULL,
  valid_to            timestamptz,              -- NULL = vigente hoy

  -- De dónde salió el número. Un precio sin procedencia es un número que nadie
  -- se anima a corregir después.
  source              text,
  note                text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_model_pricing_rango_valido
    CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- ── La invariante que hace confiable a todo el panel ───────────────────────
--
-- Dos filas con vigencias solapadas para el mismo modelo hacen que el costo de
-- una llamada sea AMBIGUO: el LEFT JOIN de la vista matchearía dos precios y
-- duplicaría la fila de uso, inflando tokens y plata a la vez.
--
-- Se resuelve en la base, no en la app, porque este es exactamente el tipo de
-- error que se cuela cargando un precio nuevo a las 11 de la noche y se
-- descubre tres semanas después mirando un total que no cierra.
ALTER TABLE ops.ai_model_pricing
  DROP CONSTRAINT IF EXISTS ai_model_pricing_sin_solape;

ALTER TABLE ops.ai_model_pricing
  ADD CONSTRAINT ai_model_pricing_sin_solape
  EXCLUDE USING gist (
    model WITH =,
    tstzrange(valid_from, valid_to) WITH &&
  );

CREATE INDEX IF NOT EXISTS ai_model_pricing_model_desde_idx
  ON ops.ai_model_pricing (model, valid_from DESC);

-- ── Trigger de updated_at ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_model_pricing_touch ON ops.ai_model_pricing;
CREATE TRIGGER ai_model_pricing_touch
  BEFORE UPDATE ON ops.ai_model_pricing
  FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

-- ── Seed ───────────────────────────────────────────────────────────────────
--
-- Tarifas públicas de la API de Anthropic (USD por millón de tokens).
-- `claude-haiku-4-5-20251001` es el único modelo que HOY aparece en la base;
-- los demás están precargados para que un cambio de modelo en el backend no
-- deje el panel sin precio en silencio.
--
-- `valid_from` es la fecha de disponibilidad del modelo, no la de hoy: si se
-- pusiera hoy, todo el consumo anterior quedaría sin precio y el panel
-- reportaría cero gasto histórico.
INSERT INTO ops.ai_model_pricing
  (provider, model, input_usd_per_mtok, output_usd_per_mtok, valid_from, source, note)
SELECT * FROM (VALUES
  ('anthropic', 'claude-haiku-4-5-20251001', 1.00,  5.00,  timestamptz '2025-10-01', 'docs.anthropic.com/pricing', 'Variante con fecha: es el string que la app graba hoy.'),
  ('anthropic', 'claude-haiku-4-5',          1.00,  5.00,  timestamptz '2025-10-01', 'docs.anthropic.com/pricing', NULL),
  ('anthropic', 'claude-sonnet-5',           2.00, 10.00,  timestamptz '2026-01-01', 'docs.anthropic.com/pricing', NULL),
  ('anthropic', 'claude-opus-5',             5.00, 25.00,  timestamptz '2026-01-01', 'docs.anthropic.com/pricing', NULL)
) AS seed(provider, model, input_usd_per_mtok, output_usd_per_mtok, valid_from, source, note)
WHERE NOT EXISTS (
  SELECT 1 FROM ops.ai_model_pricing p WHERE p.model = seed.model
);
