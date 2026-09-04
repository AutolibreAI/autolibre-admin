# Chats de IA (`/chats`, `/chats/:id`)

Alcance: `src/lib/chats.ts`, `src/server/chats.repo.ts`, `src/fn/chats.ts`,
`src/routes/_authed/chats.index.tsx`, `src/routes/_authed/chats.$conversationId.tsx`.

## Dos columnas que no son columnas

`conversations` no tiene `type` ni `title`. Las dos se derivan, y el derivado es
verificable — no es una lectura libre:

- **`type`** sale de `vehicle_id`: no nulo es `diagnostico`, nulo es `general`.
  Es literalmente cómo se definió el pedido ("si son de diagnóstico… con qué
  vehículo asociado"), así que no hace falta un enum nuevo ni una columna
  nueva — la que ya existe alcanza con el nombre correcto.
- **`title`** es el CONTENIDO del primer mensaje del usuario, sin truncar (la
  UI trunca). Verificado contra la base: de las 22 conversaciones con algún
  mensaje, las 22 arrancan con `author = 'user'` — nunca con la IA. Por eso
  `firstUserMessage()` en `~/lib/chats` busca por autor y no toma
  `messages[0]` a ciegas: el invariante es real hoy, pero buscar por autor no
  depende de que se siga cumpliendo.

**48 de las 70 conversaciones de la base no tienen NINGÚN mensaje.** No es un
caso de borde, es la mayoría. El listado y el detalle lo muestran como
`"sin mensajes"`, con estilo apagado — no lo esconden y no lo tratan como
error. Ver también `conv-sin-mensajes` en `deriveUserFlags()` de
`~/lib/users`, que ya señalaba esto mismo desde la ficha de usuario.

## El modelo es por MENSAJE, no por conversación — pero en la práctica coincide

`conversation_messages.model` está en cada mensaje, siempre `null` para
`author = 'user'` y siempre cargado para `author = 'ai'` (verificado: 61/61 y
0/61). Ninguna conversación de la base usó más de un modelo distinto.

El listado toma el de la respuesta MÁS RECIENTE (`order by sent_at desc limit
1`), no cualquiera — es la lectura que sigue siendo correcta el día que una
conversación larga cruce una migración de modelo: "con qué está respondiendo
ahora", no "con qué empezó".

**El filtro de modelo es texto libre, no un enum.** Hoy sólo existe
`claude-haiku-4-5-20251001` en la base, pero hardcodear ese valor sería el
mismo error que `scanner_type`/firmware ya tiene resuelto en
`scanners.repo.ts`: el modelo no es vocabulario nuestro, es lo que el
proveedor de IA use. `listDistinctChatModels()` arma las opciones del chip
con `select distinct model … where model is not null`, así que un modelo
nuevo aparece solo.

## `q` va en el WHERE de AFUERA, y es la excepción al patrón de `users.repo.ts`

`listUsers` mete el filtro de texto en el `where` INTERNO porque busca sobre
columnas crudas de `users` (`email`, `name`). Acá `q` busca sobre `title` y
`vehicle_plate`, que no son columnas de `conversations` — son subconsultas y
un join que sólo existen como alias DESPUÉS de que corre el SELECT interno.
Por eso el envoltorio `select * from (...) s` sigue existiendo (mismo motivo
que en `users.repo.ts`: no repetir cada subconsulta en el filtro), pero acá
**todos** los filtros —`q` incluido— van en el `where` de afuera, no sólo los
que dependen de un conteo.

## El join al vehículo es LEFT en las tres patas, no sólo en la primera

```sql
left join vehicles v on v.id = c.vehicle_id
left join vehicle_catalog_specs vcs on vcs.id = v.vehicle_catalog_spec_id
left join vehicle_catalogs vc on vc.id = vcs.vehicle_catalog_id
```

`c.vehicle_id` es nullable — un chat general no tiene auto — así que la
primera pata ya puede no matchear. Un `join` (no `left`) en la segunda o
tercera pata haría desaparecer del listado a cualquier chat SIN vehículo,
en vez de mostrarlo con las columnas de auto vacías. Es lo opuesto del `join`
que `findUserDetail` usa para el catálogo de un vehículo QUE YA EXISTE (ahí
`vehicle_catalog_spec_id` es NOT NULL, así que un `left join` escondería una
corrupción de datos) — acá el vehículo entero es opcional, no el spec de uno
que ya está.

## Es tan sensible como el padrón, y `adminMiddleware` pesa lo mismo

El contenido de un chat es lo que la persona le escribió al asistente tal
cual — a veces más sensible que el padrón de `/usuarios`, porque puede incluir
detalles del auto, de un choque, de una reparación, escritos en primera
persona. `listAppChats`, `listAppChatModels` y `getAppChat` pasan los tres por
`adminMiddleware`, mismo criterio que `users.ts`: un server function es un
endpoint HTTP público, y sin el guard cualquier sesión válida de la app se
baja cualquier chat de cualquiera con sólo saber el uuid.

## Ni una escritura

`conversations`/`conversation_messages` los escribe el backend cuando el
usuario habla con el asistente. Un chat es un hecho que pasó, no un estado que
el admin mueva — mismo criterio que `driving_sessions` en
`scanner-compatibility.md`. Si aparece un `UPDATE`/`INSERT` acá, está mal.
