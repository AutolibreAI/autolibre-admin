# Partners: el listado y el tablero de cobertura

Alcance: `src/lib/partners-coverage.ts`, `src/lib/catalog.ts` (`partnerSearchSchema`,
`PARTNER_LIST_SORT_KEYS`, `PARTNER_STATUS_FILTERS`), `src/server/partners.repo.ts`
(`listPartners`, `partnerCoverageBoard`, `loadCatalog`), `src/fn/partners.ts`
(`listMarketplacePartners`, `getPartnerCoverageBoard`, `getServiceCatalog`),
`src/routes/_authed/partners.tsx` · `partners.index.tsx` · `partners.listado.tsx` ·
`partners.cobertura.tsx`.

El editor de rubros de la ficha (`/partners/$partnerId`) sigue en
`.claude/rules/partner-approval.md`. Las escrituras de la ficha, en
`.claude/rules/ops-write-actions.md`. Acá **no se escribe nada** — las dos
pantallas son solo lectura.

## `/partners` es un layout, no una pantalla

Mismo patrón exacto que `/leads` y `/vehiculos`: `partners.tsx` es la barra de
pestañas + `<Outlet/>`, `partners.index.tsx` redirige a `/partners/listado`. La
ficha (`/partners/$partnerId`) cuelga del layout y hereda la barra, igual que
`/vehiculos/catalogo/:id`.

Consecuencia: un `Link to="/partners"` cae en el redirect (un salto de más).
Apuntá a `/partners/listado` directo — es lo que hacen la card de Inicio y las
filas de "Qué hay que arreglar".

## Vocabulario: "Rubro" acá son las CATEGORÍAS

`partner-approval.md` y `catalog.ts` venían llamando **"rubro"** a los 79
`services` y **"familia"** a las 16 `service_categories`. El dueño de producto
usa **"rubro"** para las 16 categorías (Motor, Transmisión, Climatización…) y
**"servicio"** para los 79. La UI de Partners sigue ESE lenguaje:

| Concepto | Tabla | UI (Partners) | Código |
|---|---|---|---|
| 16 categorías | `service_categories` | **Rubro** | `serviceCategory` / `category` |
| 79 servicios | `services` | **Servicio** | `service` |

El código NO cambió: sigue `serviceCategory` / `service` (regla dura 7 — el
nombre de la columna del backend manda). Sólo cambian las etiquetas y el título
de la pestaña. La columna "Rubros" del listado viejo pasó a ser dos: **Rubros**
(chips de categorías + `Nº rubros`) y **Servicios** (el conteo que antes se
llamaba "Rubros").

## El eje de zonas del tablero es TEXTO CRUDO, y fue una decisión

`partners.coverage_zone` es texto libre y sucio: 29 valores para 40 partners
("Pacheco" y "General Pacheco" separados, "Zona Norte / CABA", "A confirmar",
"Nacional"). Las coordenadas están **100% vacías** (`latitude IS NULL` en los 40
activos).

Se evaluaron tres caminos y se eligió **mostrarlo tal cual** (`btrim`, nada
más), con la nota al pie que lo dice en pantalla. Mismo criterio que el
`insurer` de seguros, el `model` de chats y el `scanner_firmware` de escáneres:
si el dato no viene estandarizado, no lo adivinamos. Los otros dos caminos
—heurística a zonas canónicas, o una feature de `ops` con tabla + SP para
asignar zona normalizada— quedaron descartados: el primero adivina, el segundo
es una migración entera para un problema que todavía no duele lo suficiente.

> Si alguien "mejora" esto agregando un mapeo `"Pacheco" → "Zona Norte"` a mano,
> está reintroduciendo exactamente lo que se decidió no hacer. El arreglo de
> verdad es que el alta del partner capture una zona estructurada, y eso vive en
> el backend / el formulario de la landing, no acá.

## Un partner está en EXACTAMENTE una zona — y de eso depende `categoryTotals`

`coverage_zone` es una sola columna de `partners`. Por eso `partnerCoverageBoard`
puede armar `categoryTotals` **sumando las celdas a lo ancho de las zonas**: un
partner que cubre "Motor" aparece en la fila de su zona y en ninguna otra, así
que sumar no doble-cuenta.

Verificado el 2026-09-08: `sum(celdas de Motor)` = 17 = `count(distinct partner)`
que cubre Motor. Si algún día `coverage_zone` se vuelve multivaluada (una tabla
`partner_zones`, un `text[]`), **esta suma pasa a estar mal** y hay que volver a
un `count(DISTINCT)` por categoría. El invariante está anotado en
`~/lib/partners-coverage`.

## Por qué `chasis-y-frenos` no es una columna

Las 16 categorías están todas `active = true`, pero `chasis-y-frenos` tiene
**cero `services` activos** (sus rubros viven hoy bajo `tren-rodante-y-frenos`,
misma `position`). El tablero filtra `WHERE sc.active AND EXISTS (servicio
activo)` → 15 columnas. Una columna permanentemente en 0 es ruido, no un hueco.

Los huecos reales (categoría con servicios pero 0 partners activos) sí se
muestran, y salen en `emptyCategories` + arriba de todo en la card de Huecos: al
2026-09-08 son **Seguridad y rastreo** y **Financiación**.

