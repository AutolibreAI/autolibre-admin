# Plan — `/negocio`: métricas de negocio (P&L mensual)

> **Estado: plan cerrado, sin implementar.** Escrito el 2026-09-10 sobre la rama
> `metricas-PandL`. Todos los números de este archivo salieron de **producción**
> (`autolibre` / `doadmin`, vía el pooler) ese mismo día — ningún número de este
> repo significa nada sin decir contra qué base se sacó.
>
> Este `.md` existe porque la pantalla todavía no. La regla del repo es que **si
> un número de la base vive en un `.md`, es porque no tiene pantalla**: cuando
> `/negocio` exista, esta tabla de estado se borra de acá y se lee de la base.

## Qué contesta

Cuánta plata entra, cuánta sale y qué queda, mes a mes. Es la primera pantalla
del panel que **no reemplaza una consulta de DBeaver**, y no por descuido: el
P&L no se puede correr hoy ni a mano. Cruza `public` (usuarios, partners,
consultas al proveedor) con `ops` (tarifas), con números que no viven en ninguna
tabla de nadie (planes, tipo de cambio, infraestructura). Es la misma excepción
que ya se aceptó para `/ai-costos` — *"nada previo: el consumo de IA no se
medía"*.

Corolario operativo, y vale para cada fila: **una fila que no se puede medir se
declara como agujero, no se estima en silencio.** Un panel de plata que rellena
un hueco con un número plausible es peor que no tener panel.

---

## 1. Con qué datos arranca (relevado el 2026-09-10, producción)

**La base tiene dos meses y uno está a la mitad.**

| Mes | Altas usuarios | Altas partners | Vehículos | Usuarios con alguna señal |
|---|---|---|---|---|
| 2026-08 | 3 | 38 (34 del `legacy_sheet`) | 4 | 2 |
| 2026-09 (parcial, 10 días) | 126 | 6 | 143 | 126 |

Totales: **129 usuarios · 44 partners · 147 vehículos**. Agosto no es un mes de
negocio, es el pre-lanzamiento.

Consecuencias que la pantalla tiene que respetar desde el día uno:

- **El mes en curso se marca como parcial en su propia fila.** Sin eso, todo
  primero de mes se lee como una caída.
- **Churn: hoy da 0 y va a dar 0 hasta fines de octubre.** Cero usuarios tienen
  60 días sin señal porque la app tiene 41 días de vida. La fila no se esconde:
  se muestra en 0 con la nota de por qué.
- Lo que **sí** tiene contenido hoy: **20 de 129 se registraron y no hicieron
  nada** (ni un auto cargado).

Costos variables ya existentes, y cuánto de eso ve el panel hoy:

| Concepto | Acumulado real | Lo que el panel muestra hoy |
|---|---|---|
| IA texto (asistente + diagnóstico) | US$0,64 | US$0,64 |
| IA imágenes (123 de `gemini-2.5-flash-image`, 161k tokens salida) | sin tarifa cargada | **US$0** |
| VTV (50 llamadas reales × US$0,10) | **US$5,00** | **US$0** |
| Deuda / GNC / Multas | US$0 (sin uso, o gratis) | — |
| **Ingresos** | US$0 real · 44 partners sin plan | — |

**El panel ve hoy menos de un tercio del costo variable que ya existe**, y
ninguna de las dos partes que faltan necesita tocar el backend.

---

## 2. Decisiones tomadas

Las cuatro que se decidieron explícitamente el 2026-09-10, más las que se
derivan de ellas:

1. **Churn de usuarios = 60 días corridos sin ninguna señal Y sin ningún
   vehículo cargado.**
2. **Sin churn de proveedores por ahora.** No existe histórico de estado y no se
   inventa uno.
3. **Todo el P&L en USD**, con tipo de cambio mensual cargado a mano.
4. **`/negocio` es un ítem nuevo del nav**, no una pestaña de `/metricas`.
   `/ai-costos` queda donde está y el bloque de costos lo linkea.
5. **Las tarifas del proveedor se editan desde la pantalla**, con vigencia.
6. **Pedidos se deja modelado, no fabricado** (sección 6).

---

## 3. Forma de la pantalla

Ruta `/negocio`, **una sola pantalla sin pestañas**, `ssr: 'data-only'` — mismo
criterio que `/metricas` y `/ai-costos`: números con filtros, nada que indexar.

