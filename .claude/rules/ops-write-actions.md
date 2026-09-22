# Escrituras del panel: stored procedures de `ops` sobre `public`

Alcance: `migrations/007_ops_acciones_admin.sql`, las funciones `setPartner*` de
`src/server/partners.repo.ts`, `src/server/leads.repo.ts`, `src/fn/leads.ts`, las
`setPartner*Fn` de `src/fn/partners.ts`, `src/components/PartnerFicha.tsx`,
`src/routes/_authed/leads.tsx`. La 010 suma
`migrations/010_ops_editar_solicitud.sql`, `updatePartnerApplication` de
`src/server/partners.repo.ts`, `updatePartnerApplicationFn` de
`src/fn/partners.ts` y `src/components/ApplicationEditor.tsx`. La 011 suma
`migrations/011_ops_pedidos_de_presupuesto.sql` y su `.test.sql`, las escrituras de
`src/server/quote-requests.repo.ts` y `src/fn/quote-requests.ts`, y
`src/components/QuoteRequestActions.tsx`. La 012 suma `migrations/012_ops_crear_pedido.sql`,
`createQuoteRequest` de `src/server/quote-requests.repo.ts`, `createQuoteRequestFn` de
`src/fn/quote-requests.ts` y `src/components/QuoteRequestComposer.tsx`. La 013 suma
`migrations/013_ops_rubro_de_pedido.sql` y su `.test.sql`, `setQuoteRequestRubro` de
`src/server/quote-requests.repo.ts`, `setQuoteRequestRubroFn` de `src/fn/quote-requests.ts`
y `src/components/PartnerCandidates.tsx` (`.claude/plans/partners-derivacion.md`).

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

---

# Migración 011 — pedidos de presupuesto (`quote_requests`)

Alcance añadido: `migrations/011_ops_pedidos_de_presupuesto.sql` y su `.test.sql`;
`markQuoteRequestContacted` / `markQuoteRequestAnswered` / `closeQuoteRequest` /
`addQuoteRequestInternalNote` de `src/server/quote-requests.repo.ts`, sus `*Fn` en
`src/fn/quote-requests.ts`, los schemas y `readableQuoteRequestError` de `src/lib/quote-requests.ts`,
y `src/components/QuoteRequestActions.tsx`. Los botones viven en `/leads/pedidos/:id`; la UI está en
`leads.md`.

## Qué reemplaza

Los cuatro scripts de transición que `autolibre-backend-hex` tenía en `scripts/sql/`, que el operador
copiaba, editaba y corría a mano. El backend los borró el 2026-09-15: ese repo no tiene código de
administración, y todo lo que es del admin vive en `ops`. El quinto script
(`listar-pedidos-de-presupuesto-abiertos.sql`) no tiene SP porque ya lo reemplazó `/leads/pedidos`.

| Script borrado | SP |
|---|---|
| `marcar-pedido-de-presupuesto-contactado.sql` | `ops.mark_quote_request_contacted(id, actor, note?)` |
| `marcar-pedido-de-presupuesto-respondido.sql` | `ops.mark_quote_request_answered(id, proposals_count, actor, note?)` |
| `cerrar-pedido-de-presupuesto.sql` | `ops.close_quote_request(id, close_reason_code, actor, closed_reason?, outcome?, outcome_note?, note?)` |
| `agregar-nota-interna-a-pedido-de-presupuesto.sql` | `ops.add_quote_request_internal_note(id, text, actor)` |

El `grep` que habilita la excepción sí se corrió, el 2026-09-15: `src/quotes` del backend no tiene
ningún `AdminGuard`, y sus dos `.update(quoteRequests)` son las transiciones del USUARIO (cancelar y
declarar resultado).

Una plantilla es peor que un SP por un motivo concreto: se edita antes de correrla, y cada edición
puede borrar la guarda de estado del `WHERE`. Los scripts también se guardaban, y la 0093 del backend
cambió el contrato: un script viejo guardado fallaba con un 23514 que parecía un bug.

## La desviación del guardrail 5: el log no lleva la ubicación exacta

