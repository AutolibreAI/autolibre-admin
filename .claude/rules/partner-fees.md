# Liquidaciones a proveedores (`/partners/liquidaciones`) — migración 038

Alcance: `migrations/038_ops_liquidaciones_proveedores.sql` (+ `.test.sql`),
`src/lib/partner-fees-config.ts`, `src/lib/partner-fees.ts`, `src/server/partner-fees.repo.ts`,
`src/fn/partner-fees.ts`, `src/routes/_authed/partners.liquidaciones.tsx`,
`tests/partner-fees.test.ts`. Pedido al back: `docs/pedido-backend-liquidaciones-proveedores.md`.
Agregado el 2026-11-25.

## Qué es

Lo que cada proveedor le debe a AutoLibre por los trabajos confirmados que le llegaron por
nosotros, el aviso por WhatsApp y el registro del cobro. Plata que el proveedor nos paga.

## La regla vive en UN archivo

`~/lib/partner-fees-config.ts`: `FEE_POR_TRABAJO = 20000`, y tres opciones **preparadas y
apagadas** hasta que Nicolás las confirme: `EXCLUIR_PLAN_PAGO`, `PRIMER_CLIENTE_GRATIS`,
`FECHA_INICIO`. Se cobra cada trabajo, cliente nuevo o no.

- **Trabajo confirmado**: `outcome = 'hired'` o `user_outcome = 'hired'`, sin `duplicate`
  (`notDuplicatePredicate`) y sin cuentas internas (`INTERNAL_PREDICATE`).
- **En disputa** (decidido el 2026-11-25): un lado `hired` y el otro `not_hired`. No se liquida;
  se resuelve a mano corrigiendo el resultado en la ficha.
- **Proveedor**: la propuesta elegida manda; si no hay, la atribución parche. Si dicen distinto, la
  fila lo avisa.
- **Día del trabajo**: `user_outcome_performed_on` → día del cierre → día del pedido (Buenos Aires).
- **Fee para el comercial**: el PRIMER trabajo (no anulado) de cada taller, si a esa fecha no tenía
  plan pago y su solicitud tiene «Alta por» (035). Etiqueta "Fee para X"; alimenta las
  liquidaciones por comercial (bloque 2, pendiente).
- `EXCLUIR_PLAN_PAGO` usa una APROXIMACIÓN: el backend no guarda el historial de estados de la
  suscripción; se mira `authorized_at` / `ended_at` / `access_until`.
- `PRIMER_CLIENTE_GRATIS` se aplica al primer trabajo del taller ("cliente nuevo" no se puede saber)
  salvo grúa (por el nombre del servicio).

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

## Comisiones de los comerciales (`/comercial/liquidaciones`, migración 039)

`~/lib/commercial-commissions`, `commercial-commissions.repo.ts`. Una comisión por proveedor con
«Alta por»:

- **Fee del primer trabajo**: si su primer trabajo confirmado (el `commercialFee` de arriba) es
  anterior a su primera suscripción paga, o no tiene suscripción → el fee completo, sin vencimiento.
- **Primera cuota**: si no, y tiene una suscripción autorizada con precio → `price_amount` del plan de
  su PRIMERA suscripción autorizada, desde `authorized_at`. No hay tabla de cobros del backend: es el
  precio de lista, no lo que pagó.
- `ops.commercial_commission_payment` guarda sólo que se pagó (sin fila = pendiente), con monto,
  comercial y referencia CONGELADOS. El servidor recalcula la regla antes de escribir.

## Pedidos al backend

- `docs/pedido-backend-liquidaciones-proveedores.md`: elegir la propuesta en pedidos cerrados y
  atribuir los que no tienen propuesta (para retirar la tabla parche).
