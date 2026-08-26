# autolibre-admin — Panel de administración

Panel web interno de AutoLibre. Consume el mismo dominio que la app mobile y el backend hexagonal.

## Por qué existe este repo

Hoy **no hay panel**. El CLAUDE.md del backend lo dice explícitamente, en la nota de `marketplace/`:

> *"El Google Sheet se va. No hay sincronización, no hay cron: la fuente de verdad es Postgres. Y el
> admin opera con SQL directo (DBeaver), no con un panel web — de ahí que la sección 9 tenga triggers
> de `updated_at` y una función `approve_partner_application()`, que son la única cosa de su tipo en
> todo el schema."*

Eso es lo que este repo viene a reemplazar. Consecuencia directa y no negociable: **cada pantalla
tiene que sustituir una consulta que hoy alguien corre a mano en DBeaver.** Una pantalla que no
reemplaza a ninguna no tiene por qué existir todavía.

Corolario sobre `approve_partner_application(p_application_id, p_reviewer_id, p_coverage_zone)`: esa
función existe porque no había panel. Cuando el panel la reemplace, la condición que el backend le
puso sigue vigente — *"que se mantenga flaca: mueve estado y copia datos, no decide nada"*. Si el
panel necesita decidir algo, decide el panel o decide un caso de uso del backend, nunca la función.

## Repos hermanos (fuentes de verdad, en este orden)

| Repo | Path | Qué manda desde ahí |
|---|---|---|
| `autolibre-backend-hex` | `../CLEAN-ARCHITECTURE/autolibre-backend-hex` | Contratos de API, bounded contexts, vocabulario del dominio, DDL (`autolibre-ddl-ddd.md`) |
| `autolibre-mobile` | `../autolibre-mobile` | Design system (`modules/shared/ui/theme/tokens.ts`), patrón Clean/Hex adaptado a cliente |

**No se copian decisiones de producto de acá para allá.** Si el panel necesita un endpoint que no
existe, se agrega en el backend con su TDD, no se resuelve con un SQL desde el panel.

> `autolibre-backend` (sin `-hex`, en `ram_projects/`) es OTRO repo — monorepo npm `vehicle-care`.
> El que manda es el `-hex`. Si una ruta te lleva al otro, estás mirando el lugar equivocado.

## Stack

- **TanStack Start** (`@tanstack/react-start`) sobre **TanStack Router** file-based
- React 19 · Vite 8 · TypeScript 7 (`tsc --noEmit`)
- **Tailwind v4** (config CSS-first, sin `tailwind.config.js`) + **shadcn/ui** (estilo `new-york`)
- Nitro para el empaquetado por runtime (`@tanstack/nitro-v2-vite-plugin`)
- **Postgres directo** vía `pg` (`src/server/db.ts`) + **Clerk** para identidad
- Inspección de schema con el skill `db-connect` (solo lectura)
- **El gestor de paquetes es `pnpm`.** Igual que en el backend hex.

## Comandos

```bash
pnpm dev          # servidor de desarrollo en :3000
pnpm build        # build de producción → .output/
pnpm start        # correr el build (node-server)
pnpm typecheck    # tsc --noEmit
```

Consultar la base (solo lectura, desde la raíz del repo):

```bash
node .claude/skills/db-connect/query.mjs "select ..."
```

**Nunca correr un build nativo ni `--allow-write` contra la base sin pedirlo.** La verificación es
`pnpm typecheck` + `pnpm build`.

## Reglas duras (no negociables)

1. **El design system NO se inventa.** Todo color, tipografía, espaciado y radio sale de
   `autolibre-mobile/modules/shared/ui/theme/tokens.ts`, portado a tokens CSS en `src/styles.css`.
   Un hex tipeado a mano en un componente es un bug. → `.claude/rules/design-system.md`
2. **El sistema es light-only y sin sombras.** No hay dark mode (en mobile `Colors.dark` espeja a
   `light` como fallback de tipado) y `Shadows` es `{ shadowOpacity: 0, elevation: 0 }` en los tres
   niveles. Las superficies se separan con **bordes**. Nada de `shadow-*`.
3. **El verde es acento, no protagonista.** La base visual es blanco/gris/Action Dark (`#1C2B1C`).
   `--primary` de shadcn es Action Dark, no el verde de marca — a propósito.
4. **Nada de trabajo de servidor fuera de `src/server/**`.** Ese árbol lleva el marcador
   `import '@tanstack/react-start/server-only'` y está bloqueado para el grafo del cliente por
   `importProtection` en `vite.config.ts`. Una violación rompe el build, no se filtra.
5. **Un search param no validado no existe.** Toda query string entra por `validateSearch` con un
   schema de zod en `src/lib/search.ts`. Ese mismo schema valida el payload del server function y del
   endpoint HTTP: una definición, tres puntos de aplicación.
6. **El modo de SSR se elige por ruta y se justifica en un comentario.** `true` / `'data-only'` /
   `false` no son gustos. → `.claude/rules/tanstack-start.md`
7. **El vocabulario es el del backend.** Se dice `Partner`, nunca `Provider` (el sufijo `Provider`
   está reservado para integraciones externas). `PartnerApplication` es el taller viniendo hacia
   nosotros; `Lead` es el usuario yendo hacia el taller. Confundirlos desalinea la conversación
   entera sin que nadie lo note.
8. **No inventar contenido de dominio.** Datos de ejemplo, entidades o pantallas fabricadas se
   marcan explícitamente como placeholder o no se escriben. Hoy `src/server/placeholder-data.ts`
   y el dominio `RecordItem` de `src/lib/types.ts` son placeholder declarado, y se borran con la
   primera pantalla real → `.claude/rules/partner-approval.md`.
