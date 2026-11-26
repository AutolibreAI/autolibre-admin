# Pedido al backend: sin tope de respuestas y sin suscripciones (2026-11-26)

De: panel de administración (`autolibre-admin`). Para: Ramiro (backend hex).

Tarjeta: «Nuevo modelo de cobro a proveedores: sin suscripciones, cobro por trabajo y paquetes».
Reemplaza el pedido del 2026-11-25 («plan gratis sin tope»), que pedía sacar el tope sólo al gratis.

Relevado el 2026-11-26 sobre `main` del backend (7d632fb) y producción (sólo lectura).

## El modelo nuevo (decidido por Nicolás el 2026-11-26)

- Las suscripciones (Gratis / Plus / Plus Max) **dejan de existir comercialmente**: no se venden más.
- **No hay tope de respuestas para nadie**: todos los proveedores responden pedidos sin límite.
- El único cobro es por **trabajo confirmado** (ARS 20.000), con el **primer trabajo gratis** para todos.
- **Paquetes**: el proveedor puede pagar por adelantado 5 trabajos con 90 días de vigencia a precio
  reducido. Por ahora se cargan a mano desde el panel (`ops`, migración 044 del panel); más adelante
  se automatiza el cobro.

El panel ya funciona así: sacó plan y tope de Partners, del despacho, de Estudio y de Liquidaciones,
cobra con la regla gratis → paquete → fee, y muestra las suscripciones existentes sólo como
«Suscripción (histórico)» en la ficha del proveedor.

## Qué hay hoy en el backend

- `subscription_plans.monthly_whatsapp_request_limit` NOT NULL (`free` 1, Plus 5, Plus Max 12 en
  producción). `PartnerEntitlements` lo expone; ningún caso de uso de `quotes` lo aplica.
- `billing/partner-subscription`: checkout de Mercado Pago (`StartSubscriptionCheckout`), webhooks y
  sync. La app y la web ofrecen los planes.

## Qué falta

- [ ] **Sin tope para todos**: `monthly_whatsapp_request_limit` NULLABLE (NULL = sin límite) y NULL en
  los tres planes, o sacar el tope de `PartnerEntitlements`. Que nada de la app ni de la web muestre
  «N pedidos por mes» ni «leads restantes».
- [ ] **Dejar de ofrecer y cobrar suscripciones** desde la app y la web: sacar la pantalla de planes y
  el checkout (o `active = false` en el catálogo y que la UI lo respete). **Sin borrar el histórico**:
  `partner_subscriptions` queda como está.
- [ ] Decidir qué pasa con las suscripciones vivas (`trialing`/`active`): el panel **no cancela nada en
  Mercado Pago**. Si hay que cancelarlas, que lo haga el backend con su caso de uso, avisándole al
  taller.
- [ ] Si algún día el despacho aplica topes: que no aplique ninguno.

## Listo cuando

- `select count(*) from subscription_plans where monthly_whatsapp_request_limit is not null` da 0
  (o el tope ya no existe).
- La app y la web no ofrecen planes ni muestran tope.
- `partner_subscriptions` conserva todas sus filas.
