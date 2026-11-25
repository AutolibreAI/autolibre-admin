Actualizá el tablero de Trello «Tareas de Autolibre» con lo que se hizo en el admin el 25/11/26.
Antes de tocar nada, mostrame el listado completo de cambios (tarjeta por tarjeta: mover, comentar,
crear) y esperá mi OK. Hablame en español rioplatense.

Todo lo nuevo está en la rama `feat/liquidaciones-proveedores` del repo `autolibre-admin`, sin
mergear a `main`. Las migraciones de `ops` 038, 039, 040 y 041 dieron verde en réplicas de prueba y
NO están aplicadas en ninguna base (las aplica el deploy de producción al mergear).

## Mover a «✅ Hecho»

1. «Admin: sumar variables a las plantillas de mensajes de pedidos» — ya estaba hecho antes de esta
   sesión (migraciones 036 y 037, en `main`). Comentario: «Hecho el 24/11 (036/037). Las
   migraciones se aplican con el próximo deploy.»
2. «Admin: guardar en el pedido el vehículo identificado por patente» — ídem, hecho el 24/11 (036).

## Actualizar con un comentario (hechas en rama, falta revisar, mergear y desplegar)

3. «Admin › Partners: liquidaciones a proveedores (ARS 20.000 por trabajo confirmado)» — Comentario:
   «Hecho en `feat/liquidaciones-proveedores` (commit 5e1600b): Partners › Liquidaciones con Por
   cobrar por proveedor, Sin atribuir (tabla parche en `ops` para los pedidos cerrados sin propuesta
   elegida), En disputa (cliente y equipo no coinciden), Cobrados y anulados con CSV, mensaje de
   cobro por WhatsApp y «Fee para {comercial}». Regla en `src/lib/partner-fees-config.ts`; plan pago,
   primer cliente gratis y fecha de inicio quedaron preparados y apagados. Falta: revisar, mergear,
   aplicar la 038 y atribuir los 10 pedidos `hired` sin proveedor. Pedido de back aparte.»
4. «Admin › Comercial: liquidaciones pendientes por comercial» — Comentario: «Hecho en la misma rama
   (commit 1ae5cc4): Comercial › Liquidaciones, por comercial, con primera cuota (plan pago) o fee
   del primer trabajo (plan gratis) y «Marcar pagado» con fecha. Migración 039. La primera cuota es
   el precio de lista del plan: el backend no guarda los cobros de Mercado Pago.»
5. «Admin › Partners: pestaña con listado de proveedores y su plan» — Comentario: «Se resolvió
   ampliando Partners › Propuestas (commit b1b6313): estado de la suscripción y fin de la prueba,
   rubros, cupo restante del mes y fee pendiente. Ya era ordenable y filtrable por plan, zona y
   rubro.»
6. «Plan gratis sin tope de propuestas (opción 2): actualizar web de planes, panel admin y
   despacho» — Comentario: «Admin hecho (commit 3b8a9b1): el plan gratis se muestra sin límite. El
   backend no aplica el tope en el despacho; el 1 por mes es un dato del catálogo: pedido de back
   aparte. Falta la web /proveedores/planes.»
7. «Trazabilidad: registrar de dónde viene cada pedido y cada usuario (orgánico vs. pauta)» —
   Comentario: «Del admin: el campo «Origen» obligatorio en la carga manual ya estaba (036). Se sumó
   el reporte de pedidos por origen por semana en Métricas › Más métricas (commit 2b2aa88). Lo demás
   de la tarjeta (UTMs, app, bot) sigue pendiente.» Marcar en el checklist los ítems «Carga manual…
   campo obligatorio Origen» y «Reporte en el admin: pedidos por origen por semana».
8. «[P3] Configurar notificaciones desde el admin (puntuales, recurrentes y objetivo)» — Comentario:
   «El objetivo ya no se pierde al recargar (commit 99421b6): se guarda en `ops` (migración 040)
   desde el envío puntual y las reglas del panel, cada envío de una regla lo hereda y la pantalla de
   efecto lo toma de ahí. Sin backend. Falta: las automatizaciones por evento siguen contra mock.»
9. «Pantalla de seguimiento de pedidos en el admin» — Comentario: «Hecho en la rama (commit
   e14f366): Pedidos › Seguimiento con el prototipo portado (pestañas, mensajes según el caso,
   respuestas rápidas con Moni), «Marcar enviado» guardado por pedido con fecha y quién (migración
   041) y «Cargar resultado» desde la tarjeta, que también anota con qué taller para Liquidaciones.
   Pendiente: mandar desde la bandeja de WhatsApp del admin.»
10. «Panel admin: sección de tableros de control de partners (importar datos o, si no, accesos)» —
    Comentario: «Hecho en la rama (commit 4e86ebb) como sección «Alianzas»: accesos a Sin Fotomultas
    y Chasis y lugar para Asistir24, La Esquina del Neumático y Moni. Sin API conocida: no hay datos
    importados. El link de Sin Fotomultas va en la variable `ALLIANCE_DASHBOARD_SINFOTOMULTAS_URL` de
    Vercel (hay que cargarla).»

## Crear (lista Backlog, a nombre de Ramiro)

11. «Backend: elegir la propuesta de un pedido cerrado (liquidaciones)» — Descripción: «Para cobrar
    el fee por trabajo confirmado hace falta saber qué taller lo hizo. Hoy hay 11 pedidos `hired` y
    sólo 1 con propuesta elegida: los 11 están cerrados (el backend no deja elegir) y 6 no tienen
    propuestas. Pedido: dejar elegir la propuesta en un cerrado con resultado `hired`, y una forma de
    atribuir un taller sin propuesta (preferimos una columna `worked_by_partner_id`). Doc:
    `docs/pedido-backend-liquidaciones-proveedores.md` en `autolibre-admin`. Destraba: «Admin ›
    Partners: liquidaciones a proveedores».»
12. «Backend: plan gratis sin tope en el catálogo» — Descripción: «`subscription_plans.free` tiene
    `monthly_whatsapp_request_limit = 1` y la columna es NOT NULL. Pedido: hacerla nullable (NULL =
    sin límite), poner el gratis en NULL en la migración y el seed, y revisar textos que digan 1 por
    mes. Doc: `docs/pedido-backend-plan-gratis-sin-tope.md` en `autolibre-admin`. Destraba: «Plan
    gratis sin tope de propuestas (opción 2)».»

## No tocar

Todo lo demás del tablero, incluidas las tarjetas de bandeja de WhatsApp y bot, reglas de despacho,
estudio de proveedores, mapa de cobertura, rol comercial, cambios normativos, sellos y gama de autos.
