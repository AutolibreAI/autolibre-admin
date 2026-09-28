# Plan — pedidos sin duplicados, ficha de escaneo, comparador de escaneos, actividad sin chats vacíos

> **Estado (2026-09-25): implementado** A, B.1, B.2, C y D. B.3 descartado (nada de DigitalOcean).
> Verificado con `tmp/probe-escaneos.mjs` contra producción; las reglas vivas son `leads.md`,
> `activity-feed.md`, `chats.md`, `scan-sessions.md` y `scan-compare.md`.

Pedido del 2026-09-25. **Restricción: no se toca `autolibre-backend-hex`.** Todo lo de abajo es
lectura de Postgres desde el panel — nada de DigitalOcean (ver B.3). Ninguna migración de `ops`.

Relevado contra PRODUCCIÓN antes de escribir (`current_database = autolibre`,
`current_user = doadmin`, puerto 25060).

---

## A. Pedidos: ningún número "de medición" cuenta duplicados

### Qué hay hoy

| Superficie | ¿Resta duplicados? |
|---|---|
| Card "Pedidos totales" de `PulseRow` (Inicio y `/metricas`) | **Sí** — muestra 7 (32 − 25) |
| Serie "Pedidos" de `/metricas` (`quoteRequestSeries`) | **Sí** (`NOT_DUPLICATE_PREDICATE`) |
| `SummaryTiles` de `/leads/pedidos` (Recibidos / Contactados / Respondidos / Cerrados / Sin contactar) | **No** — "Cerrados" cuenta 28, de los cuales 25 son duplicados |
| Subtítulo de `/leads/pedidos` ("… de **32** en total") | **No** |
| Fila `pedido` de `/actividad` | **No** — los 25 aparecen como actividad |

Producción: 32 pedidos · 25 `duplicate` · 2 `cancelled_by_user` · 1 `resolved` · 4 `answered`.

### Dato de producto nuevo que hay que escribir

`close_reason_code = 'duplicate'` **también** es cómo el equipo descarta los pedidos de PRUEBA
que manda él mismo. O sea que "duplicado" en la práctica significa "no es un pedido real". Se
documenta así en `leads.md` y en el comentario de `NOT_DUPLICATE_PREDICATE`; el código no cambia
de nombre (el enum es del backend).

### Cambios

1. **`quoteRequestStatusSummary()`** (`quote-requests.repo.ts`): todos los `count` pasan a
   filtrar `NOT_DUPLICATE_PREDICATE`, y se agrega `duplicates` aparte (mismo patrón que
   `quoteRequestPulse`). `QuoteRequestStatusSummary` suma el campo.
2. **`SummaryTiles`** muestra los contadores sin duplicados; el tile "Cerrados" dice
   "N cancelados por el usuario · M duplicados/prueba excluidos". El subtítulo pasa a
   "de 7 pedidos reales (25 descartados como duplicado o prueba)".
3. **Listado**: los duplicados siguen existiendo como filas (el operador tiene que poder
   encontrarlos), pero salen del default. Nuevo search param booleano `quoteShowDuplicates`
   (calificado por dominio, default `false`) con un chip "Duplicados / prueba (25)". El
   default de hoy (`quoteStatus=open`) ya no los mostraba; el cambio importa cuando se elige
   "Todos" o "Cerrados".
4. **`/actividad`**: la rama `pedido` excluye `NOT_DUPLICATE_PREDICATE`. Un pedido de prueba
   no es "algo que hizo una persona", y es exactamente el ruido que el corte del feed existe
   para sacar. Anotarlo en la tabla de exclusiones del comentario de cabecera de
   `~/lib/activity-feed` y en `activity-feed.md`.
   - `NOT_DUPLICATE_PREDICATE` hoy no tiene alias y es privado de `quote-requests.repo.ts`.
     Se exporta como función `notDuplicate(alias)` y lo importan el feed y el repo — mismo
     criterio que `OK`/`NO_DATA` de `scanners.repo.ts`: se importa, no se recopia.
5. `/negocio` tiene un texto viejo ("todavía no está desplegado en producción") — se corrige
   de paso, sin agregar números (esa sección sigue siendo "próximamente" por el cobro).

Cuadre: Recibidos + Contactados + Respondidos + Cerrados del resumen = card "Pedidos totales" = 7.

