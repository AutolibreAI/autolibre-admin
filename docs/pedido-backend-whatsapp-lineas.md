# Pedido al backend: las dos líneas de WhatsApp (2026-11-20)

De: panel de administración (`autolibre-admin`). Para: Ramiro (backend hex).

Relacionado con las tarjetas «Admin: bandeja de conversaciones del bot y pase a humano» y «[P3] Bot
de WhatsApp: recepción de pedidos v1».

## Contexto

Vamos a tener **dos números** de WhatsApp:

| Línea | Para qué | Número |
|---|---|---|
| **Proveedores** | El despacho de pedidos a talleres (0142, `partner_outreach`) y las respuestas de los talleres | el que usa hoy la integración (**a confirmar: no lo vemos desde el panel**) |
| **Usuarios** | El bot de recepción de pedidos y el pase a humano | +54 9 11 6877-4228 (**¿ya está configurado en el backend?**) |

El panel ya tiene la bandeja (`/whatsapp`, contra `/api/v1/admin/whatsapp/*`, contrato del
2026-11-06) y, desde el 2026-11-20, un botón flotante con un panel lateral de **dos pestañas**,
Proveedores y Usuarios, cada una con su contador de no leídas.

## El problema

`whatsapp_conversations` y `whatsapp_messages` **no guardan por cuál de NUESTROS números entró ni
salió** cada conversación o mensaje (relevado en producción el 2026-11-20: las columnas son
`counterpart_whatsapp`, timestamps y marcas de leído; nada de la línea). Y el envío
(`POST /admin/whatsapp/conversations/:id/messages`) no dice por qué número sale.

Mientras haya un solo número no pasa nada. Con dos:

1. No hay forma confiable de separar las pestañas: una misma persona puede escribir a las dos
   líneas, y un taller puede ser también usuario de la app.
2. **Una respuesta podría salir por la línea equivocada** (contestarle a un usuario desde la línea
   de proveedores, o al revés). Esto es lo que más importa.
3. El conteo de no leídas por pestaña sale de las conversaciones cargadas en la primera página, no
   de la base.

### Lo que hace el panel mientras tanto (provisorio)

`conversationLine()` en `src/lib/whatsapp-inbox.ts`: si el número de la conversación coincide con
un proveedor (`partners` no vacío en la respuesta del backend) va a **Proveedores**; si no, a
**Usuarios**. Está marcado como provisorio en el código. Hoy las 33 conversaciones de producción
son de proveedores, así que la pestaña Usuarios aparece vacía, con el texto «Todavía no hay
conversaciones de usuarios en esta línea».

## Qué hace falta

- [ ] **Una columna de línea** en `whatsapp_conversations` y en `whatsapp_messages`: nuestro número
  (E.164) o un enum. Proponemos un enum `whatsapp_line = partners | users` (el número puede cambiar;
  la línea no).
- [ ] **La conversación es por (línea, número de la contraparte)**, no sólo por número: la misma
  persona escribiéndole a las dos líneas son DOS conversaciones, con su propia ventana de 24 h y su
  propia marca de leído.
- [ ] **El envío sale por la línea de la conversación**, sin que el panel la elija. El panel nunca
  manda el número de salida: así no hay forma de equivocarse desde la UI.
- [ ] En las respuestas de `/admin/whatsapp/*`, cada conversación trae `line: "partners" | "users"`.
  El panel ya lo lee (campo opcional en el schema): apenas llega, deja de deducirlo.
- [ ] `GET /admin/whatsapp/conversations` y `.../changes` aceptan `?line=partners|users` (opcional),
  y devuelven `unreadConversationsByLine: { partners: n, users: n }` además del total.
- [ ] **Pase a humano** (fase siguiente, sin UI todavía en el panel): un `handoffRequestedAt`
  (nullable) en la conversación, que el bot setea cuando pide una persona. El panel ya lo acepta
  como campo opcional; la estructura queda lista para marcarlas y destacarlas en Usuarios. El aviso
  por Slack es aparte.
- [ ] **El nombre en la pestaña Usuarios**: igual que hoy viene `partners[]` cruzado por número,
  que venga `users: [{ id, name }]` cuando el número coincida con una cuenta. Hoy no hay de dónde:
  `users.phone` está vacío (250 de 250 al 2026-10-03, `docs/pedido-backend-2026-10-03.md` §2), así que
  el panel muestra el número. Opcional: el `contact_name` del último pedido con ese teléfono.
- [ ] **Backfill**: todas las conversaciones y mensajes existentes son de la línea de proveedores.
- [ ] Respuesta a dos preguntas: ¿qué número (o `phone_number_id` / sender del proveedor) usa hoy la
  integración? ¿Ya existe en la configuración la línea de usuarios?

## Criterio de listo

- Un mensaje entrante al +54 9 11 6877-4228 crea (o actualiza) una conversación con
  `line = users`, y uno al número de proveedores, con `line = partners`.
- Responder desde el panel a una conversación `users` sale por el +54 9 11 6877-4228, y a una
  `partners`, por el número de proveedores. Probado con un número de prueba en cada línea.
- `GET /admin/whatsapp/conversations?line=users` trae sólo las de usuarios, y la respuesta incluye
  los no leídos por línea.
- Las conversaciones existentes quedan en `partners`.
- El panel, sin cambios de código, pasa a separar las pestañas por `line` (ya lo lee si viene).
