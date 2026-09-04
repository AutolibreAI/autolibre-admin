# Manuales de vehículos (`/catalogo`, `/catalogo/:id`)

Alcance: `src/lib/manuals.ts`, `src/server/backend.ts`, `src/server/catalog.repo.ts`,
`src/fn/manuals.ts`, `src/components/ManualUploader.tsx`,
`src/routes/_authed/catalogo.index.tsx`, `src/routes/_authed/catalogo.$catalogId.tsx`.

## El manual cuelga del CATÁLOGO, no del spec

Es el error que hay que no cometer y el que la pantalla está diseñada para prevenir:

```
vehicle_catalogs (brand, model, year, trim)
├── vehicle_catalog_specs   (engine, fuel_type, transmission, gear_count)
└── vehicle_catalog_manuals (catalog_id → vehicle_catalogs.id)
```

`vehicle_catalog_manuals.catalog_id` referencia **`vehicle_catalogs`**. El spec es el
*powertrain* y es **hermano** del manual, no su padre.

Y está bien que sea así: un manual de usuario es del modelo/año/versión, no de la variante de
motor. Un Corolla 2021 XEI tiene UN manual, no uno por cada caja. Colgarlo del spec obligaría a
subir el mismo PDF N veces y a mantenerlos sincronizados a mano.

Por eso la ficha muestra las variantes en una tarjeta **sin ningún botón de carga al lado**: verlas
ahí, inertes, es lo que hace que la relación se lea de una.

## Ésta es la única pantalla del panel cuyas escrituras NO son SQL

El resto del panel escribe con stored procedures de `ops`. Acá no, y hay **dos** motivos
independientes — cualquiera de los dos alcanza:

1. **El PDF va a DigitalOcean Spaces, no a Postgres.** El panel no tiene ese adapter, ni las
   credenciales, ni el sniffing de magic bytes con el que `UploadFileHandler` rechaza un `.zip`
   renombrado a `.pdf`. Ninguna cantidad de SQL sube un archivo a un bucket.
2. **El backend SÍ tiene el camino.**

Ese segundo punto es el que decide, y **por eso la excepción de `ops-write-actions.md` no aplica
acá**. Esa regla dice que el panel escribe `public` desde SP de `ops` sólo donde el backend no
tiene camino, y que *"la excepción se gana con un `grep`, no se asume"*. Relevado el 2026-09-04 en
`autolibre-backend-hex`, el grep da **positivo**:

| Qué se buscó | Qué hay |
|---|---|
| `vehicle-management/vehicle-catalog-manual/` | Bounded context COMPLETO: entity, VO, port, 3 casos de uso, repo drizzle + in-memory, DTOs, controller, module |
| `POST /vehicle-catalog-manuals` | Existe, con `@UseGuards(AdminGuard)` |
| `POST /files` | Existe, multipart, devuelve `{ fileId }` |

Contraste con partners y leads, donde el grep dio negativo (`IPartnerRepository` sólo tiene
`findActive()`; `lead` sólo tiene `submit-lead`) y por eso ahí se escriben SP.

**Corolario operativo: si algún día ves un `INSERT INTO vehicle_catalog_manuals` en este repo,
está mal.** Significa que alguien está creando una fila que apunta a un `file_id` que el panel no
puede crear, o un manual sin PDF.

## El flujo son DOS llamadas HTTP, y no son atómicas

```
POST /api/v1/files                  (multipart, sólo sesión)   → { fileId }
POST /api/v1/vehicle-catalog-manuals (JSON, AdminGuard)         → 201 sin body
```

Si la segunda falla, **el PDF ya está en Spaces** y no hay `DELETE /files` en el backend para
limpiarlo.

La respuesta no es esconderlo: `uploadCatalogManual` re-tira el error como
`LINK_FAILED:<fileId>:<motivo>`, la UI extrae el id con `orphanFileId()` y ofrece
**"Reintentar sin volver a subir"** → `retryLinkCatalogManual`. Es la única mitad recuperable.

**No agregues un reintento automático del segundo paso.** Los dos motivos por los que falla
—catálogo inexistente, rol insuficiente— no se arreglan solos: reintentar sólo agrega latencia
antes del mismo error.

## Auth: el token de Clerk del admin, sin cuenta de servicio

El `AuthGuard` del backend es global (`APP_GUARD`) y verifica `Authorization: Bearer <token>` con
Clerk (`ClerkAuthProvider.verifyToken`). El panel usa la **misma instancia** de Clerk que la app,
así que `auth().getToken()` sirve tal cual, **sin JWT template** — el único claim obligatorio es
`sub`. Si el template no trae `email`, el backend paga un round trip a la API de Clerk y loguea un
warn una vez por proceso; es configuración del dashboard de Clerk, no de este repo.

