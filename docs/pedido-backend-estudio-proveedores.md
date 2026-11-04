# Pedido al backend: estudio de proveedores (2026-11-03)

De: panel de administración (`autolibre-admin`). Para: Ramiro (backend hex).

Tarjetas: [Estudio de proveedores](https://trello.com/c/a052eFxg) ·
[Migrar presupuestos de la tabla vieja a la nueva](https://trello.com/c/XQEoN6Rq).

Relevado en producción el 2026-11-03 (`autolibre`, `doadmin`, puerto 25060), sólo lectura.

## Qué hay hoy

Partners › Estudio, con filtros de período (7 / 30 / 90 días), zona, rubro y plan:

| Métrica | Hoy | La frena |
|---|---|---|
| Propuestas enviadas, retiradas y elegidas | Real desde el 27/10 | Migración de presupuestos |
| Mediana del tiempo de respuesta | Real desde el 27/10 | Migración de presupuestos |
| Propuestas por canal | Real | — |
| Propuestas por rubro **del pedido** | Real desde el 03/11: rubro del operador (`ops.quote_request_rubro`) o, si no hay, el de la IA (`quote_request_services`) | Rubro guardado en el pedido |
| Elegidas / no elegidas / sin decisión | Parcial: la elección en la app es real | Cierre «Contraté / No contraté» |
| Pedidos matcheados vs. propuestas (tasa) | De ejemplo | Registro de matcheo |
| Vencidos sin respuesta | De ejemplo | Matcheo + `expires_at` |
| Confirmados y disputas | De ejemplo | Cierre «Contraté / No contraté» |
| Propuestas por urgencia | No se muestra | El pedido no guarda urgencia |
| Clics de perfil y reseñas | De ejemplo | Eventos de perfil |
| Dormidos, ranking y reporte por proveedor | Real (el reporte compara contra la mediana anónima de su zona, con 3+ proveedores) | — |
| Plan del proveedor (filtro) | De ejemplo | `partners.plan` (ver `pedido-backend-plan-proveedor.md`) |

Datos al 03/11: 85 propuestas reales en 41 pedidos; 28 con rubro del operador, 9 sólo de la IA, 4
sin rubro. La tabla vieja (`ops.quote_request_response`) tiene 140 presupuestos de 64 pedidos, y
136 de esos son de pedidos sin ninguna propuesta en la tabla nueva.

## Qué falta

### 1. Migración de presupuestos (tabla vieja → nueva)

- [ ] Llevar los presupuestos de `ops.quote_request_response` (anteriores al 27/10) a un lugar que
  el estudio pueda contar junto con `quote_request_proposals`. **No como propuestas de la app**:
  esas exigen `send_id` y `position` y mandan push. Opciones: una tabla histórica, o un flag
  `source = 'legacy'` en `quote_request_proposals` que no dispare nada.
- [ ] Criterio de equivalencia: un presupuesto viejo cuenta como una propuesta enviada; sin
  «elegida» (no existía).

### 2. Rubro guardado en el pedido

- [ ] Una fuente canónica del rubro de cada pedido: confirmar la del operador o la de la IA en una
  columna del backend, o asumir `ops.quote_request_rubro` como la oficial.
- [ ] Backfill de la clasificación de la IA para los pedidos anteriores a la 0124.

### 3. Registro de matcheo (a quién se le ofreció cada pedido)

- [ ] Tabla `quote_request_partner_matches`: `quote_request_id`, `partner_id`, `matched_at`,
  `source` (`auto | operator`).

### 4. Lectura agregada (cuando el volumen lo pida)

- [ ] `GET /admin/partner-performance?from&to&zone&rubro&plan`: por proveedor `matched`, `sent`,
  `withdrawn`, `responseRate`, `medianResponseMinutes`, `expiredUnanswered`, `selected`,
  `notSelected`, `undecided`, `confirmed`, `disputed`, desglose por rubro y canal,
  `notHiredReasons` (conteo), `lastProposalAt`. Hoy se arma en el navegador pidiendo las propuestas
  pedido por pedido.

### 5. Eventos de perfil y reseñas

- [ ] `partner_profile_viewed` y `partner_contact_clicked` (WhatsApp, «cómo llegar») desde la web y
  la app.
- [ ] Reseñas: no existen en ninguna tabla.

### 6. Urgencia

- [ ] Si producto la quiere: `quote_requests.urgency` (catálogo cerrado). Hoy no está en el
  formulario de la app.

## Permisos

Sólo admins (`AdminGuard`). **No debe devolver** datos de personas ni de pedidos individuales: el
estudio son conteos por proveedor. El reporte para el proveedor nunca identifica a otro proveedor
ni a un usuario.

## Listo cuando

- Propuestas enviadas y tiempo de respuesta incluyen lo anterior al 27/10.
- Cada pedido tiene un rubro canónico y «Sin rubro» queda en cero para los nuevos.
- La tasa de respuesta y los vencidos sin respuesta salen de matcheos reales.

## Preguntas abiertas

1. ¿Qué es «urgencia» de un pedido?
2. ¿«Dormido» es sin propuestas en el período, o sin propuestas habiendo recibido pedidos?
3. El reporte al proveedor, ¿lo manda el operador a mano o se automatiza?