---

## B. Ficha de un escaneo (`/escaneres/sesiones/:sessionId`)

### Qué hay hoy

La ficha **ya existe** (2026-09-13) y trae: estado, usuario, vehículo, escáner/firmware/
protocolo, duración, lecturas y chunks, batería, distancia desde borrado, VIN, DTCs con título,
anomalías con justificación, tabla de `metrics` por PID (min/max/avg/desvío/muestras),
diagnósticos de IA y chunks.

Dos problemas reales:

- **Cómo se entra**: en `/escaneres/sesiones` sólo la FECHA es link. Clickear la fila no hace
  nada, y el usuario/patente llevan a otro lado. Es el "cuando presiono uno quiero entrar".
- **Los gráficos por PID**: la ficha muestra números, no curvas.

### B.1 — Entrar desde la fila (sin bloqueos)

- Toda la fila navega a la ficha (`onClick` + `useNavigate`, cursor de mano, hover), con los
  links internos (usuario) haciendo `stopPropagation`. Se mantiene un `<Link>` real en la
  primera celda para teclado, botón del medio y "abrir en pestaña nueva" — una fila con
  `onClick` sola no es accesible.
- Mismo tratamiento en `SessionsPanel` de `/escaneres/compatibilidad` y en el panel de
  `/escaneres/detecciones`, que hoy linkean igual (sólo la fecha).

### B.2 — Ordenar la ficha y agregar lo que falta (sin bloqueos)

Reordenar por lo que se lee primero:

1. **Cabecera**: auto (modelo completo + patente), fecha, duración, estado, "N lecturas",
   distancia desde borrado de DTCs (con "no informado" cuando es `NULL`, distinto de `0 km`),
   km del auto, batería.