`quote_requests` guarda la posición GPS de la persona, y eso es deuda **BLOQUEANTE** de Ley 25.326
en el backend. Un pedido de supresión ya obliga a limpiarla en dos lugares: las columnas y
`raw_submission->'location'`. Copiarla a `ops.action_log` en cada transición sumaría un tercero, y
uno que crece solo.

`ops._redact_quote_request` saca `location_latitude`, `location_longitude`,
`location_accuracy_meters` y `raw_submission` del `before`, del `after` y de lo que devuelve la
función. Ninguno de los cuatro SP escribe esas columnas, así que el log no pierde nada de lo que
cambió. La localidad y la provincia sí quedan.

> Si un SP futuro de `quote_requests` llega a escribir la ubicación, esta regla deja de alcanzar y
> hay que decidir de nuevo. No lo "arregles" sacando el redact.

## Los parámetros son `text`, no el enum

Al 2026-09-14 `quote_requests` **no existe en producción**. plpgsql resuelve los tipos de la firma y
del `DECLARE` al crear la función, pero las sentencias SQL recién al ejecutarlas. Con un parámetro
`quote_request_close_reason`, aplicar la 011 en producción rompería el `vercel-build` del panel hasta
que se despliegue el backend. El cast al enum va en el cuerpo, capturado a sentinela, igual que en
`set_partner_status`.

> Al 2026-09-15 la tabla ya existe en producción (relevado en `origin/config-pedidos`). Los `text` se
> quedan igual: la 011 se aplica en toda base que el panel migre, y no todas tienen el flujo del
> backend.

**Corolario**: ningún SP sobre `quote_requests` puede ser `LANGUAGE sql` (esos sí se validan contra
las tablas al crearse) ni declarar variables `quote_requests%ROWTYPE`. La suite sí usa `%ROWTYPE`,
porque corre en DEV, donde la tabla existe.

## La guarda de estado es de la función, no de los CHECK

Los CHECK de `quote_requests` exigen que cada estado tenga sus fechas, pero **no impiden
retroceder**: un `UPDATE` que devuelva un `answered` a `contacted` entra. Por eso cada SP bloquea la
fila con `FOR UPDATE` (`ops._lock_quote_request`) y valida el estado sobre ese `before`.

El `FOR UPDATE` acá además serializa contra la APP, que escribe la misma fila cuando el usuario
cancela, con su propio `UPDATE` guardado por estado. Sin el lock, "el usuario canceló mientras el
operador lo marcaba respondido" deja el `before` del log describiendo un estado que ya no existía.

| Sentinela | Cuándo |
|---|---|
| `QUOTE_REQUEST_NOT_FOUND` | el id no existe. Se busca por UUID, nunca por `AL-n` |
| `INVALID_QUOTE_REQUEST_TRANSITION` | el estado no admite la operación. Incluye tocar un pedido que canceló el usuario |
| `PROPOSALS_COUNT_REQUIRED` / `INVALID_PROPOSALS_COUNT` | respondido sin cantidad, o con una negativa. Cero es válido |
| `CLOSE_REASON_CODE_REQUIRED` / `INVALID_CLOSE_REASON_CODE` | cierre sin código, o con uno fuera del enum |
| `CLOSE_REASON_RESERVED_FOR_APP` | `cancelled_by_user`: lo pone sólo la app, junto con el motivo de la persona |
| `INVALID_OUTCOME` | outcome fuera de `hired`, `not_hired` o `no_response` |
| `INTERNAL_NOTE_REQUIRED` | nota interna en blanco |

Varias duplican lo que un CHECK rechazaría igual, por el mismo motivo que las coordenadas de la 007:
un 23514 con el nombre del constraint no le dice nada a quien opera.

## `p_note` no es la nota interna

En los tres SP de transición, `p_note` es la nota de **auditoría** y va a `ops.action_log`. La nota
interna del pedido —lo que se consiguió llamando a talleres— es `add_quote_request_internal_note`:
agrega una línea fechada en hora de Buenos Aires y nunca pisa las anteriores. Es el formato que
`/leads/pedidos/:id` parsea como hilo.

Confundirlas deja el hilo sin la llamada, y el log con texto que no es auditoría.

## Cómo se probó

