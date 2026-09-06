# Leads: las pestañas de `/leads`

Alcance: `src/routes/_authed/leads.tsx` (layout), `leads.index.tsx`,
`leads.talleres.tsx`, `leads.seguros.tsx`, `leads.contactos.tsx`,
`leads.financiacion.tsx`, `leads.pedidos.tsx`, `src/lib/insurance.ts`,
`src/server/insurance.repo.ts`, `src/fn/insurance.ts`,
`src/components/ComingSoonPipeline.tsx`.

Las escrituras del embudo de talleres (`ops.advance_lead`) NO están acá — su
regla es `.claude/rules/ops-write-actions.md`. Seguros y las otras tres pestañas
no escriben nada.

## `/leads` es un layout, no una pantalla

`leads.tsx` sólo renderiza la barra de pestañas y un `<Outlet/>`. `leads.index.tsx`
redirige a `/leads/talleres`. Cada pestaña es un archivo con su propio `Route`,
su `validateSearch` y su modo de SSR.

Consecuencia práctica: un `Link to="/leads"` cae en el redirect (un salto de
más). Apuntá a `/leads/talleres` directo, como hace la tarjeta de Inicio.

## "Sección de leads" acá NO es el `Lead` del backend

Esta es la trampa de vocabulario y hay que tenerla clara antes de tocar
cualquier archivo:

- **Para el backend, `Lead` es una cosa concreta**: el enum `lead_status`
  (`new | contacted | won | lost`), `lead_source`, el aggregate de `marketplace/`.
  Es el embudo usuario→taller por un presupuesto de service.
- **Acá "sección" es la vista de producto**: una línea por la que un usuario
  llega a pedirnos algo. El `Lead` del backend es UNA (la pestaña "Talleres").
  Las otras cuatro no son `Lead`s.

Por eso el código de Seguros dice `Insurance` (que es como se llama el aggregate
del otro lado — `vehicle-management/`), no `Lead`, y su repo es
`insurance.repo.ts`, no `leads.repo.ts`. Regla dura 7: el vocabulario es el del
backend. Si aparece un tipo `SeguroLead` o una función `advanceInsuranceLead`,
está mal.

## Qué pestaña tiene datos, al 2026-09-06

| Pestaña | Tabla | Estado |
|---|---|---|
| **Talleres** | `leads` | Real. Es `leads.talleres.tsx`, movido tal cual del viejo `leads.tsx`. En producción hoy tiene **0 filas** (el embudo todavía no se usó). |
| **Seguros** | `insurances` | Real. 16 pólizas vivas en producción, 3 vencen en <30 días. |
| **Contactos** | — | No hay tabla. Ver abajo. |
| **Financiación** | — | El producto no existe. |
| **Pedidos** | — | El flujo no existe. |

## Por qué existen tres pestañas sin datos

Es la **excepción relevada el 2026-09-06** a *"una pantalla que no reemplaza
ninguna consulta no va todavía"*. Se decidió mostrarlas como plan visible en vez
de esconderlas.

Lo que las hace admisibles y no una violación de la regla dura 8:

- **No fabrican dominio.** `ComingSoonPipeline` no tiene un array de ejemplo, ni
  una entidad inventada, ni un número. Es un cartel que dice qué línea es y qué
  falta.
- **No tienen `Route` con loader.** Cero consultas, cero server functions.

Si esto se siente como el germen de las pantallas placeholder que se borraron el
2026-08-30 (`/records`, `/analytics`, `/settings`): la diferencia es que
aquellas RENDERIZABAN datos falsos de un `placeholder-data.ts`. Estas renderizan
tres párrafos de texto y nada más. El día que una de las tres tenga tabla real,
su archivo pasa a tener `Route` + loader y deja de usar `ComingSoonPipeline`.

## Contactos a partners: por qué no se puede arrancar desde este repo

El pedido era "conteo total y por fecha de contactos directos a partners,
medidos como clicks en 'escribir por WhatsApp'".

Relevado contra el schema el 2026-09-06: **ninguna tabla registra ese tap.**

- No hay `partner_contact_clicks` ni tabla de eventos del marketplace.
- `recommendation_impressions` existe (0 filas en producción) pero registra que
  un partner se **mostró** en el ranking de learning-to-rank (`rank`, `score`,
  `features`), no que alguien lo contactó.
- `partners.whatsapp` es el número; nadie cuenta las aperturas.