**El search param se llama `businessMonths`.** `window` ya lo usan `/operacion`
y `/ai-costos` con enums distintos; un tercero con otro enum rompe el typecheck
en la ruta ajena por el merge de `FullSearchSchema`.
→ `.claude/rules/notifications.md`. Default `all` mientras haya dos meses.

**El eje de meses sale de un `generate_series`** sobre
`date_trunc('month', …)`, y todo se joinea contra esa columna. Un mes sin altas
sale en 0, no desaparece — misma razón por la que `growthSeries` rellena hoy: un
hueco se lee como "no hay dato", no como "no entró nadie". En UTC, igual que
`ai_usage_daily`, para que el último bucket cierre con el total.

Cada bloque es **una sola sentencia**. Comparten el snapshot de Postgres, así
que las columnas cuadran entre sí; con seis consultas sueltas una fila insertada
en el medio del barrido entra en un contador y no en otro. Mismo argumento que
el censo de `users.repo.ts` y el `UNION ALL` de `queueHealth`.

---

## 4. Bloque «Usuarios»

| Columna | Cómo sale |
|---|---|
| Acumulados | window sum de altas por `created_at` |
| Altas | `count(*)` del mes, excluyendo internos con `INTERNAL_PREDICATE` |
| Bajas por churn | ver abajo |
| Crecimiento neto | altas − bajas |
| Ratio altas/bajas | **`null` cuando bajas = 0**, jamás ∞ ni 0 → `—` |
| Activos fin de mes | acumulados − churn acumulado |

**La identidad tiene que cerrar en toda la tabla:**

```
activos_fin(m) = activos_fin(m-1) + altas(m) − bajas(m)
```

Va un test de cuadre, como el de `GROUPING SETS` en `/escaneres`: si la suma no
da, lo detecta el test y no el ojo mirando la tabla.

### Las tres trampas del criterio de churn

**1. La condición del vehículo se evalúa sobre `created_at`, NUNCA sobre
`archived`.** `vehicles.archived` es un booleano sin fecha: si alguien archiva
su auto hoy, la condición cambiaría también para agosto y **la serie histórica
se reescribiría sola hacia atrás**. La pregunta correcta es "¿tenía algún
vehículo creado a fin de ese mes?" — `created_at` es inmutable. Es la misma
razón por la que se descartó el churn de proveedores.

**2. El piso de la señal es `created_at`.** Un usuario que se registró y nunca
hizo nada no tiene ninguna señal, así que sin piso no churnearía jamás. Con
piso, **los 20 que nunca activaron caen como baja a los 60 días de
registrarse.** Es deliberado.

**3. La lista de señales vive en UN solo lugar.** `users.repo.ts` ya deriva
`last_activity_at` de `greatest(vehículo más nuevo, última conversación, última
sesión de manejo)`. Si el churn usa una lista más ancha, **el panel dice dos
cosas distintas del mismo usuario en dos pantallas, sin ningún error que lo
delate** — la clase de acoplamiento de `INTERNAL_PREDICATE` entre `ops.repo.ts`
y `v_ai_usage`. Sale a `src/lib/activity.ts` y las dos pantallas lo importan. Si
se amplía (mantenimiento, consulta VTV, seguro), se amplía para las dos.

`USER_CHURN_AFTER_DAYS = 60` es una constante nombrada y documentada, como
`NOTIFICATION_DELAYED_AFTER_MIN`. No un `60` suelto en el SQL.

---

## 5. Bloque «Proveedores»

Altas y acumulado **por `created_at`** (columna inmutable → serie estable).

**Sin churn**, y la fila lo dice en voz alta: *"no hay ninguna baja registrada;
medirla necesita histórico de estado, que hoy no existe"*.

Con un **guardián que se autodenuncia**: hoy `count(*) where status <> 'active'`
es **0** (los 44 partners están activos y `ops.action_log` no tiene ni un solo
`partner.set_status`). Si algún día deja de ser 0, la pantalla lo muestra en
ámbar en vez de seguir dibujando una serie que dejó de ser verdad. Ese es el
momento de agregar la tabla de snapshots mensuales, no antes.

> **Por qué `partners.status` no sirve para una serie histórica:** es el estado
> ACTUAL. Si mañana pausás un partner, la pantalla va a decir que también estaba
> pausado en agosto.

---

## 6. Bloque «Pedidos» — modelado, no fabricado

