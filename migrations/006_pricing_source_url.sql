-- ═══════════════════════════════════════════════════════════════════════════
-- 006 — Que cada tarifa se pueda auditar sin salir del panel.
--
-- EL PROBLEMA CON `source` COMO ESTABA
--
-- Era texto suelto ('docs.anthropic.com/pricing'). Sirve para recordar de dónde
-- salió un número; no sirve para VERIFICARLO. Quien sospeche que una tarifa está
-- vieja tiene que salir del panel, buscar la página, y encontrar la tabla — o
-- sea, exactamente la fricción que hace que nadie lo haga nunca.
--
-- Se agregan DOS columnas, no una:
--
--   source_url   el link exacto, clickeable desde la tabla de tarifas
--   verified_at  cuándo alguien miró esa página por última vez
--
-- La segunda es la que hace útil a la primera. Un precio con link pero sin fecha
-- de verificación no dice si se chequeó ayer o hace dos años, y una tarifa vieja
-- no se anuncia: sigue calculando, prolija y equivocada.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ops.ai_model_pricing
  ADD COLUMN IF NOT EXISTS source_url  text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

COMMENT ON COLUMN ops.ai_model_pricing.source_url IS
  'Link a la página de precios del proveedor. La tabla del panel lo renderiza '
  'clickeable para poder auditar la tarifa sin salir de la pantalla.';

COMMENT ON COLUMN ops.ai_model_pricing.verified_at IS
  'Cuándo se miró esa página por última vez. Sin esto, el link no dice si el '
  'número se chequeó ayer o hace dos años.';

-- ── Solo https, y solo un link ─────────────────────────────────────────────
--
-- Un `source_url` que no sea navegable es peor que NULL: promete auditoría y no
-- la entrega. El CHECK rechaza texto suelto, rutas relativas y http:// pelado
-- en el momento del INSERT, en vez de que aparezca como un link roto en
-- pantalla tres meses después.
ALTER TABLE ops.ai_model_pricing
  DROP CONSTRAINT IF EXISTS ai_model_pricing_source_url_https;

ALTER TABLE ops.ai_model_pricing
  ADD CONSTRAINT ai_model_pricing_source_url_https
  CHECK (source_url IS NULL OR source_url ~ '^https://[^\s]+$');

-- ── Backfill de las tarifas ya cargadas ────────────────────────────────────
--
-- Las dos URLs se verificaron con un fetch real el 2026-08-27, y no es un
-- detalle de prolijidad: la que tenía anotada para Anthropic
-- (`platform.claude.com/docs/en/pricing`) devolvía 404. Un link roto en una
-- tabla de auditoría es peor que no tener link — parece que se puede confirmar
-- y no se puede.
--
-- La de OpenAI también cambió: `platform.openai.com/docs/pricing` redirige 301
-- a `developers.openai.com/api/docs/pricing`. Se guarda el destino final, no el
-- que redirige.
UPDATE ops.ai_model_pricing
   SET source_url  = 'https://platform.claude.com/docs/en/about-claude/pricing',
       source      = 'Anthropic — Pricing (docs oficiales)',
       verified_at = timestamptz '2026-08-27'
 WHERE provider = 'anthropic';

UPDATE ops.ai_model_pricing
   SET source_url  = 'https://developers.openai.com/api/docs/pricing',
       source      = 'OpenAI — API Pricing (docs oficiales)',
       verified_at = timestamptz '2026-08-27'
 WHERE provider = 'openai';

-- ── Dónde mirar cuando toque re-verificar ──────────────────────────────────
--
-- Registro por proveedor, separado de la tarifa: la página de precios es del
-- PROVEEDOR y no del modelo. Sin esto, cargar un modelo nuevo obliga a ir a
-- buscar la URL de nuevo — y ahí es donde se cuela el link mal tipeado.
CREATE TABLE IF NOT EXISTS ops.pricing_sources (
  provider     text PRIMARY KEY,
  label        text NOT NULL,
  pricing_url  text NOT NULL CHECK (pricing_url ~ '^https://[^\s]+$'),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ops.pricing_sources (provider, label, pricing_url, note)
SELECT * FROM (VALUES
  ('anthropic', 'Anthropic — Pricing',
   'https://platform.claude.com/docs/en/about-claude/pricing',
   'Verificada 2026-08-27. Ojo: `platform.claude.com/docs/en/pricing` (sin /about-claude/) da 404.'),
  ('openai', 'OpenAI — API Pricing',
   'https://developers.openai.com/api/docs/pricing',
   'Verificada 2026-08-27. `platform.openai.com/docs/pricing` redirige 301 acá.')
) AS seed(provider, label, pricing_url, note)
WHERE NOT EXISTS (
  SELECT 1 FROM ops.pricing_sources s WHERE s.provider = seed.provider
);
