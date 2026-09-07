# Manuales de vehículos (`/vehiculos/catalogo`, `/vehiculos/catalogo/:id`)

> Las URLs eran `/catalogo` y `/catalogo/:id`. El 2026-09-06 la sección pasó a
> llamarse **Vehículos** y el catálogo es una de sus tres pestañas. Todo lo de
> este documento sigue valiendo tal cual — sólo cambió el prefijo de la ruta.
> → `.claude/rules/vehicles.md` para las otras dos pestañas.

Alcance: `src/lib/manuals.ts`, `src/server/backend.ts`, `src/server/catalog.repo.ts`,
`src/fn/manuals.ts`, `src/components/ManualUploader.tsx`,
`src/routes/_authed/vehiculos.catalogo.index.tsx`,
`src/routes/_authed/vehiculos.catalogo.$catalogId.tsx`.

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

## El flujo son CUATRO llamadas, y la secuencia no es atómica

Ver la trampa 2 para el detalle completo. El punto operativo: si un paso posterior a la subida
falla, **el PDF ya está en Spaces** y no hay `DELETE /files` en el backend para limpiarlo.

La respuesta no es esconderlo. `ManualUploader` guarda en el estado `uploaded` el `fileId` del PDF
ya subido, y el botón de reintento vuelve a llamar a `submit()`, que ve ese id y **saltea los pasos
1 y 2**. Con un manual de 80MB, esa es la diferencia entre reintentar y rendirse.

`uploaded` se limpia en cuanto el operador elige OTRO archivo: reintentar con un id que no
corresponde al archivo elegido asociaría el PDF equivocado.

Antes esto vivía en un server function aparte (`retryLinkCatalogManual`), porque cuando el panel
proxeaba el archivo re-subirlo costaba la transferencia entera. Con la subida directa el ahorro es
el mismo y el código es uno solo — se borró.

**No agregues un reintento automático.** Los motivos por los que falla el paso 4 —catálogo
inexistente, rol insuficiente— no se arreglan solos: reintentar sólo agrega latencia antes del
mismo error.

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

### 2. Proxear el archivo era la arquitectura equivocada — RESUELTO el 2026-09-04

Esta sección decía que el techo eran los 10MB del backend. Era falso, y el modo de falla fue el
peor posible: producción devolvió `FUNCTION_PAYLOAD_TOO_LARGE` (región `gru1`) y el PDF **nunca
llegó al backend**.

Había TRES límites y ganaba el más bajo:

| Salto | Límite | Configurable |
|---|---|---|
| browser → server function del panel | **4.5MB** | **NO.** Vercel Serverless Functions, límite de plataforma |
| server fn → `POST /files` | 10MB | sí, en el backend |
| backend → Spaces | sin límite práctico | — |

**En local no aparecía.** El preset es `node-server`, que no tiene ese techo; sólo `vercel` lo
tiene. Por eso el bug sobrevivió al build, al typecheck y al SQL verificado, y salió recién en el
primer deploy.

> **Regla general que sale de esto:** un límite de plataforma no se verifica en desarrollo. Se
> releva leyendo la doc del target de deploy, y se escribe acá antes de que muerda.

#### El arreglo NO fue un número más grande

Un manual de 300 páginas no entra en 4.5MB ni en 10MB. **Lo que estaba mal era que el archivo
pasara por un servidor nuestro.** Se implementó subida directa con presigned PUT, en los dos repos.

El flujo hoy son cuatro llamadas, y el archivo va en la que no toca ningún servidor propio:

```
1. POST /api/v1/files/upload-url        → { fileId, uploadUrl, expiresAt }   (JSON, ~200 bytes)
2. PUT  <uploadUrl>                     → el NAVEGADOR sube a Spaces   ← el archivo va POR ACÁ
3. POST /api/v1/files/confirm           → verifica y crea la fila `files`     (JSON)
4. POST /api/v1/vehicle-catalog-manuals → asocia el manual al catálogo        (JSON)
```

El backend ya tenía la mitad: `IFileStorageProvider.getSignedUploadUrl()` existía para
`driving-session` y sus chunks de telemetría, con este mismo argumento escrito en su comentario.
`GetDrivingSessionChunkUploadUrlHandler` fue el precedente que se espejó.

