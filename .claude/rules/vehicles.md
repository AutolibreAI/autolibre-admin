# Vehículos (`/vehiculos`, `/vehiculos/:id`)

Alcance: `src/lib/vehicles.ts`, `src/server/vehicles.repo.ts`, `src/fn/vehicles.ts`,
`src/routes/_authed/vehiculos.index.tsx`, `src/routes/_authed/vehiculos.$vehicleId.tsx`.

## Qué reemplaza

No una única consulta de DBeaver: reemplaza la docena de `select` sueltos por
`vehicle_id` que hoy hacen falta para contestar "¿qué tan sano está este
auto?" — contra `driving_sessions`, `conversations`,
`maintenance_occurrences`, `notifications`, `fines`, `insurances`,
`vehicle_inspections`, `registration_cards` y `diagnostic_dtcs`. Es el mismo
argumento que `/usuarios`, invertido: ahí el vehículo es una columna del
usuario; acá el usuario es una columna del vehículo.

`/usuarios` y `/usuarios/:userId` ya tienen su propia noción de "vehículo"
(`UserVehicle`, `UserVehicleSummary`) — **no se reusan los tipos**. Son
recortes distintos con foco distinto (trámites del auto vs. salud del auto),
y esta pantalla es más profunda que las dos combinadas: tiene el censo
completo, el historial de DTC con descripción, y las listas enteras (no sólo
contadores) de escaneos, chats, tareas, alertas, multas y deudas.

## `join`, no `left join`, contra el catálogo — mismo criterio que `findUserDetail`

`vehicles.repo.ts` arranca DESDE `vehicles`, igual que la subconsulta de
vehículos en `findUserDetail` (`users.repo.ts`), y usa el mismo
`join vehicle_catalog_specs … join vehicle_catalogs …` (los dos INNER, no
LEFT). Es el mismo caso, no una regla nueva: las dos FK son NOT NULL desde
`vehicles`, así que un vehículo sin spec o sin catálogo no es representable,
y un `left join` acá escondería una corrupción de datos detrás de celdas
vacías en vez de dejarla notarse.

Esto es DISTINTO del `left join` que usan `scanners.repo.ts` y
`chats.repo.ts`: esos arrancan desde `driving_sessions`/`conversations`,
donde `vehicle_id` es NULLABLE — ahí el LEFT existe para no hacer
desaparecer filas sin auto. Acá no hay ese problema: `vehicles.id` siempre
existe porque es la tabla de partida.

## DTCs "activos" e "inactivos" — verificado, no inventado

"Activos" son los códigos del snapshot del ÚLTIMO escaneo
(`vehicle_last_dtc_scans` → `session_dtc_snapshots`), igual que
`activeDtcCount` en `UserVehicleSummary`. "Inactivos" es la pieza NUEVA de
esta pantalla: códigos que aparecieron alguna vez en `diagnostic_dtcs` y NO
están en ese snapshot más reciente — es decir, se dejaron de ver en algún
momento entre medio.

No es una hipótesis: verificado contra producción el 2026-09-04, el vehículo
`24345106-3dc5-4718-9392-1aa846393e1a` tiene `P0171` en su historial de
`diagnostic_dtcs` y el snapshot de su escaneo más reciente viene vacío. Ese
es el caso real que separa las dos columnas — sin él, "inactivos" sería una
idea razonable sin evidencia.

**Sin escaneo, todo el historial cae del lado "inactivo".** El
`coalesce(snap.codes, array[]::text[])` en el `where` de la subconsulta hace
que esto funcione solo: si `vehicle_last_dtc_scans` no tiene fila para el
vehículo, el conjunto "activo" está vacío y cualquier código histórico
queda del lado de "inactivo" — no hay snapshot contra el cual llamarlo
"activo".

`activeDtcCodes` es `null` cuando el vehículo nunca tuvo un escaneo de DTC
(no hay fila en `vehicle_last_dtc_scans`) y `Array<string>` (posiblemente
vacío) en cualquier otro caso — mismo contrato que `activeDtcCount` en
`UserVehicleSummary`. `inactiveDtcCodes` NUNCA es `null`: es una diferencia
de conjuntos pura, y "ninguno" (`[]`) es una respuesta completa incluso sin
haber escaneado nunca.

