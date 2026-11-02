# Necesidades de backend del panel admin

Versión 6 — 2026-11-02. Bloques 1 a 4 implementados (el pedido de cobertura AMBA, sólo revisado) y las decisiones del 02/11/26 sobre propuestas y planes aplicadas (lista de cambios al final). Una sección por tarjeta de
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
- Los números citados salen de producción, solo lectura, el 2026-10-29 (los relevados el 02/11/26
  lo dicen al lado). Son conteos agregados, nunca filas de personas.

---

## Admin: conteo mensual de propuestas por proveedor + tope por plan

**Estado del front:** Hecho contra mock (solo el plan es de ejemplo; propuestas, retiradas y
elegidas son reales).

**Qué hiciste:** Pestaña Partners › Propuestas (`src/routes/_authed/partners.propuestas.tsx`)
con selector de mes, enviadas / retiradas / elegidas / plan / usadas sobre tope. Los colores los
calcula `capTone` en `src/lib/partner-plans.ts` (nunca la pantalla): **rojo** si usadas > tope,
**amarillo** si usadas = tope, **Aliado** en gris con el badge "Aliado · sin límite por ahora" (su
tope se ve como referencia), **sin plan** en gris. Los talleres de afuera del directorio van en una
sección aparte al pie, "Propuestas a talleres de afuera (excepción)", con nombre y cantidad, y no
suman a ningún tope. En el formulario de propuestas, al elegir un taller de afuera aparece el aviso
"Caso excepcional: no suma al tope de ningún proveedor…" (no frena el envío). El plan, en
`src/mocks/partner-plans.ts`. Cuadre contra SQL directo al 02/11/26: octubre 54 propuestas de 36
proveedores (52 activas, 2 retiradas, 1 elegida), noviembre 7 de 6 + 1 a un taller de afuera
(Norauto Quilmes), iguales. Las 7 propuestas colgadas de pedidos cerrados como duplicado (pruebas
del equipo) no cuentan.

**Vista histórica** (opción "Histórico (desde 27/10/26)" del selector de mes, `proposalMonth=historico`):
una fila por proveedor con enviadas, retiradas, elegidas, total usadas, % elegidas (elegidas /
enviadas), primera y última propuesta, meses con actividad, pico mensual (el máximo de usadas en un
mes calendario), plan y badge Aliado. Sin columna de tope: el color va sobre el pico mensual, con las
mismas reglas del mes, así se ve quién pasaría el tope de su plan en algún mes. Orden por total
descendente, buscador por nombre (también en la vista mensual) y botón "Descargar CSV" (separador
`;`, coma decimal, UTF-8 con BOM; trae lo que se ve en pantalla, talleres de afuera al final
marcados) para que Tobías cruce con quién pagó. Sale del mismo conteo que la vista mensual
(`bucketProposals` en `src/lib/partner-plans.ts`): no hay una segunda lógica.

**Cuadre del histórico al 02/11/26** (producción, `doadmin`, puerto 25060): pantalla = SQL directo =
**61 propuestas de 38 proveedores del directorio (59 activas, 2 retiradas, 1 elegida)**, más 1 a un
taller de afuera. El número de referencia "68 de 41 (64 activas, 4 retiradas, 2 elegidas)" **incluye
las 7 propuestas de los dos pedidos cerrados como duplicado** (AL-1169: 3; AL-1172: 4, con 1
retirada y 1 elegida): con esas el SQL da 68 de 41, pero 65 activas, 3 retiradas y 2 elegidas. La
diferencia de 64/4 contra 65/3 no se reproduce con `withdrawn_at`: en toda la tabla hay 3 retiradas.
La explicación más probable es que esa consulta contó como retirada una propuesta corregida (AL-1192:
`updated_at` posterior a `created_at`, sin `withdrawn_at`). Corregir no retira (`PUT`, sin push), así
que la pantalla no la cuenta como retirada.