**La request viaja con la identidad del admin real, jamás con una cuenta de servicio.**
`files.user_id` queda a su nombre, y eso es lo que hace auditable quién subió cada manual — mismo
criterio que `p_actor_id` en los SP de `ops`. Una cuenta de servicio ahorraría la trampa de abajo
al precio de borrar la única auditoría que hay.

Env var: **`AUTOLIBRE_BACKEND_URL`**, con el prefijo `/api/v1` incluido. En dev tiene default
(`http://localhost:3005/api/v1`, el puerto de `main.ts`); en producción **no**, y falla. Adivinar
una URL de producción es peor que fallar: un typo manda PDFs a un host que no controlás.

Falla en el **primer uso**, nunca al cargar el módulo — misma lección que `db.ts` documenta y que
costó un incidente en Vercel.

## Las cuatro trampas confirmadas

### 1. `GET /files/:id/url` está acotado al DUEÑO del archivo

`GetFileSignedUrlHandler` hace `fileRepository.findById(query.id, query.userId)`. O sea: **el admin
que subió el manual es el único que puede después descargarlo desde el panel.** Otro admin recibe
**404, no 403** — el backend no le confirma a un extraño que ese id existe.

Con 3 usuarios en producción esto muerde apenas dos personas carguen manuales.

**No se arregla desde este repo.** El arreglo honesto es que el backend deje a un admin leer
cualquier `file`, y eso es decisión de su contexto de permisos. Lo que sí hace el panel: **muestra
el email de quien subió cada manual**, para que el 404 se lea como *"pedísela a fulano"* y no como
*"está roto"*. Esa columna no es adorno; es la mitigación entera.

Ojo con el precedente tentador: `CreateVehicleCatalogManualHandler` llama a `findById(fileId)` **sin
userId**, con un comentario que dice que los manuales no tienen dueño. O sea que el backend YA sabe
que un manual es dato de referencia — pero esa excepción vive en el alta, no en la descarga.

### 2. Límite de 10MB, y los manuales reales suelen pasarlo

`MAX_UPLOAD_FILE_SIZE_BYTES = 10MB` en `upload-limits.ts`, aplicado por `@fastify/multipart`. Un
manual de usuario en PDF pesa típicamente entre 5 y 30MB.

Se valida **tres veces** y no es paranoia:

| Dónde | Para qué |
|---|---|
| `ManualUploader` (browser) | Que el operador se entere ANTES de transferir 40MB |
| `parseManualUpload` (server fn) | Que no se pueda saltear el form |
| `@fastify/multipart` (backend) | La autoridad |

El del browser es el que importa en la práctica: el 413 del backend llega recién **después** de
haber transferido el archivo entero.

**Si el PDF no entra, el arreglo es del backend (subir la constante), no del panel.** No trocear
del lado del cliente —requeriría un endpoint que no existe— ni comprimir en el browser, que
degrada un manual escaneado hasta volverlo ilegible.

### 3. `vehicles` NO apunta al catálogo: apunta al SPEC

`vehicles.vehicle_catalog_spec_id` es NOT NULL con FK a `vehicle_catalog_specs`, y recién ese tiene
`vehicle_catalog_id`. **Contar vehículos de un catálogo son DOS saltos:**

```sql
(SELECT count(*)::int
   FROM vehicles v
   JOIN vehicle_catalog_specs s ON s.id = v.vehicle_catalog_spec_id
  WHERE s.vehicle_catalog_id = c.id)
```

La versión obvia (`where v.vehicle_catalog_id = c.id`) ni siquiera compila. La peligrosa es la
sutil: contar specs y llamarlo vehículos da un número **plausible y más chico** que el real, y un
número plausible y equivocado no lo cachás nunca.

**Chequeo de regresión** (corrido el 2026-09-04, dio 79 = 79):

```sql
SELECT (SELECT count(*) FROM vehicles) total,
       (SELECT sum(x) FROM (SELECT (SELECT count(*) FROM vehicles v
          JOIN vehicle_catalog_specs s ON s.id = v.vehicle_catalog_spec_id
         WHERE s.vehicle_catalog_id = c.id) x FROM vehicle_catalogs c) t) suma;
```