## "Alertas activas" es una lectura nuestra, escrita como tal

`notifications` no tiene un estado "activa". `notification_status` es
`pending | sent | read` (verificado contra el enum real de la base) — ni uno
de los tres significa "requiere atención" en el dominio. "Activa" acá es
`status <> 'read'`: la notificación todavía no se leyó, sea que esté en cola
o ya se haya entregado. Mismo tipo de decisión que `stuck` en `/operacion` y
`noData` en `/escaneres`: útil, pero es LECTURA del panel, no una columna
del backend.

## "Tareas pasadas" y "futuras" — el mismo corte que ya usa `UserVehicleSummary`

`maintenance_occurrences.performed_at is not null` = pasada;
`performed_at is null` = futura. Es el mismo predicado que
`pastTasksCount`/`pendingTasksCount` en `users.repo.ts`, sólo que acá
"futuras" es el nombre que pidió el usuario del panel para lo que en
`/usuarios` se llama "pendientes" — son el mismo concepto, dos nombres en
dos pantallas.

## Documentos: seguro, VTV y cédula van EN la fila del vehículo, no en listas aparte

A diferencia de `findUserDetail` (que trae varias filas de `insurances` por
usuario porque un usuario tiene varios autos), acá un vehículo tiene como
mucho un seguro y una VTV vigentes a la vez en la práctica — se toma el más
reciente no archivado (`order by archived asc, created_at desc limit 1`),
igual que en `UserVehicle`. Esto es lo que permite resolverlos como
subconsultas escalares DENTRO de la consulta principal del detalle en vez de
como tres queries de lista aparte — ver el comentario en `findVehicleRow`.

`registration_cards` no tiene `archived`: se toma la más reciente por
`created_at`, sin ese `order by` extra.

## Las 23 columnas del listado ordenan Y filtran, sin excepción

Pedido explícito del 2026-09-04, después de la primera versión (recorte de
sort a 8 columnas, filtros a 5 chips booleanos). `VEHICLE_SORT_KEYS` en
`~/lib/vehicles` tiene una entrada por columna visible — si se agrega una
columna nueva a la tabla, ésa es la primera lista que hay que tocar, o queda
una columna que no ordena y nadie lo nota hasta que alguien la necesita.

**El filtro no es siempre un chip.** El control sigue al TIPO de dato:

| Tipo de columna | Control | Ejemplo |
|---|---|---|
| Identidad (texto libre) | `q` de siempre — nunca un control propio | patente, alias, dueño, versión |
| Categórica, de cardinalidad chica | dropdown con valores que SALEN DE LOS DATOS | Marca, Modelo — `listDistinctVehicleBrands/Models`, mismo criterio que `listDistinctChatModels` |
| Numérica o fecha continua | rango `xMin`/`xMax` o `xFrom`/`xTo`, dos parámetros independientes | Año, Alta, Kilometraje, Tiempo escaneado, Km s/ borrado |
| Presencia/ausencia | chip booleano | Alertas, DTCs activos, DTCs inactivos |
| Estado con pocos valores | chips de un enum cerrado | Escaneos, Seguro, VTV, Cédula, Multas |

`Versión` (trim) es la excepción a "categórica → dropdown": el texto es
bastante libre (`"1.8 M/T"`, `"XEI CVT"`) como para que un dropdown exacto
sea más ruido que ayuda, así que se sumó a `q` en vez de tener control propio
— sigue siendo ordenable, sólo que se filtra por texto.

**Simplificación deliberada en Seguro/VTV**: `document_status` tiene tres
valores (`active | expired | pending_renewal`) y el filtro sólo expone dos
más "no cargado" — `expired` agrupa los dos estados no-vigentes. Un operador
buscando "qué autos tienen el papel vencido" no necesita distinguir "vencido"
de "a renovar": las dos requieren la misma acción (avisarle al dueño).

**Simplificación deliberada en Multas**: el filtro es de tres estados
(`pending`/`none`/`all`), no cuatro. Un auto puede tener multas sin ninguna
pendiente (todas pagadas o apeladas) y ese caso no tiene chip propio — no es
la pregunta que un operador hace ("¿debe algo?" / "¿nunca tuvo?"), y agregar
un cuarto botón por completitud sería una opción que nadie clickea.

