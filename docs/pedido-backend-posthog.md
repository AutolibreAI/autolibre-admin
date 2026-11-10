# Pedido al backend: tres eventos para PostHog (2026-11-10)

De: panel de administración (`autolibre-admin`). Para: Ramiro (backend hex).

Contexto: desde el 2026-11-10 Métricas embebe cinco tableros de PostHog (proyecto AutolibreAI,
id 607170). La app mobile suma eventos propios (rama `feat/app-posthog-eventos`). Estas tres cosas
sólo las puede hacer el servidor. Ninguna bloquea al panel: completan gráficos de los tableros.

Reglas para los tres: sin datos personales en las propiedades (nada de patente, VIN, teléfono, mail
ni dirección), `snake_case`, objeto + verbo en pasado, y `distinct_id` = el `users.id` de la cuenta,
el mismo que usa la app en `identify`, para que todo quede en la misma persona.

## 1. Pago confirmado — `plan_payment_succeeded`

- **Desde dónde:** el webhook de cobro, cuando el proveedor de pagos confirma el pago. No el
  redirect al checkout.
- **Propiedades:** `provider_id` (id del partner), `plan` (`plus` | `plus_max`), `amount`
  (número), `currency` (`ARS` | `USD`).
- **Qué destraba:** cerrar el embudo de planes pagos del tablero «Demanda y monetización», que hoy
  termina en el redirect, y ver ingresos en PostHog.
- **Listo cuando:** un pago de prueba aparece en PostHog con las cuatro propiedades, en la misma
  persona que hizo el clic en el plan.

## 2. Propuesta enviada — `proposal_sent`

- **Desde dónde:** el servidor, cuando una propuesta queda publicada para la persona
  (`POST /admin/quote-requests/:id/proposal-sends`, y el camino del proveedor cuando exista).
- **Propiedades:** `provider_id`, `quote_request_id`, `channel` (canal del pedido: `app` |
  `whatsapp` | `web`), `minutes_to_response` (minutos entre la creación del pedido y el envío).
- **Qué destraba:** el lado del proveedor, que hoy no deja rastro en PostHog: tiempos de respuesta
  y propuestas por proveedor.
- **A decidir:** `distinct_id` del dueño del pedido (sugerido, para unirlo a su embudo) o del
  proveedor.

## 3. Id del envío en el push

- **Qué:** en el `data` de cada push, sumar el id de la fila de `notification_sends` que lo originó
  (`notificationSendId`), además del id de la notificación.
- **Para qué:** la app lo reporta en el evento nuevo `push_opened` (`notification_id`) al tocar el
  aviso. Así se cruzan las aperturas de PostHog con la pantalla de efecto de notificaciones.
- **A decidir:** para los avisos automáticos que no salen de `notification_sends` (vencimientos),
  si alcanza con el id de `notifications`.
