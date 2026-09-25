# Actividad (`/actividad`, `/actividad/:tipo/:id`)

Alcance: `src/lib/activity-feed.ts`, `src/server/activity-feed.repo.ts`,
`src/fn/activity-feed.ts`, `src/components/ActivityCells.tsx`,
`src/routes/_authed/actividad.index.tsx`,
`src/routes/_authed/actividad.$activityKind.$activityId.tsx`, y el ítem de nav
en `src/routes/_authed.tsx`.

No confundir con `src/lib/activity.ts` (`USER_ACTIVITY_SIGNALS`), que es otra
cosa — ver "La confusión de nombre" más abajo.

## Qué consulta reemplaza

Ninguna que alguien corriera, y es el mismo caso que `/usuarios/:id`: la
consulta que reemplaza es la que **no se corría porque no se puede**. Cada
pantalla del panel mira UNA tabla, así que contestar *"¿qué está pasando en la
app?"* son quince `select … order by created_at desc limit 20` sueltos y un
merge a ojo por timestamp. Eso no lo hace nadie.

La pantalla ES ese merge, hecho por Postgres: un `UNION ALL` de dieciséis ramas
normalizadas a `(cuándo, quién, qué, sobre qué auto, con qué resultado)`.

## El corte: lo que hizo una PERSONA

Decidido el 2026-09-16. Entra la fila que sólo existe porque alguien tocó la
app. **No entra lo que escribe el sistema solo**, y cada exclusión tiene motivo
—la tabla completa está en el comentario de cabecera de `~/lib/activity-feed`,
que es la fuente de verdad de esto—:

- `notifications` es lo que NOSOTROS mandamos, no lo que hizo la persona, y ya
  tiene `/notificaciones`.
- `fines` (659 filas) las escribe el proveedor al sincronizar; la ACCIÓN es la
  consulta, y entra una vez por auto como `consulta_multas`.
- `vehicle_inspections` con `source='provider'` es un lookup por patente, no un
  documento que alguien subió — mismo predicado que usa `/documentos`.
- `legal_acceptances` (298) son dos filas por usuario en el mismo segundo que su
  alta: ruido, no un hecho nuevo.

Dos recortes más, decididos el 2026-09-25, que viven en el `where` de su rama:

- **`conversations` SIN mensajes** (125 de 228): abrir el asistente sin
  escribir no es algo que hizo la persona. Antes entraban con resultado
  "sin mensajes"; ese resultado ya no existe. Mismo corte que `/chats`.
- **`quote_requests` cerrados como `duplicate`** (25 de 32): el operador marca
  así los duplicados Y los pedidos de PRUEBA del equipo. El predicado se
  IMPORTA de `quote-requests.repo.ts` (`notDuplicatePredicate('qr.')`), el mismo
  que resta la card "Pedidos totales" — no se recopia.

**Agregar un tipo es una rama en `BRANCHES` + una entrada en `ACTIVITY_KINDS`,
`ACTIVITY_KIND_LABELS`, `ACTIVITY_KIND_SHORT`, `ACTIVITY_TARGET_LABELS` y
`KIND_ICONS`.** Los cinco `Record` son cerrados y el compilador los obliga; lo
que NO obliga es acordarse del motivo, así que el motivo va al comentario de
cabecera del lib.

## La confusión de nombre: `activity.ts` vs `activity-feed.ts`

Son dos cosas distintas y el parecido es peligroso:

| Archivo | Qué es | Quién lo usa |
|---|---|---|
| `~/lib/activity` (`USER_ACTIVITY_SIGNALS`, `lastSignalSql`) | Tres tablas cuya presencia marca "esta persona hizo algo alguna vez" | la columna de `/usuarios` y el churn de `/negocio` |
| `~/lib/activity-feed` | Las dieciséis tablas del feed, con su detalle | `/actividad` |

El feed es un superconjunto del otro y **no se deriva de él**: acá cada rama
necesita columnas propias, y allá lo que importa es que las dos pantallas que lo
consumen usen la MISMA lista. **Agregar una rama al feed no la convierte en
señal de churn** — eso se decide aparte y se escribe en el otro archivo.

## Las trampas confirmadas

### 1. Todas las ramas alias TODAS sus columnas

En un `UNION`, Postgres toma los nombres de la PRIMERA rama. Y acá las ramas se
incluyen o no según el filtro de tipo: con `?activityKind=chat` la primera rama
es `chat`. Si los nombres dependieran del orden, **el filtro cambiaría la forma
del resultado**. Por eso `branch()` escribe `as id`, `as kind`, … en las
dieciséis, y por eso los `null` van casteados (`null::uuid`, `null::text`).

### 2. El filtro de tipo PODA, no filtra

`activityKind` decide qué ramas entran al `UNION ALL`, en vez de un
`where kind = …` sobre el resultado. Es la única parte del filtrado que
realmente baja el trabajo de Postgres, y sale gratis porque `BRANCHES` es un
`Record` cerrado.

### 3. No hay `limit` por rama, y es correctitud, no descuido

