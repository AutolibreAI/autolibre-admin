# Pedido al backend: revisión de rubros «Otro» y catálogo de servicios (2026-11-03)

De: panel de administración (`autolibre-admin`). Para: Ramiro (backend hex).

Tarjeta: [Revisión de rubros «Otro»](https://trello.com/c/R3LOYevz).

Relevado en producción el 2026-11-03 (`autolibre`, `doadmin`, puerto 25060), sólo lectura.

## Qué hay hoy

`/solicitudes/otros` lista las solicitudes con alguna de tres señales, cada una con su filtro:

| Señal | Regla | Hoy |
|---|---|---|
| Escribió en «Otro» | `partner_applications.service_other` con texto | 11 |
| Servicios en texto libre | entradas de `declared_services` que no son servicio ni familia activa | 1 («Chapa y pintura», Batata Taller) |
| Cantidad anómala | declaró más de la mitad de los 79 servicios activos (40 o más) | 9 (de 40 a 74) |

Total: 20 solicitudes. Al lado de cada una, los servicios que el proveedor tiene hoy y un selector
para asignarle servicios **que ya existen** (real, auditado). Lo que no se puede: crear un servicio
nuevo ni guardar «revisado».

## Qué falta

- [ ] **Marca de revisión**: `partner_applications.service_other_reviewed_at timestamptz`,
  `service_other_reviewed_by uuid`, `service_other_review_note text` (o tabla aparte con esas tres
  columnas y `application_id`).
- [ ] **Marcar revisado**: `POST /admin/partner-applications/:id/service-other-review` con `note`
  (opcional, ≤ 500). El actor sale de la sesión.
- [ ] **Alta de servicio**: `POST /admin/services` (`categoryId`, `name`, `slug`, `active`).
- [ ] **Alta de tarea**: `POST /admin/service-tasks` (`serviceId`, `name`, `slug`).
- [ ] **Reasignar** un servicio a otra categoría: `PUT /admin/services/:id` (`categoryId`).

Hoy el catálogo (79 servicios, 16 categorías, `service_tasks`) sólo se edita por SQL.

## Permisos

Sólo admins (`AdminGuard`), con la identidad del admin logueado. Cada alta o cambio de catálogo
queda auditado (quién y cuándo).

## Listo cuando

- «Marcar revisado» sobrevive a recargar la página y dice quién y cuándo.
- Desde la revisión se puede dar de alta un servicio o una tarea y asignarlo al proveedor en el
  mismo paso.
- Un servicio nuevo aparece en la app bajo su categoría sin tocar SQL.

## Lo que no se pide

Que el backend decida qué servicio corresponde a un texto: lo decide una persona desde el panel.

## Preguntas abiertas

1. Si la solicitud todavía no se aprobó (no hay proveedor), ¿la revisión se hace igual o espera?
2. ¿Quién decide el slug y la categoría de un servicio nuevo: Tobías desde el panel o los devs?
3. ¿Se corrige el `declared_services` de las 9 solicitudes anómalas, o sólo los servicios del
   proveedor?
