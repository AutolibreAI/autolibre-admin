# Usuarios (`/usuarios`, `/usuarios/:id`)

Alcance: `src/lib/users.ts`, `src/server/users.repo.ts`, `src/fn/users.ts`,
`src/routes/_authed/usuarios.index.tsx`, `src/routes/_authed/usuarios.$userId.tsx`.

## La consulta que reemplaza es la que NO se corría

Las otras pantallas del panel reemplazan un SQL que alguien pegaba en DBeaver. Ésta reemplaza uno
que en la práctica **nadie corría**: para saber qué tiene un usuario hacían falta ~29 `select`
sueltos con el uuid pegado en cada uno, así que se miraban `vehicles` y capaz `conversations`, y el
resto no se auditaba nunca.

Eso define el layout y hay que respetarlo: **el censo va ARRIBA, antes de cualquier detalle, y
muestra las 29 relaciones incluso en cero.** Es lo OPUESTO a la regla de Inicio, donde una fila en
cero se esconde — y es a propósito. Inicio es una lista de pendientes y seis renglones diciendo "0"
entrenan a no leerla. Acá el cero ES el síntoma que se vino a buscar: "no le llegan las
notificaciones" se diagnostica viendo `expo_push_tokens = 0`, no viendo la tarjeta desaparecer.

## Por qué el censo es de 29 y no de 42

`users` tiene 24 FKs entrantes y `vehicles` otras 18. La suma tienta y está mal: **15 de las 18 de
`vehicles` también cuelgan de `users` por `user_id`** (`fines`, `insurances`, `notifications`,
`leads`, `registration_cards`, …). Contarlas por los dos caminos las duplica en pantalla sin agregar
una sola fila real.

Alcanzables SÓLO por el vehículo hay tres, y son justo las que un `\d users` no muestra:

| Tabla | Se llega por |
|---|---|
| `driving_telemetry_analysis` | `vehicle_id` |
| `vehicle_fine_syncs` | `vehicle_id` |
| `vehicle_last_dtc_scans` | `vehicle_id` |

Más dos de tercer nivel: `conversation_messages` (por sus conversaciones) y `driving_session_chunks`
(por sus sesiones). Total: **24 + 3 + 2 = 29**.

`CENSUS_ENTRIES` en `~/lib/users` es la única definición: el SQL, los títulos y los grupos salen de
ahí. Agregar una relación es una línea, no tres lugares que se desincronizan.

## Las trampas confirmadas

### 1. `partner_applications.reviewed_by_id` NO es "algo que el usuario tiene"

Es algo que HIZO, como staff, sobre solicitudes de terceros. Por eso vive en su propio grupo
(`Como staff`) y no entre sus datos. Mezclarlo haría leer las solicitudes de talleres ajenos como si
fueran del usuario que se está inspeccionando.

### 2. `vehicle_count` y `last_activity_at` son subconsultas escalares, no JOINs

Un `left join vehicles` + `count(*)` obliga a un `group by` sobre las nueve columnas de `users`, y en
cuanto se agrega la segunda métrica el conteo de la primera se multiplica. **El fan-out no avisa: da
un número más grande, no un error.**

### 3. `last_activity_at` es derivado, y su `null` significa algo

`users` NO tiene `last_seen_at`. Inventar la columna sería inventar dominio (regla dura 8);
derivarla del `greatest()` entre el vehículo más nuevo, la última conversación y la última sesión de
manejo, no. **`null` es "se registró y no hizo nada más"**, que no es lo mismo que "hace mucho" —
13 de 72 usuarios estaban así al relevarlo. La UI los distingue con texto, no con una fecha vieja.

### 4. El censo va en UNA sentencia

Las 29 subconsultas comparten el snapshot de Postgres. Con 29 consultas separadas, una fila insertada
en el medio del barrido aparece en un contador y no en otro, y el operador ve un expediente que nunca
existió. Mismo argumento que el `UNION ALL` de las colas en `ops.repo.ts`.

### 5. `mapCensus` se escribe explícito, campo por campo

Un `Object.entries` que transforme `snake_case` → `camelCase` compila igual el día que alguien
renombre una columna del SELECT, y devuelve `undefined` en silencio. **En un censo eso se ve como un
cero, o sea como "el usuario no tiene nada"** — la mentira más cara que puede decir esta pantalla.

### 6. `join` y no `left join` contra el catálogo de vehículos