**`POST /files` (multipart) NO se deprecó.** Para una foto de cédula sacada con el celular, una
sola request sigue siendo más simple que tres. Los dos caminos conviven.

#### Las cuatro decisiones del flujo directo

1. **La fila de `files` se crea en el CONFIRM, no al pedir la URL.** Hay FKs apuntando a `files.id`
   (`vehicle_catalog_manuals`, `insurances`), así que una fila sin objeto es un dato corrupto
   **referenciable** — un manual apuntando a un archivo que no existe. Un objeto sin fila es basura
   invisible en el bucket. Entre los dos huérfanos posibles, se eligió el barato.

2. **Entre los dos pasos el backend NO guarda estado.** La key se deriva de
   `(fileId, originalName)`, y por eso `buildFileObjectKey` tiene su propio spec que fija que es
   determinística. Corolario: el confirm tiene que recibir el MISMO `originalName`; otro nombre
   apunta a una key que no existe y vuelve 404.

3. **El `ContentLength` se firma DENTRO de la URL.** Sin eso, una URL pedida para un PDF de 6MB
   sirve para subir 5GB: el presigned PUT no tiene límite propio y el archivo ya no pasa por
   `@fastify/multipart`, que era quien lo aplicaba. En el adapter hace falta además
   `signableHeaders: new Set(['content-length', 'content-type'])` — sin eso el SDK **no** los
   firma, y la condición queda escrita en el código pero ausente de la URL, que es el peor
   resultado posible porque parece aplicada.

   > Ese `Set` **REEMPLAZA** la lista, no se suma a ella. La primera versión pasaba sólo
   > `content-length` y una URL real de producción salió con
   > `X-Amz-SignedHeaders=content-length;host`: el `ContentType` estaba en el comando pero fuera
   > de la firma — declarado y no exigido. `host` no hace falta listarlo, lo agrega el SDK.

4. **El sniffing de magic bytes se recupera en el confirm. ESTO NO SE PUEDE OMITIR.** El presigned
   PUT saltea `UploadFileHandler`, que era el único lugar del sistema donde se verificaba el tipo
   real; sin el confirm, un `.zip` renombrado a `.pdf` entraría sin que nada lo note — una
   regresión de seguridad cambiada por comodidad. El backend lee los primeros 8KB con
   `IFileStorageProvider.peek()` (método nuevo) y exige lo mismo que exigía el otro camino. **No se
   usa `download()`**: bajar un PDF de 80MB para mirarle el principio sería volver a proxear el
   archivo, que es justo lo que este flujo vino a evitar.

De regalo, `peek()` devuelve el tamaño REAL del objeto guardado, así que `files.size_bytes` es
ahora mejor dato que en el flujo multipart: no depende de lo que el cliente declaró.

#### 5. El SDK de AWS firma un checksum del VACÍO, y eso rompe todo presigned PUT

Es la trampa más cara de este flujo, porque no la produce nuestro código sino un **default** del
SDK, y sobrevive a cualquier revisión que mire sólo el diff.

Desde `@aws-sdk/client-s3` v3.729 el cliente trae `requestChecksumCalculation: 'WHEN_SUPPORTED'`:
calcula un checksum para toda operación que lo admita. Al **presignar** eso es catastrófico —
todavía no hay body, así que calcula el checksum de cero bytes y lo **firma en la URL**. Visto en
producción el 2026-09-05:

```
x-amz-checksum-crc32=AAAAAA%3D%3D&x-amz-sdk-checksum-algorithm=CRC32
```

`AAAAAA==` en base64 es `00 00 00 00`: el CRC32 de un archivo vacío. **La URL exigía que el objeto
subido estuviera vacío.** El navegador manda 5.8MB, el checksum no coincide y el proveedor rechaza
el PUT.

El arreglo es `requestChecksumCalculation: 'WHEN_REQUIRED'` en el `S3Client`. `DeleteObjects`, que
sí lo exige, sigue teniendo su `Content-MD5`; `PutObject` no lo requiere, así que `upload()` no
cambia — la integridad del transporte ya la da TLS.

