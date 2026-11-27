Actualizá el tablero de Trello «Tareas de Autolibre» con lo que se hizo en el admin el 26/11/26.
Antes de tocar nada, mostrame el listado completo de cambios (tarjeta por tarjeta: mover, comentar,
crear) y esperá mi OK. Hablame en español rioplatense.

Todo lo nuevo está en la rama `updates-front-26-11` del repo `autolibre-admin` (commits 19fc8d1,
dcd4637 y 31dd530), sin mergear a `main`. Las migraciones de `ops` 043, 044 y 045 NO están aplicadas
en ninguna base (las aplica el deploy de producción al mergear); las suites de 044 y 045 (+043)
dieron verde en una réplica de prueba. No se probó en el navegador (pide login de Clerk).

Si alguna de estas tarjetas no existe, proponé crearla en «En revisión» con el texto del comentario
como descripción.

## Actualizar con un comentario y mover a «En revisión»

1. «Admin: separar usuarios y partners en los conteos» — Comentario: «Hecho (commit 19fc8d1). Tipo de
   cuenta centralizado: Partner = membresía activa en un taller (no `users.role`); Usuario + Partner +
   dueño cuentan como usuario; Admin afuera. Lo usan el pulso de Métricas, las series de altas, la
   adopción, personas por canal, Negocio, usuarios activos y Costos de IA. Usuarios suma columna y
   filtro «Tipo de cuenta», y la cola «Revisar cuentas» (mail/teléfono que coincide con un taller, y
   rol desactualizado) con «Marcar revisado» (migración 043). Producción hoy: 1.097 cuentas = 1.062
   Usuario + 24 Partner + 2 Partner + dueño + 9 Admin; 1.064 cuentan como usuario. Cola: 18 + 1. Falta
   del back: vincular una cuenta a un taller desde el admin y que vincular actualice `users.role`
   (`docs/pedido-backend-cuentas-partner.md`).»
2. «Nuevo modelo de cobro a proveedores: sin suscripciones, cobro por trabajo y paquetes» —
   Comentario: «Hecho en el admin (commit dcd4637). Primer trabajo confirmado gratis para todos;
   después, paquete vigente (el que vence primero) o ARS 20.000. Paquetes de trabajos (migración 044):
   carga manual desde la ficha, Proveedores y la pestaña nueva Paquetes, anular con motivo, saldo,
   por vencer y CSV de caja. Se sacaron plan y tope del despacho, Estudio, Liquidaciones y la ficha
   (queda «Suscripción (histórico)», sólo lectura). Partners › Propuestas pasó a «Proveedores».
   Producción hoy: 11 trabajos confirmados = 9 gratis + 0 por paquete + 2 con fee. Falta: definir el
   precio de referencia del paquete y la fecha de inicio del cobro, y el pedido al back
   (`docs/pedido-backend-plan-gratis-sin-tope.md`): sin tope para todos y dejar de vender
   suscripciones en la app y la web.»
3. «Admin › Comercial: liquidaciones a comerciales» — Comentario: «Hecho (commit 31dd530). Premio
   por alta cuando el taller tiene su primer trabajo confirmado (aunque sea gratis). Sólo quien tiene
   «Cobra premio» en Comercial › Equipo (apagado para los fundadores). Estados pendiente → pagado /
   anulado con motivo, CSV, y aparte «Con suscripción (histórico)». Migración 045. Falta definir el
   monto por alta (`PREMIO_POR_ALTA`). Hoy Tobías tiene 18 altas, ninguna con primer trabajo
   todavía.»

## Comentar en la tarjeta del back (Ramiro) o crearla en «Pedidos al back»

4. «Back: vincular cuenta ↔ taller desde el admin + actualizar users.role» — descripción:
   el contenido de `docs/pedido-backend-cuentas-partner.md`.
5. «Back: sin tope de respuestas y sin suscripciones» — reemplaza la de «plan gratis sin tope»;
   descripción: el contenido de `docs/pedido-backend-plan-gratis-sin-tope.md`.

## Para revisar en la web pública (otro repo, no tocado)

6. Crear una tarjeta «Web: sacar planes y suscripciones de /proveedores/planes y del registro» —
   descripción: «Con el modelo nuevo no se venden planes. Desde el admin sólo quedaba una mención
   en la descripción del tablero de PostHog «Demanda y monetización» ("planes pagos de proveedores").»
