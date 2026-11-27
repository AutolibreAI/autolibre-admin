# Liquidaciones a proveedores (`/partners/liquidaciones`) — migración 038

Alcance: `migrations/038_ops_liquidaciones_proveedores.sql` (+ `.test.sql`),
`src/lib/partner-fees-config.ts`, `src/lib/partner-fees.ts`, `src/server/partner-fees.repo.ts`,
`src/fn/partner-fees.ts`, `src/routes/_authed/partners.liquidaciones.tsx`,
`tests/partner-fees.test.ts`. Pedido al back: `docs/pedido-backend-liquidaciones-proveedores.md`.
Agregado el 2026-11-25.

## Qué es

Lo que cada proveedor le debe a AutoLibre por los trabajos confirmados que le llegaron por
nosotros, el aviso por WhatsApp y el registro del cobro. Plata que el proveedor nos paga.

## La regla vive en UN archivo — modelo del 2026-11-26, SIN suscripciones

`~/lib/partner-fees-config.ts`: `FEE_POR_TRABAJO = 20000`, `PRIMER_TRABAJO_GRATIS = true` (para
todos, sin excepción de grúa), `FECHA_INICIO` a definir (null), y los defaults del paquete y del
premio del comercial. `EXCLUIR_PLAN_PAGO` y `PRIMER_CLIENTE_GRATIS` se SACARON: ya no se venden
suscripciones ni hay tope de respuestas.

Para cada liquidable pendiente, en este orden (`classifyFeeJobs`):
1. el PRIMER trabajo confirmado (no anulado) del proveedor → «Gratis (primer trabajo)»;
2. un paquete vigente a la fecha del trabajo, con saldo → «Cubierto por paquete», el que vence
   primero (`~/lib/partner-packages`, migración 044);
3. si no, el fee.

- **Trabajo confirmado**: `outcome = 'hired'` o `user_outcome = 'hired'`, sin `duplicate`
  (`notDuplicatePredicate`) y sin cuentas internas (`INTERNAL_PREDICATE`).
- **En disputa** (decidido el 2026-11-25): un lado `hired` y el otro `not_hired`. No se liquida;
  se resuelve a mano corrigiendo el resultado en la ficha.
- **Proveedor**: la propuesta elegida manda; si no hay, la atribución parche. Si dicen distinto, la
  fila lo avisa.
- **Día del trabajo**: `user_outcome_performed_on` → día del cierre → día del pedido (Buenos Aires).
- **Premio para el comercial** (`commercialFee`): el primer trabajo confirmado del taller, aunque sea
  gratis para el taller, si su solicitud tiene «Alta por» (035). Ya no mira el plan.

## Paquetes de trabajos (migración 044) — desde el 2026-11-26

`ops.partner_job_package` (nunca se borra: se ANULA con motivo, y sólo sin imputaciones activas) y
`ops.partner_job_package_allocation` (trabajo → paquete; se DESHACE con motivo, nunca se borra).

- **Vigente** el día D: no anulado y `compra ≤ D ≤ vence` (`vence = compra + vigencia`, columna
  generada). Estado: anulado · agotado · vencido · vigente. Un vencido con saldo es «Vencido con X sin
  usar»: el saldo no se traslada.
- **Imputación**: una GUARDADA manda (aunque sea el primer trabajo). Las que propone la regla se
  muestran «sin guardar» en Liquidaciones y se guardan con un click (`persistPackageAllocationsFn`
  re-calcula la regla en el servidor y guarda el paquete que dice la regla, nunca uno del payload).
  «Deshacer»/«No imputar» deja una fila deshecha con motivo: ese trabajo sale de la regla automática
  (va a fee) hasta «Volver a imputar automático» (`reopened_*`).
- **Saldo** = trabajos − imputados (guardados + propuestos). Lo calcula `getPackagesViewFn` con la
  misma clasificación que Liquidaciones.
- Se carga desde la ficha del proveedor, desde Partners › Proveedores y desde Partners › Paquetes
  (con el CSV para la caja y los que vencen en 15 días o menos arriba).
- Los SP validan representabilidad (existe, no anulado, saldo, trabajo libre); las fechas las decide
  el panel antes de llamar. Suite `044_….test.sql`: 16/16 en PGlite. No aplicada en ninguna base.

## Suscripciones y tope: fuera del panel

- Ficha: «Suscripción (histórico)», sólo lectura, todas las suscripciones con estado y fechas
  (`listSubscriptionHistory`). No se cancela nada en Mercado Pago.
- Partners › Propuestas pasó a ser **Proveedores** (`partner-providers.ts`); el despacho, Estudio y
  Liquidaciones ya no muestran ni filtran por plan; el aviso de la 042 pasó a ser «Aviso de cobro»
  para todos los proveedores. `partner-plans.ts` queda sólo para el conteo de propuestas y el histórico.
