# Seguimiento comercial (`/comercial/hoy`, `/comercial/contactos`)

Alcance: `migrations/024_ops_seguimiento_comercial.sql` (+ su `.test.sql`),
`src/lib/partner-prospects.ts`, `src/server/partner-prospects.repo.ts`,
`src/fn/partner-prospects.ts`, `src/components/ProspectCards.tsx`,
`src/components/ProspectComposer.tsx`, `src/components/ProspectImporter.tsx`,
`src/components/ProspectsUnavailable.tsx`, `src/routes/_authed/comercial*.tsx`,
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

Registrado verde · Lo piensa ámbar · No le interesa rojo · **Interesado
VIOLETA, no azul**: `tokens.ts` de mobile dice "Esta app NO TIENE azul a
propósito". Si se quiere azul, se agrega primero en mobile y se re-portea
(`design-system.md`). "Ir en persona" es Action Dark (es una acción pendiente);
Pendiente y "no atendió", grises.

## Vista Hoy

`next_follow_up_on <= hoy` (en **Buenos Aires**, no UTC) y estado abierto
(`CLOSED_PROSPECT_STATUSES` = registrado / no le interesa), por fecha. Los días
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
