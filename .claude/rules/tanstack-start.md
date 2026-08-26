---
paths:
  - 'src/routes/**'
  - 'src/fn/**'
  - 'src/server/**'
  - 'src/router.tsx'
  - 'src/start.ts'
---

# TanStack Start — SSR, loaders y el borde de servidor

## El borde server-only

`src/server/**` es el único lugar donde vive acceso a datos y secretos. Dos mecanismos lo sostienen,
y hacen falta los dos:

```ts
// primera línea de todo módulo en src/server/
import '@tanstack/react-start/server-only'
```

Ese import se borra en build; el plugin de import-protection lo usa para envenenar el módulo para el
grafo del cliente. Y en `vite.config.ts`:

```ts
importProtection: {
  enabled: true,
  behavior: 'error',
  client: { files: ['src/server/**'], specifiers: ['node:fs', 'node:crypto', 'node:child_process'] },
}
```

El árbol entero queda inalcanzable desde el cliente aunque alguien olvide el marcador. **Una
violación rompe el build; no se filtra en silencio.**

### Por qué `src/fn/**` puede importar `src/server/**`

Un server function se importa desde el cliente (para el stub), pero el cuerpo de `.handler()` y de
`.server()` es un borde que el compilador reconoce: en el build de cliente saca el callback y todo
import que solo él usaba.

Verificado en este repo: el chunk de `login` en el cliente queda como una llamada a un stub
importado, sin nada del handler. `grep` sobre `.output/public` no encuentra ni `PLACEHOLDER_ROWS`, ni
`sessionConfig`, ni `SESSION_SECRET`, ni `queryRecords`.

**Si dudás, verificalo así** — no asumas:

```bash
pnpm build
grep -rl "unNombreQueSoloExisteEnElServidor" .output/public
```

## Modos de SSR — se elige por ruta y se justifica

`defaultSsr: true` en `src/start.ts`. Cada ruta que se desvía **lleva un comentario explicando por
qué**, porque no es un gusto.

| Modo | Qué corre en el servidor | Cuándo |
|---|---|---|
| `true` (default) | Loader **y** componente | Contenido, primer paint de sesión, `<title>` que depende del loader |
| `'data-only'` | Solo el loader; los datos viajan serializados | Detrás de auth (no lo ve un crawler), componente pesado en markup, usuario ya dentro del shell hidratado |
| `false` | Nada | Estado que vive en el browser (`localStorage`, medición del DOM) |

### `ssr: false` no es "no me importa el servidor"

En `/settings` el estado vive en `localStorage`, que no existe durante SSR. Renderizarlo en el
servidor emitiría markup construido con los defaults, garantizado distinto de lo que el browser pinta
un tick después: mismatch de hidratación por construcción, más un flash de valores equivocados.

**El shell y el guard NO se ven afectados.** Una request sin sesión a `/settings` sigue redirigiendo
del lado del servidor, antes de mandar un byte de esa página.

Medido en este repo (bytes del documento): `/records` full SSR 11.687 · `/analytics` data-only 4.123
· `/settings` ssr:false 3.668.

## Streaming

El loader **espera solo lo que la página no puede renderizar sin eso**. Lo lento se devuelve como
promesa sin `await`:

```ts
loader: async ({ abortController }) => {
  const signal = abortController.signal
  const slowPromise = getSlowThing({ signal })   // arranca, NO se espera
  const fast = await getFastThing({ signal })    // esto sí bloquea
  return { fast, slowPromise }
}
```

```tsx
<Await promise={slowPromise} fallback={<PanelSkeleton rows={3} label="…" />}>
  {(data) => <Panel data={data} />}
</Await>
```

**Arrancá la lenta primero.** Si la pedís después del `await`, las dos se serializan y perdés el
paralelismo entero — el error más fácil de cometer acá.

