# Plan — Métricas con evolución temporal (altas con vehículo + pedidos)

> **Todos los números de este archivo salieron de PRODUCCIÓN** el 2026-09-23:
> `POSTGRES_DATABASE_URL` apunta al pooler de DigitalOcean (`:25061/autolibre-pool`)
> y la verificación dio `current_database = autolibre`, `current_user = doadmin`,
> `inet_server_port() = 25060`. Sólo lectura.
>
> **Nada de esto está implementado.** Es el plan; el estado se actualiza acá
> hasta que cada serie tenga pantalla, y entonces el número se borra del `.md`.

| # | Métrica | Fuente | ¿Se puede hoy? |
|---|---|---|---|
| 1 | Altas con vehículo en el mismo proceso, absoluto y % | `users` + `vehicles` | sí |
| 2a | Pedidos recibidos por período | `quote_requests` | sí |
| 2b | Propuestas conseguidas por pedido | `ops.quote_request_response` | sí, desde el 2026-09-22 |
| 2c | Cuánto tardamos en mandar las propuestas | `quote_requests.answered_at` | **aproximado**: ver abajo |
| 2d | Propuestas de la red vs de afuera | `ops.quote_request_response` | sí |

Las cinco con **evolución temporal**, con el mismo selector de unidad
(día / semana / mes / año) que ya tiene la sección Crecimiento de `/metricas`.

---

## Dónde van: `/metricas`, no una pantalla nueva

`/metricas` ya es la lectura transversal del panel y ya tiene lo que hace falta:
la sección **Crecimiento**, el search param `unit` (`GROWTH_UNITS`), el helper
`growthSeries()` en `ops.repo.ts` (rellena períodos vacíos con 0 vía
`generate_series`) y `GrowthChart`. Una pantalla nueva duplicaría el selector
de unidad y el chart.

- **Métrica 1** → dentro de **Crecimiento**, al lado de Usuarios y Vehículos.
- **Métricas 2a–2d** → sección nueva **Pedidos**, debajo de Crecimiento, con el
  mismo `unit`.

Sin search params nuevos: todo cuelga de `unit`, que ya existe. No hay
colisión posible en `FullSearchSchema` (`notifications.md`).

---

## 1. Altas con vehículo en el mismo proceso

### Relevamiento

Usuarios reales (sin `INTERNAL_PREDICATE`): **198**. Con algún auto: **143**.
Distancia entre `users.created_at` y el `min(vehicles.created_at)` del usuario:

| Ventana | Usuarios |
|---|---|
| ≤ 5 min | 113 |
| ≤ 10 min | 119 |
| ≤ 30 min | 124 |
| ≤ 1 h | 127 |
| ≤ 1 día | 135 |

Mediana: **1,5 min**. Ningún auto anterior al usuario. Después de los 10 min la
curva se aplana: es un corte natural, no uno elegido para que el número quede
lindo.

### Definición

- **Alta con vehículo** = usuario real cuyo primer vehículo tiene
  `created_at - u.created_at <= 10 min`.
- Constante `ONBOARDING_VEHICLE_WINDOW_MIN = 10` en `~/lib/ops`, y la pantalla
  la dice ("auto cargado en los primeros 10 min"). Entra por parámetro
  (`make_interval(mins => $n)`), no interpolada (`ops-metrics.md`, trampa 7).
- **El período es el del alta del usuario**, no el del auto.
- **Denominador** = altas brutas de ese período (la misma serie `users` que ya
  se grafica). `%` = con vehículo / brutas, calculado en JS.
- El primer auto cuenta **aunque después se haya archivado** — mismo criterio
  que `adoptionSeries` (fue un registro real en su momento).
- `min(v.created_at)` por subconsulta escalar, no `JOIN` + `group by` (fan-out,
  `users.md` trampa 2).

### Implementación

- `onboardingSeries(unit)` en `ops.repo.ts` (ahí vive `INTERNAL_PREDICATE`, que
  no se exporta). Una sentencia que devuelve por bucket `signups` y
  `withVehicle`, con el mismo relleno de `generate_series` que `growthSeries`.
- `getOnboardingSeries` en `fn/ops.ts`, con `adminMiddleware`.
- Se suma al `Promise.all` del loader de `metricas.tsx`.

---

## 2. Pedidos

### Relevamiento

`quote_requests`: **27 filas, 21 cerradas con `close_reason_code = 'duplicate'`**
→ 6 pedidos reales, del 2026-09-15 al 2026-09-22. 0 cargados a mano.