Sería la optimización obvia (`order by … desc limit 500` en cada rama) y da un
resultado **incorrecto**: `q` va en el `where` de afuera —busca sobre `detail`,
que es una expresión del SELECT—, así que recortar antes de filtrar tira filas
que sí matcheaban. El top 500 global sólo se deriva de los top 500 por rama
cuando TODOS los filtros están adentro. Con ~1.000 eventos en producción el
costo es cero; el día que no lo sea, la respuesta es un índice.

Por el mismo criterio la VENTANA también va afuera, aunque podría ir adentro y
ser más rápida: empujar el predicado a dieciséis ramas escritas a mano son
dieciséis oportunidades de olvidarse de una, y ese olvido es silencioso (ese
tipo de evento ignoraría el filtro y nadie lo notaría).

### 4. "Hace cuánto" lo calcula Postgres

`age_minutes` viene del SELECT. La pantalla es SSR completo: restar contra el
reloj del navegador daría un string distinto del que mandó el servidor, o sea un
mismatch de hidratación **por fila**. Mismo patrón que `ExpiryCell` en
`/documentos` con `days_until_expiration`. `formatAge()` sólo formatea ese
número, sin `Intl.RelativeTimeFormat` (los cortes son nuestros y el resultado
tiene que ser byte a byte el mismo en los dos lados).

### 5. El destino de una fila es un `<Link>` TIPADO, nunca un href armado

`<Link to={unString}>` compila sin que el compilador mire el destino: una ruta
mal escrita pasa `tsc`, pasa el build, y falla recién cuando alguien la clickea.
Por eso `ActivityLink` es un `switch` de `<Link to="/chats/$conversationId"
params={…}>`, verificados contra `routeTree.gen.ts`.

**El `default` de ese switch es el guardrail**: asigna el `kind` que sobra a un
`ActivityDetailKind`, así que un tipo de evento nuevo sin destino **no
compila** — o tiene su `case`, o está en `ACTIVITY_DETAIL_KINDS` (y entonces
`DETAIL_QUERIES` también lo obliga a tener consulta de detalle). Verificado por
mutación: sacando `'login'` de esa lista, fallan los dos archivos.

**`feedback` es el ejemplo del otro camino.** Hasta el 2026-09-23 estaba en
`ACTIVITY_DETAIL_KINDS` y abría una ficha propia. Cuando apareció
`/feedback` como pantalla dueña, salió de esa lista y `ActivityLink` ganó un
`case 'feedback'` que linkea a `/feedback?userId=…` en vez de a una ficha —
el mismo patrón que ya usan `chat`, `escaneo` y `pedido`. → `.claude/rules/feedback.md`

Corolario: los cuatro tipos de documento se llaman igual que los `DocType`
(`seguro`/`cedula`/`registro`/`vtv`) y el `params={{ docType: kind }}` se apoya
en eso. Si alguno se renombra, el compilador avisa.

### 6. El id de `consulta_multas` es el del VEHÍCULO

`vehicle_fine_syncs` no tiene columna `id`: su PK es `vehicle_id` (1:1 por
vehículo). Consecuencia buscada y no un bug: **una consulta nueva PISA a la
anterior**, así que el feed muestra la última y no el historial — porque la
tabla no guarda historial.

### 7. Los cortes se IMPORTAN, no se recopian

`OK`/`NO_DATA`/`FAILED` salen de `scanners.repo.ts` (por eso el alias de la
tabla en esa rama es `ds`: las cadenas lo traen cableado). El de multas
(`status = 'pending'`) y el de mantenimiento creado por una persona
(`plan_id is null`) están escritos igual que en `fines.repo.ts`/`users.repo.ts`
y en `ops.repo.ts`. Si divergen, el panel dice dos cosas distintas del mismo
hecho sin ningún error que lo delate.

### 8. El token push NO se muestra, ni en el listado ni en la ficha

`expo_push_tokens.token` es una credencial de envío: con ella se le manda un
push a esa persona desde afuera de AutoLibre. La plataforma y el prefijo del
`device_id` alcanzan para el diagnóstico. Misma regla que `users.md` (trampa 7);
la ficha lo dice en voz alta en vez de omitir el campo.

### 9. `login_events` no tiene `user_id`

Trae el par `(auth_provider, external_auth_id)` — la clave de
`idx_users_external_identity_unique`, y la única forma correcta de resolver una
identidad (**nunca el email**). El `JOIN` es inner y eso descarta algo: al
2026-09-16, **2 de 56 logins no resuelven a ninguna fila de `users`**. No es
ruido: es el síntoma exacto del riesgo del `CLAUDE.md` (sesión válida de Clerk
sin usuario de AutoLibre). Perseguirlo es otra pantalla — un feed sin la columna
"quién" no sirve.

### 10. Las fechas de la ficha salen en formato MÁQUINA

