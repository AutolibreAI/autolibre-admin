# Seguimiento comercial (`/comercial/hoy`, `/comercial/contactos`)

Alcance: `migrations/024_ops_seguimiento_comercial.sql` y
`migrations/030_ops_comercial_ficha_y_charlas.sql` (+ sus `.test.sql`),
`src/lib/partner-prospects.ts`, `src/server/partner-prospects.repo.ts`,
`src/fn/partner-prospects.ts`, `src/components/ProspectCards.tsx`,
`src/components/ProspectComposer.tsx`, `src/components/ProspectImporter.tsx`,
`src/components/ProspectsUnavailable.tsx`, `src/components/ProspectFields.tsx`,
`src/components/ProspectInteractions.tsx`, `src/routes/_authed/comercial*.tsx`,
el ítem «Comercial» del nav. Agregado el 2026-10-29 (tarjeta de Trello "Admin:
seguimiento de contactos de Toby").

## Qué reemplaza

El tablero suelto de Ruta 2 (una planilla, un solo origen) y el "¿a quién
tenía que llamar hoy?" que se contestaba recorriéndolo a ojo. Ahora son todos
los proveedores que sale a buscar el equipo comercial (Tobías, a veces
Nicolás), de cualquier origen.

## Dónde vive: `ops.partner_prospect`, y por qué ahí

Decidido con Nicolás el 2026-10-29: tabla en `ops`, migración en este repo, sin
tocar `autolibre-backend-hex`. Ninguna tabla existente sirve:

- `partner_applications` es el proveedor VINIENDO hacia nosotros; esto es lo
  opuesto, exige `email`/`address` NOT NULL y su `status` es otro embudo.
  Mezclarlos ensucia `/solicitudes` sin que nada lo delate.
- `leads` es el usuario yendo hacia un proveedor.

**Vocabulario**: `PartnerProspect` en el código (regla dura 7: `Partner`, nunca
`Provider`); "contacto" / "proveedor" en la UI. Los orígenes son
`ops.partner_prospect_origin`, ampliables desde el panel («+ Nuevo origen…» en
el alta y en la importación), sin tocar código.

## La edición es un PARCHE, no un reemplazo

Es la excepción a "el formulario manda el juego completo" del resto de `ops`, y
es a propósito: la tarjeta **autoguarda campo por campo**. Con reemplazo
completo, una nota que se tipea y un cambio de estado guardado medio segundo
antes se pisarían con el valor viejo del otro. El SP toca sólo las claves que
vienen (`p_patch ? 'x'`); `''`/`null` borra; una clave desconocida es
`UNKNOWN_FIELD` (un typo sería un guardado que "funciona" y no guarda).

Del lado del cliente (`useProspectAutosave`): los guardados se ENCOLAN en orden,
los textos van con debounce de 800 ms y se mandan al salir del campo, y un
campo no se re-sincroniza con lo que vuelve del servidor si se siguió tipeando.
Un error queda a la vista hasta la próxima tanda de guardados. Un autoguardado
sin cambios no mueve `updated_at` ni escribe `ops.action_log`.

Sólo cambiar **estado** o **próximo seguimiento** recarga la lista
(`router.invalidate()`): son los que mueven contadores y la vista Hoy. Recargar
en cada tecla haría saltar la pantalla mientras se escribe.

## El teléfono: normalizado en SQL, espejado en TS

`phone` guarda lo tipeado; `phone_digits` es `549` + 10 dígitos (la forma de
`wa.me`), calculado por `ops.normalize_ar_phone`. **Índice único parcial** sobre
`phone_digits`: un proveedor no puede estar dos veces, ni por alta ni por CSV.

`normalizeArPhone` en `~/lib/partner-prospects` es un ESPEJO, para el botón de
WhatsApp y la vista previa del CSV. Se tocan juntas; si divergen, la vista
previa dice "nuevo" y el SP lo rechaza como `DUPLICATE_PHONE` — falla fuerte,
nunca guarda dos veces. `tmp/probe-comercial.mjs` imprime los mismos casos que
los 10–18 de la suite.

**Nunca se completa una característica**: 8 dígitos, o un "15" sin código de
área, dan `null` (sin WhatsApp, sin chequeo de duplicado) y la tarjeta lo dice.
El "15" sólo se saca después del 11, donde el código de área no es ambiguo.

El teléfono de un PROVEEDOR del marketplace se compara con la MISMA función
(`ops.normalize_ar_phone(partners.whatsapp)`) — para sugerir el vínculo y para
marcar "ya es proveedor" en el alta y en el CSV.

## Rubros = las categorías del marketplace

`category_slugs` son slugs de `public.service_categories`, validados por el SP
(sin FK, guardrail 6). Las opciones salen de `loadCatalog()` — el mismo loader
que `/partners`, que ya deja afuera `chasis-y-frenos` (sin servicios activos). No
hay lista paralela. Un rubro del CSV que no matchea se ignora y la vista previa
lo dice.

## Colores de estado

Desde la 030: Por contactar gris · Contactado neutro · **Interesado VIOLETA, no
azul** (`tokens.ts` de mobile: "Esta app NO TIENE azul a propósito"; si se
quiere azul, se agrega primero en mobile, `design-system.md`) · Registrado y
Primer pedido verde suave · Trabajo confirmado verde lleno · Descartado rojo.

## Vista Hoy

`next_follow_up_on <= hoy` (en **Buenos Aires**, no UTC) y estado abierto
(`CLOSED_PROSPECT_STATUSES` = trabajo confirmado / descartado desde la 030: un
registrado se sigue hasta su primer pedido; espejo del índice parcial
`idx_ops_pp_follow_up`, se tocan juntos), por fecha. Los días
(`followUpInDays`) los calcula Postgres: la pantalla es SSR y restar contra el
reloj del navegador sería un mismatch de hidratación. `/comercial` redirige a
Hoy: es lo primero que se ve.

## Contadores

Siguen a todos los filtros MENOS el de estado (son el desglose por estado; con
el filtro puesto dirían "3 interesados de 3"). "Contactados" = todo lo que salió
de Pendiente.

## Vínculo al registrarse

Pasar a «Registrado» sin `partner_id` abre el vinculador: sugiere los
proveedores con el mismo teléfono y ofrece un buscador por nombre o teléfono.
**Vincular es siempre un click**, nunca automático: una cadena puede compartir
un teléfono entre sucursales. El SP no exige el vínculo para pasar a
registrado (no decide); la tarjeta avisa en ámbar mientras falte.

## Importación por CSV

Todo se arma en el navegador (`parseCsv`: comillas, `,` o `;`); al servidor van
filas elegidas, no el archivo. Columnas detectadas por encabezado y
corregibles. Un origen y un comercial por tanda; rubros de la tanda para las
filas que no traen. Excluidas de entrada: sin nombre, ya cargado, repetido en el
archivo. "Ya es proveedor" arranca destildado. Tope 2000 filas.

En el SP los duplicados no cortan la tanda (se saltean y se cuentan, por si
alguien cargó el número entre la vista previa y la confirmación); un error de
validación sí, con el número de fila (`IMPORT_ROW_INVALID`), y no queda nada a
medias.

## Comercial

`owner_id`. Las opciones son los admins con cuenta de **Clerk** (los únicos que
entran al panel) más quien ya figure como comercial de algún contacto. Sin el
corte por `clerk`, DEV traería 876 admins `native` heredados. Toby tiene que
tener cuenta admin para entrar; si no, no aparece.

## Search params

Calificados `prospect*` (`prospectStatus`, `prospectOrigin`, `prospectRubro`,
`prospectOwner`, este último uuid o `none`). `q` se comparte.

## Cómo se verificó

- Suite `024_ops_seguimiento_comercial.test.sql`: 79/79 en una réplica PGlite
  (Postgres 17 en WASM) con `users`/`partners`/`service_categories` mínimos y la
  007. Aborta en rojo sin la 024. **No corrida en DEV ni en producción** (el
  `.env` de esta máquina apunta a producción).
- `tmp/probe-comercial-repo.mjs`: carga el repo REAL contra esa réplica servida
  con `@electric-sql/pglite-socket` en `:5499`. PGlite atiende UNA conexión, así
  que el probe le presta a `db.ts` un pool de 1 (`globalThis.__autolibrePool`).
- `vite build` + `tsc --noEmit` limpios; `ops.partner_prospect` aparece en el
  bundle del cliente sólo como texto de `ProspectsUnavailable`.
- **Sin verificar en el navegador**: la pantalla pide login de Clerk y la 024 no
  está en ninguna base.

## Lo que no hace

- **Borrar un contacto**: no se pidió. Se cierra con «No le interesa».
- **Historial de llamadas**: un contacto guarda el ÚLTIMO contacto y el próximo
  seguimiento, no cada llamada. `ops.action_log` tiene cada cambio, sin pantalla.
- **Pasar a Solicitud**: un contacto registrado se vincula al partner que ya
  existe; no crea la solicitud ni el partner.


## La ficha completa y las charlas (migración 030) — desde el 2026-11-11

Plan: `.claude/plans/comercial-fichas-charlas-chasis.md`. Etapa 1 (ficha,
charlas, filtros). Resumen y Altas del mes son la etapa 2 y API Chasis la 3 (las dos, abajo).

### El embudo nuevo, y por qué Comercial exige la 030 entera

`to_contact → contacted → interested → registered → first_order →
job_confirmed`, más `discarded` con motivo OBLIGATORIO (SP + CHECK + zod). La
030 mapea los viejos al aplicarse (`pending`/`no_answer`/`visit` → por
contactar, con "Volver a llamar"/"Ir en persona" como próximo paso; `thinking`
→ contactado; `not_interested` → descartado con motivo "No le interesa (estado
anterior)"). Al 2026-11-11 los 890 de producción estaban todos en `pending`.

**Sin la 030, Comercial no muestra nada y dice qué falta**
(`comercialAvailability`, `ProspectsUnavailable missing="030"`): mezclar dos
embudos en una pantalla es peor que no tenerla. Partners › Propuestas
(`listPartnerLastContacts`) y Sellos (`findPhoneMatches`) sólo leen columnas de
la 024 y siguen con `partnerProspectsAvailable`.

### "Verificado" es derivado

Los 4 checks en `true`, calculado en el SELECT (`VERIFIED_SQL`, la misma
expresión para la columna, el filtro y el contador). No se agrega una columna:
sería una segunda verdad.

### La fecha de alta se GUARDA

`partner_registered_on`: se fija sola al vincular con `partners.created_at` en
hora de Buenos Aires (decidido: el alta es cuando el proveedor existe en el
marketplace, o sea la aprobación), se borra al desvincular y se puede corregir
a mano. Es la de la liquidación de fin de mes: recalcularla al leer haría que
una liquidación ya pagada cambie sola.

### Las charlas son append-only

`ops.partner_prospect_interaction`. No hay SP que edite ni borre una charla (la
suite lo verifica, caso 04): una mal cargada se corrige cargando otra.
`ops.add_partner_prospect_interaction` guarda la charla y mueve el contacto
(estado, `last_contact_on`, `next_step`, `next_follow_up_on`) por
`ops.update_partner_prospect` en la MISMA transacción, con su propio log.

**Sólo la charla más reciente mueve el contacto**, y `last_contact_on` no
retrocede: cargar hoy un llamado de la semana pasada lo suma al historial sin
pisar lo que se habló ayer.

### El formulario del celular

`InteractionComposer`: obligatorios canal, estado (precargado con el actual) y
próximo paso; la fecha la pone la base salvo "fue otro día". Botones de un
toque de 40 px o más (`Segmented`, `YesNo`, `ToggleCheck` de `ProspectFields`),
no selects; atajos de próximo paso y de fecha ("Mañana / 3 días / 1 semana",
calculados en hora de Buenos Aires en el click, nunca en el render SSR). Todo
lo demás va plegado en "Más detalle". El SP es el que vale; zod repite las
reglas para decir qué falta al lado del campo.

### Frente

`ruta-2 | corredor-norte | por-pedido`. "Por pedido" guarda el uuid del pedido,
buscado por su `AL-n` (`findQuoteByCodeFn`), nunca un id tipeado; cambiar de
frente suelta el pedido. La 030 pasó la etiqueta del principio de la nota
(`[Ruta 2 · GPS Taller · km N]`) a los campos: frente, origen `gps-taller`, y
la nota empieza por `km N · …`. La importación por CSV elige un frente por
tanda (Ruta 2 o Corredor Norte).

### La ficha es una ruta

`/comercial/contactos/$prospectId`; el listado es `comercial.contactos.index.tsx`
(con el listado en `comercial.contactos.tsx` la ficha quedaría sin `<Outlet/>`,
`scan-sessions.md`). "Comercial" se lee "Conseguido por" en toda la UI: es el
mismo `owner_id`.

### Search params nuevos

`prospectFront` (frente o `none`), `prospectZones` (localidades crudas, por
igualdad, multiselect) y `prospectVerified`.

### Cómo se verificó la 030

- Suite `030_ops_comercial_ficha_y_charlas.test.sql`: 78/78 en PGlite; aborta en
  rojo sin la 030. La de la 024 sigue en 79/79 con la 030 aplicada (sus casos 22
  y 81 aceptan los dos embudos; además se le castearon al enum dos `'clerk'` que
  en un `UNION ALL` abortaban en una base real).
- El mapeo y el backfill: el runner inserta filas con estados viejos y notas con
  etiqueta ANTES de aplicar la 030 y compara.
- `tmp/probe-comercial-030.mjs` (repo real contra la réplica en `:5499`) y
  `tmp/probe-comercial-024only.mjs` (base sin la 030: Comercial se apaga,
  Propuestas sigue).
- **No corrida en DEV ni aplicada en producción**: la aplica el `vercel-build`
  del próximo deploy de `main`. **Sin verificar en el navegador** (login de
  Clerk contra una base sin la 030).

## Resumen y Altas (etapa 2) — desde el 2026-11-11

`/comercial/resumen` y `/comercial/altas`, pestañas 3 y 4 del layout. Sólo
lectura: `comercialSummary`, `listTodayFollowUps(quotes, search)`,
`listMonthlyRegistrations`, `listUnlinkedRegistrationCandidates` en el repo;
`getComercialSummaryFn` y `getMonthlyRegistrationsFn`, con el mismo
`comercialGate` (exige 024 y 030).

### Qué filtra la fecha y qué no

El Resumen usa los filtros de Contactos (frente, zona, rubro, conseguido por)
más `prospectFrom`/`prospectTo` (días en hora de Buenos Aires, inclusive).
**El rango acota las charlas y las altas; nunca el estado.** Los conteos por
estado y los verificados son el estado de HOY de los contactos que pasan el
filtro, y la pantalla lo dice. Mezclarlos ("interesados en octubre") pediría
saber en qué estado estaba cada contacto cada día, y eso no se guarda (sólo
`ops.action_log`, sin pantalla).

"Altas del mes" es siempre el mes actual de Buenos Aires; con rango aparece
además "Altas en el período". Las dos leen `partner_registered_on`, la fecha
GUARDADA al vincular, no la recalculan.

### Cómo se cuentan objeciones y trabajos/mes

- **Objeciones**: por objeción, proveedores DISTINTOS (el número grande) y
  charlas (el chico). El que repite "precio" en tres llamados es un proveedor,
  no tres. "Otra" se agrupa por texto sin mayúsculas ni espacios de más (top 10).
- **Trabajos/mes para pagar**: el ÚLTIMO valor de cada contacto dentro del
  rango (`distinct on (prospect_id) … order by occurred_at desc`), y recién
  después promedio y mediana entre contactos, con `n`. Promediar las charlas
  haría pesar más al que habló más veces.
- Las cuatro consultas del Resumen (contactos, objeciones, "Otra",
  trabajos/mes) son sentencias separadas, cada una con su pregunta, como los
  bloques de `/metricas`. Todas parten del MISMO `filterWhere`.

### Altas: para liquidar

Las altas de un mes (`prospectMonth`, `YYYY-MM`; sin él el servidor usa el
actual de Buenos Aires y lo devuelve), agrupadas por "Conseguido por"
(`owner_id`) con su total y cuántas verificadas. `shiftMonth`/`monthLabel` son
aritmética pura, sin `Intl` ni `Date` local: el título tiene que ser el mismo
en el servidor y en el cliente.

### Posibles altas sin vincular: nunca se vincula solo

Contactos sin `partner_id` cuyo `phone_digits` coincide con
`ops.normalize_ar_phone` del WhatsApp de un proveedor, o de una solicitud que
todavía no tiene proveedor (`partners.application_id`). Un proveedor → un
botón; varios → uno por cada uno, y elige una persona (una cadena comparte
teléfono entre sucursales). "Vincular" manda el MISMO parche que el vinculador
de la tarjeta (`partnerId`, más `status: registered` si todavía no estaba
registrado), así el SP de la 030 fija la fecha de alta. Una solicitud sin
proveedor es informativa, con link a `/solicitudes/$applicationId`: no hay con
qué vincular. Sin `partner_applications` en la base, ese lado sale vacío
(`comercialAvailability().applications`).

### Cómo se verificó

`tmp/probe-comercial-etapa2.mjs`: repo real contra una réplica PGlite con la
007/024/030 y datos sembrados POR LOS SP (no por INSERT), 29 cuadres contra SQL
directo — filtros, rango, objeciones por proveedor, el último trabajos/mes por
contacto, vencidos/hoy con filtros, altas por mes, candidatos con y sin
`partner_applications`, y vincular desde la lista. `vite build` +
`tsc --noEmit` limpios, borde server-only limpio. **Sin verificar en el
navegador**, por lo mismo que la etapa 1.

## API Chasis (migración 031, etapa 3) — desde el 2026-11-11

`/comercial/api-chasis` (listado + resumen) y `/comercial/api-chasis/$agencyId`
(ficha + historial). Alcance: `migrations/031_ops_api_chasis.sql` (+ su
`.test.sql`), `src/lib/chasis-agencies.ts`, `src/server/chasis-agencies.repo.ts`,
`src/fn/chasis-agencies.ts`, `src/components/ChasisAgencies.tsx`, las dos rutas
`comercial.api-chasis.*` y la sección de agencias de `/comercial/hoy`.

### Una agencia NO es un contacto de proveedor

`ops.chasis_agency` es su propia tabla, con su embudo (`contacted →
saw_sample → proposal_sent → client`, más `discarded` con motivo). Meterla en
`ops.partner_prospect` ensuciaría los conteos y las altas de Contactos. En el
código es `ChasisAgency`; nunca `Partner` ni `PartnerProspect`. "Chasis" es el
sistema donde se carga el referido para cobrar la comisión: el panel no habla
con él, `referral_loaded` es un check que tilda una persona.

Mismo patrón que la 024/030: la ficha se edita por PARCHE (autoguardado,
`useAgencyAutosave`), teléfono normalizado con `ops.normalize_ar_phone` e
índice único parcial, charlas append-only
(`ops.chasis_agency_interaction`), sólo la charla más reciente mueve la
agencia y `last_contact_on` no retrocede.

### Carbufy

Decidido en el plan: marcar "Usa Carbufy: sí" descarta la agencia con motivo
"Usa Carbufy" en la MISMA operación (`_normalize_chasis_agency`, sólo si el
parche no trae un estado propio; si trae otro motivo, queda ése). La ficha pide
confirmación antes de guardar.

### Cliente sin referido

`ReferralWarning`: ámbar en la tarjeta y en la ficha si `status = client` y
`referral_loaded = false`. El resumen cuenta los referidos cargados y cuántos
clientes no lo tienen.

### "Consultas/mes del pipeline"

La suma de `monthly_volume` de las agencias ABIERTAS (no cliente, no
descartada), siempre con cuántas tienen el dato al lado: una suma sin el `n`
se lee como completa. Los clientes van en su propio número.

### Las charlas de agencias no son las de proveedores

Mismo formulario de celular, con estos cambios (los dos del pedido y uno
decidido acá): modelo = suscripción mensual / pack de informes + precio dicho;
objeciones propias (precio, ya tiene proveedor, poco volumen, integración
técnica, dudas con los datos, no es el momento, otra). **No hay "qué le
contó" ni "trabajos por mes para pagar"**: son del pitch del marketplace (cómo
llegan los pedidos, perfil como web, Asistir 24); para una agencia el volumen
vive en la ficha (`monthly_volume`). Si se quieren, se agregan como columnas
nuevas en una migración, no reusando las de proveedores.