**Está fijado por un guardián que firma de verdad**, en
`digitalocean-spaces.provider.spec.ts` → `describe('getSignedUploadUrl — la URL real…')`. Ese
bloque **no mockea el presigner** a propósito: el checksum lo agrega el `S3Client` por dentro y con
el mock puesto sería invisible. Verificado por mutación: sacando el `WHEN_REQUIRED`, ese test falla.

> **Y esa es la razón por la que el guardián existe: es un default de una dependencia.** Puede
> volver con cualquier bump de versión, sin diff que revisar y sin nada que avise.

#### Lo que hay que configurar FUERA del código

**CORS en el bucket de DigitalOcean Spaces.** El `PUT` del paso 2 sale del navegador hacia
`*.digitaloceanspaces.com`, así que el bucket tiene que permitir el origen del panel. Sin eso
**todas** las subidas fallan igual, y el navegador no da detalle a propósito — por eso
`readableManualError` traduce `STORAGE_PUT_FAILED:` nombrando CORS como causa probable en vez de
mostrar "Failed to fetch".

La configuración exacta, y **`content-type` es el único header que hay que permitir**:

| Campo | Valor |
|---|---|
| Origin | el dominio del panel (uno por línea; `http://localhost:3000` para probar en local) |
| Allowed Methods | `PUT` |
| Allowed Headers | `content-type` |

> **Por qué NO va `content-length`, aunque el backend lo firme.** La primera versión del uploader lo
> mandaba explícito y esta tabla lo pedía. Los dos estaban mal: **`Content-Length` es un *forbidden
> header name* de la Fetch API**, así que el navegador descarta lo que el código ponga y calcula el
> suyo desde el body. Nunca aparece en `Access-Control-Request-Headers` del preflight, así que
> permitirlo en el bucket no hace nada.
>
> La firma valida igual y por el mismo motivo: el `Content-Length` que pone el navegador es el
> tamaño real del `File`, o sea exactamente el `sizeBytes` con el que se pidió la URL.
>
> Regla general: **un header que la Fetch API prohíbe no se declara ni en el código ni en el CORS.**
> Escribirlo no rompe nada y por eso sobrevive — pero documenta un contrato que no existe.

El `PUT` con `Content-Type: application/pdf` **no** es una *simple request*, así que dispara un
preflight `OPTIONS` que el bucket tiene que contestar. Si el CORS no está, lo que falla es el
preflight y el `fetch` tira `Failed to fetch` sin status ni cuerpo — de ahí que el diagnóstico
tenga que venir del mensaje del panel y no del navegador.

Es configuración de DigitalOcean, no está versionada en ningún repo. Si un día las subidas empiezan
a fallar todas juntas sin que nadie haya tocado código, mirá ahí primero.

> Dato relacionado, verificado el mismo día: **el backend no tiene CORS** (cero `enableCors`, cero
> `@fastify/cors` en todo `src/`). No hace falta para este flujo —el navegador sólo habla con
> Spaces, no con el backend— pero descarta el camino alternativo de llamar a `POST /files` directo
> desde el browser.

#### El límite que queda

`MAX_DIRECT_UPLOAD_FILE_SIZE_BYTES = 100MB`, en
`autolibre-backend-hex/src/files/file/application/direct-upload.ts`. Es una constante **distinta**
de `MAX_UPLOAD_FILE_SIZE_BYTES` (10MB) y no es duplicación: esa mide cuánto está dispuesto a
bufferizar nuestro servidor en un multipart, y acá el archivo no pasa por nuestro servidor.

Existe igual porque una URL de subida sin tope es una invitación a que cualquier usuario
autenticado llene el bucket. Se aplica dos veces: al firmar (como `ContentLength`, impide que el
objeto llegue a existir) y al confirmar (contra el tamaño real, que no depende de que el proveedor
respete la condición).

Sigue estando mal, y por los mismos motivos de siempre: trocear del lado del cliente (necesitaría
multipart upload, que el backend no expone) y comprimir en el browser (degrada un manual escaneado
hasta volverlo ilegible).

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
