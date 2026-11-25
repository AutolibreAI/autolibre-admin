# Pedido al backend: plan gratis sin tope de propuestas (2026-11-25)

De: panel de administración (`autolibre-admin`). Para: Ramiro (backend hex).

Tarjeta: «Plan gratis sin tope de propuestas (opción 2)».

Relevado el 2026-11-25 sobre `development` del backend (052f663) y producción (sólo lectura).

## Qué hay hoy

- `subscription_plans.monthly_whatsapp_request_limit` del plan `free` = **1** (lo siembra
  `subscription-plan-seed.ts`; Plus 5 y Plus Max 12 en producción, 10 y 15 en el seed).
- La columna es `NOT NULL` con `CHECK (>= 0)`: no hay forma de decir «sin límite».
- `PartnerEntitlements` (`billing/partner-subscription`) expone el tope, pero **ningún caso de uso
  de `quotes` lo consulta**: el despacho y las propuestas no frenan a nadie por el tope. Es sólo un
  dato que se muestra.
- El panel, desde el 2026-11-25, lee el tope del plan gratis como «sin límite»
  (`FREE_PLAN_UNLIMITED` en `src/lib/partner-plans.ts`): ya no lo pinta en rojo ni en ámbar.

## Qué falta

- [ ] Que el plan gratis no tenga tope: `monthly_whatsapp_request_limit` NULLABLE (NULL = sin
  límite) y `free` en NULL, en la migración y en el seed. Que el DTO y `PartnerEntitlements`
  acepten `null`.
- [ ] Revisar cualquier texto de la app o la web que diga «1 pedido por mes» en el plan gratis.
- [ ] Si algún día el despacho empieza a aplicar topes, que `free` quede afuera.

## Listo cuando

- `select monthly_whatsapp_request_limit from subscription_plans where code = 'free'` da NULL.
- El panel saca `FREE_PLAN_UNLIMITED` (lee el NULL directo).