### "Crear contacto de proveedor"

Sólo con "tiene taller, lubricentro o gomería" en sí y sin contacto linkeado.
`ops.create_prospect_from_chasis_agency` crea el contacto con frente Corredor
Norte, origen `api-chasis` (sembrado por la 031), nombre, teléfono, zona,
contacto y conseguido por copiados, y deja `prospect_id`. **Si el teléfono ya
es un contacto, linkea a ése y devuelve `created = false`** (la ficha lo dice),
nunca duplica. Una segunda vez es `AGENCY_ALREADY_LINKED`.

### Disponibilidad

`agencyGate` exige 024, 030 y 031 (el contacto que se crea lleva frente).
`/comercial/hoy` muestra las agencias vencidas o de hoy sólo si la 031 está;
sin ella esa sección no aparece y Hoy sigue igual. Search params calificados
`agency*` (`agencyStatus`, `agencyZones`, `agencyOwner`); `q` se comparte.

### Cómo se verificó la 031

Suite `031_ops_api_chasis.test.sql`: 64/64 en PGlite, aborta en rojo sin la
031; la 024 (79/79) y la 030 (78/78) siguen verdes con la 031 aplicada (al
caso 04 de la 030 hubo que acotarle el `LIKE '%interaction%'`, que con la 031
también agarraba `add_chasis_agency_interaction`). `tmp/probe-api-chasis.mjs`:
22 cuadres del repo real contra la réplica. `vite build` + `tsc --noEmit`
limpios, borde server-only limpio. **No aplicada en ninguna base ni vista en el
navegador.**
