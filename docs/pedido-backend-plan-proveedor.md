# Pedido al backend: plan del proveedor (2026-11-03)

De: panel de administración (`autolibre-admin`). Para: Ramiro (backend hex).

Tarjetas que lo usan: conteo mensual de propuestas por proveedor (Partners › Propuestas) y
[Estudio de proveedores](https://trello.com/c/a052eFxg) (filtro por plan). El cobro arranca en
noviembre.

Relevado en producción el 2026-11-02 (`autolibre`, `doadmin`, puerto 25060), sólo lectura.

## Qué hay hoy

- `public.partners` no tiene ninguna columna de plan ni hay un enum de plan.
- El panel ya deja elegir el plan (Gratis / Estándar / Plus / Plus Max / sin plan) con fecha de
  inicio, en la ficha y en las filas de Propuestas, con confirmación. Se guarda **en memoria**: se
  pierde al recargar.
- `tier` (`founding | standard`) es el sello Aliado, no un plan. `ops.partner_prospect.plan` es lo
  que le interesa a un contacto de Comercial, no el plan contratado.

## Qué falta

### P0 (para el cobro de noviembre)

- [ ] `partners.plan`: enum `partner_plan` (`gratis | estandar | plus | plus_max`), **nullable**
  (`NULL` = sin plan). Sin backfill.
- [ ] `partners.plan_valid_from date` nullable.
- [ ] Aceptar `plan` y `planValidFrom` en la edición de partner que ya existe
  (`ops.set_partner_profile`, migración 009 del panel) o en un `ops.set_partner_plan` aparte, con
  `before` / `after` en `ops.action_log` y el actor de la sesión.

### P1

- [ ] Historial de plan (`partner_plan_history`: `partner_id`, `plan`, `valid_from`, `valid_to`,
  `changed_by`), para medir cada mes contra el plan vigente ese mes.
- [ ] `GET /admin/partner-proposal-usage?month=YYYY-MM` (o `from` / `to` / `range=all`): por
  proveedor `plan`, `cap`, `sent`, `withdrawn`, `selected`, `usedTowardCap`; los talleres de afuera
  aparte. Mes en hora de Buenos Aires, sin pedidos `duplicate`, nada antes del 27/10.

## Permisos

Sólo admins. Cambiar el plan queda auditado (quién y cuándo): tiene consecuencia de cobro.

## Listo cuando

- El plan elegido en la ficha sobrevive a recargar y se ve en Propuestas y en el Estudio.
- `ops.action_log` dice quién cambió el plan y cuándo.

## Preguntas abiertas

1. ¿Qué es el «taller de cabecera» y si tiene tope propio?
