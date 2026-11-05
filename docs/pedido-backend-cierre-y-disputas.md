# Pedido al backend: cierre «Contraté / No contraté» y disputas (2026-11-03)

De: panel de administración (`autolibre-admin`). Para: Ramiro (backend hex).

Tarjeta: [Disputas del cierre de pedidos](https://trello.com/c/Srn5nsGn).

Relevado en producción el 2026-11-03 (`autolibre`, `doadmin`, puerto 25060), sólo lectura.

## Qué hay hoy

- La persona puede declarar en la app «contraté / no contraté» (`user_outcome`) y elegir una
  propuesta (`selected_proposal_id`). Eso es real y se ve en la ficha del pedido.
- Con quién contrató, monto final, estado del trabajo, código y motivo de «no contraté» **no
  existen**: la ficha dice «sin dato · falta backend».
- `/leads/pedidos/cierres` es el diseño de la bandeja: casos «No reconozco», validar / corregir /
  descartar con nota obligatoria, externos declarados y cierres por código. Corre con pedidos de
  ejemplo `AL-90xx` que no existen.

## Qué falta

- [ ] **Declaración de cierre** en `quote_requests` (o tabla 1:1): `hired_with` (`proposal |
  other_partner | external`), `hired_partner_id`, `external_provider_name`,
  `external_provider_phone`, `final_amount numeric(12,2)`, `not_hired_reason`, `work_status`
  (`waiting | verified | unverified | disputed`).
- [ ] **Códigos nuevos** en `quote_request_close_reason`: `user_not_hired`, `too_expensive`.
- [ ] **Respuesta del proveedor**: «Confirmo» / «No reconozco», con fecha (canal a definir).
- [ ] **Cola**: `GET /admin/quote-requests/disputes?status=open`: `id`, `publicNumber`,
  declaración, respuesta del proveedor, fechas.
- [ ] **Resolver**: `POST /admin/quote-requests/:id/dispute-resolution` con `decision` (`validate |
  correct | discard`), `note` **obligatoria**, y los campos corregidos si es `correct`. Actor de la
  sesión, auditado.
- [ ] **Externo → Comercial**: evento `external_provider_declared` que dé de alta el contacto en
  `ops.partner_prospect` con origen «declarado por usuario», deduplicado por teléfono normalizado
  (la regla ya existe: `ops.normalize_ar_phone`).

## Permisos

Sólo admins (`AdminGuard`) para la cola y la resolución. La cola **no debe devolver** teléfono ni
email de la persona: la ficha del pedido ya los tiene para quien los necesite.

## Listo cuando

- Un «No reconozco» aparece en la cola con la declaración y la respuesta.
- Resolver exige nota, queda auditado y mueve `work_status`.
- La ficha del pedido muestra con quién contrató y por cuánto, sin «sin dato».

## Preguntas abiertas

1. ¿Cómo responde el proveedor «No reconozco»? ¿Por WhatsApp al operador (el admin lo carga) o por
   un link propio?
2. «Corregir»: ¿qué campos puede corregir el admin?
3. ¿El alta del externo en Comercial es automática o la confirma el admin?
