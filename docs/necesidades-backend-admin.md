# Necesidades de backend del panel admin

Versión 3 — 2026-10-29. Bloques 1 y 2 implementados; el resto, relevado. Una sección por tarjeta de
Trello, con el título exacto de la tarjeta.

**Cómo leer esto**

- "Backend" en este documento es todo lo que el front del admin no puede tocar: endpoints del
  backend hex, server functions del panel (`src/fn`, `src/server`), consultas SQL, migraciones
  (incluidas las de `ops`), modelos, auth y permisos.
- Por eso cada ruta propuesta se escribe como `GET /admin/...`. Puede vivir en el backend hex o
  como server function de solo lectura del panel (el panel ya habla con Postgres directo); eso lo
  deciden Ramiro y Mateo. Lo que importa es el contrato: campos, filtros y lo que no debe devolver.
- "Mock" = una capa de API de ejemplo, aislada en un solo lugar del front (propuesta:
  `src/mocks/`, un archivo por tarjeta), con un cartel visible de "Datos de ejemplo" en cada
  pantalla que la use. Reemplazarla es cambiar un import.
- Los números citados salen de producción, solo lectura, el 2026-10-29. Son conteos agregados,
  nunca filas de personas.

---

## Admin: conteo mensual de propuestas por proveedor + tope por plan

**Estado del front:** Hecho contra mock (solo el plan es de ejemplo; propuestas, retiradas y
elegidas son reales).

**Qué hiciste:** Pestaña nueva Partners › Propuestas (`src/routes/_authed/partners.propuestas.tsx`)
con selector de mes, enviadas / retiradas / elegidas / plan / usadas sobre tope, rojo al pasar el
tope, badge "Aliado · excepción". El cálculo vive en `src/lib/partner-plans.ts`; el plan, en
`src/mocks/partner-plans.ts`. Cuadre contra SQL directo, octubre 2026: 34 enviadas, 2 retiradas, 1
elegida, iguales. Las 7 propuestas colgadas de pedidos cerrados como duplicado (pruebas del
equipo) no cuentan.

**Cómo probarlo:** `pnpm dev`, entrar con una cuenta admin, Partners › Propuestas. Sin login:
`node tmp/probe-propuestas.mjs` (solo lectura; `tmp/` no se versiona, está en esta máquina) arma los mismos datos con los repos reales y cuadra
contra un `count` directo.

**Necesidades de backend:**

- [ ] **tabla o columna** — `partners.plan` (enum `partner_plan`: `gratis | estandar | plus |
  plus_max`), NOT NULL con default a decidir. El tope (1 / sin límite / 10 / 15) puede vivir en
  código o en una tabla de planes con vigencia; si los topes van a cambiar, conviene tabla con
  `valid_from` para no reescribir meses pasados. `tier` (`founding | standard`) no sirve: es el
  sello Aliado, no un plan comercial. **Bloquea el front: no** (mock).
- [ ] **tabla o columna** — historial de plan (`partner_plan_history`: `partner_id`, `plan`,
  `valid_from`, `valid_to`, `changed_by`). Sin esto, si un proveedor cambia de plan a mitad de mes
  no se sabe contra qué tope medir el mes. **Bloquea el front: no.**
- [ ] **endpoint de lectura** — `GET /admin/partner-proposal-usage?month=YYYY-MM`. Una fila por
  proveedor: `partnerId`, `partnerName`, `tier`, `plan`, `cap` (null = sin límite), `sent`
  (no retiradas), `withdrawn`, `selected`, `usedTowardCap` (= sent + withdrawn). Mes calendario en
  `America/Argentina/Buenos_Aires`, nada antes del 2026-10-27. Filtros: `month`, `plan`,
  `overCap`. **No debe devolver** descripción, montos, ni nada del pedido o de la persona.
  **Bloquea el front: no** (hoy se arma en el navegador, ver abajo; con volumen se vuelve lento).
- [ ] **tabla o columna** — `quote_request_proposals.partner_id` NOT NULL. **Ojo:** hoy el
  formulario de propuestas admite un taller de afuera del directorio (`provider_name` +
  `provider_phone`, sin `partner_id`). Volverlo NOT NULL obliga a dar de alta al proveedor antes
  de mandarle una propuesta. Ver pregunta abierta. **Bloquea el front: no.**

**Lo que ya existe y reusaste:** `listQuoteRequestsFn` (pedidos) + `listQuoteProposalsFn` (las
propuestas de un pedido, con `partnerId`, `createdAt`, `withdrawnAt` y `selectedProposalId`),
llamado pedido por pedido desde el navegador, igual que hace hoy el mapa de cobertura con el GPS.
`listMarketplacePartners` para nombre y `tier`.

**Dependencias:** la usa "Panel admin: estudio de proveedores…". Reemplaza a "Proveedores:
registrar los pedidos por proveedor en la automatización" (ver Solapamientos).

**Preguntas abiertas:**
1. Aliado (`tier = founding`, 12 proveedores) y "taller de cabecera": ¿cuentan contra el tope, no
   cuentan, o tienen un tope propio? "Taller de cabecera" no existe hoy en ningún lado del sistema:
   ¿es un sello nuevo, un plan, o una marca manual?
2. ¿Qué pasa con las propuestas a un taller de afuera del directorio si `partner_id` pasa a ser
   NOT NULL? ¿Se elimina esa opción del formulario?
3. ¿El tope frena el envío (el backend rechaza la propuesta 2 de un Gratis) o solo se marca en
   rojo para cobrar? Hoy el front solo puede marcar.
4. "Elegidas": ¿una propuesta elegida y después des-elegida por la persona cuenta? La app tiene
   `DELETE /quote-requests/:id/selected-proposal`.

---

## Revisar rubros "Otro" declarados por proveedores y crear/asignar servicios faltantes

**Estado del front:** Hecho contra mock (solo la marca "revisado" es de ejemplo; asignar servicios es
real).

