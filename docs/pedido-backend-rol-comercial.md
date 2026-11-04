# Pedido al backend: rol restringido para el equipo comercial (2026-11-03)

De: panel de administración (`autolibre-admin`). Para: Ramiro (backend hex).

Sin tarjeta propia: sale de la regla «el rol restringido de Tobías no ve datos de usuarios».

## Qué hay hoy

- El panel conoce un solo rol: `admin` (`users.role`, enum `user_role` = `user | admin |
  provider`). Quien entra, ve todo: padrón, chats, documentos, pedidos con teléfono y email.
- Tobías usa sobre todo Comercial (`/comercial/hoy`, `/comercial/contactos`), Partners y las
  Propuestas por proveedor. Para eso no necesita ningún dato de usuarios de la app.

## Qué falta

- [ ] Un rol nuevo, por ejemplo `commercial`, en `user_role` (o una tabla de permisos aparte, si
  se prefiere no recrear el enum).
- [ ] Que el `AdminGuard` del backend y el `adminMiddleware` del panel distingan `admin` de
  `commercial`. El panel se encarga de qué rutas y server functions acepta cada rol.
- [ ] Cómo se asigna: a mano por ahora, auditado.

## Permisos

Sólo un `admin` puede dar o sacar el rol. `commercial` **no ve** datos de usuarios: ni padrón, ni
chats, ni documentos, ni el contacto de los pedidos.

## Listo cuando

- Tobías entra al panel con `commercial` y ve Comercial, Partners y Propuestas.
- `/usuarios`, `/chats`, `/documentos` y la ficha de un pedido le devuelven «sin acceso», también
  si llama al server function directo.

## Preguntas abiertas

1. ¿Qué otras pantallas tiene que ver? ¿Métricas agregadas sí, pedidos no?
2. ¿Puede escribir en Partners (plan, sellos, servicios) o sólo leer?
