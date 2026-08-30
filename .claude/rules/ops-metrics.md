# Métricas de operación (`/operacion`, `/dashboard`, `GET /api/metricas`)

Alcance: `src/lib/ops.ts`, `src/server/ops.repo.ts`, `src/fn/ops.ts`,
`src/routes/_authed/operacion.tsx`, `src/routes/_authed/dashboard.tsx`,
`src/routes/api/metricas.ts`.

## De qué lado está el dueño del SQL

Es el tercer caso del repo y hay que decirlo en voz alta, porque los otros dos ya tienen regla:

| Módulo | Dueño del SQL | Dónde vive |
|---|---|---|
| `partners.repo.ts` | El backend | `approve_partner_application()`, `v_partner_application_queue` |
| `ai-usage.repo.ts` | Nosotros | Funciones de `ops`, versionadas en `migrations/` |
| **`ops.repo.ts`** | **Nosotros, pero sobre tablas de `public`** | **Strings SQL en el propio archivo** |

**Por qué no son funciones en `ops`.** Una función de `ops` que lee `public` es una dependencia de
schema cruzada escrita adentro de la base, invisible para las migraciones de Drizzle del backend. El
día que el backend renombre una columna, su migración pasa verde y la función de `ops` se rompe en
runtime sin que ningún build avise. Con el SQL en el repo, el mismo rename sigue rompiendo en
runtime — pero `rg nombre_de_columna` lo encuentra y el diff queda versionado. Es el mal menor
consciente.

**Lo que esto NO habilita**: ninguna de esas consultas decide nada. Cuentan, agrupan y ordenan.

## Las trampas confirmadas

### 1. El predicado de "cuenta interna" tiene que ser el MISMO que el de la vista

`ops.v_ai_usage` marca `internal` así:

```sql
split_part(lower(u.email), '@', 2) IN (SELECT domain FROM ops.excluded_email_domains)
```

`ops.repo.ts` lo repite literal en `INTERNAL_PREDICATE`. **No lo reescribas como
`email LIKE '%@' || domain`.** Ese fue el arreglo tentador y está mal: un email
`foo@sub.autolibre.app` matchea el `LIKE` y no matchea el `split_part`. Resultado — la misma cuenta
cuenta como interna en Inicio y como externa en Costos de IA. Dos respuestas distintas a la misma
pregunta, sin ningún error que las delate.

Corolario en el schema de zod: `excludedDomainSchema` hace `.toLowerCase()`. Un dominio guardado con
una mayúscula no matchea **nunca**, y el excluido se sigue contando sin avisar.

### 2. `failed` avisa; `stuck` no avisa nunca

`failed` es un estado terminal: alguien lo escribió, queda ahí para siempre, se ve. `stuck` es lo que
ARRANCÓ y no terminó pasado el umbral — nadie lo escribe, se deduce del reloj. Sin esta pantalla se
descubre cuando un usuario reclama.

Los umbrales de `STUCK_AFTER_MINUTES` son distintos por cola y no por gusto:

| Cola | Umbral | Por qué |
|---|---|---|
| `notifications` | 30 min | `scheduled_at` vencido debería salir en el próximo tick del scheduler |
| `vehicle_data_queries` | 60 min | Depende de un proveedor externo lento |
| `driving_sessions` | 180 min | El teléfono sube chunks y puede estar sin señal un rato largo |
| `catalog_images` | 60 min | Una llamada a un modelo de generación |

### 3. Un solo `UNION ALL`, no cuatro consultas

Las cuatro colas se cuentan en una sola sentencia para que compartan el mismo `now()` de Postgres.
Con consultas separadas cada una toma su propio reloj y "colgado hace 61 minutos" deja de significar
lo mismo en las cuatro. Misma razón por la que `windowStart()` resuelve la ventana **una vez** en
JavaScript en vez de usar `now() - interval` por consulta.

### 4. `pg` devuelve `bigint` y `numeric` como STRING

`"14" + "3" === "143"`. Todas las consultas castean `::int` en SQL y además pasan por `toInt()`.
La red doble se mantiene a propósito: `percentile_cont` devuelve `double precision` y las columnas
calculadas se agregan sin que nadie revise el cast.

`toNum()` PRESERVA el null. Cero es un valor; null es "no sabemos". `vehiclesPerUser` es `null` sin
usuarios reales, nunca `0` — que se leería como "tienen cuenta y no cargaron el auto".

### 5. `coalesce(x,'') = ''`, no `x IS NULL`

El import del `legacy_sheet` escribió strings vacíos donde no había dato. `IS NULL` cuenta de menos y
el problema queda invisible. Aplica a `activeWithoutContact` y a cualquier chequeo de campo faltante
sobre filas que vinieron del sheet.

### 6. Mediana, no promedio

`medianHoursToContact` usa `percentile_cont(0.5)`. Un lead olvidado tres semanas mueve el promedio a
un número que no describe a ningún lead real.

### 7. Los umbrales entran por parámetro, no por interpolación

`make_interval(mins => $1::int)`. Son números nuestros y no entrada de usuario, pero un `interval`
armado concatenando strings es la puerta por la que después entra el primero que sí venga de la URL.

## Cuándo una fila en cero se muestra y cuándo no

Las dos decisiones son opuestas **a propósito**:

- **Inicio → "Qué hay que arreglar"**: una fila sólo aparece si su número es distinto de cero. Es una
  lista de pendientes; seis renglones diciendo "0" entrenan a no leerla, y el día que uno diga "3"
  nadie lo nota.
- **Operación → tarjetas de cola**: las cuatro están siempre, incluso en cero. Si la tarjeta
  desaparece, "no hay notificaciones registradas" se vuelve indistinguible de "todas salieron bien",
  y son dos datos distintos.

## Qué escrituras se permiten desde acá

**De este módulo de métricas, sólo `ops.excluded_email_domains`** (alta, edición de nota, baja). Se
puede porque `ops` es del panel y porque no decide nada del negocio: no cambia lo que la app hace,
cambia a quién cuentan las métricas de este panel.

**Las escrituras sobre `public` son otro asunto y tienen su propia rule** →
`.claude/rules/ops-write-actions.md`. Resumen de la línea:

- **SÍ** se escriben `partners` y `leads` desde stored procedures de `ops`, porque **el backend no
  tiene ningún camino para hacerlo** — `IPartnerRepository` es sólo lectura y `lead` sólo tiene
  `submit-lead`. Verificado, no supuesto.
- **NO** se reintenta una notificación (el backend ya reintenta cada minuto, sin tope: el SP sería un
  no-op) ni se reencola una consulta VTV (choca un índice único parcial y puede refacturar un job al
  proveedor).

La pantalla de Operación **muestra** esos dos problemas y dice en qué tabla están. No los toca.

`upsertExcludedDomain` usa `ON CONFLICT DO UPDATE` y **no toca `created_at`**: cuándo se decidió
excluir el dominio es el dato con valor, y pisarlo con cada corrección de la nota lo borra.

La columna `users` de la tabla de dominios es lo que la hace verificable: un dominio que oculta 0
usuarios está mal escrito, o la base se reseteó.