**Qué hiciste:** Pantalla `/solicitudes/otros` (`src/routes/_authed/solicitudes.otros.tsx`, link
"Revisar rubros «Otro»" desde Solicitudes): una tarjeta por solicitud con el texto declarado, los
servicios que el partner tiene hoy, un selector para asignar o sacar servicios del catálogo
(`editPartnerServicesFn`, el mismo de la ficha, auditado) y "Marcar revisado" con nota (mock en
memoria, `src/mocks/service-other-review.ts`; se pierde al recargar). Filtro "Sin revisar" /
"Todas". Al 2026-10-29: 11 solicitudes con «Otro», las 11 ya publicadas, cuadra con SQL directo.

**Cómo probarlo:** `pnpm dev`, Solicitudes › "Revisar rubros «Otro»". Sin login:
`node tmp/probe-otros.mjs` (solo lectura).

**Necesidades de backend:**

- [ ] **tabla o columna** — marca de revisión del "Otro": `service_other_reviewed_at`,
  `service_other_reviewed_by` y una nota (en `partner_applications` o tabla aparte). Filtro
  "sin revisar". **Bloquea el front: no** (mock).
- [ ] **endpoint de escritura** — alta de servicio en el catálogo: `POST /admin/services`
  (`categoryId`, `name`, `slug`, `active`) y `POST /admin/service-tasks` (`serviceId`, `name`,
  `slug`). Hoy el catálogo (79 servicios, 16 categorías, `service_tasks`) solo se edita por SQL.
  **Bloquea el front: no** (sin esto solo se asignan servicios existentes).
- [ ] **endpoint de escritura** — marcar revisado: `POST /admin/partner-applications/:id/service-other-review`
  (`note`, actor de la sesión). **Bloquea el front: no.**

**Lo que ya existe y reusaste:** `listPartnerApplications` (trae `serviceOther` y
`declaredOther`), `getPartnerServicesView` + `editPartnerServicesFn` (asignar servicios
existentes a un partner, ya auditado), `getServiceCatalog`.

**Dependencias:** ninguna.

**Preguntas abiertas:**
1. Si la solicitud todavía no se aprobó (no hay partner), ¿la revisión se hace igual o espera a la
   aprobación?
2. ¿Quién decide el slug y la categoría de un servicio nuevo? ¿Lo puede crear Tobías desde el panel
   o pasa por los devs?

---

## Medir usuarios activos reales (aperturas de la app)

**Estado del front:** Hecho contra mock (la nota sobre la métrica actual es real; la sección de
aperturas es de ejemplo).

**Qué hiciste:** En `/metricas`, arriba del gráfico de activos, un aviso ámbar: "Esto no son
aperturas de la app", con la definición actual; el gráfico pasó a llamarse "Usuarios activos
(acciones, no aperturas)". Sección nueva "Aperturas de la app" (`src/components/AppOpensSection.tsx`)
con DAU / WAU / MAU, stickiness, aperturas con valor, retención D1/D7/D30 por semana de alta y
ventana 7 / 30 / 90 días. Cálculos en `src/lib/app-opens.ts`; números en `src/mocks/app-opens.ts`.

**Cómo probarlo:** `pnpm dev`, Métricas: el aviso arriba de "Usuarios activos" y la sección
"Aperturas de la app" debajo de Crecimiento, con el cartel de datos de ejemplo.

**Necesidades de backend:**

- [ ] **evento** — `app_open` emitido por la app al pasar a primer plano: `userId`, `occurredAt`,
  `platform`, `appVersion`, `fromNotificationId` (nullable). Es de la app mobile, no del admin.
  **Bloquea el front: sí** (sin esto no hay métrica real).
- [ ] **tabla o columna** — si se guarda propio: `app_opens` append-only con esos campos,
  indexada por `(user_id, occurred_at)`. **Bloquea el front: sí.**
- [ ] **endpoint de lectura** — `GET /admin/app-opens/summary?window=7|30|90`: serie diaria de
  DAU, WAU y MAU por usuarios reales (sin cuentas internas), y `GET /admin/app-opens/retention`:
  cohortes por semana de alta con D1/D7/D30 en conteos. `GET /admin/app-opens/valuable`: activos
  que además hicieron escaneo, chat con mensaje, pedido o carga de documento en el mismo día.
  **No debe devolver** filas por persona, ni `userId`. **Bloquea el front: sí.**
- [ ] **decisión** — ¿PostHog o tabla propia? PostHog resuelve DAU/MAU/retención sin código, pero
  el cruce con "hizo algo de valor" (que vive en Postgres) y con las notificaciones (tarjeta de
  efecto) necesita los dos datos en el mismo lugar. Sugerencia: la app manda el evento a los dos,
  o PostHog con export a Postgres. Lo deciden los devs.

**Lo que ya existe y reusaste:** `getActiveUsersSeries` (la serie actual, solo para la nota).

**Dependencias:** "Panel admin: medir el efecto de cada notificación…" usa `fromNotificationId` y
las aperturas como señal.

**Preguntas abiertas:**
1. ¿"Activo con valor" incluye solo esas cuatro acciones o también cargar vehículo y consultar
   multas?
2. ¿Retención sobre la fecha de alta o sobre la primera apertura registrada?

---

## Configurar notificaciones desde el admin (puntuales y recurrentes)

**Estado del front:** Hecho contra mock (el envío puntual y los envíos programados ya eran reales;
lo nuevo es de ejemplo).

**Qué hiciste:** Pestaña nueva Notificaciones › Automatizaciones
(`src/routes/_authed/notificaciones.automatizaciones.tsx`): crear, editar, activar, pausar y borrar
avisos por evento del pedido, con disparador, canal (push / mail / WhatsApp / el que eligió la
persona), título con el tope de 25, mensaje con variables y horario permitido. Cada tarjeta dice qué
le falta del backend para funcionar. Modelo y validaciones en `src/lib/notification-automations.ts`;
guardado en memoria en `src/mocks/notification-automations.ts`. En Reglas › Envíos programados,
un aviso: activar todavía no manda nada (no hay motor) y todo es push.

**Cómo probarlo:** `pnpm dev`, Notificaciones › Automatizaciones › "Nueva automatización". Se
pierde al recargar, a propósito.

**Necesidades de backend:**

- [ ] **job** — el motor que ejecuta las reglas recurrentes y las de evento. Pendiente desde el
  plan de notificaciones automáticas: falta decidir con qué identidad se autentica un envío que
  nadie disparó a mano. **Bloquea el front: sí** (sin motor, una regla "activa" no manda nada).
