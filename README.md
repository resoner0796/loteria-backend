# ☁️ Backend — Juegos en la Nube

Servidor de tiempo real y API para el ecosistema **Juegos en la Nube**: Lotería
mexicana, Serpientes y Escaleras, Pirinola y el Hub que los agrupa.

🔗 **Producción:** <https://loteria-backend-3nde.onrender.com>

---

## 🧩 Qué hace

Un único proceso Node que atiende, en el mismo puerto:

- **API REST** (`/api/*`) — registro y login, perfil, tienda, historial de
  movimientos, transferencias entre jugadores, pagos con Stripe, panel de
  administración y catálogo del Hub.
- **Socket.IO** — salas de juego, canto de cartas, apuestas, validación de ganadores,
  turnos de dados y contadores de jugadores en vivo.

```
   FRONTENDS (Vercel)                    ESTE SERVIDOR (Render)
   ├── loteria.juegosenlanube.com  ───►  ├── REST /api/*
   ├── juegosenlanube.com (Hub)          └── Socket.IO
   └── serpientes / pirinola                     │
                                    ┌────────────┼────────────┐
                                FIRESTORE     STRIPE        FCM
```

El repo tiene **dos archivos**: `server.js` y `package.json`.

---

## 🚀 Instalación y ejecución

```bash
npm install
npm start          # → http://localhost:3000
```

### Variables de entorno

| Variable | Descripción |
|---|---|
| `nicknames` | JSON completo del service account de Firebase, en una sola línea |
| `STRIPE_SECRET_KEY` | Llave secreta de Stripe |
| `ADMIN_EMAIL` | Email de la cuenta administradora. Si no se define, cae a `admin@loteria.com` |
| `JWT_SECRET` | **Importante.** Llave para firmar los tokens de sesión. Sin ella se genera una temporal y los tokens dejan de valer en cada reinicio |
| `AUTH_ESTRICTA` | `true` cierra el camino sin token. Ver abajo |
| `PORT` | Puerto (Render lo inyecta; por defecto `3000`) |

> `ADMIN_EMAIL` debe coincidir **exactamente** con el ID del documento en
> `usuarios/{email}` (se compara en minúsculas), porque también se usa para mandarte
> las notificaciones push de ventas y registros.

> El nombre `nicknames` para las credenciales de Firebase es un accidente histórico,
> pero es el que está configurado en Render. Renombrarlo requiere actualizar Render
> **antes** de desplegar.

> ⚠️ Las credenciales de producción apuntan a la Firestore real. Para desarrollar,
> crea un proyecto de Firebase aparte y usa llaves `sk_test_` de Stripe.

### Verificación mínima

No hay tests. Después de editar:

```bash
node --check server.js
```

---

## 📡 API REST

### Autenticación y perfil
| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/registro` | Alta de usuario (bcrypt). Regala 20 monedas |
| `POST` | `/api/login` | Login. Rechaza cuentas baneadas |
| `GET` | `/api/usuario/datos-frescos` | Saldo, historial reciente y preferencias |
| `POST` | `/api/usuario/guardar-preferencias` | Ficha activa y cartas favoritas |
| `POST` | `/api/usuario/guardar-fcm` | Registra token de notificaciones |
| `POST` | `/api/actualizar-perfil` | Nickname y avatar |

### Economía
| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/recompensa-diaria` | +10 monedas cada 24 h |
| `POST` | `/api/buscar-destinatario` | Busca jugador por nickname |
| `POST` | `/api/transferir-saldo` | Transferencia entre cuentas (transaccional) |
| `GET` | `/api/historial-usuario` | Últimos 50 movimientos, en horario CDMX |
| `POST` | `/api/crear-orden` | Crea sesión de Stripe Embedded Checkout |
| `GET` | `/api/confirmar-pago` | Callback de Stripe: acredita monedas y redirige |