**Un pedido es una solicitud de cotización que abre un usuario para que los
talleres manden sus ofertas.** Hoy **no existe**: no hay tabla, no hay flujo, no
hay una sola fila. `/leads/pedidos` ya es una pestaña "todavía no" con
`ComingSoonPipeline`.

### No es un `Lead`, y confundirlos desalinea la conversación

| | Dirección | Cardinalidad |
|---|---|---|
| `Lead` (existe) | el usuario va hacia **un** taller por un presupuesto | 1 → 1 |
| **Pedido** (no existe) | el usuario abre una necesidad y **N** talleres ofertan | 1 → N, con ofertas de vuelta |

Regla dura 7: el vocabulario es el del backend. Los nombres candidatos son
`QuoteRequest` (el pedido) y `QuoteOffer` (cada oferta), **a confirmar con el
backend, que es el dueño del vocabulario.** Si aparece un tipo `PedidoLead` o un
`advancePedido`, está mal.

### «Dejarlo modelado» NO significa crearlo en `ops`

Es la tentación obvia y hay que decir por qué no: **un pedido es DOMINIO** —lo
escribe el usuario desde la app y lo lee el taller—, y `ops` es operación del
panel, que nadie de la app lee. Una tabla de dominio en `ops` sería invisible
para la app y convertiría al panel en dueño de algo que no le toca. Es
exactamente la línea que fija la decisión 3 del `CLAUDE.md`.

**El pedido vive en `public`, con su TDD, del lado del backend.**

### Qué sí hace este plan

1. **La fila existe en el contrato de métricas desde el día uno**, con la fuente
   declarada ausente — mismo patrón que `ops.ai_surface_registry`, donde una
   superficie sin instrumentar es una fila con `tracked = false` justamente para
   que el panel pueda mostrar el agujero.
2. **Queda escrita la forma mínima que el backend necesita** para que la métrica
   se enchufe sin rediseñar la pantalla:
   - fecha de creación del pedido → altas por mes (es la única columna que la
     métrica de volumen necesita de verdad);
   - estado del pedido (abierto / cotizado / cerrado / perdido) → embudo;
   - usuario y vehículo → cruce con el resto del panel;
   - una fila por oferta, con el partner que la mandó → "cuántos talleres
     respondieron", que es la métrica que dice si el producto funciona;
   - **si el pedido genera ingreso, el monto y la fecha del cobro.** Sin eso, un
     pedido es volumen, no plata.
3. **`/leads/pedidos` sigue con `ComingSoonPipeline`** hasta que exista la
   tabla. Cero `Route` con loader, cero array de ejemplo. El día que haya tabla,
   ese archivo pasa a tener loader y deja de usar el cartel.

> **Lo que NO se hace, y es la regla dura 8 con nombre y apellido:** ni un array
> de ejemplo, ni una entidad inventada, ni un número proyectado "hasta que haya
> dato". Ese array sobrevive meses y termina en producción.

### La pregunta abierta que decide dónde va la fila

**¿El pedido genera ingreso?** Si el ingreso es la comisión o el fee por
cotización, «Pedidos» es una **línea de ingreso** y va abajo, con el bloque de
plata. Si el ingreso es sólo el abono del taller, es una **métrica de uso** y va
arriba, con usuarios y proveedores. Hasta que se responda, la fila queda arriba
como volumen declarado.

---

## 7. Bloque «Tareas internas del usuario»

Distinto de los pedidos, y por eso va en su propia fila: son los recordatorios
de mantenimiento y las tareas marcadas como hechas (`maintenance_occurrences`).
**Esto sí existe y se mide hoy**: 59 filas (3 en agosto, 56 en septiembre), 34
marcadas como hechas, 10 usuarios, 3 planes cargados.

Dos números por mes: **generadas** y **hechas** (`performed_at` no nulo). Es
métrica de uso del producto, no de negocio: no entra al margen.

> Supuesto a confirmar: la fila «cantidad de tareas» del pedido original era en
> realidad **Pedidos**. Ésta se deja igual porque el dato existe y sirve; si no
> la querés en `/negocio`, se saca y no cambia nada más.

---

## 8. Bloque «Costos»

Tres familias, y la diferencia entre ellas es lo que hace honesta a la pantalla.

### a) IA con tokens en la base — ya medida, mal contada

