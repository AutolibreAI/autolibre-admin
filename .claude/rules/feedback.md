# Feedback (`/feedback`)

Alcance: `src/lib/feedback.ts`, `src/server/feedback.repo.ts`, `src/fn/feedback.ts`,
`src/routes/_authed/feedback.tsx`, y el ítem de nav en `src/routes/_authed.tsx`.

## Qué consulta reemplaza

El `select * from feedback order by submitted_at desc` + el join a `users`
que hoy nadie corre. Antes el feedback sólo se veía como una fila más del
`UNION ALL` de `/actividad` y como un contador en el censo de
`/usuarios/:id`. Ninguna de las dos muestra el mensaje completo ni deja
filtrar por plataforma o versión — de ahí la pantalla dueña.

Agregada el 2026-09-23. Al escribirse: **5 filas de 3 usuarios**, del
2026-09-04 al 2026-09-22, la más larga de 127 caracteres.

## `feedback` deja de tener ficha propia en `/actividad`

Hasta acá `feedback` estaba en `ACTIVITY_DETAIL_KINDS` y abría
`/actividad/feedback/:id`. Con esta pantalla esa ficha sobra —repetiría lo
que `/feedback` ya muestra completo— así que `feedback` salió de
`ACTIVITY_DETAIL_KINDS` y `ActivityLink` (`~/components/ActivityCells`) le
agregó un `case` propio: linkea a `/feedback?userId=…` en vez de a una ficha.
`ActivityLink` ganó un prop `userId` (opcional, sólo lo usa `feedback`) para
poder armar ese search param — `null` (el mismo caso de `login`, trampa 9)
cae al listado sin filtrar en vez de romper. → `.claude/rules/activity-feed.md`

## SSR completo, sin ventana por default

Mismo criterio que `/chats`: la tabla es chica y no hay nada que streamear.
`feedbackWindow` existe (7/30/90 días/todo) pero el default es `all` — con 5
filas en producción, cualquier ventana activada por default vaciaría la
pantalla, mismo motivo por el que la tabla de adopción de `/metricas` no
tiene ventana.

## El mensaje se muestra COMPLETO, no truncado

127 caracteres es el más largo hoy y el mensaje ES el dato — truncar acá
sería la misma pérdida que truncar el `title` de `/chats` (que se deriva del
primer mensaje del usuario, también sin truncar).

## Los search params van calificados por dominio

`feedbackPlatform`, `feedbackAppVersion`, `feedbackWindow` — nunca `platform`
pelado. `platform` es exactamente el tipo de nombre genérico que otra
pantalla va a querer mañana, y TanStack mergea los search params de TODAS las
rutas en un solo tipo: dos enums bajo la misma clave rompen el typecheck de
la ruta AJENA, no de ésta. Ya rompió un build de producción una vez.
→ `.claude/rules/notifications.md`

`userId` sí es genérico (`string`, sin enum) y se comparte sin problema —
mismo criterio que en el resto del panel. Lo usan el censo de
`/usuarios/:id` (el contador «Feedback enviado» linkea acá) y `/actividad`.

## Plataforma y versión son data-driven, nunca hardcodeadas

`listDistinctFeedbackPlatforms()` / `listDistinctFeedbackAppVersions()` hacen
`select distinct … where … is not null`, mismo patrón que
`listDistinctChatModels`. Un valor nuevo aparece solo, sin tocar código —
`platform` es un enum del backend (`feedback_platform`) pero sigue el mismo
criterio que `scanner_type`/firmware: la lista de opciones del filtro no se
copia a mano.

## El contexto por fila son subconsultas escalares, no JOINs

`vehicleCount`, `feedbackCount` y `lastActivityAt` (importado de
`~/lib/activity`, la MISMA señal que `/usuarios`) van como subconsultas del
SELECT interno — un `LEFT JOIN` a `vehicles` o a `feedback` de nuevo
multiplicaría la fila. Mismo motivo que la trampa 2 de `users.md`.

`lastActivityAt` se muestra con `formatDate` (fecha absoluta), no con una
edad relativa calculada en el cliente: la pantalla es SSR completo, y restar
contra `new Date()` en el render daría un string distinto en el servidor y en
el cliente — el mismatch de hidratación que ya documentan `activity-feed.md`
(`age_minutes`) y `/documentos` (`ExpiryCell`).

## El botón "Responder" reusa `BroadcastComposer`, no un formulario nuevo

`BroadcastComposer` (antes sin props, sólo el botón "Nueva notificación" de
`/notificaciones`) ganó dos props opcionales: `presetRecipient` (agrega ese
destinatario al abrir — `addRecipient` ya es idempotente por `id`, así que
reabrir no duplica) y `trigger` (reemplaza el botón por defecto). `/feedback`
monta un `<BroadcastComposer/>` por FILA, cada uno con su propio
`presetRecipient` y un trigger "Responder" — no uno solo compartido, porque
cada composer es una `Sheet` con su propio estado y tiene que abrir con la
persona correcta según qué fila se clickeó.

`presetRecipient` necesita `pushTokens` (para que el aviso de "sin
dispositivo" funcione igual que en la búsqueda a mano de `/notificaciones`),
así que `FeedbackListItem.pushTokenCount` es una subconsulta más contra
`expo_push_tokens` — mismo criterio que el resto de las columnas de
contexto.

Manda por `POST /notifications/broadcast`, igual que siempre — no escribe
Postgres. → `.claude/rules/notifications.md`

## Ni una escritura sobre `feedback`

Lo escribe la app. Si aparece un `UPDATE`/`INSERT` en `feedback.repo.ts`,
está mal.

## Lo que se decidió diferir

- **Estado de triage** (visto / resuelto + nota interna): necesitaría una
  tabla nueva en `ops` (`ops.feedback_triage`) con sus 8 guardrails. Con 5
  mensajes no hay cola que ordenar.
- **Agrupado por versión de app**: con 5 filas no dice nada. Se hace cuando
  el volumen lo pida.

## Cómo verificar un cambio acá

`node_modules/.bin/vite build` (regenera `routeTree.gen.ts`) y después
`node_modules/.bin/tsc --noEmit`. Más el borde server-only:

```bash
grep -rl "feedback.repo\|listFeedback\|POSTGRES_DATABASE_URL" .output/public
```

Cero resultados. Cuadre: el total de la pantalla sin filtros tiene que dar
`count(*) from feedback`.