- [ ] **tabla o columna** — canales: `notification_channel` es `push | email | sms`. No hay
  WhatsApp. Agregar `whatsapp` y el proveedor de envío (Brevo para mail; WhatsApp a definir).
  **Bloquea el front: no** (el selector puede mostrar el canal deshabilitado).
- [ ] **tabla o columna** — **registro de cada envío** (cabecera): `notification_sends` con `id`,
  `sentAt`, `channel`, `title`, `body`, `ruleId` (nullable), `kind` (`adhoc | rule | event`),
  `audienceDefinition` (la condición usada, jsonb), `targetAction` (nullable), `createdBy`, y la
  relación a cada destinatario (hoy ya existe por fila en `notifications` vía `source_id`).
  **Bloquea el front: no** para esta tarjeta; **sí** para la de efecto.
- [ ] **endpoint de escritura** — reglas en un solo modelo (pedido abierto desde el 2026-10-03,
  `docs/pedido-backend-2026-10-03.md` §1): `POST/PUT /admin/notification-rules`,
  `POST /admin/notification-rules/:id/activate|pause`. **Bloquea el front: no** (mock).

**Lo que ya existe y reusaste:** `sendBroadcastNotification`, `previewNotificationAudience`,
`searchNotificationRecipients`, `listNotificationCampaigns`, `getNotificationCampaign`, las 6 fns de
`schedules.ts`, `listNotificationRulesFn`.

**Dependencias:** base de las tarjetas de reglas de seguimiento y de efecto de cada notificación.

**Preguntas abiertas:**
1. WhatsApp: ¿por qué proveedor (API oficial de Meta, Brevo, otro)? Cambia qué se puede medir.
2. ¿Las reglas de vencimiento del backend también se editan desde acá, o solo se ven?

---

## Notificaciones: pensar y crear reglas de seguimiento a usuarios con pedidos abiertos (recordatorio, propuestas recibidas, horas restantes)

**Estado del front:** Hecho contra mock.

**Qué hiciste:** Seis plantillas en `src/lib/quote-follow-up-templates.ts`, precargadas PAUSADAS en
Notificaciones › Automatizaciones: pedido abierto sin propuestas (24 h), 1ª / 2ª / 3ª propuesta,
"quedan 12 h" (el pedido dura 72 h) y "propuestas sin mirar" con pregunta de cierre. Canal: el que
eligió la persona en el pedido. Los textos son borradores; un guardrail al cargar el módulo rechaza
una plantilla que no pase el schema (título de más de 25, horario al revés).

**Cómo probarlo:** `pnpm dev`, Notificaciones › Automatizaciones: aparecen las 6 con el badge
"Plantilla", pausadas. Sin login: `node tmp/probe-plantillas.mjs`.

**Necesidades de backend:**

- [ ] **evento** — disparadores por evento del pedido: `quote_proposal_sent` (con el número de
  propuesta: 1ª, 2ª, 3ª), `quote_request_hours_left` (al llegar a X horas del vencimiento),
  `quote_proposals_unviewed` (N horas después de una propuesta sin vista). **Bloquea el front:
  sí** para activarlas; **no** para mostrarlas.
- [ ] **tabla o columna** — `quote_requests.expires_at` (o la regla "72 h desde `created_at`"
  escrita en un solo lugar del backend). **Bloquea el front: no.**
- [ ] **evento** — `quote_proposal_viewed` desde la app (`proposalId`, `userId`, `viewedAt`).
  Sin esto "sin mirar" no se puede calcular. **Bloquea el front: sí** para esa plantilla.
- [ ] **job** — el mismo motor de la tarjeta de configuración, que además deduplique (una persona
  no recibe dos veces el mismo aviso del mismo pedido). **Bloquea el front: sí.**

**Lo que ya existe y reusaste:** el texto y las variables de las plantillas de mensaje de pedidos
(`QuoteTemplates`, con `{{codigo}}` obligatorio) como referencia de tono.

**Dependencias:** "Configurar notificaciones desde el admin…" (motor, registro de envíos);
"Pedidos (app): al crear el pedido, preguntar si quiere que le avisen por WhatsApp" (canal);
"Pedidos: 'Contraté / No contraté'…" (la pregunta de cierre).

**Preguntas abiertas:**
1. ¿Cuántas horas antes del vencimiento va "quedan X horas"? ¿Una vez o varias (24 h y 6 h)?
2. ¿Los avisos de pedido respetan el silencio de `announcement` o son transaccionales? Hoy
  `user_notification_preferences` tiene 0 filas, pero el filtro existe.

---

## Panel admin: medir el efecto de cada notificación en usuarios existentes

**Estado del front:** Hecho contra mock (envíos reales; conversión de ejemplo).

**Qué hiciste:** Pantalla `/notificaciones/envios/efecto` (link "Efecto por envío" desde Envíos,
`src/routes/_authed/notificaciones.envios.efecto.tsx`): una fila por envío con fecha, canal, mensaje
y alcanzados reales (`listNotificationCampaigns`, 39 envíos salidos al 2026-10-29), acción objetivo
elegible por fila (cargar vehículo / cargar documento / crear pedido), conversión a 24 h / 72 h / 7
días con la diferencia en puntos contra la base, y la base de 7 días antes. Las celdas de ejemplo van
en cursiva; una ventana que no cerró dice "en curso". Cálculos en `src/lib/notification-effect.ts`,
conversión en `src/mocks/notification-effect.ts`.

**Cómo probarlo:** `pnpm dev`, Notificaciones › Envíos › "Efecto por envío". Sin login:
`node tmp/probe-efecto.mjs`.

**Necesidades de backend:**

- [ ] **tabla o columna** — el registro de envíos de la tarjeta de configuración, con
  `targetAction` y la audiencia congelada al momento del envío (solo usuarios con `created_at`
  anterior al envío). **Bloquea el front: sí.**
- [ ] **endpoint de lectura** — `GET /admin/notification-sends/:id/effect?action=…`: `reached`,
  y para cada ventana (24h/72h/7d) `converted` y `baselineConverted` (misma audiencia, ventana del
  mismo largo antes del envío), excluyendo a quien ya había hecho la acción. **No debe devolver**
  la lista de personas (solo conteos). **Bloquea el front: sí.**