9. **No `git commit` salvo que se pida en ese turno.**

## Mapa del repo

```
src/
├── routes/                  # File-based routing. Un archivo = una URL.
│   ├── __root.tsx           # Documento completo (<html> abajo) + fuentes + head
│   ├── _authed.tsx          # Layout pathless: guard de sesión + shell de la app
│   ├── _authed/             # Todo lo que requiere sesión
│   └── api/                 # Endpoints HTTP (server.handlers)
├── fn/                      # Server functions: el borde RPC tipado
│   └── middleware.ts        # request/function middleware (sesión, roles)
├── server/                  # SERVER-ONLY. Acceso a datos y secretos.
│   ├── db.ts                #   pool de pg — todo el SQL pasa por acá
│   └── session.ts           #   Clerk (quién) + users.role (qué puede)
├── lib/                     # Contratos compartidos: types, schemas de search, format, cn
├── components/
│   └── ui/                  # shadcn — generado, se edita solo con criterio
├── styles.css               # Design tokens + capa base de Tailwind
├── router.tsx               # createRouter + RouterContext
└── start.ts                 # createStart: defaultSsr + request middleware
```

## Decisiones tomadas

### 1. El panel habla con Postgres directo, usando stored procedures

**Decidido.** Se aparta a propósito de la regla de mobile ("los adaptadores nuevos apuntan al backend
hex por default"), y el motivo es concreto: **el trabajo del admin ES el SQL que ya existe.**
`approve_partner_application()`, la vista `v_partner_application_queue` y el runbook de
`autolibre-backend-hex/scripts/sql/` no son un detalle de implementación que convenga esconder detrás
de REST — son la lógica. Re-expresarlos como endpoints agregaría un salto sin agregar una regla.

Lo que esto **no** habilita: meter decisiones de dominio en SQL. La condición que el backend le puso
a `approve_partner_application()` sigue vigente — *mueve estado y copia datos, no decide nada.*

El acceso vive en `src/server/db.ts` (pool de `pg`, server-only). Todo pasa por ahí.

### 2. Auth: Clerk web + rol desde Postgres — IMPLEMENTADO

Son **dos chequeos independientes** y confundirlos es el bug que `src/server/session.ts` existe para
prevenir:

- **Clerk** contesta *"¿es una identidad real y logueada?"*. Dueño de la sesión. No sabe de roles.
- **Postgres** contesta *"¿qué tiene permitido?"*. La fila de `users` trae `role`, y es la única
  autoridad sobre eso.

Una sesión válida de Clerk **no alcanza** para entrar al panel: todos los usuarios de la app tienen
una. La clave de lookup es el par `(auth_provider, external_auth_id)`, **nunca el email**.

Piezas: `clerkMiddleware()` en `src/start.ts` · `<ClerkProvider>` en `__root.tsx` · `<SignIn />` en
`/login` · guard de admin en `_authed.tsx` · `/sin-acceso` para el logueado-que-no-es-admin ·
`adminMiddleware` en `src/fn/middleware.ts` para el lado servidor.

> El guard de ruta modela lo que la UI ofrece. **Un server function es un endpoint HTTP público**:
> el chequeo de rol va también ahí, siempre.

## ⚠ Riesgo abierto: 761 admins heredados

Relevado el 2026-08-26 sobre la base real:

| role | auth_provider | filas |
|---|---|---|
| user | native | 1891 |
| **admin** | **native** | **761** |
| user | clerk | 124 |
| **admin** | **clerk** | **2** |

El 28% de la base figura como admin, todos `native` (era pre-Clerk). Huele a default mal migrado, no
a decisión.

**Hoy no pueden entrar**: el lookup está acotado a `auth_provider = 'clerk'` y una fila native nunca
matchea una identidad de Clerk. Eso es un **efecto colateral, no una salvaguarda** — el día que
alguien migre una cuenta native a Clerk, hereda admin.

No lo "arregles" ampliando la query. El arreglo es una auditoría de datos del lado del backend, y no
es decisión de este repo.

## Decisión abierta

**El enum `user_role` todavía tiene `'provider'`.** El backend ya avisó que quedó viejo (se dice
Partner). Cambiarlo obliga a recrear el tipo entero — es una decisión aparte, no un olvido.
`src/lib/types.ts` lo espeja tal cual a propósito: un enum de front que no coincide con la base
renderiza filas en blanco el día que aparece un valor que no conoce.

## Índice de rules (`.claude/rules/`)

| Rule | Cubre |
|---|---|
| `design-system.md` | Tokens, mapeo a shadcn, qué está prohibido, tipografía |
| `tanstack-start.md` | Modos de SSR, streaming, loaders, search params, borde server-only |
| `backend-contracts.md` | Bounded contexts, vocabulario, auth Clerk, dónde vive cada dato |
| `database.md` | Cómo consultar, 42 tablas, enums, las dos funciones de app |
| `partner-approval.md` | La primera pantalla real: el runbook de aprobación de partners y sus trampas |

## Cómo mantener esto vivo

- **Un bug o gotcha confirmado** → va a la rule cuyo alcance cubre los archivos donde muerde.
  Incluí el síntoma, el arreglo equivocado que probaste y por qué falló: los intentos fallidos son
  la parte valiosa.
- **Una ley nueva que aplica a todo** → a la lista de reglas duras de acá arriba.
- Lo que **no** va: cualquier cosa ya visible en el código, y cualquier cosa que solo importó para
  una tarea. Si una regla no se puede escribir como *"la próxima vez hacé X en vez de Y"*, todavía
  no es una regla.