**`array_length` de un array VACÍO es `NULL` en Postgres, no `0`.** Los dos
filtros de DTC (`onlyWithActiveDtc`/`onlyWithInactiveDtc`) y los dos `ORDER
BY` que ordenan por cantidad de DTC llevan `coalesce(array_length(…, 1), 0)`
por esto — sin el `coalesce`, un vehículo escaneado y limpio (`array {}`, no
`NULL`) desaparecería de "con 0 activos" en el `ORDER BY` y el filtro
"con activos" seguiría funcionando por casualidad (0 nunca es `> 0`), pero el
sort se rompería en silencio.

**En los inputs de rango, `''` (vacío) es "sin tope", nunca `0`.** Un campo
numérico vacío que se leyera como cero excluiría todo lo que tenga menos de
cero — o sea nada — así que el filtro "funcionaría" a simple vista y estaría
mal: `RangeFilter` en `~/components/Filters.tsx` y `toIntParam`/`toDateParam`
en la ruta convierten `''` a `undefined` explícitamente antes de tocar el
search param.

**Filtros "rápidos" arriba, el resto colapsado.** Con 23 columnas, exponer
todos los controles sueltos habría vuelto la pantalla ilegible antes de leer
una sola fila. Los seis de uso diario (buscar, estado, escaneos, alertas,
multas, actividad) quedan sueltos; el resto vive en un `<details>` nativo
("Más filtros") — no hay componente de acordeón en este repo y uno nuevo no
hacía falta sólo para esto.

## Ocho consultas en paralelo, como `findUserDetail`

La fila base (vehículo + catálogo + dueño + documentos) gatea el 404 y corre
sola; después van en `Promise.all`: censo, historial de DTC, escaneos, chats,
tareas, alertas, multas, deudas de patente. Son ocho — misma escala que las
ocho de `findUserDetail` sobre el mismo pool (`max: 5`). Ojo antes de agregar
una novena.

## El censo son 21 relaciones, no 19

19 tablas tienen `vehicle_id` directo. Dos son de segundo nivel —
`driving_session_chunks` (por las sesiones del vehículo) y
`conversation_messages` (por sus conversaciones) — mismo motivo que las
`sus sesiones`/`sus conversaciones` de `CENSUS_ENTRIES` en `~/lib/users`.
`VEHICLE_CENSUS_ENTRIES` es la única fuente de verdad, mismo patrón que ese
archivo.

## Multas y deudas de patente muestran monto, pero no se supone que decidan nada

`fines.amount` y `vehicle_tax_debts.amount` son `numeric`, y `pg` los
devuelve como STRING — se pasan por `Number(...)` al mapear, nunca se suman
en SQL sin castear. La pantalla los MUESTRA; no hay ningún flujo de pago ni
de disputa acá — eso es dominio del backend (`vehicle-management/Fine`) y no
tiene ningún camino de escritura desde este panel.

## Ni una escritura

Igual que `/usuarios` y `/chats`: todo lo que se lee acá lo escribe el
backend cuando la app o sus jobs corren. Un escaneo, un chat, una multa
sincronizada, una notificación generada — son hechos que pasaron, no un
estado que el admin mueva. Si aparece un `UPDATE`/`INSERT` en
`vehicles.repo.ts`, está mal.

Antes de agregar la primera escritura (por ejemplo, "marcar una tarea como
hecha" o "descartar una alerta"), leer `.claude/rules/ops-write-actions.md`:
un stored procedure de `ops` con sus 8 guardrails y auditoría en
`ops.action_log`, sólo si se verifica primero que el backend realmente no
tiene el camino — la excepción se gana con un `grep`, no se asume.

## Cómo se verificó

Contra producción (`doadmin@…ondigitalocean.com`, 2026-09-04, sólo lectura):
90 vehículos, 9 con algún escaneo de DTC. El caso de "DTC inactivo" de arriba
y el chequeo de `activeDtcCodes`/`inactiveDtcCodes` salen de esa misma
sesión, cruzando `vehicle_last_dtc_scans` + `session_dtc_snapshots` +
`diagnostic_dtcs` fila por fila para los 9 vehículos con algún escaneo.