**Lo más valioso del relevamiento:** el backend **ya instrumentó** la generación
de imágenes. `vehicle_catalog_images` tiene `model`, `prompt_tokens` y
`completion_tokens` cargados — 123 imágenes de `gemini-2.5-flash-image`, 161k
tokens de salida, ~1311 por imagen. Pero `ops.ai_surface_registry` sigue
diciendo `tracked = false` y **no hay tarifa cargada**, así que hoy ese gasto es
invisible. Según la tarifa que verifiquemos, es entre 3× y 8× todo el gasto de
texto: **el costo más grande del sistema es el que el panel no está mostrando.**

Lo mismo con los **embeddings**: `ai_diagnostics.embedding_tokens` (835 tokens,
`voyage-large-2`) está fuera de la vista y sin tarifa.

Los dos entran por la **migración 013**, con las trampas ya documentadas en
`.claude/rules/ai-costs.md`:

- **`valid_from` en el PASADO.** Con la fecha de hoy la tarifa entra, el panel
  no cambia, y parece que la carga no funcionó.
- **`source_url` verificado antes de escribirlo**, con `verified_at`. Las dos, no
  una: un link sin fecha no dice si el número se chequeó ayer o hace dos años.
- **El embedding emite una SEGUNDA fila** en la vista (`surface = 'embeddings'`,
  `input_tokens = embedding_tokens`, `output_tokens = 0`) sobre la misma fila de
  `ai_diagnostics`. Consecuencia asumida: el contador de eventos de diagnóstico
  deja de ser 1:1 con las filas de la tabla. Es preferible a esconder una
  llamada facturable.

### b) Eventos contables con precio cargado a mano

**Consulta al proveedor de datos del vehículo.** `vehicle_data_queries` es un
ledger de verdad: una fila por job, con `requested_modules`.

**Y además deja ver cuál pegó contra el proveedor y cuál salió del caché.** La
firma es limpia y verificada sobre las 61 filas de producción:

| | Filas | `settled_at − created_at` | `completed_at` |
|---|---|---|---|
| Llamada real al proveedor | **50** | 271 s promedio | posterior a `created_at` |
| Servida del caché | **7** | **0,0 s** | **anterior** a `created_at` |
| Fallidas | 4 | — | `NULL` |

**No hay un solo caso en el medio** — mismo tipo de corte limpio que `noData` en
`.claude/rules/scanner-compatibility.md`. Contando las 57 completadas
sobrefacturaríamos **14%**.

Reglas que salen de esto:

1. **Sólo se cobran las llamadas reales.** El caché no cuesta.
2. **Es deducción NUESTRA y se rotula como tal.** Que una señal sea derivada no
   es licencia para presentarla como dato del dominio — igual que `stuck` en
   `/operacion` y `atrasada` en `/notificaciones`.
3. **Las 4 fallidas se muestran aparte y NO se suman** hasta saber si el
   proveedor las cobra (pendiente abierto).

### Las cuatro tarifas, y qué contador tiene cada una

| Ítem | Precio | Contador hoy |
|---|---|---|
| **VTV** | US$0,10 | **50 llamadas reales** (8 en agosto, 42 en septiembre) |
| **Deuda** (`tax_debt`) | US$0,12 | 0 — el módulo existe en el enum, ninguna consulta lo pidió, `vehicle_tax_debts` está vacía |
| **GNC** | US$0,10 | 0 — **no existe en el schema** (ver pendiente abierto) |
| **Multas** | US$0,00 | no medible, **y no importa**: cero por lo que sea es cero |

Notas que no son opcionales:

- **El enum `vehicle_data_module` tiene exactamente `vtv | tax_debt`.** Multas y
  GNC no son módulos de esa tabla.
- **Multas a US$0,00 desactiva el agujero de `fine_lookups` para el margen.** Se
  carga la tarifa igual, el contador queda declarado como no medible, y **el día
  que deje de ser gratis hace falta el ledger del backend** — esa tabla no puede
  contar llamadas (ver más abajo).
- **GNC**: `vehicle_inspections.type` tiene `standard | cng` pero las 41 filas
  son `standard`. Precio cargado, contador 0, declarado.

### c) Los agujeros — declarados y NUNCA sumados

**Multas, patente y OCR no se pueden contar**, y no es un defecto de la
consulta:

| Tabla | Por qué no cuenta llamadas |
|---|---|
| `fine_lookups` | `UNIQUE (plate)` — una fila por patente, no por llamada |
| `vehicle_plate_lookups` | `UNIQUE (plate)` |
| `vehicle_plate_lookup_misses` | `UNIQUE (plate)` |
| `vehicle_fine_syncs` | PK `vehicle_id`, una fila por vehículo con `last_synced_at` |
| OCR de documentos | ninguna tabla registra la llamada |
| `driving_telemetry_analysis` | sin instrumentar, ninguna columna de consumo |

**Y hay algo peor que no poder contar: el timestamp se pisa en cada refresh, así
que una fila se MUDA de mes y el costo del pasado cambia solo.** Una serie
histórica construida sobre esas tablas se reescribe hacia atrás sin que nadie la
toque.

Se muestran con el patrón de `ops.ai_surface_coverage()`: *"Multas — sin
registro por llamada. 35 patentes en caché; cota inferior, no sumada al
total."* **Nunca entran al total ni al margen.**

El arreglo real es del backend y queda escrito: **un ledger append-only de
llamadas al proveedor**. Misma lección que `ai-costs.md` — el dato lo devuelve
el proveedor en la llamada, y esa llamada la hace el backend; si no lo anota en
ese momento, se perdió para siempre.

### d) Infraestructura fija

`ops.monthly_fixed_costs`: Vercel, DigitalOcean (base + Spaces), Clerk, dominio.
Un monto por ítem por mes, cargado a mano. No está en la base ni puede estarlo.

---

## 9. Bloque «Ingresos»

No existe nada en `public`: revisadas las 54 tablas, no hay planes, ni
suscripciones, ni columna de precio en `partners`. Se modela en `ops`, que es
del panel:

- **`ops.plans`** — `key`, `label`, `monthly_price`, `currency`, `valid_from` /
  `valid_to`, con la misma **exclusion constraint `btree_gist`** de
  `ai_model_pricing`. Dos precios solapados hacen que un partner matchee dos
  veces y el ingreso se duplique; se resuelve en la base, no en la app, porque
  es el error que se cuela cargando un precio a las once de la noche.
- **`ops.partner_plan_assignments`** — `partner_id` **uuid pelado, sin FK a
  `public`** (ninguna FK cruza), `plan_key`, vigencia, anti-solape por partner.

```
ingresos(m) = Σ precio vigente en m de cada partner con asignación vigente en m
```

convertido a USD con el FX del mes.

**Un partner sin plan asignado no se asume gratis: suma 0 y se cuenta aparte.**
Hoy eso es "US$0 · 44 partners sin plan asignado", que es la verdad. Mismo
patrón que `unpricedEvents`: el total nunca viaja solo.

**Un precio nuevo cierra el anterior y abre uno nuevo.** Nunca se edita la fila
—eso reescribe el ingreso de todo el histórico— y vale igual para las tarifas
del proveedor cuando se renegocien.

---

## 10. Bloque «Margen bruto»

`ingresos − costos`, en USD, con **`ops.fx_rates`** (un `ars_per_usd` por mes,
con fuente y fecha de verificación — un tipo de cambio sin procedencia es un
número que nadie se anima a corregir después).

**El margen viaja SIEMPRE con el contador de huecos al lado**: eventos sin
tarifa + costos no medibles + partners sin plan. Y **cero `coalesce(costo, 0)`
en cualquier columna de plata**: cero es un precio, `NULL` es "no sabemos". En
TypeScript, `toNum` (preserva null) y nunca `toInt` sobre plata.

---

## 11. Escrituras

Tarifas, FX, costos fijos, planes y asignaciones son **tablas de `ops`**, que es
del panel: se escriben **directo desde el repo** con `adminMiddleware`, sin
stored procedure. Los 8 guardrails de `.claude/rules/ops-write-actions.md`
aplican a los SP que escriben `public`, y acá no se toca `public`. Mismo
criterio que `ops.excluded_email_domains` desde `/operacion`.

**Con una diferencia: esto es plata, así que cada cambio de precio va a
`ops.action_log`** con `before` y `after`. Y el `UPDATE` más el `INSERT` del log
van en **una transacción** (`withTransaction` ya existe en `src/server/db.ts`).
Separados, el modo de falla es el peor posible: el precio cambia y el registro
de quién lo cambió no.

