# Escrituras del panel: stored procedures de `ops` sobre `public`

Alcance: `migrations/007_ops_acciones_admin.sql`, las funciones `setPartner*` de
`src/server/partners.repo.ts`, `src/server/leads.repo.ts`, `src/fn/leads.ts`, las
`setPartner*Fn` de `src/fn/partners.ts`, `src/components/PartnerFicha.tsx`,
`src/routes/_authed/leads.tsx`. La 010 suma
`migrations/010_ops_editar_solicitud.sql`, `updatePartnerApplication` de
`src/server/partners.repo.ts`, `updatePartnerApplicationFn` de
`src/fn/partners.ts` y `src/components/ApplicationEditor.tsx`.

## La regla que esto reemplaza, y por qué

El CLAUDE.md decía: *"Si el panel necesita un endpoint que no existe, se agrega en el backend con su
TDD, no se resuelve con un SQL desde el panel."*

**Esa regla es inaplicable para el marketplace, y no por conveniencia.** Verificado en
`autolibre-backend-hex` el 2026-08-30:

| Qué se buscó | Qué hay |
|---|---|
| `IPartnerRepository` (`marketplace/partner/application/port/`) | SÓLO `findActive()` y `findActiveById()`. Sin `save`, sin `update`. |
| Casos de uso de `partner` | `get-partner`, `list-partners`. Nada más. |
| `grep "update(partners)"` en todo `src/` | cero resultados |
| Casos de uso de `lead` | `submit-lead`. Crea en `new` y termina. |
| `grep "update(leads)"` en todo `src/` | cero resultados |

**El backend no puede editar un partner ni mover un lead.** No es que convenga que lo haga el panel:
no existe otro camino. Mandar a "pedirlo como caso de uso" era mandar a pedir features que no están
en ningún lado y dejar al admin bloqueado indefinidamente.

Y para leads el backend además lo dice explícitamente, en `lead-status.vo.ts`:

> *"La app solo crea leads en `new`; el resto del recorrido lo mueve el equipo desde SQL, igual que
> el pipeline de las solicitudes."*

O sea que el SQL a mano ya estaba designado. Lo que cambia con esta migración es **dónde vive**: deja
de ser una sentencia pegada en DBeaver y pasa a estar versionada, revisada y auditada.

## Los guardrails, y ninguno es opcional

1. **Viven en `migrations/`.** Nunca DDL a mano desde DBeaver — eso recrea el problema que este repo
   existe para matar.
2. **`SECURITY INVOKER`** (el default). `DEFINER` convertiría cada función en una escalada de
   privilegios. El control de acceso es de `adminMiddleware`, donde está la sesión.
3. **`SET search_path` fijo en cada función.** Sin eso, un `search_path` manipulado puede hacer que
   `partners` resuelva a otra tabla.
4. **`p_actor_id` sale de la sesión de Clerk, JAMÁS del payload.** No está en ningún schema de zod, a
   propósito. `ops.action_log` es el único registro de quién cambió qué en el marketplace —
   `partners` sólo tiene `updated_at`, que dice cuándo y no dice quién. Un actor por payload lo
   convierte en una firma falsificable, o sea en ninguna auditoría.
5. **Escriben `ops.action_log` DENTRO de la función**, con `before` y `after` completos en jsonb. Un
   UPDATE desde el repo más un INSERT de log serían dos sentencias separables, y el modo de falla es
   el peor posible: el cambio queda y el registro de quién lo hizo no.
6. **Ninguna FK cruza a `public`.** `actor_id` y `target_id` son UUID pelados.
7. **`SELECT ... FOR UPDATE` antes de escribir.** Dos admins sobre el mismo partner se serializan;
   sin eso el `before` del log puede ser de un estado que ya no existía.
8. **`updated_at` NO se toca**: `trg_partners_updated_at` y `trg_leads_updated_at` ya lo hacen.
   Escribirlo a mano *y* por trigger es duplicación que diverge en silencio.

## Lo que estas funciones deliberadamente NO deciden

Sigue vigente la condición del backend a `approve_partner_application()`: **mueven estado y copian
datos, no deciden nada.** Validan que la operación sea REPRESENTABLE y nada más.

Dos casos donde eso se sintió como una omisión y es a propósito:

- **`set_partner_contact` no exige que quede algún canal de contacto**, aunque un partner publicado
  sin WhatsApp, sin email y sin link sea una ficha rota. Eso es regla de negocio. La pantalla de
  Inicio ya las cuenta como pendiente y el formulario avisa. Si el equipo la quiere obligatoria, el
  lugar es el formulario — donde cambiar de opinión no cuesta una migración.