Si los dos números no coinciden, hay fan-out. Los tres contadores del listado son subconsultas
escalares y no JOINs por esta razón — mismo criterio que `listUsers` en `users.repo.ts`.

### 4. `POST /vehicle-catalog-manuals` no valida catálogo ni duplicados

`CreateVehicleCatalogManualHandler` valida **sólo** el `fileId`. Dos consecuencias:

- Un `catalogId` inexistente llega hasta la FK de Postgres y vuelve como error crudo. Por eso el
  panel manda un `catalogId` que salió de su propio `SELECT`, nunca uno tipeado.
- **No hay UNIQUE sobre `(catalog_id, …)`**: se pueden crear diez manuales idénticos y nada se
  queja. La única defensa es de UI — el uploader va **al lado** de la lista de manuales ya
  cargados, no encima, para que el duplicado se vea antes de crearlo. Y el `<input type="file">`
  se vacía por `ref` después de una carga exitosa: sin eso el nombre del PDF ya subido queda en
  pantalla y el operador vuelve a apretar "Subir" creyendo que no pasó nada.

## `NULL` vs `''`, otra vez

`version` y `language` son `text NULL`. **Los campos vacíos NO se mandan** —
`linkManualToCatalog` omite la clave del JSON en vez de mandar `""`. Un string vacío es el mismo
dato roto que dejó el import del `legacy_sheet` y la razón por la que todo chequeo de "falta este
campo" en este repo se escribe `coalesce(x,'') = ''` en vez de `x IS NULL`.

## El idioma es una lista cerrada, y eso es una decisión del panel

La columna es `text NULL` y el backend no valida nada. Un input libre se llenaría de `"Español"`,
`"español"`, `"ES"`, `"es-AR"` y `"castellano"`.

Elegir de `MANUAL_LANGUAGES` **no inventa dominio** (regla dura 8): la columna sigue siendo texto
libre. Impone una convención en el único lugar donde hoy se escribe esa columna.

Corolario que sí importa: **la ficha muestra un idioma desconocido CRUDO, no lo esconde.** El día
que aparezca un `"castellano"` cargado desde otro lado hay que poder verlo — que es justamente el
problema que la convención quiere evitar.

## Cuándo el cero se muestra

Coherente con `users.md` y opuesto a Inicio: **la lista de manuales muestra el vacío con texto que
lo explica**, no desaparece. Es el estado de los 83 catálogos al 2026-09-04, así que es la pantalla
que más se va a ver — y "todavía no hay manual" es distinto de que parezca que algo no cargó.

En el listado, el chip **"Sin manual (N)"** usa `tone="warn"` y no `brand`: acota a filas
problemáticas, y pintarlo de verde diría "seleccionado y todo bien", que es lo contrario.

## Qué NO se implementó, y por qué

- **Borrar un manual.** No hay `DELETE /vehicle-catalog-manuals/:id` en el backend, y tampoco
  `DELETE /files/:id`. Un `DELETE` por SQL desde el panel dejaría el PDF huérfano en Spaces para
  siempre, sin registro. Si hace falta, el lugar es el backend.
- **Editar versión o idioma de un manual cargado.** Mismo motivo: el controller sólo tiene `POST` y
  dos `GET`. No hay `PATCH`.
- **Crear un catálogo desde el panel.** `POST /vehicle-catalogs` existe con `AdminGuard`, así que
  sería posible — pero los 83 catálogos ya están y ninguna consulta de DBeaver los creaba a mano.
  Una pantalla que no reemplaza ninguna consulta no va todavía.
- **Carga masiva de N PDFs.** Con 83 catálogos y PDFs sueltos, el matcheo PDF ↔ modelo lo hace una
  persona igual. Multi-archivo agrega estado de N subidas, errores parciales y reintentos por fila
  para ahorrar clicks en el paso que no es el cuello de botella.

## Cómo verificar un cambio acá

`pnpm typecheck` + `pnpm build` (el build regenera `routeTree.gen.ts`, así que un `Link to` a una
ruta nueva sólo se valida DESPUÉS del build — el typecheck solo pasa igual).

Y el chequeo de borde server-only, que acá tiene un falso positivo esperado:

```bash
grep -rl "POSTGRES_DATABASE_URL\|sqlOne\|bearerToken\|server/backend" .output/public
```

`AUTOLIBRE_BACKEND_URL` **sí aparece** en el bundle del cliente y está bien: es el NOMBRE de la
variable dentro de un mensaje de `readableManualError`, que es una función de traducción que corre
en el browser a propósito. El valor no viaja, y `~/server/backend` no está en el grafo del cliente.