`DETAIL_QUERIES` arma los campos con `json_build_array` de pares
`{label, value, kind}`. El SQL declara **qué es** el valor (`date` / `datetime`
/ `text`) y el formato humano lo pone la pantalla con `formatDate` /
`formatDateTime` de `~/lib/format` — los mismos de todo el panel, con la zona
pineada en UTC. Un `to_char` con el formato final adentro de la consulta daría
una fecha que se ve distinta al resto en cuanto alguien toque uno de los dos
lados.

Y es `json`, **no `jsonb`**: `jsonb` normaliza y reordena las claves, así que el
orden de los campos de la ficha —que es el orden en que los escribe el SELECT—
se perdería. El valor va siempre `::text` porque un `Record<string, unknown>` no
compila: TanStack Start valida en tipos que lo que devuelve un server function
sea serializable (`scan-sessions.md`).

### 11. `quote_requests` puede no existir

Misma situación que `/leads/pedidos`, con el mismo guard
(`quoteRequestsAvailability`). Acá la respuesta no es una pantalla de error: es
**sacar la rama y seguir**. Un feed de quince tipos vale; un 500 con el texto de
Postgres, no.

## Por qué el listado NO es ordenable por columna

El orden cronológico ES la pregunta de la pantalla. Lo único que se invierte es
la dirección del tiempo (`activityDir`, un chip). Agrupar por usuario o por tipo
lo hacen los FILTROS, con un resultado más útil que un `order by` — y de paso no
hay un `sort`/`dir` más que pueda colisionar en el merge de `FullSearchSchema`.

Los search params van calificados (`activityKind`, `activityWindow`,
`activityDir`), nunca `kind`/`window`/`dir` pelados: `kind` ya lo usan
`/documentos` y `/notificaciones` con enums disjuntos, y eso rompe el typecheck
de la ruta AJENA. → `.claude/rules/notifications.md`.

## Adónde lleva un click, y por qué no es siempre al mismo lado

**A la pantalla que ya es dueña de esa entidad**: un chat abre `/chats/:id` con
la conversación entera, un escaneo abre `/escaneres/sesiones/:id` con su
telemetría, un documento abre su ficha de OCR, un pedido abre `/leads/pedidos/:id`,
un alta de usuario abre su expediente, un feedback abre `/feedback?userId=…`
(desde el 2026-09-23 — antes tenía ficha propia acá, ver `.claude/rules/feedback.md`).
Repetir esas pantallas adentro de `/actividad` sería el error que la premisa
del `CLAUDE.md` prohíbe: una pantalla que no reemplaza ninguna consulta.

`/actividad/:tipo/:id` existe sólo para los siete tipos que **hoy no tienen
dueño** (`ACTIVITY_DETAIL_KINDS`): vehículo, mantenimiento, plan, consulta de
multas, consulta de datos, dispositivo y login. Ahí sí reemplaza un
`select * from <tabla> where id = '…'` más los dos joins que hacen falta para
entenderlo.

**El día que exista una ficha de vehículo**, `vehiculo` sale de
`ACTIVITY_DETAIL_KINDS` y entra como `case` en `ActivityLink`. Los dos lugares
se tocan juntos y el compilador lo exige.

Como el destino cambia según el tipo, **la fila DICE adónde va**
(`ACTIVITY_TARGET_LABELS`: "Ver el chat", "Ver el escaneo", "Ver el detalle").
Un link cuyo destino hay que adivinar no se clickea.

## Ni una escritura

Todo lo que lee lo escribe el backend cuando alguien usa la app. Un evento es un
hecho que pasó, no un estado que el admin mueva — mismo criterio que
`driving_sessions`, `conversations` y `notifications`. Si aparece un
`UPDATE`/`INSERT` en `activity-feed.repo.ts`, está mal.

## `adminMiddleware`, y acá pesa como en `/usuarios`

Es el padrón entero cruzado con lo que cada persona hizo y cuándo: email,
nombre, patente, la primera línea de lo que le escribió al asistente, la ciudad y
la IP desde donde entró. Un server function es un endpoint HTTP público y el
guard de `_authed` no lo cubre. Que sea sólo lectura lo hace MÁS grave, no menos.

## Cómo verificar un cambio acá

En esta máquina: `& ".\node_modules\.bin\vite.CMD" build` (regenera
`routeTree.gen.ts` — una ruta o `Link` nuevo sólo se valida DESPUÉS del build) y
después `& ".\node_modules\.bin\tsc.CMD" --noEmit`. Más el borde server-only:

```bash
grep -rl "listActivity\|activity-feed.repo\|POSTGRES_DATABASE_URL\|sqlOne" .output/public
```

Cero resultados.

Y el SQL contra la base, con `tmp/probe.mjs`, que **carga el módulo real del
repo con vite** (resuelve el alias `~/` y compila el TS) en vez de pegar una
copia de las consultas: una prueba sobre una copia verifica la copia. Cubre el
listado, los tres filtros, las dos direcciones, el cuadre del orden y las ocho
consultas de detalle. Corrido el 2026-09-16 contra producción
(`current_user = doadmin`, puerto 25060): 500 eventos, los 16 tipos, las 8
fichas con campos.