- **`advance_lead` no exige `lost_reason`**, aunque un "perdido" sin motivo no sirva. La columna es
  NULLABLE en el schema del backend y este panel no endurece un contrato ajeno desde afuera.

## Las dos minas confirmadas

### `idx_leads_open_user_partner_vehicle_unique`

UNIQUE **parcial** sobre `(user_id, partner_id, coalesce(vehicle_id,'000…'))` donde
`status IN ('new','contacted')`. Es la mitad de base del dedupe cuya mitad de aplicación es
`Lead.isOpenStatus()`.

- **Cerrar** (→ `won`/`lost`) siempre se puede: saca la fila del índice.
- **Reabrir** puede chocar, si mientras tanto se abrió otro lead para el mismo trío.

`ops.advance_lead` captura `unique_violation` y la traduce a `LEAD_ALREADY_OPEN` con explicación. Sin
eso la pantalla mostraría el texto crudo de Postgres con el nombre del índice.

`OPEN_LEAD_STATUSES` está en tres lugares —el VO del backend, el `WHERE` del índice y
`src/lib/leads.ts`— y **los tres se tocan juntos**. Si se separan, la UI ofrece reabrir algo que la
base rechaza, o esconde algo que sí se podía.

La UI **no esconde** el botón de reabrir: la colisión depende de otras filas que no están en la
pantalla, así que esconderlo dejaría al operador sin saber por qué no puede.

### Coordenadas incompletas

`set_partner_location` rechaza el par incompleto. Un partner con `latitude` y sin `longitude` no está
"medio geolocalizado": cualquier cálculo de distancia lo lee como `(lat, 0)`, un punto en el Golfo de
Guinea. `(NULL, NULL)` sí se acepta y borra la geo — si alguien cargó mal una coordenada, poder
dejarla vacía es mejor que dejarla mal.

La validación está **duplicada** en `setPartnerLocationSchema` (zod) y en el SP. No es redundancia
inútil: la de zod llega como issue con el path del campo y el formulario la muestra al lado del
input; la del SP es la que **no se puede saltear** y protege a cualquier otro llamador.

## `NULL` vs `''` en `set_partner_contact`

El SP distingue `NULL` ("no toques este campo") de `''` ("borralo"). Sin esa distinción no habría
forma de limpiar un dato mal cargado sin reescribir los otros cuatro.

**El formulario del panel manda siempre los cinco como string**, así que nunca usa el modo parche: lo
que se ve en pantalla es exactamente lo que queda guardado. Un form que manda parches parciales es
más eficiente y es imposible de leer cuando algo sale mal.

Y normaliza `''` → `NULL` al escribir: el import del `legacy_sheet` dejó strings vacíos, que es por
lo que todo chequeo de "falta este campo" en este repo se escribe `coalesce(x,'') = ''` y no
`x IS NULL`.

## Lo que se decidió NO escribir, y por qué

Dos SPs que parecían obvios y se descartaron con motivo técnico, no con la regla:

**Reintentar una notificación fallida** → sería un **no-op**. `notification-delivery.cron` corre cada
minuto sobre `status='pending' AND scheduled_at <= now()`, y ni `markAsFailed()` ni `markAsNoToken()`
tocan `status` — sólo `deliveryStatus`. La fila ya está pendiente y se va a reintentar sola.

Lo que falta es lo CONTRARIO: cortar el loop. Y no se puede hacer honestamente, porque
`notification_status` es `pending | sent | read` — **no hay estado terminal de falla**. El arreglo
real es un valor nuevo en ese enum, que vive en el schema del backend. Empujar `scheduled_at` al
futuro es un workaround que reescribe un campo del dominio para conseguir un efecto que ese campo no
significa.

**Reencolar una consulta VTV** → `idx_vehicle_data_queries_active_vehicle_unique` es UNIQUE parcial
sobre `vehicle_id` donde `status IN ('queued','processing')`. Reencolar choca ese índice, o peor,
**refactura un job al proveedor** — y `provider_job_id` se comparte entre usuarios con la misma
patente. No se toca sin aprobación de quien paga esa factura.

## Cómo se probaron

