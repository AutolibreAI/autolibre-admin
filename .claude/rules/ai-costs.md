---
paths:
  - 'migrations/**'
  - 'scripts/migrate.mjs'
  - 'src/server/ai-usage.repo.ts'
  - 'src/fn/ai-usage.ts'
  - 'src/lib/ai-usage.ts'
  - 'src/routes/_authed/ai-costos.tsx'
---

# Costos de IA — el schema `ops`

## Por qué existe un segundo schema

`public` es del backend: lo migra Drizzle desde `autolibre-backend-hex`, y su contenido es el
**dominio**. Las métricas de operación no son dominio — nadie de la app las lee, tienen otro ciclo de
vida y otro dueño.

`ops` es del panel. **Este repo lo crea, lo migra y lo consulta. El repo del backend no lo conoce.**

Eso fue un pedido explícito ("no quiero tocar el backend para esto") y se pudo cumplir entero, con
**una** excepción que no es negociable y está más abajo: instrumentar una superficie nueva.

## Migrar

```bash
pnpm db:migrate          # aplica pendientes
pnpm db:migrate:status   # qué hay aplicado y qué falta
pnpm db:migrate:dry      # qué aplicaría, sin aplicar
```

### `ops.schema_migrations` es POR BASE

No es global. Aplicar en desarrollo **no** aplica en producción, y no hay nada que avise: la app
compila, deploya, y recién revienta en el primer request a `/ai-costos` con
`relation "ops.v_ai_usage_costed" does not exist`.

**Todo deploy a un entorno nuevo necesita su `pnpm db:migrate` apuntando a la
`POSTGRES_DATABASE_URL` de ese entorno.** Al 2026-08-27 el schema está aplicado en desarrollo y
**no** en producción.

### En Vercel eso lo hace el build, y sólo el de producción

Desde el 2026-08-30 `pnpm vercel-build` corre `scripts/migrate.mjs --on-deploy` **antes** de
`vite build`. Es el único momento posible: Vercel no tiene hook de post-deploy.

El orden importa y no es reversible: si la migración falla, el build falla y **no se deploya nada**.
Fallar cerrado es lo que queremos — el estado "código nuevo servido contra schema viejo" no llega a
existir.

La compuerta está en `deployGateOpen()` y su default es `production`, porque **las previews también
buildean**. Sin compuerta, una rama sin mergear le aplica sus migraciones a la base de producción, en
silencio y antes de que nadie las revise. `OPS_MIGRATE_ON_DEPLOY` la abre (`always`) o la cierra
(`never`) por entorno.

**Un builder de Vercel sin `VERCEL_ENV` corta el build a propósito.** Pasa con el toggle
"Automatically expose System Environment Variables" apagado, y ahí no hay forma de distinguir
producción de preview: las dos salidas silenciosas son malas, así que no se adivina.

Dos condiciones que se descubren tarde si no se las nombra:

- **`POSTGRES_DATABASE_URL` y `POSTGRES_CA_CERT` tienen que estar disponibles en BUILD**, no sólo en
  runtime. Una env var scopeada sólo a runtime deja al migrador sin base y voltea el build.
- **El contenedor de build tiene que poder abrir el puerto de la base.** Si el Postgres administrado
  tiene "Trusted Sources" / allowlist de IPs, las IPs del builder de Vercel no son fijas y la
  conexión muere por timeout. Ese caso no se arregla desde este repo: o se abre el acceso, o se pone
  `OPS_MIGRATE_ON_DEPLOY=never` y se migra a mano.

### Nunca edites una migración ya aplicada

El runner guarda un checksum y aborta si el archivo cambió. El arreglo **no** es borrar la fila de
`ops.schema_migrations` para que vuelva a correr: es una migración NUEVA que lleve el schema del
estado actual al deseado. Borrar la fila re-ejecuta un archivo que ya corrió, y ahí el error deja de
ser recuperable.

## Las cuatro leyes de este schema

### 1. Costo desconocido es `NULL`, jamás `0`

`ops.v_ai_usage_costed` une el uso con el precio por **LEFT JOIN**. Un `INNER JOIN` haría desaparecer
los eventos cuyo modelo no tiene tarifa cargada, y el panel mostraría un total menor y
**perfectamente creíble**, sin una sola señal de que faltan filas.

Es el peor bug posible acá: no es un error, es un número equivocado con aspecto de correcto.

- Un `COALESCE(costo, 0)` sobre cualquier columna de plata **es un bug**. Cero es un precio; NULL es
  "no sabemos".
- En TypeScript hay dos conversores y no son intercambiables: `toInt` (0 si null, para contadores) y
  `toNum` (preserva null, para plata). Usar `toInt` sobre un costo reintroduce el bug.
- `formatUsd(null)` rinde `—`.
- El total **nunca** se muestra solo: viaja siempre con `unpricedEvents` al lado.