Medido: el dashboard llega en **2 chunks**, las KPIs en el HTML a los 200 ms y el panel lento a los
1266 ms (~1,07 s después), con marcadores `<!--$?-->` y el script de completado de React. Es
streaming de servidor, no un fetch del cliente.

## Search params

`validateSearch` es el **único** lugar donde una query string se vuelve dato tipado. El schema vive
en `src/lib/search.ts` y lo consumen tres cosas: la ruta, el server function y el endpoint HTTP.

### `.catch()` vs. fallar duro — es una decisión por campo

```ts
page: z.coerce.number().int().min(1).catch(1).default(1),   // ?page=banana → 1
minPrice: z.coerce.number().int().min(0).optional(),        // ?minPrice=-5 → error
```

Un `?page=banana` marcado en favoritos tiene que renderizar la página 1, no una pantalla de error. Un
valor genuinamente irrecuperable sí tira, y Router lo muestra por el `errorComponent` de la ruta.

Verificado: `?page=banana&pageSize=9999` → página 1, pageSize 25. `?minPrice=-500` → 400 con el issue
exacto y su path.

### Router normaliza la URL antes del guard

`GET /records?page=2&sort=name` responde **307 a la misma URL con los defaults escritos**
(`&pageSize=25&dir=desc`), y recién la segunda request pega contra el guard de auth. Son 2 redirects
hasta `/login`. No es un bug: es el schema escribiendo sus defaults en la URL.

### Actualizadores funcionales, siempre

```tsx
<Link to="/records" search={(prev) => ({ ...prev, sort: field, page: 1 })} />
```

Nunca un objeto literal que pise el resto. Así "ordenar me borró los filtros" es irrepresentable.

Y los headers de orden son **links, no botones**: el orden ES la URL, así que tiene que ser navegable,
clickeable con el botón del medio y compartible.

## Endpoints HTTP (`src/routes/api/**`)

Van con `server.handlers` en un `createFileRoute` normal. Dos cosas aprendidas acá:

**Llaman al repositorio directo, no al server function.** Los server functions existen para llamarse
desde el cliente con los tipos intactos; adentro de un handler ya estás en el servidor y el salto RPC
es puro overhead.

**No uses `getValidatedQuery`.** Su genérico no está atado al parámetro, así que resuelve a `any` y
borra en silencio los tipos que el endpoint existe para garantizar. Comprobado en este repo: con
`getValidatedQuery(schema)`, `q.propiedadQueNoExiste` compila sin error. Usá `schema.safeParse()`
directo — queda tipado y podés devolver los issues reales en el 400.

## Trampas confirmadas en este repo

**`import.meta.env.DEV` no poda un import estático.** Tener `import('@tanstack/react-router-devtools')`
en el grafo hace que el bundler lo emita igual — 64 kB de devtools más el `jsx-dev-runtime` de React,
en producción. Y el import dinámico detrás del mismo guard **tampoco** alcanzó: el entry seguía
referenciando el chunk. La única solución que funcionó fue sacar devtools del grafo de la app.

**El handler de un server function no tiene `signal` en su contexto.** Ahí `signal` es una opción del
*call site* (aborta el fetch saliente del cliente). Para cancelar el trabajo del servidor cuando el
cliente corta, usá `requestSignal()` de `src/server/request.ts`, que lee la request ambiente.

**Los formatters se fijan en locale y timezone.** `Intl` sin `timeZone` fijo produce markup distinto
en servidor y cliente. `src/lib/format.ts` pinea `es-AR` + `UTC` por eso.

## Runtime de deploy

Es un asunto de **build**, nunca de la aplicación. Nada bajo `src/` sabe dónde corre.

```bash
NITRO_PRESET=node-server        pnpm build   # default
NITRO_PRESET=vercel             pnpm build
NITRO_PRESET=cloudflare-module  pnpm build
```

`vite.config.ts` lo inyecta como `__DEPLOY_TARGET__`, que `/api/health` reporta. Ese es el único
lugar donde el nombre del target llega a `src/`.