Suite de 21 casos + 6 de integración del SQL exacto de los repos, **entera dentro de una transacción
que termina en `ROLLBACK`**. Cubre: transiciones válidas, los cinco errores con sentinela
(`INVALID_STATUS`, `PARTNER_NOT_FOUND`, `ACTOR_NOT_FOUND`, `ACTOR_REQUIRED`,
`INCOMPLETE_COORDINATES`, rangos de lat/lng), el sellado de `contacted_at` sin pisar, la limpieza de
`won_at` y `lost_reason` al salir del estado, la colisión del índice único, y que
`ops.action_log` guarde `before`/`after` completos.

**Repetir ese patrón para cada SP nuevo.** Un stored procedure sin probar es peor que no tenerlo: se
ve como una garantía y no lo es.

---

# Migración 008 — el resto de la ficha: perfil y links

Alcance añadido: `migrations/008_ops_partner_perfil_y_links.sql`, su `.test.sql`, las funciones
`setPartnerProfile` / `setPartnerLinks` de `src/server/partners.repo.ts`, sus `*Fn` en
`src/fn/partners.ts`, y las tarjetas `ProfileCard` / `LinksCard` de `src/components/PartnerFicha.tsx`.

Se apoya en la justificación entera de la 007 y no la repite: el backend no tiene ningún camino para
editar un partner, verificado con `grep`, no supuesto.

## Cuándo un SP agrupa campos y cuándo no

La 007 separó estado, ubicación y contacto en tres funciones. La 008 mete zona, descripción y tier en
UNA. No es una inconsistencia: **el criterio es la consecuencia, no la cantidad de campos.**

- Pausar saca al taller del marketplace. Cargar coordenadas lo hace ordenable. Completar el contacto
  lo hace contactable. Son tres cosas distintas y cada una merece su entrada en `ops.action_log`.
- Zona, descripción y badge son tres caras de una sola: **cómo se ve la tarjeta.** Se editan en la
  misma sentada, y separarlas daría tres entradas de auditoría para un solo acto de edición — tan
  inútil como una sola entrada que dice "cambió algo".

## Las cuatro minas de esta migración

### 1. `mercado_libre` tiene que estar en el formulario aunque nadie lo pida

`set_partner_links` deja la tabla **igual** al payload: lo que no viene, se borra. Consecuencia
directa y silenciosa: **un kind que la UI no renderice se borra en el primer guardado.**

Al 2026-09-04 hay 1 link de `mercado_libre` en producción. Sin el campo en el formulario, el primer
admin que edite ese partner lo borra sin enterarse, y no hay forma de notarlo después.

> **Regla que sale de esto: si aparece un kind nuevo en `partner_link_kind`, se agrega a
> `PARTNER_LINK_KINDS` el mismo día.** No es una mejora pendiente, es una pérdida de datos en
> progreso.

### 2. `idx_partner_links_kind_unique` decide la forma del formulario

UNIQUE **parcial** sobre `(partner_id, kind)` WHERE `kind <> 'other'`. Un partner tiene como máximo
un Instagram y un Facebook, pero puede tener muchos `other`.

Por eso la UI es campo único para los seis kinds con restricción y **lista** para `other`. Un
formulario que ofreciera dos Instagram chocaría el índice, y uno que ofreciera un solo `other`
escondería links existentes.

### 3. Maps no existe en el enum, y `other` ya venía siendo su cajón

`partner_link_kind` no tiene `maps`, y este repo no migra `public`. Pero al 2026-09-04, **10 de los
11 links guardados como `other` son de `maps.app.goo.gl`**.

La ficha le da campo propio y lo guarda como `other`; `isMapsUrl()` decide al leer cuál de los
`other` sube a ese campo.

**El caso que la heurística deja afuera a propósito**: `https://share.google/hNP1lXzbykdC3muYU`. Es
un acortador genérico de Google que puede apuntar a cualquier cosa. Clasificarlo como maps por venir
de un dominio de Google sería adivinar, y el costo de adivinar mal es mover el link de alguien a un
campo donde no lo va a buscar. **Ante la duda, cae en "otros"** — ese cajón es visible y editable; un
campo equivocado es invisible.

El arreglo de verdad es un valor nuevo en el enum del backend. Hasta entonces esto es una heurística
y está escrita como tal.

### 4. Un guardado de links NO puede ser `DELETE` + `INSERT`

Parece lo obvio y borra `created_at` de todos los links, incluidos los que nadie tocó. Es la misma
lección que `upsertExcludedDomain` en `ops.repo.ts`, donde el `ON CONFLICT DO UPDATE`
deliberadamente no pisa esa columna: **cuándo se cargó un link es el dato con valor.**