`ops.quote_request_response` (migración 015) **ya existe en producción**: 8
filas, todas del 2026-09-22/23. 4 con `partner_id` (red), 4 con
`provider_name` (afuera), 5 con precio.

### Universo común de las cuatro series

- **Se excluyen los duplicados**: `close_reason_code is distinct from 'duplicate'`.
  Mismo corte que la card "Pedidos totales" de `PulseRow` (`leads.md`); si
  divergen, Inicio y Métricas cuentan distinto el mismo pedido. El predicado va
  en una constante compartida en `quote-requests.repo.ts`, usada por
  `quoteRequestPulse()` y por la serie nueva.
- Los **cancelados por el usuario SÍ cuentan**: llegaron.
- **El período es el de creación del pedido** (cohorte) en las cuatro series.
  Así "los pedidos de esta semana" son los mismos en 2a, 2b, 2c y 2d, y los
  números se pueden leer juntos.

### 2a. Recibidos por período

`count(*)` por bucket, barras + acumulado. Es `GrowthChart` tal cual.

### 2b. Propuestas por pedido

**Fuente: `ops.quote_request_response`, no `proposals_count`.** Relevado:

| Pedido | `proposals_count` | filas en `ops` |
|---|---|---|
| AL-1024 | 3 | 0 (anterior a la 015) |
| AL-1035 | 3 | 4 |
| AL-1037 | 3 | 3 |

Las dos fuentes no coinciden y no se mezclan. Se elige la tabla de `ops`
porque es la única que permite 2d (red vs afuera), y porque es lo que el
operador cargó taller por taller; `proposals_count` es un número que se tipea
aparte (`leads.md`: "son DOS números, y no se sincronizan").

Por bucket: pedidos, pedidos con al menos una propuesta, total de propuestas,
y promedio por pedido.

> **⚠ Corregido el 2026-09-23, antes de aplicarse a ningún dato real.** Esta
> sección decía "sobre todos los pedidos del bucket, no sólo los que tienen
> alguna: un pedido sin propuestas es un cero real". Es la pregunta
> equivocada: lo que se quiere medir es cuántas propuestas se le mandan a un
> cliente, en promedio — y eso es sobre los pedidos a los que SE LES MANDÓ
> algo (`pedidosConPropuesta`), no sobre `received`. El promedio es
> `proposalsTotal / pedidosConPropuesta`, y `null` (no `0`) cuando nadie
> recibió propuesta en el bucket — el promedio no está definido, no es cero.
> → `.claude/rules/metricas.md`, sección "El promedio de propuestas…".

**Los pedidos anteriores al 2026-09-22 no tienen filas.** La sección lo dice
en texto (no se backfillea desde `proposals_count`, ni se parsea
`internal_notes`). Con volumen, ese tramo pierde peso solo.

### 2c. Cuánto tardamos

**No existe el timestamp de "envío".** Abrir el link de WhatsApp no escribe
nada. Lo más cercano es `answered_at`: lo sella
`ops.mark_quote_request_answered` (011) cuando el operador marca respondido.
Se mide eso y la pantalla lo nombra así ("hasta marcado respondido"), no
"hasta enviado".

Por bucket, dos medianas en horas (`percentile_cont(0.5)`, no promedio —
`ops-metrics.md` trampa 6):

- alta → `contacted_at`
- alta → `answered_at`

Más **cuántos pedidos del bucket siguen sin contactar / sin responder**. Un
pendiente no puede entrar a la mediana; sin mostrarlo aparte, la curva mejora
exactamente cuando dejamos pedidos sin atender. Los cancelados por el usuario
antes de responder no cuentan como pendientes (salen del universo de 2c).

Relevado: AL-1024 18,7 h, AL-1035 5,1 h, AL-1037 2,8 h hasta respondido.

Si se quiere medir el envío de verdad, es trabajo aparte: registrar un evento
en `ops` al tocar "Enviar por WhatsApp" — y aun así es "abrió WhatsApp", no
"envió". Fuera de este plan.

### 2d. Red vs afuera

Por bucket: propuestas con `partner_id` (red) y con `provider_name` (afuera),
absoluto y % de red. Barras apiladas.

Se toma `partner_id is not null` tal cual está guardado. Un taller de afuera
que casualmente se llama igual que uno del directorio cuenta como afuera — el
componente no vincula por nombre a propósito (`leads.md`, "Tipear NO vincula").
Un partner borrado del directorio después sigue contando como red: la
respuesta vino de la red en su momento.

### Implementación

- `quoteRequestSeries(unit)` en `quote-requests.repo.ts`. **Una sola sentencia**
  para 2a–2d, así los cuatro bloques comparten snapshot y se leen juntos.
