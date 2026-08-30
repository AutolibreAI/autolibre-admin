# Escrituras del panel: stored procedures de `ops` sobre `public`

Alcance: `migrations/007_ops_acciones_admin.sql`, las funciones `setPartner*` de
`src/server/partners.repo.ts`, `src/server/leads.repo.ts`, `src/fn/leads.ts`, las
`setPartner*Fn` de `src/fn/partners.ts`, `src/components/PartnerFicha.tsx`,
`src/routes/_authed/leads.tsx`.

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