`migrations/011_ops_pedidos_de_presupuesto.test.sql`: 46 casos, `BEGIN … ROLLBACK`, con su propio
actor, seis pedidos de fixture (uno por estado —cancelado por el usuario incluido—, uno con notas; el
recibido trae ubicación) y cuatro más para la integración. Corrió primero en rojo, sin la migración, y
después con la migración adentro de la misma transacción, contra el Postgres de Docker de desarrollo
(`localhost:5435`).

Cubre los guardrails de forma, las cuatro transiciones felices, cada sentinela, que un respondido no
retroceda y un cancelado por el usuario no se toque, la normalización de `''` a NULL, el hilo de notas,
el log con `before`/`after`, y que ni el log ni lo devuelto traigan coordenadas.

Los casos 60–64 son la integración con el SQL exacto de `quote-requests.repo.ts`, y van con
**`PREPARE` sin tipos**, no con variables de plpgsql como la 008: `pg` manda cada `$n` con tipo
desconocido y es Postgres el que lo resuelve contra la firma, que es justo la parte que falla en
runtime (una sobrecarga viva, un parámetro que no resuelve). Dos detalles del mecanismo: `EXECUTE` no
acepta subconsultas como argumento (de ahí `pg_temp.fix_id`), y un prepared statement es de la
SESIÓN, así que el `ROLLBACK` no se lo lleva y la suite hace `DEALLOCATE`.

Al 2026-09-15 dio 46/46 en DEV (`autolibre_ai_hex`), con la 011 inyectada después del `BEGIN` porque
esa base tenía aplicadas sólo 001–007. Después se aplicaron 008–011 en DEV con `pnpm db:migrate`.

## La 011 que se descartó: `ops.advance_quote_request`

La rama `origin/config-pedidos` escribió en paralelo OTRA migración 011 (`011_ops_avanzar_pedido.sql`):
un solo SP que movía `status` de cualquier estado a cualquier estado, con un `QuoteStatusControl` en
cada fila del listado. En el merge del 2026-09-15 se descartó entera —migración, test, componente, fn,
repo y schema— y quedó esta 011 como único camino de escritura. Los motivos, verificados:

1. **Dos archivos `011` no conviven**: el runner los lee como la misma versión. Ésta ya estaba en
   `origin/main` y aplicada en DEV, así que la que cedía era la otra.
2. **Reabrir un pedido cancelado por el usuario reventaba con un 23514 crudo.** El SP limpiaba
   `close_reason_code` y dejaba `cancellation_reason`, que viola
   `chk_quote_requests_cancellation_iff_cancelled` (relevado con `pg_get_constraintdef`).
3. **Copiaba la fila entera a `ops.action_log`**, coordenadas GPS y `raw_submission` incluidos: justo
   lo que `_redact_quote_request` existe para no hacer.
4. **Dejaba retroceder** (`answered` → `received`), que los CHECK no frenan y esta 011 prohíbe a
   propósito.
5. **Su `grep` al backend no se había corrido** (lo decía su propia cabecera).

De esa rama SÍ se conservaron las plantillas de mensajes de la ficha, la lectura de `location_address`
y Pedidos como pestaña default de `/leads` (→ `leads.md`).

**Si vuelve la idea de mover el estado desde la fila**, se implementa llamando a estos mismos SP. Un
segundo SP para la misma transición, con reglas distintas, es exactamente lo que se sacó.

---

# Migración 012 — cargar un pedido de presupuesto a mano

Alcance añadido: `migrations/012_ops_crear_pedido.sql`, su `.test.sql`,
`ops.create_quote_request`, `createQuoteRequest` de
`src/server/quote-requests.repo.ts`, `createQuoteRequestFn` de
`src/fn/quote-requests.ts`, `createQuoteRequestSchema` +
`readableCreateQuoteRequestError` de `src/lib/quote-requests.ts`,
`src/components/QuoteRequestComposer.tsx`.

## El primer SP de `quote_requests` que EXISTE al lado de un camino del backend, y se usa igual

