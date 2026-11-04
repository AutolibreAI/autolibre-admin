# Pedido al backend: asignar un pedido manual a un usuario de la app (2026-11-03)

De: panel de administración (`autolibre-admin`). Para: Ramiro (backend hex).

Tarjeta: [Asignar pedido manual](https://trello.com/c/PcrZvzFP).

Relevado en producción el 2026-11-03 (`autolibre`, `doadmin`, puerto 25060), sólo lectura.

## Qué hay hoy

- En la ficha del pedido, «Canal de entrada» y «Tiene la app» van por separado: un pedido de
  WhatsApp vinculado a una cuenta sigue contando como WhatsApp, y la adopción de la app no se
  infla.
- «Vincular a un usuario de la app» (en la ficha y en «Cargar pedido») busca de verdad por **email
  y nombre**. El vínculo es de ejemplo: no se guarda.
- 58 pedidos reales no tienen cuenta (`user_id` nulo).
- `users.phone` está vacío en todas las cuentas: buscar por teléfono no encuentra a nadie.

## Qué falta

- [ ] **Búsqueda**: `GET /admin/users/search?q=` por email, nombre, teléfono y patente (vía
  `vehicles.plate`). Devuelve `id`, `email`, `name`, `plates[]`, `createdAt`. Tope 20 filas.
- [ ] **`users.phone` cargado** (pedido abierto desde el 2026-10-03), normalizado a `549` + 10
  dígitos, con la misma regla que `ops.normalize_ar_phone`.
- [ ] **Vincular**: `POST /admin/quote-requests/:id/link-user` con `userId`. Valida que el pedido
  no tenga cuenta y que la patente siga siendo coherente (la base exige patente si hay cuenta).
  Auditado con el actor de la sesión. **No cambia el canal de entrada.**
- [ ] **Desvincular** (por si se eligió mal): `POST /admin/quote-requests/:id/unlink-user`.

## Permisos

Sólo admins (`AdminGuard`). La búsqueda **no debe devolver** documentos, domicilio, token push ni
nada que la pantalla no muestre.

## Listo cuando

- Se encuentra a una persona por su teléfono o su patente.
- Vincular deja `quote_requests.user_id` cargado, queda en auditoría, y el canal de entrada sigue
  siendo WhatsApp.
- Métricas › Personas por canal no cuenta dos veces a quien se vinculó.

## Preguntas abiertas

1. Al vincular, ¿la persona ve en la app el pedido y las propuestas que ya se le mandaron por
   WhatsApp? Hoy la app no tiene ningún `GET` de pedidos.
2. ¿Se le avisa a la persona que se vinculó un pedido a su cuenta?