El click pasa en la app mobile. Es la misma situación que la medición de tokens
de IA en `ai-costs.md`: *"el panel puede leer y agregar sin tocar el backend;
medir no"*. Para que esta pestaña exista, primero:

1. La app emite el evento al tocar "contactar por WhatsApp".
2. El backend lo persiste — una tabla append-only estilo
   `recommendation_impressions`, o un endpoint en `query/` (la capa de
   composición de lectura, que es la puerta natural del panel para reportes).

Recién ahí el panel lo lee, y el "total y por fecha" es un `count(*) … group by
date_trunc('day', …)` trivial. **No se resuelve con un array de ejemplo hasta
que haya dato** — ese array sobrevive meses y termina en producción (regla dura
8, corolario operativo).

## Seguros (`/leads/seguros`)

### Qué consulta reemplaza

El `select … from insurances where expiration_date < now() + interval '30 days'`
que hoy nadie corre sistemáticamente. Es una **lista de trabajo** (a quién
contactar para ofrecerle una alternativa), no una métrica — por eso muestra
nombre, email y patente, y por eso pasa por `adminMiddleware`.

### `days_to_expiry` sale de `expiration_date`, NUNCA de `status`

Verificado contra producción: hay pólizas en `active` a 28 días de vencer y en
`pending_renewal` a 7. A `insurances.status` (`document_status`:
`active | pending_renewal | expired`) lo mueve alguien o algún proceso del
backend, y no es un reloj confiable. Los días son aritmética sobre la fecha;
`status` viaja aparte como una columna más.

Es la misma forma que `noData` vs `failed` en `scanner-compatibility.md` y
`stuck` vs `failed` en `ops-metrics.md`: una señal derivada del reloj no se
mezcla con un estado que el dominio escribe.

### `JOIN`, no `LEFT JOIN`, a `users` y `vehicles`

`insurances.user_id` y `insurances.vehicle_id` son NOT NULL con FK. Un
`LEFT JOIN` escondería una corrupción de datos detrás de celdas vacías. Mismo
criterio que `findUserDetail` contra el catálogo del vehículo, y opuesto al
`LEFT` de `chats.md` (ahí el vehículo entero es opcional; acá no).

### La aseguradora es texto libre y sucio — se muestra crudo

14 valores distintos para 16 filas: `SANCOR SEGUROS` / `Sancor` / `Sancor
Seguros` / `SANCOR COOPERATIVA DE SEGUROS LIMITADA` conviven. No hay forma de
normalizar sin inventar un mapeo, así que se muestra tal cual viene. Mismo
criterio que el `insurer` sin tocar, el `model` de `chats.md` y el
`scanner_firmware` de escáneres: si el proveedor del dato no lo estandariza,
nosotros tampoco lo adivinamos.

### El PDF no se descarga

`insurances.file_id` puede apuntar a un `files` con el PDF de la póliza. La
columna "PDF" sólo **informa** si existe. `GET /files/:id/url` del backend está
acotado al DUEÑO del archivo (el usuario), así que un admin recibiría 404. Mismo
límite exacto que los manuales de catálogo (`vehicle-manuals.md`, trampa 1) — y
no se arregla desde este repo.

### `nullif(btrim(coalesce(x,'')), '')` en cada campo de texto

`insurer`, `coverage_type`, `insured_name`, `plate`, `vin`, `engine_number`
pueden venir vacíos (string, no `NULL`) del import de datos. Se normalizan a
`null` en el SELECT para que la UI muestre "—" y no una celda con un espacio.
Misma razón por la que todo chequeo de campo faltante en este repo se escribe
`coalesce(x,'') = ''`.

### Los cuatro contadores están siempre, incluso en cero

`SummaryTiles` es una superficie de monitoreo (mismo criterio que las tarjetas
de cola de `/operacion`), no la lista de pendientes de Inicio. Y los cortes son
**fijos** (vencidas / ≤30 / 31–90), no siguen la ventana elegida en los chips:
son un panorama, no el resultado del filtro.

### Ni una escritura

Una póliza es un hecho que el backend escribe cuando el usuario la carga en la
app. Mismo criterio que `driving_sessions` y `conversations`. Si aparece un
`UPDATE`/`INSERT` en `insurance.repo.ts`, está mal.

## Cómo verificar un cambio acá

`pnpm typecheck` + `pnpm build` (el build regenera `routeTree.gen.ts`, así que
una pestaña nueva o un `Link` a una ruta nueva sólo se validan DESPUÉS del
build).