007-011 se justificaron porque el backend no tenía NINGÚN camino para lo que
hace el admin. La 012 es distinta: el backend SÍ tiene un endpoint para
crear un `quote_request` — el POST público que usan app/web/whatsapp,
mencionado en `.claude/rules/leads.md` ("un POST público con `channel = app`
tampoco [tiene cuenta]"). Y el panel usa un SP igual.

La razón no es que el POST no alcance funcionalmente — probablemente los
mismos campos servirían. Es que ese endpoint es **anónimo por diseño**: así
es como app/web/whatsapp aceptan pedidos de gente sin cuenta de AutoLibre. No
hay forma de pasarle qué admin del equipo lo está cargando, y sin eso
`ops.action_log` — la única auditoría de quién tipeó qué en este panel —
queda ciego para esas filas. Mismo argumento de fondo que 007-011, aplicado al
revés: ahí el backend no tenía camino y el panel lo suplía; acá tiene un
camino, pero es el camino equivocado para un actor identificado.

**El `grep` se corrió en el merge del 2026-09-15** (la rama no había podido):
`src/quotes` del backend sólo tiene el `@Public() @Post()` anónimo y el
`@Post('app')` del usuario autenticado. No hay alta con `AdminGuard`: la
excepción aplica.

> La cabecera de `012_ops_crear_pedido.sql` sigue diciendo que el grep no se
> corrió y que `ops.advance_quote_request` mueve el pedido después de creado
> (se descartó; lo mueven los SP de la 011). **No se corrigió a propósito**: la
> migración pudo haberse aplicado en otra base, y editar un comentario cambia
> el checksum y hace abortar al runner ahí. Vale lo que dice esta rule.

## Guardrail 7 (`FOR UPDATE`) no aplica — y es la primera vez

Los guardrails de 007-011 asumen un SP que EDITA una fila existente: por eso
el 7 dice "lockear antes de escribir". La 012 es la primera función de
escritura de este archivo que CREA, no edita — no hay fila previa que
lockear, y el único punto de contención (la `id` nueva) lo resuelve
`gen_random_uuid()` sin colisión posible. El resto de los guardrails se
sostiene igual, incluido el 8: como es un `INSERT` y no un `UPDATE`, el
trigger `trg_quote_requests_updated_at` ni siquiera dispara — `created_at` y
`updated_at` toman su propio `DEFAULT now()`.

## El canal es una aproximación, y está anotado como tal

`quote_request_channel` (relevado con `pg_enum`: `app | web | whatsapp`, nada
más) no tiene un valor para "cargado a mano" — es un enum de `public`, este
repo no lo puede ampliar. El formulario pide elegir uno de los tres
igual (default `whatsapp`) en vez de inventar un cuarto valor. La fila queda
marcada aparte (`raw_submission->>'source' = 'admin_manual_entry'`,
expuesta como `enteredManually`), así que el canal elegido no oculta que el
pedido se cargó a mano — sólo aproxima por dónde "se pareció más" a haber
entrado.

## `raw_submission` documenta el origen en vez de mentir con `'{}'`

La columna es NOT NULL y las tres vías digitales la llenan con el body real
del cliente. Acá no hay body — lo tipea el operador — así que en vez de un
`'{}'::jsonb` vacío (que se leería como una submission real sin datos) el SP
guarda `{"source": "admin_manual_entry", "enteredBy": <actor>, "enteredAt":
<now()>}`. Es metadata verdadera sobre la fila, no dato inventado, y es lo
que le permite al repo derivar `enteredManually` sin que el backend tenga que
agregar una columna.

## Cómo se probó

`migrations/012_ops_crear_pedido.test.sql`: 29 casos, `BEGIN … ROLLBACK`, sin
fixture de `quote_requests` (esta migración crea filas, no las edita). Cubre:
los 3 guardrails de forma, el camino feliz con los 8 campos y la
normalización de la patente (`upper`+`btrim`), los tres opcionales ausentes
→ `NULL`, los tres `*_REQUIRED` de las columnas NOT NULL, `INVALID_CHANNEL`,
`ACTOR_NOT_FOUND`/`ACTOR_REQUIRED`, el log con `before IS NULL` (no hay
estado previo) y `after` completo, que el SP no escriba `updated_at`, y una
integración con parámetros nombrados. **Repetir ese patrón para cualquier SP
nuevo.**

Desde el merge, `createQuoteRequest` del repo también llama con parámetros
nombrados (antes mandaba `$1…$9` por posición, así que la integración probaba
una forma que el repo no usaba). La integración de la 012 va con variables de
plpgsql, no con el `PREPARE` sin tipos de la 011: resuelve la firma igual, pero
no con parámetros de tipo desconocido como los manda `pg`.

---

# Migración 013 — clasificar el rubro de un pedido, para poder derivarlo

Alcance añadido: `migrations/013_ops_rubro_de_pedido.sql` y su `.test.sql`,
`setQuoteRequestRubro` de `src/server/quote-requests.repo.ts`,
`setQuoteRequestRubroFn` de `src/fn/quote-requests.ts`,
`src/components/PartnerCandidates.tsx`, `listPartnerCandidates` +
`listPartnerZones` de `src/server/partners.repo.ts`. Nace de
`.claude/plans/partners-derivacion.md`, que tiene el detalle completo (Fase 0
a Fase 2); esto es el resumen que hay que mantener sincronizado con el código.
La 015 suma `migrations/015_ops_respuestas_de_talleres.sql` y su `.test.sql`,
`src/lib/quote-responses.ts`, `src/server/quote-responses.repo.ts`,
`src/fn/quote-responses.ts` y `src/components/QuoteResponses.tsx`.

## Una tabla nueva de `ops`, no una columna en `quote_requests`

`quote_requests` es del backend y este repo no migra `public`. La
clasificación por rubro es dato de OPERACIÓN del panel —nadie de la app la
lee— así que vive en `ops.quote_request_rubro`, mismo criterio que
`ops.excluded_email_domains` o los precios de IA: `quote_request_id` es un
UUID pelado, **sin FK** a `quote_requests` (guardrail 6). El caso 22 de la
suite lo verifica al revés de lo habitual: borra el `quote_request` y
comprueba que la fila de `ops` SIGUE ahí.

## Es un UPSERT, y el guardrail 7 se aplica distinto según el camino

Igual que la 012 (que sólo inserta), el ALTA no lockea nada — no hay fila
previa que lockear, y el `INSERT … ON CONFLICT` es atómico solo. Pero a
diferencia de la 012, esta función SÍ puede pisar una clasificación anterior
(reclasificar un pedido), y ahí el `SELECT … FOR UPDATE` antes del upsert sí
corre — es la salvedad que anota la cabecera de la migración.

`created_at` no se pisa en el `ON CONFLICT DO UPDATE` — mismo criterio que
`upsertExcludedDomain` en `ops.repo.ts`: cuándo se clasificó por primera vez
es el dato con valor.

## Los slugs se validan contra el catálogo, no contra un enum

`p_category_slug` y `p_service_slug` son `text`, y el cuerpo de la función los
valida contra `service_categories`/`services` (activos, y el servicio
colgando de la MISMA categoría que se está guardando) — sentinelas
`INVALID_CATEGORY_SLUG` / `INVALID_SERVICE_SLUG`. **No valida que el rubro
tenga sentido para la `description` del pedido**: eso es juicio del operador,
no algo que la base pueda verificar.

## La escritura que se decidió NO hacer: una tabla de derivaciones

El plan evaluó guardar "a qué taller se derivó" como una fila más (una tabla
`ops.quote_request_referrals`) y se decidió que NO, todavía. La derivación se
registra como una línea de `internal_notes` vía
`ops.add_quote_request_internal_note` (011) — la misma escritura que ya usa
el hilo de notas de la ficha, sin SP nuevo.

El costo es real y está anotado a propósito: **no se puede contestar "¿cuánto
le mandamos a cada taller y cuánto convirtió?" con una consulta.** Esa
respuesta queda en texto libre, y recuperarla parseando notas sería el mismo
error que `leads.md` ya prohíbe para "ofertas" parseadas de `internal_notes`.
Si esa pregunta se vuelve importante, el arreglo es la tabla — no un parser.

## `listPartnerCandidates` no escribe nada — es lectura pura

Cruza `partners` activos por rubro (vía `partner_services` → `services` →
`service_categories`) con Haversine inline contra la coordenada del pedido
(sin `postgis`/`earthdistance`: están disponibles pero no instaladas, e
instalar una extensión es DDL global que cae en `public`, del backend — ver
el plan, Fase 2). No es un SP de `ops`: es un `SELECT` en
`partners.repo.ts`, igual que `listPartners` o `partnerCoverageBoard`.

## Se probó como 007–012

`migrations/013_ops_rubro_de_pedido.test.sql`: 23 casos, `BEGIN … ROLLBACK`,
con su propio actor y su propio `quote_request` de fixture. Cubre los 3
guardrails de forma, el camino feliz sin y con servicio puntual, el rubro
inválido, el servicio de OTRO rubro rechazado, el pedido inexistente, actor
inexistente/NULL, la reclasificación (misma fila, `created_at` intacto,
`updated_at` avanza), el log con `before`/`after` en las dos escrituras, la
ausencia de FK a `quote_requests`, y la integración con parámetros nombrados.
**Repetir ese patrón para cualquier SP nuevo.**

---

# Migración 015 — lo que contestó cada taller

Alcance añadido: `migrations/015_ops_respuestas_de_talleres.sql`, su
`.test.sql`, la tabla `ops.quote_request_response`, `ops._lock_quote_response`,
`ops._normalize_quote_response`, `ops.add_quote_request_response`,
`ops.update_quote_request_response`, `ops.delete_quote_request_response`,
`ops.reorder_quote_request_responses`, `src/server/quote-responses.repo.ts`,
`src/fn/quote-responses.ts`, `src/lib/quote-responses.ts` y
`src/components/QuoteResponses.tsx`. La UI y el mensaje de WhatsApp están en
`leads.md`, sección Presupuestos.

## Es una tabla de `ops` AUNQUE el backend tenga una parecida

`public.quote_request_proposals` existe —relevada en producción el 2026-09-22:
0 filas— y esta migración deliberadamente **no** la usa. Una primera versión sí
la usaba; se descartó el mismo día, al mirar un mensaje real del operador.

| Lo que el caso real necesita | La tabla del backend |
|---|---|
| Una respuesta **sin precio** (diagnóstico, "traelo y vemos") | `amount_min` NOT NULL + `CHECK (amount_min > 0)` — estricto: **ni 0 entra** |
| Dirección y teléfono de un taller **de afuera del directorio** | sólo `partner_id` o `provider_name` |

En el mensaje que motivó el cambio, los TRES talleres contestaron sin precio y
uno no estaba en el directorio.

**Que exista una tabla parecida no la vuelve la tabla del dominio de esto.**
`proposal` describe *una oferta con precio*; lo que el panel maneja es *la
respuesta de un taller*, de la cual el precio es un atributo a veces ausente.
Por eso el nombre también es distinto (`response`), y eso NO viola la regla
dura 7: el vocabulario del backend se respeta llamando `proposal` a lo que el
backend llama así, no bautizando igual a dos cosas distintas. Dos tablas casi
homónimas con significados distintos es el peor de los mundos.

**Y nada lee la del backend hoy**: 0 filas, y todo lo que la persona recibe se
lo manda el operador por WhatsApp a mano. Así que no hay dos verdades que
sincronizar — hay una, y es la nuestra. Ése es el hecho que hace correcta la
decisión, y el que hay que volver a chequear si cambia.

### El camino de vuelta, escrito para que no se pierda

El `INSERT … SELECT` del backfill está en la cabecera de la migración. Las
columnas se eligieron con los mismos nombres y tipos que el backend ya usa
justamente para que ese día sea un `INSERT`, no una traducción. Se retira
cuando el backend acepte precio nulo y sume el contacto del taller de afuera.

## Los guardrails, con dos notas

Los mismos 8 que 007–013. Dos aplican distinto y conviene saber por qué:

- **Guardrail 6** (ninguna FK cruza a `public`) acá **sí aplica y se cumple**:
  `quote_request_id`, `partner_id` y `actor_id` son UUID pelados. El caso 04 de
  la suite lo verifica contando `contype = 'f'` sobre la tabla. Consecuencia
  buscada: si el backend borra un partner, la respuesta que ese taller dio
  sigue existiendo — con el nombre resuelto a NULL y el `coalesce` del SELECT
  poniendo un texto, nunca una fila que desaparece.
- **Guardrail 8** (`updated_at` lo pone el trigger) se invierte: en `ops` no
  hay trigger, así que **lo escribe la función**. Es lo contrario de
  `partners`/`leads`, donde el SP no lo toca justamente porque el trigger
  existe. El caso 05 de la suite verifica que no haya trigger, para que el día
  que alguien agregue uno se entere de que ahora hay duplicación.
- **Guardrail 7** (`FOR UPDATE`): el alta no lockea nada (no hay fila previa,
  igual que la 012); editar y borrar lockean la fila; reordenar lockea TODAS
  las del pedido antes de leer el `before`.

El alta valida que el pedido exista con un `EXISTS` sobre `quote_requests` —
mismo patrón que la 013— porque sin FK no hay nada que lo garantice.

## El precio tiene tres estados, y por eso el CHECK es `>= 0`

`NULL` = no pasó precio · `0` = sin cargo · `> 0` = el precio. El backend usa
`> 0` estricto; acá es `>= 0` **a propósito**, porque "diagnóstico sin cargo"
es literalmente lo que contestó uno de los talleres del mensaje real, y `NULL`
ya está tomado por "no dijo nada". Las dos puntas van juntas o ninguna
(`chk_ops_qrr_amounts_paired`): "de 80.000 a NULL" no es un rango.

## Las validaciones viven en UN helper, no en cuatro funciones

`ops._normalize_quote_response` valida y normaliza todo lo que comparten el
alta y la edición. No es ahorro de líneas: **un `IF` que sólo esté en una de
las dos es un dato que entra por el otro camino, y no hay nada que lo delate.**
Por eso el caso 57 de la suite prueba una validación del alta a través de la
EDICIÓN.

| Sentinela | Cuándo |
|---|---|
| `PROVIDER_REQUIRED` / `PROVIDER_AMBIGUOUS` | los dos lados de `num_nonnulls(partner_id, provider_name) = 1`, traducidos por separado: "no elegiste taller" y "elegiste dos cosas" son errores distintos para quien opera |
| `PROVIDER_CONTACT_NOT_EDITABLE` | dirección o teléfono tipeados sobre un partner. Los suyos salen de `partners`; una copia acá sería una segunda verdad que envejece sola |
| `PARTNER_NOT_FOUND` | el partner no existe. **Que exista, no que esté `active`**: un taller pausado igual pudo contestar ayer |
| `DETAIL_REQUIRED` | el párrafo que lee la persona, en blanco |
| `AMOUNT_INCOMPLETE` · `INVALID_AMOUNT` · `INVALID_AMOUNT_RANGE` · `AMOUNT_TOO_LARGE` | una sola punta, negativo, `min > max`, o no entra en `numeric(12,2)` |
| `INVALID_CURRENCY` | fuera de `ARS` / `USD` |
| `INVALID_VALID_UNTIL` / `VALID_UNTIL_IN_PAST` | formato malo, o anterior a la fecha de carga |
| `QUOTE_REQUEST_NOT_FOUND` / `QUOTE_RESPONSE_NOT_FOUND` | el pedido o la respuesta no existen |
| `REORDER_EMPTY` · `REORDER_DUPLICATE_IDS` · `REORDER_MISMATCH` | la lista de reorden no es exactamente el conjunto del pedido |

Varias duplican lo que un CHECK rechazaría igual, por el mismo motivo que las
coordenadas de la 007: un 23514 con el nombre del constraint no le dice nada a
quien está cargando un precio.

## La moneda es un CHECK nuestro, no el enum de `public`

`quote_request_proposal_currency` es un tipo del backend. Usarlo ataría esta
tabla a su deploy — misma razón por la que los SP de la 011 toman `text`. El
catálogo es un `CHECK (currency IN ('ARS','USD'))`, con los mismos valores a
propósito para que el backfill sea un cast directo.

## La vigencia se compara contra `created_at`, no contra hoy

`_normalize_quote_response` recibe la fecha de referencia por parámetro
(`p_created_on`): hoy al dar de alta, el `created_at` de la fila al editar. Con
`now()` adentro no se podría corregirle el texto a una respuesta de la semana
pasada sin además moverle la vigencia al futuro.

## La edición es reemplazo COMPLETO; el pedido y la posición no se tocan

Lo que llega es lo que queda guardado, y un opcional que no viene se BORRA —
**incluido el precio**, que así se puede quitar si se cargó por error. Misma
decisión que el formulario de `set_partner_contact`.

`quote_request_id` no es parámetro: una respuesta pertenece al pedido en el que
se cargó (si se cargó en el equivocado, se borra y se carga en el que va, y
quedan las dos cosas en el log). `position` tampoco: tiene su propia función.

## El orden es editorial, y se reordena con la lista COMPLETA

`ops.reorder_quote_request_responses` recibe todos los ids en el orden deseado,
no un "mové éste una posición". Con un movimiento relativo, dos operadores
reordenando a la vez dejan un orden que ninguno de los dos pidió; con la lista
entera, el último que guarda gana y el resultado es el que vio en pantalla. El
SP rechaza una lista incompleta, con duplicados o con ids de otro pedido —
sin ese chequeo, un id de más se ignoraría en silencio y los que faltan
quedarían con su posición vieja, mezclados.

**Una sola entrada en `ops.action_log` para todo el reordenamiento**: es UN
acto de edición, igual que el perfil de un partner en la 008. Su `target_id` es
el PEDIDO y no una respuesta, porque lo que cambió es el conjunto.

El `DELETE` **no renumera**: los huecos no molestan porque el orden se lee por
`position ASC` y no por su valor absoluto. Renumerar tocaría filas que nadie
pidió tocar, y cada una dejaría su entrada en el log.

## Lo que la 015 deliberadamente NO hace

- **No toca `quote_requests.proposals_count`.** La escribe
  `ops.mark_quote_request_answered` (011), que la exige para pasar a
  `answered`. Sincronizarla con un `count(*)` sería mover el estado del pedido
  de costado, sin pasar por su guarda de estado. El panel muestra los dos
  números y avisa en ámbar si no coinciden.
- **No exige que el pedido esté abierto.** Una respuesta que llegó tarde es un
  hecho real, y un presupuesto no es un estado.
- **No adjunta el PDF.** `quote_request_files` (`purpose = 'budget'`) necesita
  el archivo en DigitalOcean Spaces, y ninguna cantidad de SQL sube un archivo
  a un bucket. Feature aparte.
- **No marca "el elegido".** No hay columna, y `quote_requests.outcome` ya dice
  si contrató, sin decir a quién. Agregarlo es una decisión aparte.

## Se probó como 007–013 — pero la suite NO se corrió

`migrations/015_ops_respuestas_de_talleres.test.sql`: `BEGIN … ROLLBACK`, con su
propio actor, su propio partner (creado `paused` a propósito) y tres pedidos de
fixture (uno abierto, uno cerrado, uno vacío para los casos de reorden). Cubre
los guardrails de forma —incluidos "sin FK a `public`" y "sin trigger"—, los
tres estados del precio, los dos tipos de taller, las quince sentinelas, que no
se escriba `proposals_count`, el reemplazo completo de la edición (con el precio
volviendo a NULL), que `created_at` no se pise y `updated_at` sí avance, la baja
con su log, las cinco formas de reordenar mal, y la integración con `PREPARE`
sin tipos.

**⚠ Al 2026-09-22 la suite está escrita y NO corrida, y la 015 no está aplicada
en ninguna base.** El `.env` de esta máquina apunta a PRODUCCIÓN (verificado
antes de tocar nada: `current_database = autolibre`, `current_user = doadmin`,
puerto 25060 detrás del pooler `:25061`) y el Postgres de DEV (`localhost:5435`)
está comentado. Correr un `--allow-write` contra producción no se hace sin
pedirlo, ni siquiera dentro de una transacción que termina en `ROLLBACK`.

Orden para ponerla en pie, y no se saltea ninguno:

1. levantar DEV y apuntar `POSTGRES_DATABASE_URL` ahí;
2. correr la suite **en rojo primero**, sin la migración, para verificar que las
   aserciones fallan por lo que tienen que fallar;
3. `pnpm db:migrate` en DEV y correr la suite en verde;
4. recién entonces producción, **por el puerto DIRECTO `:25060`** — nunca por el
   pooler, por el `pg_advisory_lock` de sesión del runner.

Hasta que ese paso 3 no esté hecho, la tarjeta de Presupuestos de la ficha se
muestra con el cartel de "falta aplicar la migración 015" y no deja cargar nada
— `quoteResponsesAvailable()` lo detecta con `to_regclass`, y cada escritura lo
re-chequea en su handler.