## `invisible` se define IGUAL que en `pipelineHealth`

En `listPartners`, `invisible = NOT EXISTS (partner_services)` — **sin** filtro
de `services.active`. Es a propósito: tiene que coincidir exacto con
`pipelineHealth.invisible` (la card "Partners invisibles" de Inicio) y con el
chip "Solo invisibles". Los chips de rubro y el tablero sí filtran por
`s.active`, que es lo que usa la app. Si estos dos predicados divergen, Inicio y
el listado cuentan distinto los mismos partners rotos — misma clase de
acoplamiento que `INTERNAL_PREDICATE` entre `ops.repo.ts` y `v_ai_usage`.

## El envoltorio `select * from (...) t` en `listPartners`

Igual que `listUsers` / `listChats` / `listNotifications`: `category_count`,
`categories` (jsonb) y el flag `invisible` son agregados/subconsultas que el
`where`/`order by` de afuera necesita ver como alias. `q` es la única excepción
—busca sobre `p.name`, columna cruda— así que va en el `where` interno y acota
el barrido antes de agrupar.

`PARTNER_SORT_COLUMNS` es el `Record` cerrado que hace seguro interpolar la
columna en el `ORDER BY` (mismo patrón que `SORT_COLUMNS` de `users.repo.ts`).
El desempate por `t.name` va SIEMPRE al final — ver `partner-approval.md`.

## El search param del filtro de estado se llama `partnerStatus`, NO `status`

`/solicitudes` (`applicationSearchSchema`) ya usa `status` con el enum
`partner_application_status`. Dos search params con la misma clave y enums
disjuntos rompen el typecheck de la ruta ajena en el spread `{...prev}` de los
updaters — la trampa que documenta `.claude/rules/notifications.md` y que ya
rompió un build.

Por el mismo motivo el multi-select de rubros del tablero se llama
**`coverageRubros`** (`string[]`) y NO reusa el `category` (`string`) del
listado: `string` contra `string[]` es tipos incompatibles bajo la misma clave.
El `q` sí se comparte —`string` en todos lados— y el `<Link>` del SPOF que va de
Cobertura a `/partners/listado` pasa `search={{ category: slug }}` como objeto
literal (no spread), así que ese sí puede nombrar `category`.

## Tildar un rubro no debe scrollear al tope

`setSearch` en `partners.cobertura.tsx` (y en `partners.listado.tsx`) pasa
**`resetScroll: false`** a `navigate`. Sin eso, cada cambio de search param
—tildar un rubro en la card de Huecos, tocar un chip adentro de una fila—
dispara el scroll-to-top default de TanStack y el control que apretaste se va de
la vista. El tablero se filtra en el cliente (no hay `loaderDeps` en cobertura),
así que no hay ninguna razón para moverse.

## Las dos cards de indicadores tienen la MISMA altura, y cómo

El grid es `lg:grid-cols-2` **sin `items-start`** → los dos cards se estiran a la
altura de la fila. La referencia es **Huecos** (15 rubros fijos, `<ul>` de
altura natural, sin scroll). **Punto único de falla** tiene el `<ul>` como
`min-h-0 flex-1 overflow-y-auto` dentro de un `CardContent` que es
`flex min-h-0 flex-1 flex-col`: eso hace que su lista aporte ~0 al alto
intrínseco, así que el card termina exactamente con la altura de Huecos y
scrollea su excedente (los SPOF agrupados por rubro pueden ser más largos que
15 filas). Si se toca esto, la regla es: **exactamente uno de los dos `<ul>`
define la altura (natural), el otro es `flex-1` + scroll.** Si los dos son
`flex-1`, la fila colapsa al header y los dos scrollean siempre.

## Los updaters de `<Link search>` cross-schema: usar `<button>` + `setSearch`

Los chips de rubro adentro de una fila del listado, y los headers de categoría
del tablero, son **`<button onClick={() => setSearch(...)}>`**, no
`<Link search={(prev) => ({...prev, ...})}>`. Con `<Link>` sin `from`, `prev` se
tipa como el `FullSearchSchema` (la unión de TODAS las rutas), y al spreadearlo
de vuelta `sort` queda con el tipo ancho y no matchea la ruta destino —
`Type '"aiMessages"' is not assignable to '"categories" | "name" | …'`. Es la
misma familia que la colisión de nombres, pero disparada por el spread y no por
la clave. Los `SortHeader` esquivan esto con un cast interno; para todo lo demás,
`setSearch` (que sale de `Route.useSearch()` / `Route.useNavigate()`, tipados
finos) es el camino. Un `<Link>` con objeto literal cross-route
(`search={{ category: x }}`) sí compila — es el spread lo que rompe.

## Cómo verificar un cambio acá

`& ".\node_modules\.bin\vite.CMD" build` (regenera `routeTree.gen.ts`, así que
las pestañas nuevas sólo se validan DESPUÉS del build) y después
`tsc.CMD --noEmit`. Más el borde server-only:

```
Get-ChildItem -Recurse dist/client -File | Select-String "partnerCoverageBoard|loadCatalog|jsonb_agg" -List
```

Cero resultados — `~/server/partners.repo` no está en el grafo del cliente.