**Plan cargado a mano** (decisión 5): en la ficha del proveedor, al lado de Perfil, la tarjeta
"Plan" con selector Gratis / Estándar / Plus / Plus Max / sin plan y fecha de inicio; en las dos
tablas de Propuestas, el plan se edita desde la misma fila (lápiz). Siempre con confirmación ("¿Cambiar
el plan de X de Gratis a Plus desde el 01/11/26?"). La ficha muestra quién lo cambió y cuándo (el
email sale de la sesión, nunca del formulario). Componente `src/components/PartnerPlanEditor.tsx`,
hook `src/components/usePartnerPlans.ts`; guarda contra `src/mocks/partner-plans.ts`, **en memoria**:
la ficha, Propuestas y Estudio ven el cambio en la misma sesión y se pierde al recargar (nada en
`localStorage`). Con el cartel "Datos de ejemplo".

**Relevamiento del campo de plan (02/11/26), contra producción:** no existe. `public.partners` no
tiene ninguna columna de plan (sus columnas: `id, application_id, source, user_id, name,
description, logo_url, whatsapp, email, address, hours, modality, redirect_link, coverage_zone,
latitude, longitude, tier, status, created_at, updated_at, legacy_sheet_row_id,
whatsapp_message`), no hay ningún enum de plan, y lo que edita la ficha
(`setPartnerProfileFn` → `ops.set_partner_profile`, migración 009) sólo escribe nombre, zona,
descripción y `tier`. Lo único parecido es `ops.partner_prospect.plan` (`free | plus | undecided`):
es lo que un **contacto** de Comercial dijo que le interesa, no el plan contratado de un proveedor
(otra entidad, otro catálogo, sin Estándar ni Plus Max, y no todo proveedor tiene contacto). No
sirve, y no se usó. `tier` tampoco: es el sello Aliado.

**Cómo probarlo:** `pnpm dev`, entrar con una cuenta admin, Partners › Propuestas. Sin login:
`node tmp/probe-propuestas-historico.mjs` (solo lectura; `tmp/` no se versiona, está en esta
máquina) arma los mismos datos con los repos reales, corre los meses y el histórico, y cuadra contra
un `count` directo.

**Decisiones (02/11/26):**

1. **Aliado** (`tier = founding`): se ve su conteo y el tope de su plan como referencia, pero por
   ahora no tiene límite. Nunca se pinta en rojo ni en amarillo. Badge "Aliado · sin límite por
   ahora".
2. **El tope no frena el envío**, solo se marca. No hay bloqueo ni confirmación al cargar una
   propuesta.
3. **Los talleres de afuera del directorio siguen permitidos** como caso excepcional.
   `quote_request_proposals.partner_id` sigue siendo nullable: se sacó el pedido de volverlo NOT
   NULL.
4. **Elegidas = la propuesta que es hoy `quote_requests.selected_proposal_id`**, en la vista
   mensual y en la histórica. Una propuesta elegida y después des-elegida no cuenta como elegida.
   Está escrito también en `src/lib/partner-plans.ts`.
5. **El plan de cada proveedor se carga a mano desde el admin.**

**Necesidades de backend:**

**P0 — el pedido mínimo, para hacer en el día (el cobro arranca en noviembre):**

- [ ] **tabla o columna** — `partners.plan`: enum `partner_plan` (`gratis | estandar | plus |
  plus_max`), **nullable** (`NULL` = sin plan). Es `public`, así que va por Drizzle en
  `autolibre-backend-hex`. Sin backfill: todos arrancan sin plan y se cargan a mano. `tier`
  (`founding | standard`) no se toca: es el sello Aliado, no un plan. **Bloquea el front: no**
  (mock).
- [ ] **endpoint de escritura** — aceptar `plan` en la edición de partner que ya existe: hoy es
  `ops.set_partner_profile` (migración 009 de este repo, la que usa la ficha). Agregar `p_plan`
  (o un `ops.set_partner_plan` aparte, si se prefiere una entrada de auditoría propia porque el plan
  tiene otra consecuencia: el cobro). Las dos opciones escriben `ops.action_log` con `before` /
  `after` y el actor de la sesión, así que **quién y cuándo lo cambió sale gratis** sin el
  historial. Opcional en el mismo cambio: `partners.plan_valid_from date` nullable, para guardar la
  fecha de inicio que ya pide el formulario. **Bloquea el front: sí** para guardar de verdad.