`created_at` **no se pisa** al corregir una nota o un precio: cuándo se cargó es
el dato con valor (misma lección que `upsertExcludedDomain`).

---

## 12. Migraciones

| | Qué |
|---|---|
| **011** | `ops.unit_costs` (tarifa por llamada, con vigencia + anti-solape), `ops.monthly_fixed_costs`, `ops.fx_rates` |
| **012** | `ops.plans`, `ops.partner_plan_assignments` |
| **013** | `v_ai_usage` + superficies `catalog_images` y `embeddings`; tarifas de Gemini y Voyage; `tracked = true` en el registry |

Cada una con su `.test.sql` en `BEGIN … ROLLBACK`, con el patrón de las 007–010.
Mínimo: que la exclusion constraint **rechace de verdad** un solape. Una
constraint que nadie probó se ve como una garantía y no lo es.

**Nunca editar una migración ya aplicada** — el runner guarda checksum. El
arreglo es una migración nueva, jamás borrar la fila de
`ops.schema_migrations`.

**A producción se migra por el puerto directo `:25060`, nunca por el pooler**:
`scripts/migrate.mjs` toma un `pg_advisory_lock` de sesión, y pgBouncer en modo
transacción reparte las sentencias entre conexiones distintas. Al 2026-09-10 las
migraciones 001–010 están todas aplicadas en producción.

---

## 13. Archivos

```
migrations/011_ops_costos_unitarios_y_fijos.sql   (+ .test.sql)
migrations/012_ops_planes_partners.sql            (+ .test.sql)
migrations/013_ops_ai_superficies_nuevas.sql      (+ .test.sql)

src/lib/activity.ts        # la lista ÚNICA de señales de actividad
src/lib/business.ts        # tipos, constantes, businessSearchSchema
src/server/business.repo.ts
src/fn/business.ts         # server functions, todas con adminMiddleware
src/routes/_authed/negocio.tsx
src/routes/_authed.tsx     # el ítem de nav

src/server/users.repo.ts   # pasa a importar la lista de señales
.claude/rules/business-metrics.md   # al cerrar la implementación
```

---

## 14. Fases

1. **Lectura pura** — usuarios, proveedores, pedidos (declarado), tareas. Sin
   migración, sin escritura. Ya sirve sola.
2. **Migración 013** — hacer visible el gasto de Gemini y los embeddings. **Es
   el mayor valor por unidad de trabajo de todo el plan**: hoy el costo más
   grande del sistema no se ve.
3. **Migración 011 + editor de tarifas, fijos y FX.** El editor va acá y no al
   final porque poder renegociar una tarifa fue parte explícita del pedido.
4. **Migración 012 + ingresos + margen.**

Los agujeros declarados entran en la fase 2, no al final: son la mitad del
mensaje de la pantalla.

---

## 15. Pendientes abiertos

1. **¿El chequeo de GNC es una llamada aparte al proveedor, o viene adentro de
   la respuesta de VTV?** Si viene adentro no es una unidad facturable y contarla
   sería inventar gasto.
2. **¿El proveedor cobra un job fallido?** Son 4 y nunca llegaron a
   `completed_at`. Por ahora se muestran aparte y no se suman.
3. **¿El pedido genera ingreso** (comisión / fee) **o el ingreso es sólo el abono
   del taller?** Decide si «Pedidos» es una línea de ingreso o una métrica de uso.
4. **Nombre definitivo del pedido en el vocabulario del backend**
   (`QuoteRequest` / `QuoteOffer` son candidatos, no decisión).

---

## 16. Cómo verificar un cambio acá

En esta máquina `pnpm` no está en el PATH; se usan los binarios locales, y **el
build va ANTES del typecheck** porque regenera `routeTree.gen.ts` (una ruta o un
`Link` nuevo sólo se validan después del build):

```
& ".\node_modules\.bin\vite.CMD" build
& ".\node_modules\.bin\tsc.CMD" --noEmit
```

Más el borde server-only, que tiene que dar **cero resultados**:

```
grep -rl "business.repo\|POSTGRES_DATABASE_URL\|unit_costs\|INTERNAL_PREDICATE" .output/public
```

Y el cuadre de los números: correr las mismas consultas con
`node .claude/skills/db-connect/query.mjs` y comparar contra lo que muestra la
pantalla. Para el bloque de usuarios, además, la identidad de la sección 4 tiene
que cerrar en todas las filas.
