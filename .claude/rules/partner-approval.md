---
paths:
  - 'src/server/partners.repo.ts'
  - 'src/fn/partners.ts'
  - 'src/lib/partners.ts'
  - 'src/lib/catalog.ts'
  - 'src/routes/_authed/partners.*'
  - 'src/routes/_authed/solicitudes.*'
---

# Aprobación de partners — la primera pantalla real

## La spec ya está escrita

`../autolibre-backend-hex/scripts/sql/aprobar-partner-application.sql`

Ese archivo es un runbook de DBeaver de 8 consultas, con sus trampas documentadas. **Es la
especificación de esta pantalla.** Leelo entero antes de escribir una línea — no lo resumas de acá,
que este archivo se puede quedar viejo y aquél es el que corre.

Lo que sigue es lo que el panel tiene que preservar, no un reemplazo del original.

## Son DOS pasos, y el segundo es el que se olvida

1. **`approve_partner_application(application_id, reviewer_id, coverage_zone)`** crea el partner.
   Nace con `status='active'`, así que aparece en `GET /partners` sin filtro al toque.
2. **Cargar los rubros en `partner_services`.** Sin esto el partner **no sale bajo ningún chip** de
   la app — solo en el listado sin filtrar.

El paso 2 no lo puede hacer la función porque son **dos alturas distintas de la taxonomía**:

- El formulario declara **FAMILIAS** — 16 `service_categories`, para no ahogar a quien se anota.
- `partner_services` guarda **RUBROS** — 79 `services`, que es por lo que filtra la app.

Bajar de una a la otra es un JOIN por `services.category_id`. **No es una tabla de mapeo escrita a
mano**: el archivo tuvo una y se sacó, justamente para que un rubro nuevo del catálogo entre solo.

> Si en el panel volvés a escribir un mapa familia→rubro a mano, estás reintroduciendo la clase de
> bug que ese JOIN vino a eliminar.

### Un partner entra con TODOS los rubros de las familias que declaró

Decisión tomada. Si el taller marca "Motor", entra en los 10 rubros de motor.

**La contra es real y hay que conocerla: SOBRE-DECLARA.** Un taller de service básico va a salir
también bajo "rectificación de motores". Se corrige borrando filas puntuales de `partner_services`.
El panel debería dejar hacer eso — es la consulta 7 del runbook.

## La regla dura: nunca `status='verbal_agreement'` a mano

`approve_partner_application()` lleva `AND status <> 'verbal_agreement'` como **lock optimista**, para
que dos aprobaciones simultáneas no creen dos partners.

Consecuencia: una solicitud marcada a mano con ese estado queda **TRABADA** — la función la rechaza
para siempre con "inexistente o ya aprobada", y encima sin partner. **Ya pasó.**

Para el panel esto significa dos cosas concretas:

- El editor de estado del pipeline **no puede ofrecer `verbal_agreement`** como opción manual. Los
  otros cuatro (`not_contacted → contacted → in_conversation`, más `discarded`) sí.
- Hace falta la pantalla de destrabe (consulta 5): solicitudes en `verbal_agreement` **sin** partner.
  El `NOT EXISTS` de esa consulta no es decorativo — sin él le devolvés el estado a partners ya
  publicados y al re-aprobarlos los duplicás.

## El modo de falla silencioso

**Partners activos sin un solo rubro.** Existen, se listan sin filtro, y no aparecen bajo ningún
chip. El runbook lo mira después de cada aprobación (consulta 6) y lo esperable es cero filas.

**Esto tiene que ser un indicador permanente del panel, no una consulta que alguien se acuerde de
correr.** Es exactamente la clase de cosa que un panel existe para hacer imposible de olvidar.

Igual con la consulta 4: solicitudes que declararon un slug que no es una familia activa. Con el
formulario nuevo debería dar cero siempre (el backend valida en el alta y devuelve 400), pero cubre
dos casos que el backend no pudo: solicitudes cargadas antes de esa validación, y familias dadas de
baja después de haber sido declaradas. En los dos, la carga automática no le pone **nada** a ese
partner, en silencio.

## `v_partner_application_queue`

Es una **vista**, y trae la columna que importa: `already_published`. En `false` con
`status='verbal_agreement'` significa que la invariante está rota.

## Qué NO hacer

**No le agregues lógica a `approve_partner_application()`.** El backend le puso una condición
explícita para que siga siendo aceptable:

> *"La condición para que esa función siga siendo aceptable es que se mantenga flaca: mueve estado y
> copia datos, no decide nada."*

Esa condición no se relaja porque ahora haya panel. Si aparece una decisión que tomar, la toma el
panel o un caso de uso del backend.

**No inventes vocabulario.** `PartnerApplication` es el taller viniendo hacia nosotros; `Lead` es el
usuario yendo hacia el taller. Se dice `Partner`, nunca `Provider`.