`vehicles.vehicle_catalog_spec_id` es NOT NULL con FK, así que un vehículo sin spec no es
representable. Un `left join` escondería una corrupción de datos detrás de celdas vacías.

### 7. El token push NO se muestra

`expo_push_tokens.token` es una **credencial de envío**: con ella se le puede mandar un push a esa
persona desde afuera de AutoLibre. La plataforma, el prefijo del `device_id` y la fecha alcanzan para
el diagnóstico y no comprometen a nadie.

### 8. `adminMiddleware` en las lecturas, y acá pesa más que en ninguna otra pantalla

Un server function es un endpoint HTTP público: cualquiera con una sesión válida de la app mobile lo
llama con `fetch`, y el guard de `_authed` no lo cubre porque sólo modela lo que la UI ofrece. Esto
devuelve email, teléfono, patentes, número de licencia y domicilio de personas reales. **Que sea solo
lectura lo hace MÁS grave, no menos**: sin esa línea, cualquier usuario logueado se baja el padrón.

### 9. El listado corta en 500 y no pagina

A propósito. Paginar sin buscar es hojear un padrón y nadie encuentra a nadie así. Si el corte
molesta, el arreglo es mejorar la búsqueda, no agregar páginas.

## Escrituras: ninguna, y así se decidió

La pantalla es **solo lectura entera**. Antes de agregar el primer botón que escriba, leer
`.claude/rules/ops-write-actions.md` — un stored procedure de `ops` con sus 8 guardrails, auditoría
en `ops.action_log` y su suite de tests.

Dos advertencias concretas sobre lo que va a tentar primero:

- **Cambiar el rol.** Es la escritura más peligrosa del sistema: quien la tiene se da acceso al panel
  a sí mismo, y `users` no tiene ninguna columna que diga quién lo cambió. Sin `ops.action_log` no
  hay auditoría, y sin auditoría esto no va.
- **Borrar un usuario.** 24 FKs apuntan a `users`. Un `DELETE` sin relevar el `ON DELETE` de cada una
  es una bomba — y ese relevamiento todavía no se hizo.

## El riesgo de los admins `native`, ahora con pantalla

El CLAUDE.md documenta el riesgo de los admins heredados con `auth_provider = 'native'`. El listado
lo **calcula** contra la base a la que el panel esté conectado y lo muestra como banner, con filtro
propio (`?onlyLegacyNative=true`). Regla general del repo: si un número de la base aparece en un
`.md`, es porque todavía no tiene pantalla. Éste ya la tiene.

Ese filtro **no es un chequeo de acceso** — el lookup de sesión ya está acotado a `clerk` y un native
nunca matchea una identidad de Clerk.

**Qué es ese filtro, corregido el 2026-09-04.** Decía "auditarlos por si heredan el rol". Ese
mecanismo no existe: `users` tiene `idx_users_email_unique` y
`idx_users_external_identity_unique`, y los dos caminos de provisioning del backend rechazan en vez
de migrar (`HandleIdentityWebhookHandler.provision()` loguea y retorna; `AuthenticateUserHandler
.provision()` tira CONFLICT). Ninguno escribe `auth_provider`, `external_auth_id` ni `role`. La
herencia automática de admin **no puede pasar** — sólo un `UPDATE` manual y deliberado.

Lo que ese filtro lista de verdad es el problema opuesto y de cara al usuario: **los emails cuyo
registro por Clerk va a fallar en silencio.** Quien tiene una fila `native` se registra en Clerk, el
provisioning encuentra el email tomado, no crea nada, y la persona queda con sesión de Clerk y sin
usuario de AutoLibre. La única evidencia por el camino del webhook es un `logger.warn`.

El detalle completo, con la tabla de los dos caminos, está en el `CLAUDE.md`.

---

## La columna «Escaneos» del listado, y por qué son DOS números

`scansOk / scansTotal`: las sesiones del escáner OBD que trajeron datos, sobre los intentos.

Mostrar sólo el total sería repetir el error que `/escaneres` existe para no cometer. Al 2026-09-04,
de las 17 sesiones de la base **6 quedaron marcadas como `completed` con cero lecturas y cero minutos
de duración**: el escáner nunca enganchó. Son fracasos guardados como éxitos.

Y no es un caso de borde. Con los datos reales de producción, los dos usuarios más activos tienen
**4 de 8** y **2 de 4**: la mitad de sus intentos no trajo nada. Sin el denominador, la lista diría
"8 escaneos" y "4 escaneos" — y el usuario que llama a soporte porque el escáner no le anda
aparecería como el que más lo usa.