### 2. Ninguna FK cruza de `ops` a `public`

La tentación es `user_id uuid REFERENCES public.users(id)`. **No.** Una FK cruzada vuelve a atar los
dos schemas justo en lo que se quiso desatar: el backend ya no podría migrar `users` sin romper el
panel, y el panel pasaría a ser un bloqueante de las migraciones del backend.

UUID pelado, y el nombre se resuelve con `LEFT JOIN` al leer. Efecto buscado: si el backend borra un
usuario, la fila de consumo sigue existiendo con el uuid y sin nombre — el gasto no desaparece
porque el usuario ya no esté.

### 3. Dos precios no pueden solaparse

`ops.ai_model_pricing` tiene una exclusion constraint (`btree_gist`) sobre
`(model, tstzrange(valid_from, valid_to))`.

Sin ella, dos filas solapadas para el mismo modelo hacen que el LEFT JOIN matchee dos precios y
**duplique la fila de uso**, inflando tokens y plata a la vez. Es el error que se comete cargando una
tarifa nueva a las once de la noche y se descubre tres semanas después mirando un total que no
cierra.

Cargar un precio nuevo es **cerrar el anterior** (`valid_to`) y abrir uno nuevo — no editar el
existente, que reescribiría el histórico.

### 4. Las funciones de `ops` se mantienen flacas

Misma condición que el backend le puso a `approve_partner_application()`: **agregan y devuelven, no
deciden.**

Lo que NO va en SQL: qué se considera gasto alto, qué modelo conviene, cuándo alertar. Eso es
política de producto y la decide la UI o un caso de uso, con la tabla de precios como dato. Una
función SQL que decide es una regla de negocio sin tests que nadie encuentra cuando cambia.

## Trampas confirmadas

### `pg` devuelve `bigint` y `numeric` como STRING

`count(*)::bigint` llega como `"14"`, y `"14" + "3"` en JavaScript es `"143"`. Un total de tokens
concatenado en vez de sumado se ve plausible en una fila y absurdo en el agregado. Toda columna que
salga de una función de `ops` pasa por `toInt` o `toNum`.

### `conversation_messages` guarda los dos lados de la charla

La mitad de las filas son `author = 'user'` y tienen `model`, `prompt_tokens` y `completion_tokens`
en NULL. **Sin `WHERE author = 'ai'` la cuenta de llamadas da el doble.** Verificado: al 2026-08-27,
1623 filas totales y 766 medidas.

### Un `date` de Postgres llega a medianoche LOCAL del proceso

`pg` construye el `Date` en la zona del proceso. `toISOString().slice(0, 10)` funciona en ART
(UTC-3) y devuelve **el día anterior** si el proceso corre al este de UTC: la serie diaria entera
corrida un día, y los totales por día dejando de cuadrar con el total del período.

Vercel corre en UTC, así que no muerde hoy — es un bug latente esperando un cambio de región.
`toPlainDay()` en `ai-usage.repo.ts` lee los componentes locales y deshace la conversión de `pg`.
**No lo "simplifiques" de vuelta a `toISOString()`.**

### `provider` es una columna, no se infiere del nombre del modelo

Al 2026-08-27 la base de desarrollo tiene **`gpt-4o-mini`** con 57 llamadas y 80.374 tokens de
entrada, sobre la superficie `diagnostics`. Inferir el proveedor del prefijo `claude-` habría
atribuido mal ese gasto o lo habría dejado invisible. La columna explícita es lo que hizo que
apareciera como "sin tarifa" en vez de como otra cosa — y así fue como nos enteramos de que hay
OpenAI en el sistema.

Tarifa cargada en `004_pricing_gpt_4o_mini.sql`.

### Toda tarifa lleva link y fecha de verificación

`source_url` (link clickeable desde la tabla del panel) y `verified_at` (cuándo se miró esa página
por última vez). Las dos, no una: un link sin fecha no dice si el número se chequeó ayer o hace dos
años, y **una tarifa vieja no se anuncia — sigue calculando, prolija y equivocada.**

Un CHECK en la base exige `^https://`. Un link roto en una tabla de auditoría es peor que no tener
link: promete verificación y no la entrega.

Las URLs vigentes por proveedor viven en `ops.pricing_sources`, y **hay que verificarlas antes de
escribirlas**. Las dos que hoy están cargadas se fetchearon el 2026-08-27, y las dos candidatas
obvias fallaban:

| Proveedor | URL correcta | La que NO sirve |
|---|---|---|
| anthropic | `https://platform.claude.com/docs/en/about-claude/pricing` | `platform.claude.com/docs/en/pricing` → **404** |
| openai | `https://developers.openai.com/api/docs/pricing` | `platform.openai.com/docs/pricing` → 301 |

### Una tarifa nueva se carga con el `valid_from` del PASADO