## Volumen (2026-08-26)

`partner_applications` 3 · `partners` **34** · `partner_services` 129 · `services` 79 ·
`service_categories` 16 · `leads` 0.

> El 35 que devuelve `reltuples` en `pg_class` es una ESTIMACIÓN del planner, no un conteo. Para
> cualquier número que vayas a mostrar o sobre el que vayas a decidir, `count(*)`.

Chico y verificable: se puede comparar el resultado del panel contra el del runbook fila por fila.
Hacelo la primera vez.

---

# Consultas 7 y 8 — el editor de rubros

`/partners/listado` y `/partners/$partnerId` (editor). Reemplazan las tres consultas de
mantenimiento del runbook: la 6 (invisibles), la 7 (qué tiene cada uno) y la 8 (carga manual).

> **`/partners` pasó a ser un layout de 2 pestañas el 2026-09-08** (Listado · Cobertura), mismo
> patrón que `/leads` y `/vehiculos`. Todo lo de esta sección vale igual — sólo cambió el prefijo:
> `/partners` → `/partners/listado`. El tablero de Cobertura y el vocabulario de UI
> (`Rubro` = las 16 `service_categories`, `Servicio` = los 79 `services`) están en
> `.claude/rules/partners-coverage.md`.

## Por qué van juntas en una pantalla

En DBeaver son operaciones opuestas y sueltas — un `DELETE` para corregir sobre-declaración y un
`INSERT` para cargar lo que la automática no resolvió. Pero **la corrección típica es las dos a la
vez**: sacarle tres rubros que no hace y agregarle uno que sí. Aplicarlas por separado deja al
partner en un estado intermedio que nadie eligió, así que el editor manda `add` y `remove` juntos y
el repo los aplica en una transacción.

## El orden del listado no es alfabético a propósito

El **default** es `sort=services` `asc` con desempate por `name` — o sea el viejo
`ORDER BY count(ps.service_id), p.name`: los de cero rubros van **primero**. Un listado alfabético
los esconde en el medio, que es exactamente lo que hace que este modo de falla pase desapercibido.

Desde el 2026-09-08 el listado es ordenable por columna (el operador puede pasar a alfabético), pero
el default no se toca y `PARTNER_SORT_COLUMNS` en `partners.repo.ts` **siempre** appendea `t.name`
como último criterio para que ese default siga siendo estable.

## Sugerencias para lo que la automática ignoró

Cuando un partner viene de una solicitud que declaró algo que **no es una familia activa**, el editor
ofrece los rubros del catálogo que coinciden por texto normalizado (sin acentos, minúsculas,
espacios → guiones).

Sale de un caso real: `"Chapa y pintura"` no es familia, así que la consulta 3 no cargó nada — pero
`chapa-y-pintura` **sí existe como rubro**, bajo "Carrocería y cristales". El runbook te manda a
buscarlo a mano en la consulta 8.

Comportamiento verificado contra el catálogo real (79 rubros):

| Declarado | Sugerencias |
|---|---|
| `Chapa y pintura` | `chapa-y-pintura` |
| `Gomeria` | `gomeria` **y** `gomeria-movil` — elige el operador |
| `Taller Mecanico` | ninguna — demasiado genérico |

Las tres son correctas, incluida la última: por eso el editor muestra **el catálogo completo**, no
solo lo sugerido. Y **se sugiere, no se aplica solo** — una coincidencia de texto no es una decisión
de negocio.

La normalización vive en JS (`normalizeForMatch` en `~/lib/catalog`) y no en SQL: la versión en
Postgres necesitaría la extensión `unaccent`, que es una dependencia de infraestructura para comparar
strings sobre 79 filas que ya están en memoria.

## Detalles del `editPartnerServices`

- **`ON CONFLICT DO NOTHING`** — la PK es `(partner_id, service_id)`; reenviar un rubro que ya está
  no es un error del operador.
- **El `INSERT` va con `JOIN services ... AND s.active`**, no con los ids sueltos. Filtra ids
  inexistentes o de rubros dados de baja antes de que salte la FK: un id inválido en el payload es un
  0 en el contador, no un 500.
- **Devuelve el total resultante**, para que la UI avise en el acto si el partner quedó en cero en vez
  de esperar al próximo chequeo de salud.

## Estado relevado (2026-08-26)

34 partners publicados, **0 invisibles**. Distribución de rubros → partners:
`{1:14, 2:9, 3:1, 4:3, 8:2, 9:2, 11:1, 12:2}`.

La mayoría tiene 1–2 rubros, lo que sugiere que vinieron de la planilla vieja y no de la carga
automática por familia (que da 5–10+ por familia declarada). Vale tenerlo en cuenta antes de leer un
número bajo como un error.
