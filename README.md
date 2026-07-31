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

## 🔐 Estado de seguridad

> **Este servidor mueve dinero real y hoy no tiene autenticación.**

No existen sesiones ni tokens. El servidor confía en el email que le llegue en el
cuerpo de la petición o en un header. Huecos conocidos:

| # | Problema | Impacto |
|---|---|---|
| 1 | `/api/transferir-saldo` no verifica que quien llama sea el dueño de `origenEmail`, y `/api/buscar-destinatario` revela el email de cualquier nickname | Cualquiera puede vaciar la cuenta de cualquiera |
| 2 | Los `/api/admin/*` se autorizan con un header de texto plano contra un email que está hardcodeado en el frontend público | Monedas infinitas, baneos arbitrarios |
| 3 | `/api/admin/usuarios` con el mismo header trivial | Fuga de la base de usuarios |
| 4 | El SSO del Hub es JSON en base64 sin firmar | Suplantación de identidad |
| 5 | Los eventos de socket toman el email del payload del cliente | Compras y apuestas a nombre de terceros |
| 6 | Sin rate limiting ni validación de entrada | Fuerza bruta, spam de registros |

**Plan:** JWT firmado emitido en el login, leído del header `Authorization`, y
handshake autenticado en Socket.IO. El despliegue tiene que ser coordinado con el
frontend.

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
- [ ] **Autenticación JWT** + handshake de socket autenticado
- [ ] Rate limiting y validación de entrada
- [ ] Mover secretos y `ADMIN_EMAIL` a variables de entorno
- [ ] Estado de salas en Redis
- [ ] Partir `server.js` en módulos por juego
- [ ] Webhook de Stripe en lugar de confiar en el redirect de retorno
- [ ] Evaluar migración a VPS propio