**P1 — aparte, no frena el P0:**

- [ ] **tabla o columna** — historial de plan (`partner_plan_history`: `partner_id`, `plan`,
  `valid_from`, `valid_to`, `changed_by`). Sin esto, si un proveedor cambia de plan a mitad de mes
  no se sabe contra qué tope medir ese mes: hoy todo mes se mide contra el plan vigente. El tope
  (1 / sin límite / 10 / 15) puede vivir en código o en una tabla de planes con vigencia; si los
  topes van a cambiar, conviene tabla con `valid_from` para no reescribir meses pasados.
  **Bloquea el front: no.**
- [ ] **endpoint de lectura** — `GET /admin/partner-proposal-usage?month=YYYY-MM`. Una fila por
  proveedor del directorio: `partnerId`, `partnerName`, `tier`, `plan`, `cap` (null = sin límite),
  `sent` (no retiradas), `withdrawn`, `selected` (= es hoy `selected_proposal_id`),
  `usedTowardCap` (= sent + withdrawn). Aparte, `externals`: los talleres de afuera (nombre y los
  mismos conteos, sin plan ni tope). Mes calendario en `America/Argentina/Buenos_Aires`, nada antes
  del 2026-10-27, sin los pedidos cerrados como `duplicate`. Filtros: `month`, `plan`, `overCap`.
  **Rango:** que acepte también `from` / `to` (mes o día) o `range=all` para la vista histórica; con
  rango, por proveedor suma además `firstAt`, `lastAt`, `activeMonths` y `peakMonth` +
  `peakUsed` (el máximo de usadas en un mes calendario).
  **No debe devolver** descripción, montos, ni nada del pedido o de la persona. **Bloquea el front:
  no** (hoy se arma en el navegador, ver abajo; con volumen se vuelve lento).

> Se sacó el pedido de volver `quote_request_proposals.partner_id` NOT NULL (decisión 3 del
> 02/11/26): las propuestas a talleres de afuera siguen permitidas como excepción.

**Lo que ya existe y reusaste:** `listQuoteRequestsFn` (pedidos) + `listQuoteProposalsFn` (las
propuestas de un pedido, con `partnerId`, `createdAt`, `withdrawnAt` y `selectedProposalId`),
llamado pedido por pedido desde el navegador, igual que hace hoy el mapa de cobertura con el GPS.
`listMarketplacePartners` para nombre y `tier`.

**Dependencias:** la usa "Panel admin: estudio de proveedores…". Reemplaza a "Proveedores:
registrar los pedidos por proveedor en la automatización" (ver Solapamientos).

**Preguntas abiertas:**
1. "Taller de cabecera" no existe hoy en ningún lado del sistema: ¿es un sello nuevo, un plan, o
   una marca manual? ¿Tiene tope?

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

**Estado del front:** Hecho contra mock (la búsqueda es real; el vínculo es de ejemplo).

**Qué hiciste:** En la ficha del pedido, debajo de "Entró por…", dos datos por separado: "Canal de
entrada" y "Tiene la app: sí / no". Sin cuenta, botón "Vincular a un usuario de la app"
(`src/components/QuoteUserLinker.tsx`) con buscador real por email y nombre
(`searchNotificationRecipients`) y "Vincular" de ejemplo (`src/mocks/quote-user-link.ts`, en memoria).
El listado ya mostraba canal y cuenta en columnas separadas. Desde el 02/11/26 también se vincula
desde el formulario "Cargar pedido" (`src/components/QuoteRequestComposer.tsx`), con el mismo
buscador (`AppUserSearch`, extraído de `QuoteUserLinker`) y el mismo mock: el vínculo se aplica
recién después de crear el pedido, con el id que devuelve el alta. Si se elige una cuenta y no hay
patente, avisa que con cuenta la base la exige. Lo que sigue faltando es buscar por teléfono o
patente (necesita backend).

