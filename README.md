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
   FRONTENDS (Vercel)                      ESTE SERVIDOR (Render)
   ├── www.juegosenlanube.com  (Hub)  ──►  ├── REST /api/*
   ├── loteria.juegosenlanube.com          └── Socket.IO
   ├── serpientes.juegosenlanube.com               │
   └── pirinola.juegosenlanube.com    ┌────────────┼────────────┐
                                  FIRESTORE     STRIPE        FCM
```

### Los cinco repos

| Repo | Rol |
|---|---|
| **`loteria-backend`** | **Este.** Backend común |
| [`juegosenalnube`](https://github.com/resoner0796/juegosenalnube) | Hub: login, monedero, catálogo |
| [`CARTAS-LOTERIA-`](https://github.com/resoner0796/CARTAS-LOTERIA-) | Lotería mexicana |
| [`Serpientesyescaleras`](https://github.com/resoner0796/Serpientesyescaleras) | Serpientes y Escaleras |
| [`Pirinola-Online`](https://github.com/resoner0796/Pirinola-Online) | Pirinola |

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
| `ORIGENES_EXTRA` | Dominios adicionales permitidos por CORS, separados por comas |
| `PERMITIR_LOCALHOST` | `true` añade los servidores locales a CORS, para probar los frontends sin desplegar |
| `STRIPE_WEBHOOK_SECRET` | Secreto de firma del webhook (`whsec_...`). Sin él los pagos solo se acreditan si el navegador vuelve |
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
| `POST` | `/api/stripe-webhook` | **Acreditación fiable.** Verifica la firma de Stripe |
| `GET` | `/api/confirmar-pago` | Retorno del navegador: redirige y acredita como respaldo |

### Administración
| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/admin/stats` | Usuarios, monedas circulantes, ventas MXN |
| `GET` | `/api/admin/usuarios` | Listado completo |
| `POST` | `/api/admin/recargar-manual` | Abono manual de monedas |
| `POST` | `/api/admin/banear` | Banear / desbanear |
| `POST` | `/api/admin/broadcast` | Push masivo vía FCM |
| `GET` | `/api/admin/uso-heredado` | Peticiones que aún llegan sin token, por ruta |
| `POST` | `/api/admin/migrar-nicknames` | Rellena el índice de unicidad. Se corre una vez |

### Hub
| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/hub/juegos` | Catálogo de juegos |
| `POST` | `/api/hub/nuevo-juego` | Alta de juego |
| `DELETE` | `/api/hub/eliminar-juego/:id` | Baja de juego |

---

## 🎴 Las cartas de Lotería, y quién gana

Una carta **no es una imagen**: es una lista de 16 números (o `null` en las
casillas vacías). Ese cambio es lo que permite que el servidor sepa qué lleva
cada carta y decida las victorias solo.

### Generarlas — `scripts/generar-cartas-sistema.js`

Escribe `cartas-sistema.json`, que está **commiteado**. Se ejecuta a mano: si se
generaran al arrancar, cada reinicio de Render repartiría cartas distintas a
media partida.

Persigue dos cosas contrarias entre sí:

- **Equilibrio** — cada baraja aparece las mismas veces, para que ninguna carta
  vaya con ventaja partida tras partida.
- **Separación** — dos cartas comparten lo menos posible, para que no se llenen a
  la vez y haya que partir el bote.

| Conjunto | Modos | Equilibrio | Comparten máx. | Media | Al azar |
|---|---|---|---|---|---|
| `normal` 60×16 | Tradicional, Llena | 17–18 | 7 | 4.55 | 4.74 (máx. 11) |
| `esquinas` 20×8 | Pozo | 2–3 | 1 | 0.83 | 1.19 |
| `dobles` 60×15 | Doble | 16–17 | 6 | 3.99 | 4.17 |

⚠️ **La media no se puede bajar.** Con reparto parejo queda fijada por la
aritmética; lo que el afinado mejora es el máximo. Si alguien propone
«optimizarlo más», ese es el techo.

El script **se niega a escribir** si al final hay barajas repetidas dentro de una
carta, cartas duplicadas o desequilibrio mayor que 1.

### Validar la victoria — `victoria.js`

Antes el anfitrión miraba la carta del reclamante y decidía. Dos problemas que no
se arreglan mirando mejor: se validaba a sí mismo, y cualquiera podía picar
LOTERÍA de broma y congelar la sala.

Hoy, al recibir `loteria`:

1. Se toman las barajas de cada carta **de aquí**, nunca del cliente:
   `cartas-sistema.json` para las del sistema, Firestore para las compradas.
2. Se cruzan con `salaInfo.historial` y con las casillas que el cliente dice
   haber tapado.
3. Se buscan las **20 figuras**: 4 horizontales, 4 verticales, 2 diagonales, las
   4 esquinas y los 9 cuadros de 2×2. Se generan, no se escriben a mano.
4. Sin figura → `loteria-rechazada` solo a quien gritó, **y el juego sigue**.
   Con figura → pausa de empates y `cerrarRonda()` reparte.

⚠️ **Lo que decide el dinero es que la baraja esté CANTADA**, y eso lo sabe el
servidor. Las fichas las manda el navegador y podrían falsearse, pero mentir ahí
solo saltaría el requisito de haber estado atento — nunca daría por buena una
carta cuyas barajas no hayan salido.

### Bots — `bots.js`

Un bot es un jugador más de la sala: elige cartas, apuesta, va tapando las
barajas que le cantan y grita lotería. La diferencia es que no tiene socket y
que su dinero es de la banca.

Existe porque el problema real del juego no es el juego, **es juntar gente**. Y
solo se pudo escribir cuando el servidor aprendió a validar solo: un bot no
puede «mirar» su carta, necesita que alguien sepa en datos si la figura está
completa.

| Nivel | Se da cuenta | Tarda en tapar | Tarda en gritar |
|---|---|---|---|
| `distraido` | 55% | 1.4–3.6 s | 1.2–2.6 s |
| `normal` | 85% | 0.7–2.0 s | 0.6–1.5 s |
| `experto` | 97% | 0.3–0.9 s | 0.25–0.7 s |

El nivel `distraido` **no es un bot roto**: una sala donde todos juegan perfecto
no es divertida, es una sala donde no ganas nunca. Que se les pasen barajas es lo
que deja hueco a la gente.

⚠️ **Un bot no se salta la validación.** Grita por el mismo camino que todo el
mundo (`procesarLoteria`) y el servidor lo juzga igual. No tiene su propia
comprobación a propósito: si la tuviera, podría ganar con reglas distintas.

⚠️ **El dinero del bot es de la BANCA.** Un bot no tiene email, así que nada suyo
se escribe en Firestore — es lo que lo mantiene separado del dinero de verdad. Su
apuesta engorda el bote y se apunta con `registrarEmisionBanca`; si gana, ese
premio vuelve a la banca y se apunta en negativo.

**Esto significa que la banca emite monedas.** Si gana una persona, se lleva
también lo que pusieron los bots, y esas monedas son nuevas. Es a propósito —es
lo que hace que jugar con bots valga la pena— pero es dinero real saliendo.
Vigílalo en `finanzas/general.monedasEmitidasBanca`; si crece más rápido de lo
que quieres, sube el nivel de los bots o baja cuántos caben por sala.

Una sala donde **solo quedan bots se cierra**: no hay a quién enseñarle la
partida, y dejarla viva sería una sala eterna gastando relojes. Y el anfitrión
nuevo siempre es una persona, porque un bot no puede iniciar la partida.

---

## 🧪 Pruebas

```bash
npm test
```

No hace falta ni Firestore ni red: son funciones puras salvo por el azar, y lo
aleatorio se comprueba midiendo la distribución sobre muchas repeticiones.

| Archivo | Qué cubre |
|---|---|
| `generador.prueba.js` | Los tres modos de carta, el barajado sin sesgo, las cartas a medida |
| `pack.prueba.js` | Que un pack no repita cartas ni te venda una que ya tienes |
| `victoria.prueba.js` | Las 20 figuras, las condiciones por modo, y que un grito en falso no gane |
| `bots.prueba.js` | Que un bot no robe cartas ajenas, de dónde sale su dinero, que sus relojes se paren, y que el nivel se note (se mide sobre 60 partidas) |

⚠️ Una prueba que nunca falla no prueba nada. Al añadir una, rómpela a propósito
y comprueba que salta.

---

## 🗄️ Datos

Firestore, con el **email como ID de documento**:

```
usuarios/{email}
  nickname · password (bcrypt) · monedas · avatar · inventario[]
  fichaActiva · cartasFavoritas[] · baneado · fcmToken · ultimaRecompensa
  └── historial/{id}   tipo · monto · descripcion · esIngreso · fecha
  └── tablas/{id}      cartas[16] · modo · firma      ← las compradas

nicknames/{minúsculas} email · nickname     ← índice de unicidad
pagos_procesados/{id}  email · monedas · montoMXN   ← idempotencia de Stripe

finanzas/general       totalVentasMXN · monedasEmitidasBanca
juegos_hub/{id}        titulo · url · imgPoster · descripcion · estado
```

El estado de las partidas **no se persiste**: vive en los objetos `salas`,
`salasSerpientes` y `salasPirinola` en memoria.

---

## 💳 Pagos

Las monedas se acreditan por **dos caminos**, y ambos son idempotentes: se reserva
el `session_id` en `pagos_procesados` antes de tocar ningún saldo, así que da igual
cuál llegue primero o si llegan los dos.

1. **Webhook** (`POST /api/stripe-webhook`) — el fiable. Stripe lo reintenta durante
   días hasta recibir un 200, así que el pago se acredita aunque el usuario cierre la
   pestaña. Verifica la firma sobre el cuerpo crudo; por eso la ruta se registra
   **antes** de `express.json()`.
2. **Retorno del navegador** (`GET /api/confirmar-pago`) — redirige al usuario y
   acredita por si el webhook aún no llegó.

### Configurar el webhook en Stripe

1. Dashboard de Stripe → **Developers** → **Webhooks** → **Add endpoint**
2. URL: `https://loteria-backend-3nde.onrender.com/api/stripe-webhook`
3. Eventos: `checkout.session.completed` y `checkout.session.async_payment_succeeded`
4. Copia el **Signing secret** (`whsec_...`) y ponlo en Render como `STRIPE_WEBHOOK_SECRET`

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
| 1 | `/api/buscar-destinatario` sigue devolviendo el email del destinatario | Pendiente |
| 2 | El SSO del Hub aún manda el `sso` base64 además del token firmado | Pendiente: retirar `sso` |
| 3 | Estado de las partidas en memoria: un redeploy tumba las activas | Pendiente |

---

## 🛠️ Notas de infraestructura

- **Render plan free**: el servicio duerme tras 15 min sin tráfico. Se mantiene
  despierto con **UptimeRobot** haciendo ping periódico.
- **Estado en RAM**: cada redeploy tumba las partidas activas y bloquea el escalado a
  más de una instancia. Moverlo a Redis (con el adaptador de Socket.IO) resolvería
  ambas cosas.
- **CORS restringido** a los dominios propios, en Express y en Socket.IO. Las
  peticiones sin cabecera `Origin` (webhook de Stripe, curl, health checks) se
  permiten. Los orígenes rechazados quedan en los logs.

---

## 🗺️ Roadmap

- [x] Documentar arquitectura (`CLAUDE.md`, `README.md`)
- [x] **Autenticación JWT** + handshake de socket autenticado (en convivencia)
- [ ] Poner `AUTH_ESTRICTA=true` cuando los contadores lleguen a cero
- [x] Rate limiting y validación de entrada
- [x] Nicknames únicos mediante índice en Firestore
- [x] `crypto.randomInt()` en barajas, dados y códigos de mesa
- [x] CORS restringido a los dominios propios
- [x] Mover `ADMIN_EMAIL` a variable de entorno
- [x] **Cartas del sistema como datos**, generadas y equilibradas por modo
- [x] **Validación automática de victoria** — el servidor busca las 20 figuras
- [x] Modo **Doble**: una baraja ocupa las dos casillas del centro
- [ ] Estado de salas en Redis
- [ ] Partir `server.js` en módulos por juego
- [x] **Bots** con tres niveles, que se añaden a la sala desde el anfitrión
- [ ] Salas de bots permanentes, abiertas para unirse — hay que resolver antes
      que Render duerme a los 15 min y que el estado vive en RAM
- [x] Webhook de Stripe en lugar de confiar solo en el redirect de retorno
- [ ] Evaluar migración a VPS propio