Un operador que corrige un typo en la descripción no debería resetear la antigüedad de nueve links
que no miró. Así que:

- los kinds únicos van por **UPSERT** — conservan `id` y `created_at`, y el trigger mueve
  `updated_at` sólo si la URL cambió de verdad;
- los `other` se matchean **por URL**, porque no tienen clave natural: se borra lo que ya no está y
  se inserta lo que falta. Un `other` idéntico ni se toca.

El caso 17 de la suite es el que verifica esto y es el que justifica todo el diseño.

## `coverage_zone` vacía NO borra: rechaza

`partners.coverage_zone` es NOT NULL en el schema del backend, así que `''` no es "borrá el dato": es
un valor que la columna no puede representar. El SP lo rechaza con `COVERAGE_ZONE_REQUIRED`.

Es la asimetría con `description`, que **sí** es nullable y donde `''` sí borra — mismo contrato que
`set_partner_contact`, y por el mismo motivo: el import del `legacy_sheet` dejó strings vacíos.

La validación está duplicada en zod y en el SP, igual que las coordenadas de la 007, y por la misma
razón: la de zod llega como issue con el path del campo y el formulario la muestra al lado del input;
la del SP es la que no se puede saltear.

## El largo de la descripción se avisa, no se impide

90 caracteres es el largo **ideal** para la tarjeta del marketplace. No es un límite, y el SP a
propósito no lo valida.

El número que lo decide: al 2026-09-04, **25 de los 34 partners con descripción ya lo pasan**
(promedio 114, máximo 248). Un límite duro en el formulario haría imposible corregirle la zona de
cobertura a tres cuartos del directorio.

Por eso pasarse pinta **ámbar y no rojo**: rojo dice "esto está mal", ámbar dice "se va a cortar en
la tarjeta". El techo duro de 600 es otra cosa — no sale de ningún requisito de diseño, es holgura
sobre el máximo real para que nadie pegue un documento entero en un campo `text` sin restricción.

## El vocabulario: es `tier`, no `aliado`

El equipo lo llama "badge de aliado" y la UI lo dice así. **El código dice `tier` y `founding`**,
porque el vocabulario es el del backend (regla dura 7). Un campo llamado `aliado` en el front sería
intraducible el día que alguien abra DBeaver y encuentre `partner_tier`.

La tarjeta lo dice en pantalla —"Escribe `partners.tier`: Aliado es `founding`"— justamente para que
esa traducción no viva sólo en la cabeza de quien la escribió.

## Cómo se probó

`migrations/008_ops_partner_perfil_y_links.test.sql`: 32 casos, **entera dentro de una transacción
que termina en `ROLLBACK`**, con el mismo patrón que la 007.

Crea su propio partner y su propio actor en vez de usar filas reales. El motivo no es sólo no dejar
basura —para eso alcanza el ROLLBACK—: un `UPDATE` sobre un partner real toma su fila con
`FOR UPDATE` y **bloquea a cualquier otro que la toque** mientras la transacción está abierta.

Cubre: los tres campos del perfil, el borrado por `''` y el rechazo de la zona vacía, las cuatro
sentinelas nuevas, que `updated_at` lo mueva el trigger, la conservación de `id` y `created_at` en un
link intacto, el upsert al cambiar una URL, el borrado por ausencia, la deduplicación de `other`, y
que el log de links guarde links y no la fila del partner. Más 2 casos de integración con el SQL de
parámetros nombrados exacto que manda el repo.

---

# Migración 009 — el nombre entra al perfil

Alcance añadido: `migrations/009_ops_partner_nombre.sql` y su `.test.sql`.

`ops.set_partner_profile` pasó a tomar `p_name`. Va adentro del perfil y no en un SP propio por el
mismo criterio de la 008: el nombre es **cómo se presenta el partner en la tarjeta**, igual que la
zona, la descripción y el tier. Se edita en la misma sentada.

## ⚠ `CREATE OR REPLACE` no puede agregar un parámetro

Es la trampa central de esta migración, y muerde en runtime y no al migrar.

Postgres identifica una función por `(nombre, tipos de argumentos)`. Agregarle un parámetro **no la
reemplaza: crea una SOBRECARGA**, y deja la vieja viva al lado. Con las dos existiendo, una llamada
por parámetros nombrados —que es exactamente como llama `partners.repo.ts`— puede matchear las dos, y
Postgres responde:

```
function ops.set_partner_profile(...) is not unique
```

Eso no aparece aplicando la migración. Aparece en el primer guardado de un operador.

Por eso la 009 hace **`DROP FUNCTION` explícito con los tipos de la firma vieja** y recién después
crea la nueva. Y por eso el primer caso de su suite —antes que cualquier prueba de comportamiento—
verifica que exista **UNA sola** `ops.set_partner_profile` en `pg_proc`.

**Regla para cualquier migración que le agregue un parámetro a un SP existente: DROP + CREATE, y una
prueba que cuente las firmas.**

## Un DROP + CREATE puede perder validaciones en silencio

Reescribir una función entera es exactamente donde se cae un `IF` sin que nadie lo note: la migración
pasa, el SP existe, y una validación que estaba dejó de estar.

Por eso los casos 11, 12 y 13 de la suite de la 009 **re-verifican lo que ya probaba la 008** — zona
vacía rechazada, tier inválido rechazado, descripción vacía que borra. No es duplicación por
descuido: es la única forma de saber que la reescritura no se comió nada.

## Las pruebas de perfil se MUDARON, no se copiaron

La suite de la 008 llamaba a la firma de 6 argumentos y quedó rota al aplicar la 009. Se sacó ese
bloque de ahí en vez de actualizarlo: las mismas aserciones en dos suites obligan a mantener las dos
sincronizadas, y la que se olvide falla por razones que no tienen que ver con el código.

`set_partner_profile` es de la 009. La 008 se quedó con `set_partner_links`.

## El nombre no valida unicidad, y eso es a propósito

`partners.name` **no tiene índice único** en el schema del backend, así que dos partners con el mismo
nombre son representables. El SP valida representabilidad, no reglas de negocio.

Lo que sí hace el panel: `getPartnerServices` devuelve `nameCollisions` —cuántos OTROS partners se
llaman igual— y la ficha avisa. Es el mismo patrón que el aviso de "sin forma de contacto": se avisa,
no se impide, y si el equipo lo quiere obligatorio el lugar es el formulario.

La comparación es `lower(btrim(...))` de los dos lados: "Taller Norte" y "taller norte " son el mismo
taller para quien lee la lista, y una comparación exacta no los vería.

## Renombrar mueve al partner de lugar en el marketplace

`idx_partners_active_tier_name` es `(tier, name) WHERE status = 'active'`. El nombre **es la clave de
orden** del listado dentro de cada tier. No es un efecto colateral a corregir —así funciona el índice
del backend— pero conviene saberlo antes de renombrar de "AA Taller" a "Zzz".

Verificado: nada hace JOIN por nombre. `partner_applications.business_name` es una columna aparte y
no se toca, así que renombrar el partner no renombra su solicitud de origen.

## Un backtick adentro de un template literal cierra el string