2. **DTCs** (ya está).
3. **PIDs**: una fila por PID con etiqueta legible y unidad — `longFuelTrim` → "LTFT (%)",
   `engineTemp` → "Temp. refrigerante (°C)", etc. Hoy se muestran las claves crudas del jsonb.
   Mapa cerrado `PID_LABELS` en `~/lib/scan-sessions` (13 claves en producción); una clave sin
   entrada se muestra cruda, nunca se esconde. Por PID: un **gráfico de rango** (min–max con
   la media marcada y ±1 desvío) — es lo que `metrics` permite dibujar sin datos crudos.
   Los "no evaluables" de `summary.notEvaluable` al lado del PID que afectan ("este auto no
   informa temperatura de aceite").
4. **Anomalías**, **diagnóstico de IA**, **identificadores técnicos y chunks** al final
   (plegado).
5. **Contexto del auto**: los otros escaneos de ESE vehículo (link a cada uno) y el último
   mantenimiento hecho antes de la fecha del escaneo.

**Lecturas dudosas.** Relevado: 2 de 49 análisis tienen LTFT/STFT = −100 constante y RPM
~8.270 con desvío ≈ 0 (una sesión de 4–12 muestras que leyó basura). La ficha lo marca en
ámbar ("valores fuera de rango físico, probablemente lectura inválida"), no lo esconde. El
criterio vive en UNA función (`implausibleMetric(pid, m)` en `~/lib/scan-sessions`) porque el
comparador (C) la reusa para excluir.

### B.3 — Gráfico en el tiempo de cada PID: **descartado el 2026-09-25**

Las lecturas crudas no están en Postgres (`driving_session_chunks.object_key` apunta a JSON en
DigitalOcean Spaces). Leerlas exigía darle al panel una credencial de Spaces. Decisión del
2026-09-25: **nada que tenga que ver con DigitalOcean.** La ficha muestra lo que hay en la base
(el resumen `metrics` por PID, dibujado como rango) y lo dice: "la curva completa del escaneo no
está en la base".

---

## C. Comparador de escaneos — nueva pestaña `/escaneres/comparar`

### La pregunta

*"¿Cuál es el LTFT normal de un Vento 2.5?"* — y en general: comparar el comportamiento de
autos iguales o parecidos que difieren en algo (con/sin DTCs, km, mantenimiento).

### Se puede contestar HOY sin datos crudos

`driving_telemetry_analysis.metrics` trae por sesión y por PID `{min, max, avg, stdDev,
sampleCount}`. Para "¿cuál es el valor normal?" alcanza con la media y el rango de cada
sesión. Relevado para Vento 2.5:

| Catálogo | Autos | Sesiones con LTFT | LTFT medio por sesión |
|---|---|---|---|
| VENTO 2.5 2007 | 2 (1 con análisis) | 7 | ≈ 19,5–20,3 % (una en −100 → basura) |
| VENTO 2.5 2015 | 1 | 3 | 4,9 · 39,6 · 52,0 % — el mismo día |

Con eso la pantalla ya dice algo útil ("el único 2007 corre siempre ~+20 %, el 2015 es
inestable") y **también dice cuán poca evidencia hay**: 3 autos. Esa segunda parte es tan
importante como la primera — mismo espíritu que `MIN_VEHICLES_FOR_CONFIDENCE` de la matriz.

### Qué es "similar" — tres niveles, sin adivinar

`vehicle_catalog_specs.engine` está vacío en la mayoría de los catálogos escaneados, así que
no sirve para agrupar por cilindrada, y parsear "2.5" del `trim` sería adivinar. Los niveles
salen de columnas que existen:

1. **Exacto** — mismo `vehicle_catalogs.id` (VENTO 2.5 2007).
2. **Misma versión, otros años** — mismo `brand + model + trim` (VENTO 2.5 2007 + 2015).
3. **Mismo modelo** — mismo `brand + model` (+ VENTO COMFORTLINE 1.4TSI 2019).

Se elige un modelo de referencia y el nivel; la pantalla muestra qué catálogos entraron.

### La pantalla

**Arriba — selección** (todo en la URL, para poder pegar el link):

- Modelo de referencia (buscador sobre catálogos con al menos un escaneo) + nivel de similitud.
- Multiselect de **vehículos** (patente + año + dueño) y, debajo, multiselect de **escaneos**
  de esos vehículos (fecha + duración + DTCs). Default: todos los autos, todos los escaneos
  con análisis. `MultiSelect` ya existe (`src/components/MultiSelect.tsx`).
- Multiselect de **PIDs** a mostrar (default: LTFT, STFT, temp. refrigerante, RPM, MAF, carga).
- "Excluir lecturas dudosas" (default sí, con el conteo de excluidas a la vista — usa
  `implausibleMetric` de B.2).

**Medio — un gráfico por PID**: cada escaneo es un punto/barra de rango (min–max, media,
±desvío), agrupado por vehículo y coloreado por una **característica elegible**:

- con DTCs / sin DTCs (en ese escaneo, de `session_dtc_snapshots`);
- tramo de km del auto (`vehicles.odometer_value` — ojo: es el km ACTUAL, no el del día del
  escaneo; se dice en pantalla. El más cercano al escaneo es `distance_since_dtc_clear_km`,
  que es otra cosa y se ofrece aparte);
- año del catálogo;
- mantenimiento: "hizo un mantenimiento en los N días previos" (de `maintenance_occurrences`
  con `performed_at`, no archivadas). Hoy sólo 19 autos tienen ocurrencias: el color va a
  ser casi todo gris, y se dice.
- transmisión / combustible (del spec, cuando está cargado).

Una línea horizontal marca la **mediana del grupo** y una banda el rango intercuartil de las
medias por sesión — eso es "el valor normal" que contesta la pregunta, calculado sobre
sesiones y también sobre autos (un auto con 7 escaneos no puede pesar 7 veces más que uno
con 1: se muestran las dos lecturas, "por escaneo" y "por auto").

**Abajo — tabla**: una fila por escaneo seleccionado con auto, fecha, DTCs, km, último
mantenimiento, y las columnas de los PIDs elegidos (media · rango). Click → la ficha de B.

### Implementación

- `src/lib/scan-compare.ts`: search schema (`compareCatalogId`, `compareLevel`,
  `compareVehicles`, `compareSessions`, `comparePids`, `compareColorBy`,
  `compareExcludeImplausible` — todos calificados), tipos, `PID_LABELS` reusado.
- `src/server/scan-compare.repo.ts`: una consulta que parte de `driving_sessions` →
  `vehicles` → spec → catálogo (LEFT al catálogo, como el resto de `/escaneres`), trae
  `metrics` recortado a los PIDs pedidos (`jsonb_build_object` sólo con esas claves, no el
  jsonb entero), `session_dtc_snapshots.codes`, y el último `maintenance_occurrences` previo
  como subconsulta escalar (no JOIN: fan-out). El corte de sesión se IMPORTA (`OK` de
  `scanners.repo.ts`).
- Estadísticas de grupo (mediana, IQR, por auto vs por escaneo) en JS, sobre las filas ya
  traídas: son decenas, y así la tabla y el gráfico salen del mismo snapshot.
- Gráfico: SVG propio, igual que `GrowthChart` (el repo no usa librería de gráficos). Un
  componente `RangeChart` reutilizable, que también usa la ficha de B.2.
- `adminMiddleware` en el server function (patentes y dueños).
- Pestaña nueva en el layout de `/escaneres` (4ª). SSR `'data-only'`: detrás de auth y con
  un componente pesado en SVG.
- Nueva rule `.claude/rules/scan-compare.md` + fila en la tabla de pantallas del `CLAUDE.md`
  ("reemplaza: la consulta que nadie arma — abrir el jsonb de `metrics` de N sesiones del
  mismo modelo y compararlas a ojo").

### Límites que la pantalla dice en voz alta

- Con 49 análisis en toda la base, casi ningún grupo tiene más de 3 autos. Debajo de
  `MIN_VEHICLES_FOR_CONFIDENCE` el "valor normal" se muestra en gris con "evidencia de N autos".
- Los números son resúmenes por sesión (media de una sesión), no la curva: dos escaneos con
  la misma media pueden comportarse distinto. Las curvas completas están en
  DigitalOcean y quedaron fuera (B.3).
- `odometer_value` no es el km del día del escaneo.

---

## D. Chats vacíos: fuera de `/actividad` Y de `/chats`

Producción: **125 de 228** conversaciones no tienen ningún mensaje. Hoy entran al feed como
`chat` con resultado "sin mensajes".

- La rama `chat` de `BRANCHES` (`activity-feed.repo.ts`) agrega
  `where exists (select 1 from conversation_messages m where m.conversation_id = c.id)` y
  pierde el `outcome = 'sin_mensajes'` (queda sin resultado).
- Es una **decisión que revierte lo documentado**: `activity-feed.repo.ts` y `chats.md` dicen
  "se muestra, no se esconde". Decidido el 2026-09-25: *abrir el asistente sin escribir no es
  algo que la persona hizo, es ruido* — sale del feed y **también del listado de `/chats`**.
  El número no se pierde: `/metricas` (adopción del chat) y la ficha de usuario siguen
  contando conversaciones con mensaje, y `/chats` dice cuántas vacías se excluyeron.
  Se actualizan el comentario de cabecera de `~/lib/activity-feed`, `activity-feed.md` y
  `chats.md`.
- Mismo predicado que ya usan `usageAdoption` (`/metricas`) y el armador de audiencias para
  "usó el chat": conversación con al menos un mensaje.

---

## Orden de ejecución

| Fase | Qué | Depende de |
|---|---|---|
| 1 | **D** — actividad sin chats vacíos | nada (chico) |
| 2 | **A** — pedidos sin duplicados en resumen, listado y feed | nada |
| 3 | **B.1 + B.2** — fila clickeable, ficha reordenada, PIDs con etiqueta y `RangeChart` | nada |
| 4 | **C** — `/escaneres/comparar` | `RangeChart` y `implausibleMetric` de la fase 3 |

Verificación por fase: `vite build` + `tsc --noEmit`, el chequeo de borde server-only
(`grep` de los nombres nuevos en `.output/public`), y los cuadres contra producción:

- A: suma de tiles del resumen = card "Pedidos totales" (7 al relevar).
- D: `count(*)` de la rama `chat` del feed = conversaciones con ≥1 mensaje (103 al relevar).
- C: para el nivel "misma versión" de VENTO 2.5, 3 autos / 10 sesiones con LTFT (9 sin la
  dudosa) — lo mismo que da el SQL a mano de este plan.

## Decisiones que quedan abiertas

1. ~~B.3~~ — descartado (nada de DigitalOcean).
2. **A.4**: ¿los pedidos duplicados/prueba salen del feed de actividad? El plan dice que sí;
   si un duplicado real (doble submit de una persona) debería verse, la alternativa es
   dejarlos con un tag "duplicado" en vez de sacarlos.
