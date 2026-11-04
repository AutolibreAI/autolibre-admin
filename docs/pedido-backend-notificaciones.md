# Pedido al backend: notificaciones desde el admin (2026-11-03)

De: panel de administración (`autolibre-admin`). Para: Ramiro (backend hex).

Tarjetas: [Configurar notificaciones](https://trello.com/c/0ZWqUuH2) ·
[Reglas de seguimiento](https://trello.com/c/fNpuajm3) ·
[Deep link](https://trello.com/c/t3lLAht4) ·
[Límite de 500](https://trello.com/c/ULgzoDkK) ·
[Efecto de cada notificación](https://trello.com/c/2ZNKZTQZ).

Relevado en producción el 2026-11-03 (`autolibre`, `doadmin`, puerto 25060), sólo lectura.

## Qué hay hoy

| Pieza | Estado |
|---|---|
| Envío puntual (`POST /notifications/broadcast`) | **Real.** Lo usa «Nueva notificación» de `/notificaciones` |
| Efecto de cada envío (`/notificaciones/envios/efecto`) | **Real desde el 03/11.** Conversión a 24 h / 72 h / 7 días contra la ventana previa, calculada con las filas de `notifications` del envío. No necesita endpoint nuevo |
| Envíos programados por calendario (`ops.notification_schedule`) | Se guardan, pero **no hay motor**: activarlos no manda nada |
| Automatizaciones por evento del pedido (`/notificaciones/automatizaciones`) | Contra mock. 7 plantillas de seguimiento, todas pausadas |
| Canales | `notification_channel` = `push \| email \| sms`. El 100 % de lo enviado es push. No existe WhatsApp |
| Deep link | Ninguna notificación lleva destino: tocarla abre la home de la app |
| Tope por envío | 500 destinatarios (DTO de `POST /notifications/broadcast`). Hay 850 usuarios reales y 586 con token push |

Reglas del pedido que las automatizaciones respetan (decididas por producto, sin modelar en la base):
72 h abierto · hasta 3 propuestas, 5 sólo si la 4ª y la 5ª son de un Aliado o del taller de
cabecera · la extensión sólo con confirmación de la persona.

## Qué falta

### 1. Motor de reglas (bloquea activar cualquier regla)

- [ ] Job que ejecute las reglas programadas (`ops.notification_schedule`) y las de evento.
- [ ] Deduplicación: una persona no recibe dos veces el mismo aviso del mismo pedido.
- [ ] Definir con qué identidad se autentica un envío que nadie disparó a mano (auditoría).

### 2. Reglas en un solo modelo (pedido abierto desde el 2026-10-03)

- [ ] `POST /admin/notification-rules` y `PUT /admin/notification-rules/:id`: `name`, `trigger`
  (`{kind, …}` de un catálogo cerrado), `channel`, `title` (≤ 25), `body` (≤ 500),
  `sendFromHour`, `sendToHour`, `asksClosing`.
- [ ] `POST /admin/notification-rules/:id/activate` y `/pause`.

### 3. Eventos del pedido (bloquean las plantillas de seguimiento)

- [ ] `quote_proposal_sent` con `quoteRequestId`, `proposalId`, `ordinal` (1 a 5), `partnerTier`.
- [ ] `quote_requests.expires_at` (o la regla «72 h desde `created_at`» escrita en un solo lugar).
- [ ] `quote_proposal_viewed` desde la app: `proposalId`, `userId`, `viewedAt`.
- [ ] Extensión del pedido: endpoint para que la persona la confirme desde la app
  (`POST /quote-requests/:id/extend`), y cuántas horas se extiende.
- [ ] Tope de propuestas: dejar pasar la 4ª y la 5ª sólo si son de un Aliado (`tier = founding`)
  o del taller de cabecera (que todavía no existe en ningún lado).

### 4. Canales

- [ ] `whatsapp` en `notification_channel` y el proveedor de envío (a definir).
- [ ] Mail por Brevo: hoy el canal existe y nunca se usó.
- [ ] `quote_requests.notify_whatsapp` boolean nullable (lo pregunta la app al crear el pedido).

### 5. Deep link

- [ ] Campo `deepLink` en `POST /notifications/broadcast` y en las reglas: una pantalla de un
  catálogo cerrado (`vehicle_new`, `quote_request`, `documents`, `scanner`, …) más su id si hace
  falta. Lo resuelve la app; la fila de `notifications` lo guarda.

### 6. Límite de 500 por envío

- [ ] Aceptar más de 500 `userIds` por envío, partiendo en lotes del lado del backend (o subir el
  tope si el proveedor de push lo permite). El panel ya manda el `broadcastId` como clave de
  idempotencia: cada lote tiene que respetarla para que un reintento no duplique.

### 7. Efecto de cada envío (lo único que falta)

- [ ] Guardar la **acción objetivo** del envío (`targetAction`: `vehicle | document |
  quote_request | null`) en una cabecera `notification_sends` (`id`, `sentAt`, `channel`,
  `title`, `body`, `kind` = `adhoc | rule | event`, `ruleId`, `audienceDefinition` jsonb,
  `targetAction`, `createdBy`). Hoy la acción se elige en pantalla y se pierde al recargar.
- [ ] Opcional: `notifications.read_at` (hoy se sabe si la leyó, nunca cuándo) y los eventos de
  Brevo (aperturas y clics del mail).

## Permisos

Todo lo que se escribe desde el panel, con `AdminGuard` y la identidad del admin logueado (token de
Clerk). Nada de esto lo puede llamar un usuario de la app, salvo `quote_proposal_viewed` y la
confirmación de la extensión, que son de la persona dueña del pedido.

## Listo cuando

- Una regla activada desde el panel manda el aviso al evento correspondiente, una sola vez por
  persona y pedido, en el horario permitido.
- La 4ª propuesta de un taller que no es Aliado se rechaza; la de un Aliado entra.
- Un pedido no se extiende sin que la persona lo confirme.
- Un envío a 850 personas sale completo, sin duplicar a nadie si se reintenta.
- Tocar una notificación con deep link abre esa pantalla de la app.
- El efecto de un envío muestra la acción objetivo guardada al enviar.

## Preguntas abiertas

1. WhatsApp: ¿API oficial de Meta, Brevo u otro? Cambia qué se puede medir.
2. ¿Los avisos de pedido respetan el silencio de `announcement` o son transaccionales?
3. ¿Cuántas horas antes del vencimiento va «quedan X horas»? ¿Una vez o varias?
4. ¿Cuánto se extiende un pedido cuando la persona confirma?
5. ¿Qué es el «taller de cabecera» y dónde se guarda?
