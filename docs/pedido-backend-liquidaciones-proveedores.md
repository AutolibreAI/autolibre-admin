# Pedido al backend: elegir la propuesta de un pedido cerrado (liquidaciones) (2026-11-25)

De: panel de administración (`autolibre-admin`). Para: Ramiro (backend hex).

Tarjeta que destraba: Admin › Partners: Liquidaciones a proveedores (cobro del fee por trabajo
confirmado). Rama del panel: `feat/liquidaciones-proveedores`.

Relevado en producción el 2026-11-25 (`autolibre`, sólo lectura).

## Qué hay hoy

- El panel cobra ARS 20.000 por trabajo confirmado (`outcome = 'hired'` o `user_outcome = 'hired'`)
  al proveedor que hizo el trabajo. El proveedor sale de `quote_requests.selected_proposal_id` →
  `quote_request_proposals.partner_id`.
- Hay **11 pedidos `hired`** y **sólo 1** tiene la propuesta elegida. Los 11 están **cerrados**, y
  `PUT /admin/quote-requests/:id/selected-proposal` no deja elegir en un pedido cerrado.
- **6 de los 10** sin elegida no tienen ninguna propuesta (AL-1037, 1038, 1040, 1089, 1097, 1108):
  son anteriores a las propuestas en la app. El proveedor sólo está en la nota del cierre.
- Mientras tanto, el panel guarda «qué proveedor hizo el trabajo» en una tabla propia,
  `ops.partner_fee_attribution` (migración 038 del panel), con auditoría. **Es un parche**: si el
  pedido tiene propuesta elegida, manda la elegida.

## Qué falta

- [ ] **Elegir la propuesta en un pedido cerrado** con `PUT /admin/quote-requests/:id/selected-proposal`
  cuando el pedido terminó con `outcome = 'hired'` o `user_outcome = 'hired'` (sólo para registrar
  quién hizo el trabajo, sin push a la persona ni reabrir el pedido). Con `selection_source = 'operator'`
  y `selected_by`, como hoy.
- [ ] **Atribuir un trabajo a un proveedor sin propuesta** (los 6 pedidos viejos y los que se
  resolvieron con un taller que no mandó propuesta): opción A, un endpoint admin que cree una
  propuesta "registrada después" (sin push, sin lugar en la app) y la marque elegida; opción B, una
  columna `quote_requests.worked_by_partner_id` (uuid NULLABLE, FK `partners`), con
  `worked_by_set_by` y `worked_by_set_at`, que se escriba por `PUT /admin/quote-requests/:id/worked-by`.
  La B es más simple y no ensucia las propuestas: preferimos la B, pero decidan ustedes.

## Permisos

Sólo admins (`AdminGuard`), con el actor de la sesión.

## Listo cuando

- Los 10 pedidos `hired` sin proveedor se pueden atribuir por HTTP desde el panel.
- El panel pasa lo de `ops.partner_fee_attribution` al backend (una vez, por HTTP) y deja de
  escribir esa tabla.

## Preguntas abiertas

1. ¿El cobro del fee (avisado / cobrado / anulado) tiene que vivir en el backend algún día (p. ej.
   para que el proveedor lo vea en su panel)? Hoy vive en `ops.partner_fee_charge` del panel y no
   hace falta nada del backend para eso.