No es de la migración, es de `partners.repo.ts`, y costó un typecheck roto: el comentario que explica
la subconsulta de `name_collisions` se escribió como JSDoc **adentro** del template literal del SQL, y
cada `` ` `` de sus referencias a columnas terminaba el string.

**Adentro de un template de SQL, los comentarios van con `--` y sin backticks.** Los JSDoc con
backticks van AFUERA, antes del literal — que es donde están todos los demás de ese archivo.

---

# Migración 010 — editar la solicitud entera (`partner_applications`)

Alcance añadido: `migrations/010_ops_editar_solicitud.sql`, su `.test.sql`,
`ops.update_partner_application`, `ops._jsonb_text_array`, `updatePartnerApplication`
de `src/server/partners.repo.ts`, `updatePartnerApplicationFn` de
`src/fn/partners.ts`, `editApplicationSchema` + `APPLICATION_PATCH_KEYS` de
`src/lib/partners.ts`, `src/components/ApplicationEditor.tsx`.

## Por qué un SP y no un UPDATE directo como el status

`partner_applications` ya se escribía desde `partners.repo.ts` sin SP:
`updateApplicationStatus` y `unstickApplication` son `UPDATE` directos. La 010 NO
sigue ese camino, y la diferencia es la **consecuencia**, no la tabla:

- Mover el status es una columna por un embudo de 4 estados. Bajo impacto,
  reversible, y el propio backend lo dejó designado en `lead-status.vo.ts`.
- La 010 reescribe **todo el formulario del taller** — contacto, marcas,
  combustibles, rubros declarados, notas internas. Eso necesita `before`/`after`
  en `ops.action_log`, que es lo único que contesta "¿quién le cambió el email a
  esta solicitud?".

Los 8 guardrails son los mismos que 007/008/009 (`SECURITY INVOKER`,
`search_path` fijo, `assert_actor`, `FOR UPDATE`, log adentro de la función, sin
FK a `public`, `updated_at` lo pone `trg_partner_applications_updated_at`).

## El `grep` al backend NO se pudo correr

La regla dice *"la excepción se gana con un `grep`, no se asume"*. Para la 010 no
se pudo: `../autolibre-backend-hex` no estaba clonado. Se asumió que el backend
no tiene un caso de uso que edite campos de una solicitud —mismo estado que
partners— pero **antes de ampliar este SP hay que correr ese `grep`**:

```
rg -n "IPartnerApplicationRepository|update\(partnerApplications" ../autolibre-backend-hex/src
```

Si aparece un `update` de campos (más allá de la función de aprobación), esto
pasa a ser competencia del backend.

## El patch es jsonb y viaja completo

`ops.update_partner_application(p_application_id, p_actor_id, p_patch jsonb, p_note)`.
`p_patch` trae TODAS las claves editables en **snake_case** —el formulario manda
el juego completo, misma filosofía que `set_partner_contact`.

- **`APPLICATION_PATCH_KEYS`** (en `~/lib/partners`) traduce camelCase → snake_case
  explícito. Un `Object.entries` con regex daría una clave mal mapeada = un campo
  que no se guarda en silencio (mismo criterio que `mapCensus`).
- **`JSON.stringify` explícito** en el repo: `pg` serializaría un objeto de JS a
  algo que `jsonb` no reconoce (misma trampa que `setPartnerLinks`).

### Validación: solo representabilidad

| Campo | Regla |
|---|---|
| `business_name`, `email`, `whatsapp`, `address` | NOT NULL en la base → `''` rechaza con `<FIELD>_REQUIRED`, no borra |
| nullable text (9 campos) | `nullif(btrim(x), '')` → `''` borra |
| `follow_up_date` | `''`→NULL; formato malo → `INVALID_FOLLOW_UP_DATE` (parseada ANTES del UPDATE para poder traducir el error) |
| `declared_*` / `*_types` (4 arrays) | `ops._jsonb_text_array`: descarta elementos vacíos; si la clave falta se deja como estaba; `[]` sí vacía |

Ninguna regla de negocio: no valida que un rubro declarado exista en el catálogo
(eso lo resuelve la pantalla de aprobación, que sabe leer slugs heterogéneos), ni
normaliza marcas, ni exige nada.

## `status` y las fechas de CRM NO se editan acá

`status` tiene su editor propio y el lock de `verbal_agreement`. `first_contacted_at`,
`reviewed_at`, `reviewed_by_id`, `raw_submission`, `legacy_sheet_row_id` no son
datos que el operador corrija a mano — quedan fuera del `p_patch` a propósito.

## El selector de rubros declarados normaliza familia → servicios

`declared_services` guarda un histórico heterogéneo: slugs de servicio
(`frenos`), slugs de familia (`motor`), y etiquetas del formulario viejo
(`"Chapa y pintura"`). `ApplicationEditor` al sembrar:

- slug de servicio → tilde en el picker
- slug de familia → se expande a los slugs de sus servicios activos
- lo demás → chip "sin reconocer", removible pero preservado al guardar

Expandir la familia es **deliberado y seguro**: `expandDeclaredSlugs` y el INSERT
de `approveApplication` producen el MISMO conjunto de `partner_services` con los
slugs de servicio que con el slug de familia. Lo que cambia es que
`matchedFamilies` de `resolved` deja de decir "familia declarada" y pasa a listar
los servicios uno a uno — más verboso, mismo resultado.

## Se probó como 007/008/009

`migrations/010_ops_editar_solicitud.test.sql`: 31 casos, `BEGIN … ROLLBACK`,
crea su propia solicitud + actor. Cubre los 3 guardrails de forma, el camino
feliz de los ~19 campos, los 4 `*_REQUIRED`, `INVALID_FOLLOW_UP_DATE`, la
normalización de arrays (ausente ≠ `[]` ≠ con vacíos), `APPLICATION_NOT_FOUND` /
`ACTOR_NOT_FOUND` / `ACTOR_REQUIRED`, el log con `before`/`after`, y que el SP no
escriba `updated_at`. **Repetir ese patrón para cualquier SP nuevo.**