El error natural es poner la fecha de hoy. El JOIN exige `occurred_at >= valid_from`, así que todo
el consumo anterior queda fuera de vigencia: **la tarifa entra, el panel no cambia, y parece que la
carga no funcionó.**

Va la fecha desde la que ese precio rigió. Para `gpt-4o-mini` fue `2024-07-18` (lanzamiento), que
cubre las llamadas de junio a agosto de 2026.

Y cuando un precio CAMBIA, no se edita la fila: se le pone `valid_to` y se abre una nueva. Editarla
reescribe el costo de todo el histórico.

### El costo de OpenAI está SOBREestimado

OpenAI cobra los tokens de entrada cacheados a mitad de precio ($0,075/Mtok en `gpt-4o-mini`). El
panel no lo puede aplicar porque el dato no existe: ni `ai_diagnostics` ni `conversation_messages`
guardan cuántos tokens vinieron de cache.

Para las llamadas que pegaron en cache, el número del panel es **mayor** al real. Sobreestimar es el
error tolerable de los dos, pero es una diferencia real — no la busques como bug cuando no cuadre
contra el resumen de OpenAI. Medirlo bien necesita al backend: viene en
`usage.prompt_tokens_details.cached_tokens` de la respuesta, y si no se anota ahí se pierde.

## Lo único que SÍ necesita al backend

Instrumentar una superficie que hoy no mide.

El proveedor devuelve los tokens **en la respuesta de la llamada**. Esa llamada la hace el backend.
Si no anota el número en ese momento, **ese número se perdió para siempre** — no hay SQL, schema ni
SP que lo recupere después.

Estado al 2026-08-27 (desarrollo), vía `ops.ai_surface_coverage()`:

| Superficie | Origen | Filas | Medidas |
|---|---|---|---|
| Asistente | `conversation_messages` | 1623 | 766 |
| Diagnóstico IA | `ai_diagnostics` | 172 | 172 |
| **Imágenes de catálogo** | `vehicle_catalog_images` | **1030** | **0** |
| **Análisis de telemetría** | `driving_telemetry_analysis` | **129** | **0** |

Las dos últimas se muestran en el panel como agujero declarado, a propósito: **un panel de costos que
oculta un costo es peor que no tener panel**, porque da confianza falsa.

`has_token_columns` sale de `information_schema`, no de una lista a mano. Cuando el backend agregue
las columnas, el panel lo detecta solo. Ahí, y recién ahí, hace falta una migración de este repo que
sume la superficie a `ops.v_ai_usage` y le ponga `tracked = true` en el registry.

## El consumo interno se excluye por IDENTIDAD, no por nombre de modelo

`ops.excluded_email_domains` lista los dominios cuyo consumo no cuenta como gasto del producto. Hoy
tiene uno: `autolibre.app`. Al 2026-08-27 eso son 2.986 cuentas generadas por los E2E (`lead-`,
`owner-`, `cal-reject-`, `reborn-`, `webhook-e2e`…), ninguna una persona, responsables de **799 de
938** eventos medidos.

### Por qué no se filtró por `fake-model` / `fake-diagnosis-model`

Daba el mismo resultado — esos 799 eventos son exactamente los de esos dos modelos — y se descartó
igual. Un filtro escrito contra nombres de modelos inventados no significa nada en producción, y el
día que un modelo real se llame parecido **esconde gasto de un cliente**.

"Esta cuenta es nuestra" sigue siendo cierto en producción y no puede tapar consumo ajeno. Misma
exclusión, sostenida por algo real.

### Se marca, no se borra

`ops.v_ai_usage` tiene una columna `internal`; **son las funciones las que filtran** con
`WHERE NOT internal`. Sacarlos de la vista era más corto y es la versión equivocada: el panel no
podría decir cuánto está dejando afuera.

- `ai_usage_summary` devuelve `internal_events`, y la pantalla lo escribe abajo de los tiles.
- El total y el contador de excluidos **viajan siempre juntos**, igual que con `unpriced`.

### `COALESCE(..., false)` no es decorativo

Un evento con `user_id` NULL (o apuntando a un usuario borrado) da `NULL IN (...)` → NULL, y sin el
COALESCE se caería del `WHERE NOT internal` y **desaparecería del panel**. Desconocido no es interno:
en la duda, el consumo CUENTA.

### El match es por dominio exacto

`split_part(lower(email), '@', 2) IN (...)`, no `LIKE '%autolibre.app'`. Con LIKE, un
`@no-autolibre.app` entra por la ventana. Para cubrir subdominios se agrega la fila
`mail.autolibre.app` — explícito, no por accidente de patrón.

### Agregar un dominio es un INSERT, no una migración de vistas

```sql
INSERT INTO ops.excluded_email_domains (domain, note) VALUES ('otro.dominio', '…');
```
