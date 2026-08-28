-- ═══════════════════════════════════════════════════════════════════════════
-- 004 — Tarifa de `gpt-4o-mini`.
--
-- POR QUÉ ES UN ARCHIVO NUEVO Y NO UN RENGLÓN MÁS EN LA 001
--
-- Porque la 001 ya corrió. El runner guarda su checksum y aborta si el archivo
-- cambia, y hace bien: un archivo editado después de aplicado deja de describir
-- lo que la base tiene, en silencio y para siempre. Cada tarifa nueva es su
-- propia migración.
--
-- POR QUÉ EL PRECIO NO SALIÓ DE LA MEMORIA
--
-- Se verificó contra developers.openai.com/api/docs/pricing. Un precio tipeado
-- de memoria en una tabla que después audita alguien es exactamente el tipo de
-- número que nadie se anima a corregir — por eso la columna `source` existe y
-- por eso se llena.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── valid_from: 2024-07-18, y NO la fecha de hoy ───────────────────────────
--
-- Es la fecha de lanzamiento del modelo, y elegirla mal rompe justo lo que esta
-- tabla vino a resolver.
--
-- Las 57 llamadas a `gpt-4o-mini` que hay en la base van del 2026-06-30 al
-- 2026-08-17, sobre la superficie de diagnósticos. El JOIN de
-- `ops.v_ai_usage_costed` exige `occurred_at >= valid_from`: con un
-- `valid_from` de hoy, esas 57 llamadas quedarían FUERA de toda vigencia y
-- seguirían contando como no-preciadas — la tarifa cargada y el panel sin
-- cambiar, que es el peor resultado porque parece que la carga no funcionó.
--
-- Se pone la fecha de lanzamiento porque el precio de este modelo no cambió
-- desde entonces. Si mañana OpenAI lo modifica, la carga correcta NO es editar
-- esta fila: es CERRARLA (`valid_to` = fecha del cambio) y abrir una nueva.
-- Editarla reescribiría el costo de todo el histórico.
INSERT INTO ops.ai_model_pricing
  (provider, model, input_usd_per_mtok, output_usd_per_mtok, valid_from, source, note)
SELECT * FROM (VALUES
  ('openai', 'gpt-4o-mini', 0.15, 0.60, timestamptz '2024-07-18',
   'developers.openai.com/api/docs/pricing (verificado 2026-08-27)',
   'Apareció en la base sin estar en el seed inicial: el panel lo detectó como modelo sin tarifa. La superficie que lo usa es `diagnostics`.')
) AS seed(provider, model, input_usd_per_mtok, output_usd_per_mtok, valid_from, source, note)
WHERE NOT EXISTS (
  SELECT 1 FROM ops.ai_model_pricing p WHERE p.model = seed.model
);

-- ── Lo que esta tarifa NO cubre ────────────────────────────────────────────
--
-- OpenAI cobra los tokens de entrada CACHEADOS a mitad de precio ($0.075/Mtok
-- para este modelo). El panel no lo puede aprovechar porque el dato no existe:
-- ni `ai_diagnostics` ni `conversation_messages` guardan cuántos tokens vinieron
-- de cache — guardan `prompt_tokens` y nada más.
--
-- Consecuencia concreta: para las llamadas que sí pegaron en cache, el costo que
-- muestra el panel es MAYOR al real. Sobreestimar es el error tolerable de los
-- dos (mejor que la factura sorprenda para abajo), pero es una diferencia real y
-- queda anotada acá en vez de descubrirse comparando contra el resumen de
-- OpenAI.
--
-- Medirlo bien necesita al backend: el dato viene en `usage.prompt_tokens_details
-- .cached_tokens` de la respuesta, y si no se anota en ese momento se pierde.
