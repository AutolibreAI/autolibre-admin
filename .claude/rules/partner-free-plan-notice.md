# Aviso del cambio del plan gratis (`/partners/plan-gratis`) — migración 042

Alcance: `migrations/042_ops_aviso_plan_gratis.sql` (+ `.test.sql`), `src/lib/partner-free-plan-notice.ts`,
`src/server/partner-free-plan-notice.repo.ts`, `src/fn/partner-free-plan-notice.ts`,
`src/routes/_authed/partners.plan-gratis.tsx`, `src/components/FreePlanNoticeLine.tsx` (ficha del partner),
`tests/partner-free-plan-notice.test.ts`, `tmp/run-042.mjs` + `tmp/replica-042.sql`. Agregado el 2026-11-26.

## Qué es

El plan gratis cambió de modalidad: el PRIMER trabajo que le llevamos a un proveedor es gratis, y desde
el SEGUNDO se cobra `PARTNER_FEE_CONFIG.FEE_POR_TRABAJO` (hoy ARS 20.000) por trabajo. El equipo le
avisa a cada proveedor con plan gratis y marca acá que ya está avisado: quién (actor de la sesión),
cuándo (lo pone la base), canal (`whatsapp | llamada | en_persona`) y nota opcional.

**No toca Liquidaciones ni `partner-fees-config`** (`PRIMER_CLIENTE_GRATIS` sigue apagado). Esto sólo
registra el aviso; cuándo empieza a regir la regla nueva en la cuenta es otra decisión.

## Dónde vive: `ops`, sin backend

Dato de operación del equipo. `ops.partner_free_plan_notice` (vigente, una fila por partner, sin fila =
sin avisar) + `ops.partner_free_plan_notice_log` (append-only, cada tilde y destilde). Partner por UUID
pelado (guardrail 6), validado con `EXISTS`. Los 8 guardrails + `ops.action_log`.

- **Control de pisada**: `p_expected_notified` = lo que vio el operador. Distinto → `FREE_PLAN_NOTICE_CHANGED`
  y la pantalla relee (mismo patrón que `SOURCER_CHANGED`, `team-sourcing.md`).
- **Mismo estado = no-op sin log.** Para corregir canal o nota: destildar y volver a tildar (queda todo
  en el historial). No hay "editar el aviso".
- Tildar exige canal (`CHANNEL_REQUIRED` / `INVALID_CHANNEL`); nota ≤ 1000 (`NOTE_TOO_LONG`), `''` = sin
  nota. Destildar ignora el canal; la nota va al historial como motivo.
- Advisory lock de transacción por partner (no hay fila previa que lockear cuando está sin avisar).

## Quién tiene plan gratis: NO se reimplementa

`listPartnerPlans` + `effectivePlans` + `FREE_PLAN_CODE` de `~/lib/partner-plans` — la misma regla que
`/partners/propuestas`. El SP no valida el plan: un proveedor que pasó a pago conserva su aviso (y la
ficha lo sigue mostrando), uno que vuelve a gratis lo recupera. Sin billing en la base, la pantalla dice
que no se puede saber.

**Universo**: partners `active` y `paused`; los `archived` no se listan. El contador «X de Y avisados»
es sobre los ACTIVOS (Propuestas también muestra pausados, pero un pausado no recibe pedidos hoy); el
chip «Incluir pausados» los suma al universo. Los Aliados (`founding`) con plan gratis aparecen con su
badge: si la regla nueva no aplica a ellos, es una decisión de producto pendiente, no del panel.

## La pantalla

Pestaña «Aviso plan gratis» de `/partners`, SSR `true`. Filtros en el cliente, search params calificados
`freePlanNotice*` (`State`, `Channel`, `Paused`); `q` se comparte. El WhatsApp abre `wa.me` con el aviso
ya escrito (`freePlanNoticeMessage`, monto de la config; `canonicalWhatsAppDigits` y si no
`toWhatsAppAR`, nunca se adivina una característica). Abrir el chat no marca nada. Fechas con
`formatDateTimeBuenosAires` (zona pineada: sin mismatch de hidratación).

La ficha `/partners/$partnerId` muestra una línea de SÓLO LECTURA (avisado el … por … vía …, o «sin
avisar» en ámbar) si el plan efectivo es gratis o hay aviso; se marca en la pestaña.

## Sin la 042

`freePlanNoticeAvailable()` (`to_regclass`, cachea sólo el `true`). La pantalla dice qué falta y no
escribe (`FREE_PLAN_NOTICE_UNAVAILABLE`); la ficha no muestra nada.

## Cómo se probó

- Suite `042_….test.sql`: **32/32** en PGlite (`PGLITE_DIR=… node tmp/run-042.mjs`), aborta en rojo sin
  la 042. Incluye integración con `PREPARE` sin tipos.
- `tests/partner-free-plan-notice.test.ts` (filtros, contador, mensaje con el monto de la config,
  WhatsApp, schema, errores).
- **No aplicada en ninguna base** ni vista en el navegador.