- [ ] **evento** — acciones con fecha y usuario para "crear pedido" (hoy `quote_requests.user_id`
  sirve), "cargar vehículo" y "cargar documento" (ya existen por `created_at`). Falta solo si se
  suman acciones nuevas. **Bloquea el front: no.**
- [ ] **job** — traer aperturas y clics de Brevo (webhook o pull) a una tabla
  `notification_delivery_events` (`sendId`, `userId`, `event`, `occurredAt`). **Bloquea el front:
  no.**

**Lo que ya existe y reusaste:** `listNotificationCampaigns`, `getNotificationCampaign`
(`CAMPAIGN_OUTCOMES`). `notifications` no tiene `read_at`: no se puede medir cuánto tardaron en
abrirla.

**Dependencias:** "Configurar notificaciones desde el admin…" (registro de envíos); "Medir
usuarios activos reales…" (aperturas desde notificación).

**Preguntas abiertas:**
1. ¿La base de comparación es la misma audiencia antes del envío (lo que dice la tarjeta) o un
   grupo de control que no recibe el envío? El primero es más fácil y más débil.

---

## Pedidos: "Contraté / No contraté" con elección de proveedor, historial, confirmación y cierre

**Estado del front:** Hecho contra mock (en la ficha, lo que existe es real y lo que falta dice "sin
dato"; la cola es toda de ejemplo).

**Qué hiciste:** En la ficha del pedido, tarjeta "Cierre declarado"
(`src/components/QuoteClosureCard.tsx`): lo que declaró la persona en la app y la propuesta que
eligió (reales), y con quién contrató, monto final, estado del trabajo, código y motivo como "sin
dato · falta backend" (nunca un valor de ejemplo sobre un pedido real). Pantalla
`/leads/pedidos/cierres` (link "Cierres y disputas" desde Pedidos,
`src/routes/_authed/leads.pedidos.cierres.tsx`): cola "En disputa" (declaración de la persona,
respuesta del proveedor, validar / corregir / descartar con nota obligatoria), proveedores externos
declarados con "Mandar a Comercial", y cierres filtrables por código, incluidos `user_not_hired` y
`too_expensive`. Pedidos de ejemplo AL-90xx en `src/mocks/quote-closures.ts`; modelo en
`src/lib/quote-closures.ts`.

**Cómo probarlo:** `pnpm dev`, Pedidos › "Cierres y disputas"; y cualquier ficha de pedido, tarjeta
"Cierre declarado" debajo de las propuestas.

**Necesidades de backend:**

- [ ] **tabla o columna** — declaración de cierre: `hired_with` (`proposal | other_partner |
  external`), `hired_partner_id`, `external_provider_name`, `external_provider_phone`,
  `final_amount`, `not_hired_reason`, `work_status` (`waiting | verified | unverified |
  disputed`). **Bloquea el front: sí** para datos reales.
- [ ] **tabla o columna** — valores nuevos en `quote_request_close_reason`: `user_not_hired`,
  `too_expensive`. **Bloquea el front: no.**
- [ ] **endpoint de escritura** — respuesta del proveedor ("Confirmo" / "No reconozco") y
  resolución de disputa por el admin: `POST /admin/quote-requests/:id/dispute-resolution`
  (`decision: validate | correct | discard`, `note` obligatoria, actor de la sesión, campos
  corregidos si `correct`). **Bloquea el front: sí** para la cola real.
- [ ] **endpoint de lectura** — `GET /admin/quote-requests/disputes?status=open`: pedido, código
  `AL-`, declaración, respuesta del proveedor, fechas. **No debe devolver** teléfono ni email de la
  persona (la ficha del pedido ya los tiene). **Bloquea el front: sí.**
- [ ] **evento** — `external_provider_declared` → alta en `ops.partner_prospect` con origen
  "declarado por usuario" (deduplicado por teléfono normalizado, que ya existe). **Bloquea el
  front: no.**

**Lo que ya existe y reusaste:** `getQuoteRequestFn` (ficha), `listQuoteRequestsFn` (filtros),
`addProspectOriginFn` y el resto de Comercial (`ops.partner_prospect`, `ops.normalize_ar_phone`).

**Dependencias:** la usa "Panel admin: estudio de proveedores…" (confirmaciones, disputas,
motivos) y "Notificaciones: … reglas de seguimiento…" (pregunta de cierre). Se solapa con
"Pedidos: seguimiento cuando los talleres respondieron y el usuario no volvió".

**Preguntas abiertas:**
1. ¿Cómo responde el proveedor "No reconozco"? ¿Por WhatsApp al operador (y el admin lo carga) o
   por un link/app del proveedor? Cambia si el admin escribe la respuesta o solo la lee.
2. "Corregir": ¿qué campos puede corregir el admin (con quién, monto)?
3. ¿El alta del externo en Comercial es automática o el admin la confirma?

---

## Admin: asignar a un usuario activo de la app los pedidos creados manualmente (los que entran por WhatsApp)

**Estado del front:** Parcial (la búsqueda es real; el vínculo es de ejemplo; solo desde la ficha).

**Qué hiciste:** En la ficha del pedido, debajo de "Entró por…", dos datos por separado: "Canal de
entrada" y "Tiene la app: sí / no". Sin cuenta, botón "Vincular a un usuario de la app"
(`src/components/QuoteUserLinker.tsx`) con buscador real por email y nombre
(`searchNotificationRecipients`) y "Vincular" de ejemplo (`src/mocks/quote-user-link.ts`, en memoria).
El listado ya mostraba canal y cuenta en columnas separadas. Falta: vincular en el mismo formulario
de "Cargar pedido" (hoy se vincula desde la ficha recién creada) y buscar por teléfono o patente.

**Cómo probarlo:** `pnpm dev`, la ficha de un pedido de WhatsApp sin cuenta › "Vincular a un usuario
de la app", buscar por email.

**Necesidades de backend:**

- [ ] **endpoint de lectura** — `GET /admin/users/search?q=`: por email, nombre, teléfono y
  patente (vía `vehicles.plate`). Devuelve `id`, `email`, `name`, patentes, fecha de alta. **No
  debe devolver** documentos, domicilio ni token push. **Bloquea el front: no** (email y nombre ya
  funcionan con lo que hay).
- [ ] **tabla o columna** — `users.phone` cargado (pedido abierto desde el 2026-10-03, §2).
  **Bloquea el front: no.**
- [ ] **endpoint de escritura** — `POST /admin/quote-requests/:id/link-user` (`userId`, actor de
  la sesión, auditado). Tiene que validar que la patente siga siendo coherente (la base exige
  patente si hay cuenta). **Bloquea el front: sí** para vincular de verdad.
- [ ] **decisión** — ¿el pedido vinculado aparece en el historial del usuario dentro de la app?
  Hoy la app no tiene ningún `GET` de pedidos. **Bloquea el front: no.**

**Lo que ya existe y reusaste:** `searchNotificationRecipients` / `listAppUsers` (búsqueda por
email y nombre), `getQuoteRequestFn`.

**Dependencias:** "Pedidos (app): al crear el pedido, preguntar si quiere que le avisen por
WhatsApp" (misma ficha).

**Preguntas abiertas:**
1. Al vincular, ¿la persona recibe en la app las propuestas que ya se le mandaron por WhatsApp?

---

## Pedidos (app): al crear el pedido, preguntar si quiere que le avisen por WhatsApp

**Estado del front:** Hecho contra mock.

**Qué hiciste:** "Avisos por WhatsApp: Sí / No / sin dato" en la celda de contacto del listado de
pedidos y al lado de "Tiene la app" en la ficha (`whatsappOptInLabel` en `src/lib/quote-requests.ts`).
El mock (`src/mocks/quote-whatsapp-opt-in.ts`) devuelve "sin dato" para todos los pedidos, que es
la verdad hoy: no se inventa un sí o un no sobre pedidos reales. Cuando exista la columna, llega como
un campo más de la fila.

**Cómo probarlo:** `pnpm dev`, Pedidos (columna de contacto) y cualquier ficha.

**Necesidades de backend:**

- [ ] **tabla o columna** — `quote_requests.notify_whatsapp` boolean nullable (null = sin dato,
  pedidos viejos y canales sin la pregunta). Lo escribe la app al crear. **Bloquea el front: no.**
- [ ] **endpoint de lectura** — sumarlo a lo que ya lee el panel de cada pedido. **Bloquea el
  front: no.**

**Lo que ya existe y reusaste:** `listQuoteRequestsFn`, `getQuoteRequestFn`.

**Dependencias:** la usa "Notificaciones: … reglas de seguimiento…" para elegir canal.

**Preguntas abiertas:**
1. Para pedidos que entran por WhatsApp o web, ¿se asume "Sí"?

---

## Panel admin: estudio de proveedores (presupuestos enviados, tipo, confirmados y reporte para ellos)

**Estado del front:** Hecho contra mock (lo calculable con propuestas es real; el resto, de ejemplo).

**Qué hiciste:** Pestaña Partners › Estudio (`src/routes/_authed/partners.estudio.tsx`):
- **Real**, con las mismas propuestas que Propuestas (hook compartido
  `src/components/useProposalFacts.ts`): enviadas y retiradas, elegida / otra / sin decisión,
  mediana de tiempo de respuesta (desde que entró el pedido), propuestas por canal, dormidos, y el
  norte "pedidos con 3 propuestas en menos de 60 min". Últimos 90 días al 2026-10-29: 1 de 16
  pedidos lo cumple; 4 llegaron a 3 propuestas en algún momento.
- **De ejemplo, en cursiva** (`src/mocks/partner-study.ts`): matcheados y tasa de respuesta, vencidos
  sin respuesta, confirmados y disputas, vistas y clics. El plan también.
- Filtros por período (7/30/90), zona, rubro y plan.
- Botón "Reporte" por proveedor: el resumen de un mes calendario, en texto, listo para WhatsApp.
  Determinístico (`partnerMonthlyReport` en `src/lib/partner-study.ts`). No nombra clientes ni a
  otros proveedores; la zona va como mediana anónima, y solo si hay 3 o más proveedores más en esa zona.

No se muestran propuestas por rubro ni por urgencia: el listado de pedidos no trae el rubro y la
urgencia no existe.

**Cómo probarlo:** `pnpm dev`, Partners › Estudio; "Reporte" en cualquier fila. Sin login:
`node tmp/probe-estudio.mjs` (cuadra elegida + otra + sin decisión = total, y chequea que el texto
del reporte no contenga el nombre de otro proveedor).

**Necesidades de backend:**

- [ ] **tabla o columna** — registro de matcheo/derivación: `quote_request_partner_matches`
  (`quote_request_id`, `partner_id`, `matched_at`, `source`: `auto | operator`). Sin esto no hay
  "pedidos matcheados vs. propuestas" ni "vencidos sin respuesta". **Bloquea el front: sí** para
  esas métricas.
- [ ] **endpoint de lectura** — `GET /admin/partner-performance?from&to&zone&rubro&plan`: por
  proveedor `matched`, `sent`, `responseRate`, `medianResponseMinutes`, `expiredUnanswered`,
  `selected`, `notSelected`, `undecided`, `confirmed`, `disputed`, desglose por rubro, canal y
  urgencia, `notHiredReasons` (conteo por motivo), `lastProposalAt`. **No debe devolver** datos
  de personas ni de pedidos individuales. **Bloquea el front: no** (parte se arma en el navegador).
- [ ] **evento** — vistas de perfil y clics (WhatsApp, "cómo llegar") en la web y la app:
  `partner_profile_viewed`, `partner_contact_clicked`. **Bloquea el front: no.**
- [ ] **tabla o columna** — urgencia del pedido: no existe. **Bloquea el front: no.**

**Lo que ya existe y reusaste:** lo mismo que la tarjeta de conteo mensual, más
`listPartnerZonesFn` y `getServiceCatalog` para los filtros.

**Dependencias:** "Admin: conteo mensual de propuestas por proveedor + tope por plan" (conteo y
plan); "Pedidos: 'Contraté / No contraté'…" (confirmaciones, disputas, motivos); cobertura AMBA
(zonas).

**Preguntas abiertas:**
1. ¿Qué es "urgencia" de un pedido? No está en el formulario de la app.
2. ¿"Dormido" es sin propuestas en 30 días, o sin propuestas habiendo recibido pedidos?
3. El reporte, ¿lo manda el operador a mano o se automatiza después?

---

## Sellos y validaciones de proveedores (Aliado, redes, aseguradoras) + filtro en catálogo

**Estado del front:** No empezado.

**Qué hiciste:** Relevamiento. El único sello hoy es Aliado = `partners.tier = founding` (12
proveedores), editable desde la ficha. No hay catálogo de sellos ni redes. El backend tiene
"promociones" de partner con endpoints admin, que no son sellos.

**Plan para el front:** contra mock: sección "Sellos" en la ficha del proveedor (asignar, revocar,
estado pendiente / verificado / vencido, fuente) y pantalla de importación CSV de una red con el
cruce contra proveedores por teléfono, CUIT, dirección o nombre. El cruce se calcula en el
navegador con reglas fijas (teléfono normalizado igual que Comercial; nombre exacto
normalizado; nunca "parecido" automático).

**Necesidades de backend:**

- [ ] **tabla o columna** — `seals` (`id`, `slug`, `name`, `kind`: `alliance | network |
  insurer`, `requires_expiry`). **Bloquea el front: no.**
- [ ] **tabla o columna** — `partner_seals` (`partner_id`, `seal_id`, `status`: `pending |
  verified | expired | revoked`, `source`, `verified_at`, `expires_at`, `granted_by`).
  **Bloquea el front: sí** para datos reales.
- [ ] **tabla o columna** — `partners.cuit` (no existe; sin eso no se cruza por CUIT).
  **Bloquea el front: no.**
- [ ] **endpoint de escritura** — `POST /admin/partners/:id/seals`, `POST
  /admin/partner-seals/:id/revoke`, `POST /admin/seal-imports` (filas ya cruzadas y confirmadas).
  **Bloquea el front: sí** para guardar.
- [ ] **endpoint de lectura** — sellos por proveedor para el filtro del catálogo de la app.
  **Bloquea el front: no.**

**Lo que ya existe y reusaste:** `setPartnerProfileFn` (tier = Aliado), `listMarketplacePartners`.
La normalización de teléfono de Comercial (`normalizeArPhone`) para el cruce.

**Dependencias:** conteo mensual (Aliado como excepción al tope).

**Preguntas abiertas:**
1. ¿Aliado pasa a ser un sello más (y `tier` se retira) o conviven?
2. ¿Qué redes y aseguradoras hay en el primer listado, y qué columnas trae el CSV?

---

## automatizar cambios normativos a .md de la IA

**Estado del front:** No empezado.

**Qué hiciste:** Relevamiento. Los .md del chat IA se cargan en `/conocimiento`: subida por HTTP a
`POST /knowledge-documents/markdown`, una versión nueva reemplaza a la anterior cuando la ingesta
termina, y la pantalla ya muestra la cadena de versiones (en uso / en curso / historial). No hay
fichas de cambios normativos, ni diff, ni changelog, ni forma de bajar el .md (la descarga está
acotada al dueño del archivo).

**Plan para el front:** contra mock: pestaña "Cambios normativos" en `/conocimiento` con la cola en
amarillo (tema, jurisdicción, valor anterior y nuevo, vigencia, norma, URL, cita textual) y el diff
propuesto sobre la sección del .md; aprobar / rechazar. Historial de versiones con changelog
reusando la cadena que ya existe. La IA puede proponer la ficha, pero aprobar es siempre de una
persona.

**Necesidades de backend:**

- [ ] **tabla o columna** — `regulatory_changes` (`topic`, `jurisdiction`, `old_value`,
  `new_value`, `effective_from`, `norm`, `source_url`, `quote`, `status`: `pending | approved |
  rejected`, `traffic_light`, `document_id`, `section`, `proposed_diff`, `reviewed_by`,
  `reviewed_at`). **Bloquea el front: sí** para datos reales.
- [ ] **job** — el que detecta cambios y arma las fichas. **Bloquea el front: no.**
- [ ] **endpoint de lectura** — contenido del .md vigente (`GET /admin/knowledge-documents/:id/content`)
  para mostrar el diff. Hoy no se puede bajar. **Bloquea el front: sí** para el diff real.
- [ ] **endpoint de escritura** — aprobar una ficha = subir una versión nueva con el diff aplicado
  (`supersedesDocumentId` ya existe) y guardar el changelog (`change_summary` en
  `knowledge_documents`). **Bloquea el front: no.**
- [ ] **job** — prueba de control después del reindexado: un set de preguntas fijas que el
  asistente tiene que contestar con el valor nuevo. **Bloquea el front: no.**

**Lo que ya existe y reusaste:** `listKnowledgeDocumentsFn`, `uploadKnowledgeDocumentFn` (con
`supersedesDocumentId`), `groupKnowledgeChains`.

**Dependencias:** ninguna.

**Preguntas abiertas:**
1. ¿Qué significa cada color del semáforo (amarillo = a revisar; ¿rojo y verde?)?
2. ¿Quién aprueba: cualquier admin o una persona designada?

---

## Backend: endpoints para el mapa de cobertura AMBA (admin › Partners › Cobertura)

**Estado del front:** Hecho (v1 sin endpoint propio, desde el 2026-10-22).

**Qué hiciste:** Nada nuevo (la tarjeta pide no implementar). Verifiqué que el pedido sigue
vigente: el backend no tiene ningún endpoint de cobertura al 2026-10-28. Detalle completo en
`docs/pedido-backend-cobertura.md`.

**Necesidades de backend:**

- [ ] **endpoint de lectura** — `GET /admin/coverage` → pedidos reales del mapa (sin duplicados
  ni cancelados por el usuario): número, fecha, canal, rubro inferido, lat/lng redondeados a 3
  decimales, localidad. **No debe devolver** descripción, teléfono, email ni nombre. Hoy el front
  pide el detalle de cada pedido (~750 ms cada uno) y recibe datos personales que no usa.
  **Bloquea el front: no** (funciona lento).
- [ ] **endpoint de lectura** — usuarios agregados por zona (domicilio de la cédula y ciudad del
  login), `[{ zonaId, usuarios }]`. **No debe devolver** filas por persona. **Bloquea el front:
  sí** para la prioridad "Demanda latente".
- [ ] **endpoint de lectura** — listado de partners para el mapa (servicios, modalidad,
  coordenadas), sin datos de contacto. **Bloquea el front: no.**

**Limpieza pendiente del front para cuando exista:** borrar `partnerCoverageBoard` (repo),
`getPartnerCoverageBoard` (fn, hoy solo se usa para `totalActivePartners`), `~/lib/partners-coverage`
y las funciones de traducción de `~/lib/coverage-map` (`inferPedidoRubro`, `toCoveragePedido`,
`toCoverageProveedor`).

**Lo que ya existe y reusaste:** `listPartnerCandidatesFn`, `listQuoteRequestsFn`,
`getQuoteRequestFn`, `getPartnerCoverageBoard`.

**Dependencias:** "Panel admin: estudio de proveedores…" (filtro por zona, promedio de zona).

**Preguntas abiertas:** ninguna nueva.

---

## 1. Tabla resumen

| Tarjeta | Necesidad | Tipo | Bloquea front | Prioridad sugerida |
|---|---|---|---|---|
| Conteo mensual + tope | `partners.plan` | tabla o columna | no | **P0** (cobro en noviembre) |
| Conteo mensual + tope | historial de plan | tabla o columna | no | P1 |
| Conteo mensual + tope | `GET /admin/partner-proposal-usage` | endpoint de lectura | no | P1 |
| Conteo mensual + tope | `partner_id` NOT NULL | tabla o columna | no | P2 (decidir externos antes) |
| Rubros "Otro" | marca de revisado | tabla o columna | no | P1 |
| Rubros "Otro" | alta de servicios / service_tasks | endpoint de escritura | no | P1 |
| Rubros "Otro" | marcar revisado | endpoint de escritura | no | P1 |
| Usuarios activos | `app_open` | evento | sí | P0 |
| Usuarios activos | `app_opens` | tabla o columna | sí | P0 |
| Usuarios activos | resumen, retención, con valor | endpoint de lectura | sí | P1 |
| Configurar notificaciones | motor de reglas | job | sí | P0 |
| Configurar notificaciones | canal `whatsapp` | tabla o columna | no | P2 |
| Configurar notificaciones | registro de envíos | tabla o columna | no (sí para Efecto) | **P0** |
| Configurar notificaciones | reglas en un solo modelo | endpoint de escritura | no | P1 |
| Reglas de seguimiento | eventos del pedido | evento | sí (activar) | P1 |
| Reglas de seguimiento | `expires_at` | tabla o columna | no | P1 |
| Reglas de seguimiento | `quote_proposal_viewed` | evento | sí (esa plantilla) | P1 |
| Efecto de cada notificación | efecto por envío | endpoint de lectura | sí | P1 |
| Efecto de cada notificación | eventos de Brevo | job | no | P2 |
| Contraté / No contraté | declaración de cierre | tabla o columna | sí | P1 |
| Contraté / No contraté | códigos `user_not_hired`, `too_expensive` | tabla o columna | no | P1 |
| Contraté / No contraté | resolución de disputa | endpoint de escritura | sí | P1 |
| Contraté / No contraté | cola de disputas | endpoint de lectura | sí | P1 |
| Contraté / No contraté | externo → Comercial | evento | no | P2 |
| Asignar pedidos manuales | búsqueda de usuarios | endpoint de lectura | no | P1 |
| Asignar pedidos manuales | `users.phone` | tabla o columna | no | P1 |
| Asignar pedidos manuales | vincular usuario | endpoint de escritura | sí | P1 |
| Avisos por WhatsApp | `notify_whatsapp` | tabla o columna | no | P1 |
| Estudio de proveedores | registro de matcheo | tabla o columna | sí (tasa) | P1 |
| Estudio de proveedores | rendimiento por proveedor | endpoint de lectura | no | P2 |
| Estudio de proveedores | vistas y clics de perfil | evento | no | P2 |
| Sellos | `seals` + `partner_seals` | tabla o columna | sí | P2 |
| Sellos | `partners.cuit` | tabla o columna | no | P2 |
| Sellos | asignar / revocar / importar | endpoint de escritura | sí | P2 |
| Cambios normativos | `regulatory_changes` | tabla o columna | sí | P3 |
| Cambios normativos | contenido del .md | endpoint de lectura | sí (diff) | P3 |
| Cambios normativos | detector + prueba de control | job | no | P3 |
| Cobertura AMBA | `GET /admin/coverage` | endpoint de lectura | no | P2 |
| Cobertura AMBA | usuarios por zona | endpoint de lectura | sí | P2 |

## 2. Solapamientos

1. **Registro de envíos de notificaciones** — lo piden "Configurar notificaciones…", "Reglas de
   seguimiento…" y "Medir el efecto…". Hacerlo una vez: una cabecera `notification_sends` que
   todo envío (ad-hoc, regla, evento de pedido) crea antes de escribir las filas de
   `notifications`, con `targetAction` y la audiencia congelada. Ojo: `notifications` ya guarda una
   fila por destinatario con `source_type`/`source_id`; lo que falta es la cabecera, no el detalle.
2. **Conteo de propuestas por proveedor** — "Conteo mensual + tope" y "Estudio de proveedores"
   leen lo mismo. Un solo endpoint de uso por proveedor, con mes o rango. **Reemplaza a la tarjeta
   "Proveedores: registrar los pedidos por proveedor en la automatización"**: el registro ya
   existe (`quote_request_proposals`), lo que faltaba era contarlo.
3. **Plan del proveedor** — "Conteo mensual", "Estudio de proveedores" (filtro por plan) y
   "Sellos" (Aliado como excepción). Una sola columna `partners.plan` + historial.
4. **Cierre del pedido** — "Contraté / No contraté", "Reglas de seguimiento" (pregunta de cierre)
   y "Pedidos: seguimiento cuando los talleres respondieron y el usuario no volvió". **Propuesta:
   unificar esa última en "Reglas de seguimiento"** (es la plantilla "tenés propuestas sin mirar"
   + pregunta de cierre), y que la respuesta escriba la declaración de cierre de "Contraté / No
   contraté".
5. **Eventos del pedido** (`quote_proposal_sent`, `quote_proposal_viewed`, horas restantes) —
   "Reglas de seguimiento", "Estudio de proveedores" (tiempo de respuesta, sin decisión) y
   "Efecto" (crear pedido como acción). Una sola tabla de eventos de pedido.
6. **`app_open`** — "Usuarios activos" y "Efecto" (apertura desde notificación con
   `fromNotificationId`).
7. **Canal elegido por la persona** — "Avisos por WhatsApp", "Reglas de seguimiento" y
   "Configurar notificaciones" (no existe el canal `whatsapp`). Se definen juntos.
8. **Búsqueda de usuarios** — "Asignar pedidos manuales" y el buscador de destinatarios de
   notificaciones. Un solo `GET /admin/users/search` con teléfono y patente, y `users.phone`
   cargado.
9. **Normalización de teléfono para cruces** — "Sellos" (importar red), "Contraté / No contraté"
   (externos a Comercial) y Comercial ya la tienen: `ops.normalize_ar_phone` + su espejo en el
   front. Reusar, no reescribir.
10. **Zonas** — "Cobertura AMBA" y "Estudio de proveedores" (filtro por zona, promedio de zona).

## 3. Hallazgos

1. **`CLAUDE.md` está desactualizado**: dice que la migración 024 (Comercial) no está aplicada en
   ninguna base; producción tiene hasta la 024 aplicada. Lo mismo con 0120–0122 del backend: la
   rule de propuestas dice que el 26/10 no estaban; hoy están y la tarjeta funciona.
2. **Métricas › Pedidos (propuestas por pedido, red vs. afuera) dejó de crecer el 27/10**: sigue
   leyendo `ops.quote_request_response`, que ya no se carga desde ninguna pantalla.
3. **Las reglas recurrentes no mandan nada**: `/notificaciones/reglas` deja crearlas y activarlas,
   pero no hay motor. Una persona puede creer que un envío está programado.
4. **`notification_channel` no tiene WhatsApp** (`push | email | sms`), y el 100% de las
   notificaciones son push.
5. **`users.phone` vacío en todas las cuentas**: cualquier búsqueda o cruce por teléfono contra
   usuarios falla en silencio. Pedido abierto desde el 2026-10-03.
6. **La duración de 72 h del pedido no está modelada** (no hay `expires_at`).
7. **`notifications` no tiene `read_at`**: se sabe si se leyó, nunca cuándo.
8. **Volver `partner_id` NOT NULL rompe el flujo de propuestas a talleres de afuera**, que el
   formulario hoy permite (aunque al 2026-10-29 ninguna de las 43 lo usa).
9. **El mapa de cobertura recibe teléfono, email y nombre de hasta 500 pedidos** para dibujar
   puntos (ya documentado en `docs/pedido-backend-cobertura.md`).
10. **El backend tiene promociones de partner con endpoints admin** (`/promotions`, asignaciones)
   que el panel no usa ni muestra.
11. **"Taller de cabecera" no existe** en ningún repo ni en la base.
12. **`user_notification_preferences` tiene 0 filas**: el filtro de silenciados existe, pero nadie
   silenció nada todavía.
13. **El repo de solicitudes devuelve `createdAt` como `Date` aunque el tipo diga `string`**
   (`listApplications` / `findApplication` en `src/server/partners.repo.ts`). Pedidos y propuestas
   sí lo devuelven como string. Rompió `/solicitudes/otros` (`localeCompare is not a function`); la
   pantalla lo normaliza, pero el arreglo de fondo es en el repo (`toISOString()` o `::text`), y
   cualquier pantalla nueva que ordene o compare esa fecha como texto va a fallar igual.
14. **Hay un partner que se llama "AutoLibre"** (pausado, carga manual). Si es de prueba, conviene
   archivarlo: aparece en listados y filtros como si fuera un proveedor más.


## 4. Supuestos que tomé

1. "No tocar backend" incluye las server functions y los repos de este mismo repo (`src/fn`,
   `src/server`) y las migraciones de `ops`, aunque el 2026-10-29 se aceptó una tabla en `ops`
   para Comercial. Sigo la regla de hoy.
2. Llamar a fns que ya existen desde pantallas nuevas no es tocar backend. Donde una pantalla
   necesita un agregado que no existe, lo armo en el navegador combinando fns existentes (como hace
   el mapa de cobertura) si el volumen lo permite; si no, mock.
3. Todo dato de ejemplo vive en `src/mocks/` y cada pantalla que lo usa muestra un cartel de "Datos
   de ejemplo". Nada se persiste en `localStorage`.
4. "Mes calendario en hora de Buenos Aires" = el mes de `created_at` convertido a
   `America/Argentina/Buenos_Aires`; el 27/10/26 se toma como 2026-10-27 00:00 de Buenos Aires.
5. "Enviadas" = las propuestas que siguen activas; "Retiradas" va aparte; "Usadas / tope" =
   enviadas + retiradas. Las elegidas no suman aparte (son parte de las enviadas).
6. Las propuestas de un pedido cerrado como `duplicate` no cuentan para el tope: el equipo usa ese
   cierre para sus pedidos de prueba. Son 7 al 2026-10-29.
7. Se cuenta por proveedor del directorio; una propuesta a un taller de afuera aparece aparte, sin
   plan, como "no se cobra".
8. Aliado = `tier = founding`. Una propuesta Aliado sobre el tope igual se pinta en rojo, con el
   badge "Aliado · excepción", hasta que se decida cómo cuenta.
9. "Proveedores" en la UI nueva; en el código sigue `Partner` (vocabulario del backend).
10. La marca "revisado" de los rubros «Otro» vive en memoria del navegador (mock) y se pierde al
   recargar, a propósito: guardarla en `localStorage` la haría parecer persistida.
11. Las automatizaciones por evento son una pestaña nueva y no se mezclan con los envíos programados
   por calendario (que ya son reales, en `ops`): cuando exista el modelo único de reglas del
   backend, las dos pestañas se juntan.
12. Los textos de las plantillas de seguimiento son borradores míos, para revisar. Usan
   "proveedores" y "propuestas".
13. En el efecto por envío, la acción objetivo se elige en pantalla y no se guarda: no hay dónde
   (lo cubre `targetAction` del registro de envíos).