- Guard antes de consultar: `quoteRequestsAvailability()` (la tabla puede no
  existir en otra base) + `to_regclass('ops.quote_request_response')` (la 015
  puede no estar aplicada). Sin tabla de respuestas, 2a y 2c se muestran igual y
  2b/2d dicen que falta la 015.
- `getQuoteRequestSeries` en `fn/quote-requests.ts`, con `adminMiddleware`.
- Las columnas del bucket se mapean explícito, campo por campo (`mapCensus`).
- `pg` devuelve `count`/`percentile_cont` como string o double → `toInt`/`toNum`,
  con `null` preservado (sin pedidos respondidos en el bucket = `null`, no `0`).

---

## El chart

`GrowthChart` hoy dibuja barras + línea de **acumulado**. Tres de las series
necesitan otra línea:

| Serie | Barras | Línea |
|---|---|---|
| 1 | altas brutas / con vehículo | % con vehículo |
| 2a | recibidos | acumulado (igual que hoy) |
| 2b | propuestas | promedio por pedido |
| 2c | pendientes | mediana en horas (dos líneas) |
| 2d | red / afuera apiladas | % de red |

Se generaliza `GrowthChart` en vez de copiarlo: la línea pasa a ser un prop
(`{ values, label, format }`), el default sigue siendo el acumulado, y se suman
barras apiladas. Todo color de tokens, sin sombras (`design-system.md`).

---

## Zona horaria del bucket: hora de Buenos Aires — decidido el 2026-09-23

Con UTC, un pedido o un alta de las 21–24 h de Buenos Aires caía en el día
siguiente. Se agrupa en `America/Argentina/Buenos_Aires`.

**Alcance: toda la sección Crecimiento, no sólo las series nuevas.** El
denominador de la métrica 1 son las altas brutas, que es la MISMA serie que el
gráfico de Usuarios de al lado. Si una agrupara en Buenos Aires y la otra en
UTC, el "de 12 altas" del % no coincidiría con la barra de Usuarios de ese
mismo día. Así que `growthSeries()` pasa a Buenos Aires también (afecta
Usuarios y Vehículos de `/metricas`).

- La zona es una constante (`METRICS_TZ` en `~/lib/ops`) que entra por
  parámetro: `date_trunc($1, ts at time zone $2)`, nunca interpolada.
- `date_trunc('week', …)` sobre la hora local sigue cortando en lunes, ahora
  lunes de Buenos Aires.
- El bucket sale como `YYYY-MM-DD` (un día calendario, sin hora). `formatDate`
  lo pinea en UTC al mostrarlo, y como el string ya es el día local, se ve el
  día correcto. **No** convertir el bucket a `timestamptz` en el camino: ahí
  sí se correría tres horas.
- Lo que NO cambia: `ai_usage_daily` de `/ai-costos` y el resto del panel
  siguen en UTC. `/metricas` lo dice en la nota del gráfico ("días en hora de
  Buenos Aires").
- Cuadre extra: la suma de los buckets en Buenos Aires tiene que dar el mismo
  total que en UTC. Cambia en qué día cae cada fila, no cuántas filas hay.

## Volumen

6 pedidos reales en una semana: en vista diaria una "mediana" es casi siempre un
pedido. Las series de pedidos se leen en semana hasta que haya volumen. Se
construyen igual.

## Lo que no hace

- Ni una escritura, ni una migración.
- No backfillea propuestas desde `proposals_count` ni desde `internal_notes`.
- No mide el envío real por WhatsApp.

## Verificación

- `vite build` + `tsc --noEmit` (`running-build-commands`).
- Borde server-only: `grep -rl "onboardingSeries\|quoteRequestSeries\|INTERNAL_PREDICATE\|POSTGRES_DATABASE_URL" .output/public` → vacío.
- Cuadres contra la base con `db-connect`:
  - 1: `sum(signups)` = usuarios reales; `sum(withVehicle)` = 119 al 2026-09-23.
  - 2a: `sum` = `count(*)` de `quote_requests` sin duplicados (6).
  - 2b/2d: `sum(propuestas)` = `count(*)` de `ops.quote_request_response` sobre
    pedidos no duplicados; red + afuera = total.

## Reglas a actualizar cuando esto exista

- `metricas.md`: las dos secciones nuevas, el corte de 10 min, la fuente de 2b,
  y que Crecimiento agrupa en hora de Buenos Aires (a diferencia del resto del
  panel).
- `leads.md`: el predicado de duplicados compartido entre la card y la serie.
- `CLAUDE.md`: la fila de `/metricas` en la tabla de pantallas.