### Administración
| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/admin/stats` | Usuarios, monedas circulantes, ventas MXN |
| `GET` | `/api/admin/usuarios` | Listado completo |
| `POST` | `/api/admin/recargar-manual` | Abono manual de monedas |
| `POST` | `/api/admin/banear` | Banear / desbanear |
| `POST` | `/api/admin/broadcast` | Push masivo vía FCM |

### Hub
| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/hub/juegos` | Catálogo de juegos |
| `POST` | `/api/hub/nuevo-juego` | Alta de juego |
| `DELETE` | `/api/hub/eliminar-juego/:id` | Baja de juego |

---

## 🗄️ Datos

Firestore, con el **email como ID de documento**:

```
usuarios/{email}
  nickname · password (bcrypt) · monedas · avatar · inventario[]
  fichaActiva · cartasFavoritas[] · baneado · fcmToken · ultimaRecompensa
  └── historial/{id}   tipo · monto · descripcion · esIngreso · fecha

finanzas/general       totalVentasMXN
juegos_hub/{id}        titulo · url · imgPoster · descripcion · estado
```

El estado de las partidas **no se persiste**: vive en los objetos `salas`,
`salasSerpientes` y `salasPirinola` en memoria.

---

## ⏰ Tareas automáticas

`node-cron` a las **18:00** todos los días: busca usuarios cuya recompensa diaria ya
esté disponible y les manda un push recordándoselo.

---

## 🔐 Autenticación

El login y el registro emiten un **JWT firmado** (30 días). El cliente lo manda en
`Authorization: Bearer <token>` y en el `auth` del handshake de Socket.IO.

Cuando la petición trae token válido, la identidad sale de ahí y **se ignora cualquier
email del body**. Esa es la ruta segura.

### Fase de convivencia

Este servidor atiende a varios frontends (Lotería, Hub, Serpientes, Pirinola) y
ninguno mandaba token. Exigirlo de golpe habría tumbado a todos los que no se hayan
redesplegado, más a cualquier usuario con la sesión abierta.

Por eso, mientras `AUTH_ESTRICTA` no sea `true`, las peticiones sin token siguen
aceptando el email del body **igual que antes**, pero quedan contadas por ruta:

```bash
curl -H "Authorization: Bearer <token-de-admin>" https://<backend>/api/admin/uso-heredado
```

```json
{ "modoEstricto": false, "totalSinToken": 0, "porRuta": {} }
```

Cuando `porRuta` se mantenga vacío un buen rato, significa que ya nadie depende del
camino viejo: pon `AUTH_ESTRICTA=true` en Render y queda cerrado.

> ⚠️ **Hasta entonces los huecos siguen abiertos.** La convivencia no empeora nada
> respecto a antes, pero tampoco cierra nada: cualquiera que no mande token sigue
> pudiendo declarar el email que quiera.

### Lo que falta

| # | Problema | Estado |
|---|---|---|
| 1 | `/api/buscar-destinatario` revela el email de cualquier nickname | Pendiente |
| 2 | Sin rate limiting ni validación de entrada | Pendiente |
| 3 | El SSO del Hub debe pasar a mandar el JWT en vez de base64 sin firmar | Pendiente en el Hub |
| 4 | Nicknames no únicos | Pendiente |

---

## 🛠️ Notas de infraestructura

- **Render plan free**: el servicio duerme tras 15 min sin tráfico. Se mantiene
  despierto con **UptimeRobot** haciendo ping periódico.
- **Estado en RAM**: cada redeploy tumba las partidas activas y bloquea el escalado a
  más de una instancia. Moverlo a Redis (con el adaptador de Socket.IO) resolvería
  ambas cosas.
- **CORS abierto** (`origin: '*'`) tanto en Express como en Socket.IO.

---

## 🗺️ Roadmap

- [x] Documentar arquitectura (`CLAUDE.md`, `README.md`)
- [x] **Autenticación JWT** + handshake de socket autenticado (en convivencia)
- [ ] Poner `AUTH_ESTRICTA=true` cuando los contadores lleguen a cero
- [ ] Rate limiting y validación de entrada
- [x] Mover `ADMIN_EMAIL` a variable de entorno
- [ ] Estado de salas en Redis
- [ ] Partir `server.js` en módulos por juego
- [ ] Webhook de Stripe en lugar de confiar en el redirect de retorno
- [ ] Evaluar migración a VPS propio