- Pedido al back: `docs/pedido-backend-plan-gratis-sin-tope.md`.

## Atribución: tabla parche, a propósito

Al 2026-11-25 de 11 pedidos `hired` sólo 1 tiene propuesta elegida: todos cerrados (el backend no
deja elegir en un cerrado) y 6 sin propuestas. Decidido: `ops.partner_fee_attribution`, cargada por
el equipo desde la nota del cierre, + el pedido al back. Cuando el back lo resuelva, se pasa por HTTP
y la tabla se retira. **No escribir `selected_proposal_id` por SQL.**

## El cobro

`ops.partner_fee_charge`, una fila por trabajo fuera de `pendiente` (sin fila = pendiente).
`pendiente → avisado → cobrado`, o `anulado` con motivo obligatorio; volver a pendiente borra la fila.

- **El monto se congela** al avisar o cobrar. Cambiar `FEE_POR_TRABAJO` mueve sólo lo pendiente.
- **El monto lo pone el servidor**: `setPartnerFeeStatusFn` re-clasifica con los datos de ahora y
  exige que cada trabajo siga siendo liquidable y de ESE proveedor (`FEE_NOT_LIQUIDABLE`). Un lote
  lleva un solo monto (`FEE_MIXED_AMOUNTS`).
- Un trabajo avisado o cobrado no se reatribuye ni se cobra a otro proveedor sin volverlo antes a
  pendiente (`FEE_ALREADY_CHARGED`, en el SP).
- Los SP no deciden qué es liquidable: validan representabilidad. Guardrails de siempre, con log por
  trabajo en `ops.action_log`.

## La pantalla

Cuatro vistas (`feeView`): Por cobrar (por proveedor, con plan de hoy, «Alta por», mensaje de cobro
editable, copiar y abrir WhatsApp con `toWhatsAppAR`), Sin atribuir, En disputa, Cobrados y anulados
(CSV para la caja: una fila por proveedor + fecha + medio, `toCsv`). Filtros `fee*` en el CLIENTE.

- El mensaje no lleva nombre, teléfono ni patente del cliente. La forma de pago es un `[corchete]`
  de la config: el alias/CBU no va en el código.
- "Hoy" lo calcula el servidor en Buenos Aires (SSR).

## Sin la 038

La pantalla dice qué falta y no escribe nada (`PARTNER_FEES_UNAVAILABLE`).

## Cómo se probó

- Suite `038_….test.sql`: 33/33 en PGlite (aborta en rojo sin la 038).
- `tests/partner-fees.test.ts` (regla, agrupado, resumen, CSV, mensaje, schema).
- Cuadre contra producción: ver el commit del bloque.
- **No aplicada en ninguna base**: la aplica el `vercel-build` del próximo deploy de `main`.

## Liquidaciones a comerciales (`/comercial/liquidaciones`, migración 045) — desde el 2026-11-26

`~/lib/commercial-commissions`, `commercial-commissions.repo.ts`. Un premio por alta:

- **Quién cobra**: sólo quien tiene «Cobra premio» (`ops.team_member.earns_award`, 045) en Comercial ›
  Equipo. La 045 lo apaga para el rol `fundador` y para Nicolás Leunda, Ramiro Sarasola, Mateo
  Ghidini, Matías Vidal y Matías García Guevara; una persona nueva arranca encendida. Las altas de
  quien no cobra no aparecen.
- **Cuándo**: el taller («Alta por», 035) tiene su PRIMER trabajo confirmado (`isFirstOfPartner` de
  `classifyFeeJobs`, la misma regla que Liquidaciones), aunque ese trabajo sea gratis para el taller.
- **Cuánto**: `PREMIO_POR_ALTA` en la config, vacío por defecto: los premios se ven y no se pueden
  marcar pagados hasta definirlo (`AWARD_AMOUNT_UNDEFINED`).
- **Estados**: esperando (sin primer trabajo) → pendiente → pagado / anulado (motivo obligatorio),
  en `ops.commercial_award`; «Volver a pendiente» borra la fila. Monto, comercial y referencia los
  pone el servidor re-calculando la regla; lo pagado queda congelado. CSV de pagados para la caja.
- **Se sacó la «primera cuota»** (alta con plan pago) de la 039: ya no se venden suscripciones. Las
  altas que tuvieron suscripción paga van a la sección «Con suscripción (histórico)», para resolverlas
  a mano. `ops.commercial_commission_payment` (039) queda sin uso (0 filas en producción).
- Suite `045_….test.sql` (cubre también la 043): 14/14 en PGlite. No aplicada en ninguna base.

## Pedidos al backend

- `docs/pedido-backend-liquidaciones-proveedores.md`: elegir la propuesta en pedidos cerrados y
  atribuir los que no tienen propuesta (para retirar la tabla parche).