Cuando ninguno sirvió se pinta **ámbar y no rojo**: el problema puede ser el escáner del usuario y no
la app, y esta pantalla no sabe cuál de los dos. Un guión gris significa que nunca lo usó, que es
distinto de que le haya fallado.

---

## Las columnas de multas del desplegable, y el `null` vs `$0`

En el toggle de vehículos de `/usuarios` (`listUserVehicleSummaries`), dos columnas contestan sobre
la última consulta de multas:

- **«Multas consultadas»** — la fecha, de `vehicle_fine_syncs.last_synced_at`. Es 1:1 por vehículo
  (PK `vehicle_id`), así que entra por `LEFT JOIN` y no por subconsulta escalar — misma excepción que
  `lds` y `dta`, y por la misma razón: no puede fan-outear.
- **«Monto adeudado»** — `sum(fines.amount)` con `status = 'pending'`. `paid` está saldada,
  `appealed` en disputa: ninguna es deuda a cobrar. Al 2026-09-06 las 240 multas de producción están
  todas en `pending`, así que el filtro hoy no descuenta nada — pero el día que alguien marque una
  pagada, la columna tiene que bajar.

**El gate por `vfs.vehicle_id IS NULL` no es opcional.** Distingue tres estados que NO son lo mismo,
igual que `activeDtcCount`:

| Estado | `fineQueryAt` | `fineDebtAmount` | Se ve |
|---|---|---|---|
| Nunca se consultaron las multas de este auto | `null` | `null` | "nunca" · "—" gris |
| Se consultaron y no hay nada adeudado | fecha | `0` | fecha · `$0` en texto plano |
| Se consultaron y hay deuda | fecha | `> 0` | fecha · monto en **ámbar** |

Sin el gate, `sum()` de cero filas devuelve `NULL` y "consultado sin deuda" se volvería
indistinguible de "nunca consultado". El `$0` **no se pinta de verde**: "no debe nada hoy" es un
dato, no un logro del panel — mismo criterio que las filas en cero de `/operacion`.

Hoy el gate es exacto porque **toda multa de la base tiene su fila en `vehicle_fine_syncs`** (las 240
son `source = 'provider'`). Si aparecieran multas manuales sin sync, el monto de ese auto seguiría
saliendo `null` a propósito: la columna es "según la última consulta", y una carga manual no es una
consulta.

`formatArs` (`~/lib/format`) es el formateador de pesos, transversal — no confundir con `formatUsd`
de `~/lib/ai-usage`, que es dato del contexto de Costos de IA (al proveedor se le paga en dólares).

### ⚠ El predicado está en DOS lugares y se tocan juntos

```sql
status = 'completed' AND coalesce(total_readings, 0) > 0
```

Vive en `users.repo.ts` (esta columna) y en `scanners.repo.ts` (la constante `OK`). **Si divergen, el
panel dice dos verdades distintas sobre la misma palabra** — un usuario con "3 escaneos" acá y una
fila que suma 5 en Escáneres, sin ningún error que lo delate. Es la misma clase de acoplamiento que
`INTERNAL_PREDICATE` entre `ops.repo.ts` y la vista `ops.v_ai_usage`.

La explicación completa de por qué el corte es ése —y por qué va sobre `total_readings` y no sobre
`scanner_firmware`— está en `.claude/rules/scanner-compatibility.md`. No se duplica acá.

## Las tarjetas del pulso de Inicio llevan a su pantalla

Las cuatro: Usuarios → `/usuarios`, Partners → `/partners/listado`, Leads → `/leads/talleres`,
Vehículos → `/vehiculos/listado`.

> Hasta el 2026-09-08 Vehículos **no linkeaba a nada**, a propósito: no había listado propio de
> autos, sólo la vista dentro de la ficha del dueño. Ahora existe `/vehiculos/listado` (el padrón
> entero, transversal), así que la tarjeta lleva ahí. La regla que sale de esto NO cambió: `to`
> sigue siendo opcional en `PulseTile` y una tarjeta sin pantalla detrás no debe fingir que la
> tiene — sin `to` no recibe ni cursor de mano ni hover.

Las que sí son link llevan anillo de foco. No es cosmético: pasan a ser destinos de tabulación, y un
foco invisible deja a quien navega con teclado sin saber dónde está parado.