**Cómo probarlo:** `pnpm dev`, la ficha de un pedido de WhatsApp sin cuenta › "Vincular a un usuario
de la app", buscar por email. O Pedidos › "Cargar pedido" › "Vincular a un usuario de la app".

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

**Estado del front:** Hecho contra mock (Aliado y el cruce son reales; los sellos de redes y
aseguradoras, de ejemplo).

**Qué hiciste:**
- **Ficha del proveedor** (`/partners/$partnerId`), tarjeta "Sellos"
  (`src/components/PartnerSeals.tsx`): Aliado se muestra real (`tier = founding`, se sigue
  cambiando en Perfil). Para redes y aseguradoras: asignar (sello, estado pendiente / verificado,
  fuente, vencimiento), marcar verificado, revocar con confirmación, e historial de revocados.
  "Vencido" no se elige: sale de la fecha contra hoy en Buenos Aires (`sealState`). Re-asignar un
  sello que ya tiene revoca el anterior (un vigente por sello).
- **Pestaña Partners › Sellos** (`src/routes/_authed/partners.sellos.tsx`): importar el CSV de una
  red. Se elige el sello, el estado, la fuente y un vencimiento por defecto; las columnas se
  detectan por encabezado y se corrigen a mano. El cruce se calcula en el navegador con reglas fijas
  (`src/lib/partner-seals.ts`): teléfono normalizado igual que Comercial, contra la base con
  `findPhoneMatchesFn` (una llamada con todos los números); dirección normalizada (`av.` = `avenida`,
  sin `N°`, exige altura), opcional porque pide la ficha de cada proveedor; nombre exacto con
  `normalizeForMatch`. CUIT se lee pero no cruza: `partners.cuit` no existe y la pantalla lo dice.
  Nunca por parecido. Sólo arrancan tildadas las filas que cruzan con un único proveedor; si dos
  claves llevan a proveedores distintos ("Las claves no coinciden") o una clave a varios ("Varios
  proveedores"), elige una persona. Un proveedor no puede salir dos veces en la misma tanda.
- Abajo, la lista de lo asignado en la sesión, con estado. Mock: `src/mocks/partner-seals.ts`, en
  memoria; nombres de redes y aseguradoras genéricos ("Red de talleres A (ejemplo)").

No se hizo el filtro por sello del catálogo de la app: es de la app y del backend (endpoint de
lectura de abajo).

**Cómo probarlo:** `pnpm dev`, la ficha de cualquier proveedor → tarjeta Sellos: asignar "Red de
talleres A" verificado con un vencimiento pasado no deja (no se verifica vencido); con uno futuro
queda verde; con menos de 30 días, la fecha en ámbar. Partners › Sellos: un CSV con encabezado
`nombre;telefono;direccion;vence` y filas con el teléfono de un proveedor escrito con `0` y guiones,
el nombre de otro en mayúsculas y una fila con el teléfono de uno y el nombre de otro (sale "Las
claves no coinciden"). Sin login: `node tmp/probe-sellos.mjs` (reglas puras + 15 teléfonos reales
reescritos que cruzan con su proveedor, y los 126 nombres en mayúsculas).

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

**Lo que ya existe y reusaste:** `listMarketplacePartners` (nombres y tier), `findPhoneMatchesFn`
(teléfono contra `ops.normalize_ar_phone(partners.whatsapp)`), `getPartnerServicesView` (dirección,
sólo si se pide), `normalizeArPhone` y `parseCsv` de Comercial, `normalizeForMatch`. El tier Aliado
sigue en `setPartnerProfileFn`.

**Dependencias:** conteo mensual (Aliado como excepción al tope).

**Preguntas abiertas:**
1. ¿Aliado pasa a ser un sello más (y `tier` se retira) o conviven?
2. ¿Qué redes y aseguradoras hay en el primer listado, y qué columnas trae el CSV?
3. ¿El listado de una red es fuente suficiente para "verificado", o siempre entra "pendiente"?
4. ¿Un sello vencido se muestra en la app (como vencido) o desaparece?

---

## automatizar cambios normativos a .md de la IA

**Estado del front:** Hecho contra mock (las fichas son de ejemplo; el historial de versiones es real).

**Qué hiciste:** `/conocimiento` pasó a tener pestañas: **Documentos** (la pantalla de siempre, ahora
`conocimiento.index.tsx`) y **Cambios normativos** (`src/routes/_authed/conocimiento.cambios.tsx`):
- **Cola a revisar**, en amarillo: tema, jurisdicción, valor anterior y nuevo, vigencia, norma con
  link a la fuente, cita textual, quién la propuso (detector IA o persona) y el **diff por renglón**
  sobre la sección del .md (`diffLines`, LCS determinístico en `src/lib/regulatory-changes.ts`).
- **Chequeos de coherencia** fijos (`regulatoryChecks`): hay cita, hay URL https, el diff cambia
  algo, el valor nuevo está en lo agregado, el anterior en lo sacado, y el anterior no queda en otro
  renglón. Con uno en rojo, "Aprobar" está deshabilitado (la ficha 2 de ejemplo está así a propósito).
- **Aprobar** pide tildar "Leí la norma en la fuente" y un resumen de qué cambió (el renglón del
  changelog); queda a nombre de la persona logueada. **No sube nada**: lo dice en pantalla.
  **Rechazar** pide motivo. La IA nunca aprueba.
- **Revisadas** (plegado) con el changelog o el motivo.
- **Historial de versiones REAL** por documento, de `listKnowledgeDocumentsFn` +
  `groupKnowledgeChains` (en curso, en uso, reemplazadas), con "Qué cambió: sin dato · falta
  backend" en cada versión.

Mock: `src/mocks/regulatory-changes.ts`, en memoria. Normas, jurisdicciones, valores y URLs son
inventados y lo dicen ("(ejemplo)", `example.org`); el texto de cada sección también, porque el .md
no se puede bajar.

**Cómo probarlo:** `pnpm dev`, Conocimiento › Cambios normativos: la ficha de VTV pasa los chequeos
(aprobar exige el tilde y el resumen); la de multas tiene un chequeo en rojo y no se puede aprobar;
rechazar sin motivo no deja. Documentos sigue igual en `/conocimiento`. Sin login:
`node tmp/probe-normativos.mjs`.

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

**Lo que ya existe y reusaste:** `listKnowledgeDocumentsFn` y `groupKnowledgeChains` (historial).
`uploadKnowledgeDocumentFn` (con `supersedesDocumentId`) es lo que aprobar tendría que llamar cuando
exista el contenido del .md; hoy no se llama a propósito.

**Dependencias:** ninguna.

**Preguntas abiertas:**
1. ¿Qué significa cada color del semáforo (amarillo = a revisar; ¿rojo y verde?)? Supuse amarillo
   = a revisar, verde = aprobado, gris = rechazado.
2. ¿Quién aprueba: cualquier admin o una persona designada? Hoy cualquier admin.
3. ¿Qué preguntas de control corre la prueba después del reindexado, y quién las escribe?

---

## Backend: endpoints para el mapa de cobertura AMBA (admin › Partners › Cobertura)

**Estado del front:** Hecho (v1 sin endpoint propio, desde el 2026-10-22). El pedido al backend
**sigue vigente**.

**Qué hiciste:** Nada de código (la tarjeta pide no implementar). Re-verifiqué el 2026-10-29 sobre
`main` del backend (commit del 2026-10-28, clon de lectura): no hay ningún endpoint de cobertura,
ni de pedidos con coordenadas sin datos personales, ni de usuarios por zona. Lo más cercano que
apareció es `GET /partner-profiles/facets/zones` (público): zonas normalizadas a partir del texto
de `coverage_zone` de los proveedores publicados, con conteo. No sirve para el mapa (no trae pedidos
ni GPS ni usuarios), pero es la normalización de zonas que pide "Estudio de proveedores" para su
filtro (ver Hallazgos). Detalle del pedido en `docs/pedido-backend-cobertura.md`.

**Cómo probarlo:** sin cambios: Partners › Cobertura funciona igual que el 2026-10-22
(`node tmp/probe-cobertura.mjs` cuadra contra la sección 6 del spec).

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

**Limpieza pendiente del front para cuando exista** (verificado el 2026-10-29 con `grep`, quién usa
qué):
- `getPartnerCoverageBoard` (`src/fn/partners.ts`): hoy lo llama sólo `partners.cobertura.tsx`, y
  sólo para `totalActivePartners` (el texto "N activos" y los "sin servicios"). Se borra cuando el
  endpoint de partners del mapa traiga ese total.
- `partnerCoverageBoard` (`src/server/partners.repo.ts`): lo usa sólo esa fn.
- `~/lib/partners-coverage`: lo importan sólo esa fn y ese repo (tipos). Se va con ellos; quedan
  dos comentarios que lo nombran en `src/lib/catalog.ts` para actualizar.
- `~/lib/coverage-map`: `inferPedidoRubro`, `toCoveragePedido` y `toCoverageProveedor` (las usa sólo
  `partners.cobertura.tsx`). El resto del archivo (zonas, distancia, prioridad) se queda.
- En `partners.cobertura.tsx`, la carga de GPS pedido por pedido (`getQuoteRequestFn` con
  `GPS_CONCURRENCY`) y su cache de módulo.
- `.claude/rules/partners-coverage.md` (secciones del tablero viejo) y `coverage-map.md` ("v1 sin
  endpoint").

**Lo que ya existe y reusaste:** `listPartnerCandidatesFn`, `listQuoteRequestsFn`,
`getQuoteRequestFn`, `getPartnerCoverageBoard`.

**Dependencias:** "Panel admin: estudio de proveedores…" (filtro por zona, promedio de zona).

**Preguntas abiertas:** ninguna nueva.

---

## 1. Tabla resumen

| Tarjeta | Necesidad | Tipo | Bloquea front | Prioridad sugerida |
|---|---|---|---|---|
| Conteo mensual + tope | `partners.plan` (nullable) | tabla o columna | no | **P0** (cobro en noviembre) |
| Conteo mensual + tope | aceptar `plan` en la edición de partner | endpoint de escritura | sí (guardar) | **P0** |
| Conteo mensual + tope | historial de plan | tabla o columna | no | P1 |
| Conteo mensual + tope | `GET /admin/partner-proposal-usage` | endpoint de lectura | no | P1 |
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
| Sellos | sellos por proveedor (filtro del catálogo de la app) | endpoint de lectura | no | P2 |
| Cambios normativos | `regulatory_changes` | tabla o columna | sí | P3 |
| Cambios normativos | contenido del .md | endpoint de lectura | sí (diff) | P3 |
| Cambios normativos | aprobar = versión nueva + `change_summary` | endpoint de escritura | no | P3 |
| Cambios normativos | detector + prueba de control | job | no | P3 |
| Cobertura AMBA | `GET /admin/coverage` | endpoint de lectura | no | P2 |
| Cobertura AMBA | usuarios por zona | endpoint de lectura | sí | P2 |
| Métricas › Pedidos | propuestas por pedido y red vs. afuera desde `quote_request_proposals` | endpoint de lectura | no (cartel) | P2 |

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
   El backend ya normaliza el texto de `coverage_zone` para la web (`normalize-zone`, detrás de
   `GET /partner-profiles/facets/zones`): conviene que el filtro del Estudio y el endpoint de
   cobertura usen esa misma normalización y no una tercera.
11. **Cruce de un listado externo contra proveedores** — "Sellos" (CSV de una red) y Comercial
   (CSV de contactos) cruzan por teléfono con la misma regla. Si `seal-imports` se hace en el
   backend, que reuse `ops.normalize_ar_phone` (o su equivalente) y agregue CUIT cuando exista
   `partners.cuit`.
12. **Subir una versión nueva de un .md** — "Cambios normativos" (aprobar una ficha) y la pestaña
   Documentos ya usan el mismo camino (`POST /knowledge-documents/markdown` con
   `supersedesDocumentId`). Aprobar debería ser ese mismo alta más el `change_summary`, no un camino
   aparte.

## 3. Hallazgos

1. **`CLAUDE.md` estaba desactualizado** sobre qué migraciones hay en producción. **Corregido el
   02/11/26**: producción tiene de la 001 a la 024 de `ops` (relevado en `ops.schema_migrations`) y
   las 0120–0122 del backend (`quote_request_proposal_sends` existe).
2. **Métricas › Pedidos (propuestas por pedido, red vs. afuera) dejó de crecer el 27/10**: sigue
   leyendo `ops.quote_request_response`, que ya no se carga desde ninguna pantalla. Desde el
   02/11/26 los dos gráficos llevan el cartel "Datos hasta el 27/10/26" y mandan a Partners ›
   Propuestas. **No se recalcula en el navegador** con las propuestas: un mismo pedido puede tener
   filas en las dos tablas (la precarga copia de `ops` a la app), y sumarlas lo contaría dos veces;
   además Métricas tendría que pedir las propuestas pedido por pedido. Lo resuelve el endpoint de uso
   por proveedor con rango (`GET /admin/partner-proposal-usage`, ver la primera tarjeta), si suma
   un corte por fecha de creación del pedido; o una consulta de `quote_request_proposals` por
   período en la sección Pedidos de Métricas (`quoteRequestSeries`, server-only). **P2.**
3. **Las reglas recurrentes no mandan nada**: `/notificaciones/reglas` deja crearlas y activarlas,
   pero no hay motor. Una persona puede creer que un envío está programado.
4. **`notification_channel` no tiene WhatsApp** (`push | email | sms`), y el 100% de las
   notificaciones son push.
5. **`users.phone` vacío en todas las cuentas**: cualquier búsqueda o cruce por teléfono contra
   usuarios falla en silencio. Pedido abierto desde el 2026-10-03.
6. **La duración de 72 h del pedido no está modelada** (no hay `expires_at`).
7. **`notifications` no tiene `read_at`**: se sabe si se leyó, nunca cuándo.
8. **Volver `partner_id` NOT NULL rompía el flujo de propuestas a talleres de afuera.** Resuelto el
   02/11/26: se mantiene nullable y el taller de afuera queda como excepción, en su sección aparte.
   Al 02/11/26 hay 1 (Norauto Quilmes).
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
15. **La dirección de los proveedores no se puede leer en bloque**: ningún listado la trae, sólo la
   ficha. El cruce por dirección de Sellos pide la ficha de cada proveedor (126 llamadas, de a 4) y
   por eso es opcional. Un listado admin con dirección y teléfono normalizado lo resolvería.
16. **Hay nombres de proveedor repetidos** (sucursales): el cruce por nombre exacto da "Varios
   proveedores" en esos casos. No es un error del cruce; es por qué el nombre es la clave de menor
   confianza.
17. **`/conocimiento` pasó a ser un layout**: la pantalla de siempre vive ahora en
   `conocimiento.index.tsx`. La URL y el ítem del menú no cambiaron. Volcado a `CLAUDE.md` el
   02/11/26.
18. **El backend no se puede clonar entero en Windows** (rutas de más de 260 caracteres en
   `src/vehicle-management/...`). Para los `grep`, `git clone --depth 1` + `git grep HEAD` sin
   checkout funciona. Volcado a `CLAUDE.md` el 02/11/26.
19. **Un cuadre de propuestas que cuente por `updated_at` mezcla corregidas con retiradas.** Corregir
   una propuesta (`PUT`, sin push) mueve `updated_at` sin retirarla. "Retirada" es sólo
   `withdrawn_at` cargado; al 02/11/26 hay 3 en toda la tabla, y 1 corregida sin retirar (AL-1192).


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
   plan, como "no se cobra" (confirmado el 02/11/26).
8. Aliado = `tier = founding`. Desde el 02/11/26 es decisión, no supuesto: nunca se pinta, aunque
   pase el tope de su plan (ver "Decisiones (02/11/26)").
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
14. Los cierres declarados y las disputas usan pedidos de ejemplo AL-90xx que no existen. La ficha
   de un pedido real nunca muestra un valor de ejemplo: dice "sin dato · falta backend".
15. "Mandar a Comercial" desde un externo declarado NO crea el contacto en Comercial, aunque esa
   escritura exista: los datos son de ejemplo y terminarían como contactos reales.
16. En el estudio, el período cuenta propuestas por su fecha de envío; el norte "3 en menos de 1 h"
   cuenta pedidos por su fecha de entrada. La zona del reporte compara por el texto exacto de la
   zona declarada.
17. Un sello vigente por proveedor y por sello: re-asignar revoca el anterior (queda en el
   historial). "Vencido" se deduce de la fecha contra hoy en Buenos Aires; un pendiente no vence.
18. Para "Verificado" alcanza con que lo diga la persona que asigna (o que importe el listado como
   oficial); no hay un segundo paso de aprobación.
19. El cruce del CSV de una red usa, en orden de confianza: teléfono, CUIT, dirección y nombre, todos
   por igualdad después de normalizar. Si dos claves apuntan a proveedores distintos, o una a
   varios, decide una persona. Un proveedor no puede salir dos veces en la misma importación.
20. Las fichas de cambios normativos apuntan a .md y secciones de ejemplo, no a los documentos
   reales: sin el contenido del .md no hay cómo mostrar el diff contra el texto verdadero.
21. Aprobar una ficha exige pasar los chequeos de coherencia, tildar "leí la fuente" y escribir el
   resumen; cualquier admin puede aprobar. El resumen propuesto se arma con tema, valores y norma, y
   la persona lo edita.

## 5. Cambios respecto de la versión 5 (02/11/26)

Para actualizar Trello:

1. **Conteo mensual + tope** — se aplicaron las 5 decisiones del 02/11/26 (nueva subsección
   "Decisiones (02/11/26)"). Las 4 preguntas abiertas se cerraron; queda sólo "taller de cabecera".
   Colores: rojo pasó, amarillo llegó, Aliado gris con "Aliado · sin límite por ahora", sin plan
   gris. El tope no frena nada.
2. **Talleres de afuera** — sección aparte al pie de Propuestas, "Propuestas a talleres de afuera
   (excepción)", y aviso en el formulario de propuestas. Se **sacó** el pedido de
   `quote_request_proposals.partner_id` NOT NULL (y su fila de la tabla resumen).
3. **Elegidas** — definido: la propuesta que es hoy `selected_proposal_id`; una des-elegida no
   cuenta. Escrito en `src/lib/partner-plans.ts`.
4. **Vista histórica** de Propuestas (desde 27/10/26) con pico mensual coloreado, buscador y CSV.
   Cuadre: 61 propuestas de 38 proveedores sin duplicados; el "68 de 41" de referencia incluye las 7
   de pedidos duplicados (explicado en la tarjeta).
5. **Endpoint de uso por proveedor** — ahora pide `from` / `to` o `range=all`, y `externals` aparte.
6. **Plan cargado a mano** — tarjeta "Plan" en la ficha y edición desde las filas de Propuestas, con
   confirmación, contra mock en memoria. Relevamiento: no hay campo de plan en la base
   (`ops.partner_prospect.plan` no sirve). El pedido se partió en **P0** (`partners.plan` nullable +
   aceptarlo en la edición de partner que ya existe) y **P1** (historial de plan).
7. **Asignar pedidos manuales** — pasó de Parcial a Hecho contra mock: también se vincula desde
   "Cargar pedido".
8. **Métricas › Pedidos** — cartel "Datos hasta el 27/10/26" en propuestas por pedido y red vs.
   afuera; necesidad nueva P2 en la tabla resumen (hallazgo 2).
9. **`CLAUDE.md`** — al día con los hallazgos 1, 17 y 18. Hallazgo nuevo 19 (corregidas ≠
   retiradas).
