# CLAUDE.md — Backend Juegos en la Nube

Contexto para agentes trabajando en este repo. Léelo antes de tocar código.

## Qué es esto

Un **único proceso Node** que da servicio a todo el ecosistema *Juegos en la Nube*:
Lotería, Serpientes y Escaleras, Pirinola y la API del Hub. Expone una API REST
(`/api/*`) y un servidor Socket.IO en el mismo puerto.

Son literalmente **dos archivos**: `server.js` (~2,200 líneas) y `package.json`.
No hay carpetas, módulos, tests ni build.

Corre en **Render**: <https://loteria-backend-3nde.onrender.com>

## El ecosistema: cinco repos

| Repo | Rol | Producción | Ruta local |
|---|---|---|---|
| `loteria-backend` | Este. **Backend** de todos los juegos | loteria-backend-3nde.onrender.com | `~/loteria-backend-repo` |
| `juegosenalnube` | **Hub**: el único con login | www.juegosenlanube.com | `~/juegosenalnube` |
| `CARTAS-LOTERIA-` | Lotería mexicana | loteria.juegosenlanube.com | `~/CARTAS-LOTERIA--1` |
| `Serpientesyescaleras` | Serpientes y Escaleras | serpientes.juegosenlanube.com | `~/Serpientesyescaleras` |
| `Pirinola-Online` | Pirinola | pirinola.juegosenlanube.com | `~/Pirinola-Online` |

```
        HUB (login, monedero, catálogo)
                 │  reparte el token en la URL (?tk=...)
   ┌─────────────┼─────────────┐
LOTERÍA     SERPIENTES     PIRINOLA
   └─────────────┼─────────────┘
                 ▼
       ESTE SERVIDOR (Render): Socket.IO + /api/*
                 │
            FIRESTORE · STRIPE · FCM
```

**Este repo es el único con estado compartido.** Un cambio aquí puede afectar a
los cuatro frontends a la vez: antes de renombrar un evento de socket o cambiar el
shape de una respuesta, revisa quién lo consume.

| Bloque de `server.js` | Lo consume |
|---|---|
| `--- LOTERIA ---` | `~/CARTAS-LOTERIA--1/js/app.js` |
| `🐍 BLOQUE SERPIENTES Y ESCALERAS` | `~/Serpientesyescaleras/game.js` |
| `🌀 BLOQUE PIRINOLA ROYAL` | `~/Pirinola-Online/js/app.js` |
| `--- HUB & JUEGOS API ---`, admin, pagos | `~/juegosenalnube/hub.js` |

> ⚠️ `~/Desktop/loteria-backend` es un clon obsoleto congelado en agosto 2025
> (`server.js` de 70 líneas). **No trabajar ahí.** Un push desde esa carpeta destruiría
> el servidor de producción.

## Dependencias externas

| Servicio | Para qué | Configuración |
|---|---|---|
| **Firestore** (`firebase-admin`) | Única base de datos | env `nicknames` = JSON del service account |
| **Stripe** | Pagos reales en MXN | env `STRIPE_SECRET_KEY` |
| **FCM** (`firebase-admin/messaging`) | Notificaciones push | mismo service account |
| **node-cron** | Recordatorio de regalo diario, 18:00 | — |
| **jsonwebtoken** | Sesiones firmadas | env `JWT_SECRET` |
| **express-rate-limit** | Límites por IP | requiere `app.set('trust proxy', 1)` |

Variables de entorno: `nicknames`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`JWT_SECRET`, `ADMIN_EMAIL`, `AUTH_ESTRICTA`, `ORIGENES_EXTRA`. `PORT` lo inyecta
Render.

> El nombre de la variable `nicknames` para el service account de Firebase es
> confuso pero es el que está en producción. No renombrar sin actualizar Render primero.

## Modelo de datos (Firestore)

```
usuarios/{email}                     ← el email ES el ID del documento
  ├── nickname, password (bcrypt), monedas, avatar
  ├── inventario[]        IDs de items comprados ('skin_bitcoin', 'snd_cuack'…)
  ├── fichaActiva         ruta de la skin de ficha en uso
  ├── cartasFavoritas[]   preset de cartas guardado
  ├── baneado, fcmToken, ultimaRecompensa, creado
  └── historial/{auto}    tipo, monto, descripcion, esIngreso, fecha

nicknames/{minúsculas}    email, nickname       ← índice de UNICIDAD
pagos_procesados/{id}     email, monedas, montoMXN, acreditadoPor
                                                ← idempotencia de Stripe

finanzas/general          totalVentasMXN, monedasEmitidasBanca, ultimaActualizacion
juegos_hub/{auto}         titulo, url, imgPoster, descripcion, estado
```

Notas:
- Que el email sea el ID hace imposible cambiar de correo sin migrar el documento.
- `historial` es subcolección: se consulta por usuario, nunca globalmente.
- Las fechas se guardan en UTC y se formatean a `America/Mexico_City` al leerlas.
- Firestore no tiene `UNIQUE`: la unicidad de nicknames se consigue con la colección
  `nicknames`, donde el ID del documento ES el nickname en minúsculas. Reservarlo
  dentro de una transacción falla si ya existe.
- `pagos_procesados` hace idempotente la acreditación de Stripe: el `session_id` se
  reserva ANTES de tocar ningún saldo, así que da igual si llegan el webhook y el
  retorno del navegador.

## Estado en memoria

```js
const salas = {}            // Lotería
const salasSerpientes = {}
const salasPirinola = {}
```

**Todo el estado de partida vive en RAM.** Un reinicio o redeploy de Render tumba las
partidas activas. Esto también impide escalar a más de una instancia (haría falta el
adaptador de Redis para Socket.IO).

## Lotería — el flujo

```js
MODOS_JUEGO = {
  tradicional: { costo: 1, tablasDisponibles: 53 },
  llena:       { costo: 2, tablasDisponibles: 53 },
  pozo:        { costo: 2, tablasDisponibles: 20 },
}
```

⚠️ **No confundas los dos conjuntos**, es la trampa más fácil del proyecto:
- **Tabla** = lo que elige el jugador. Hay **53**.
- **Carta** = lo que se canta. La baraja es de **54**, con una voz por cada una.

La baraja que se canta siempre es de 54, sin importar el modo. `mezclarBaraja()`
usa Fisher-Yates más un "corte", con `crypto.randomInt()`: **nunca uses
`Math.random()` para nada que decida dinero**, es predecible observando
suficientes resultados.

1. `unirse-sala` — crea la sala si no existe; el creador queda como `hostId`.
   Responde `rol-asignado` + `info-sala`.
2. `seleccionar-carta` / `deseleccionar-carta` — máximo 4 por jugador; se difunde
   `cartas-desactivadas` para que nadie repita.
3. `apostar` — cobra `costoCarta × nº de cartas`, alimenta `sala.bote`, persiste el
   saldo y registra el movimiento.
4. `iniciar-juego` (solo host) — baraja, emite `campana`, a los 2 s `corre` y arranca
   el `setInterval` que emite `carta-cantada`.
5. `loteria` — pausa el canto y abre ventana de **4 s** para recoger empates
   (`pausa-empate`, `notificar-otro-ganador`). Al cerrarse, el host recibe
   `iniciar-validacion-secuencial` y aprueba o rechaza cada tabla con `veredicto-host`.
6. Al terminar: el bote se divide entre los validados (`ganadores-multiples`), sube la
   `racha` 🔥 de los ganadores y se resetea la de los demás. Si nadie fue validado →
   `falsa-alarma-masiva` y el canto continúa.
7. `reconectar` — reasocia el email al nuevo `socket.id`, devuelve la corona si era
   host y restaura el tablero con `estado-sala-restaurado`.
8. `salir-sala` — si la partida no había arrancado, reembolsa la apuesta; si el que se
   va era el host, la corona pasa al primer jugador restante.

## Convenciones

- **Todo en español**: eventos, variables, colecciones.
- **Un solo archivo.** Está dividido por comentarios de banner (`==== SECCIÓN ====`).
  Respeta esa organización; no lo partas en módulos sin acordarlo con el usuario.
- **CommonJS** (`require`), no ESM.
- Los movimientos de dinero se registran con el helper `registrarMovimiento(email,
  tipo, monto, descripcion, esIngreso)`. Si agregas una operación que toca monedas,
  regístrala también.
- Las operaciones que mueven saldo entre cuentas usan `db.runTransaction`. Las que
  suman a una sola cuenta usan `FieldValue.increment`. **Nunca leas-modifiques-escribas
  el saldo a mano.**
- Los errores de push (FCM) se loguean pero **no** deben tumbar la petición principal.

## 🔑 Autenticación — LÉELO ANTES DE TOCAR NADA

El login y el registro emiten un **JWT firmado** (30 días). El cliente lo manda en
`Authorization: Bearer` y en el `auth` del handshake de Socket.IO.

**Regla de oro: la identidad sale SIEMPRE del token, nunca del body.**

- En rutas HTTP: `identificar(req, emailDeclarado, etiqueta)`
- En eventos de socket: `emailDeSocket(socket, emailDeclarado, etiqueta)`
- Para admin: `solicitanteEsAdmin(req)`

Si añades un endpoint o evento que toque saldo o datos de un usuario, **tiene que
pasar por uno de esos tres**. Aceptar un email del cuerpo de la petición fue
exactamente el fallo que permitía vaciarle la cuenta a cualquiera.

`AUTH_ESTRICTA=true` está **activo en producción**: sin token, esas funciones
devuelven `null` y la petición se rechaza. El modo permisivo existió solo durante
la migración; los contadores de `/api/admin/uso-heredado` sirvieron para saber
cuándo era seguro cerrarlo.

### Otras defensas en su sitio

- **Rate limiting** por IP: login 10/15 min, registro 5/h, búsqueda 40/15 min,
  techo general 200/min. Requiere `trust proxy` porque Render va detrás del suyo.
- **CORS** restringido a los dominios propios, en Express **y** en Socket.IO. Ojo:
  un WebSocket no está sujeto a la política de mismo origen, así que la opción
  `cors` de Socket.IO no basta y hace falta `allowRequest`.
- **Pagos idempotentes** y webhook con verificación de firma.
- **Nickname validado** en registro y cambio de perfil.
- `process.on('unhandledRejection')` como red de seguridad: los handlers `async`
  de socket sin `try/catch` podían tumbar el proceso entero con un payload
  malformado, y con él todas las partidas activas.

### Lo que sigue pendiente

- `/api/buscar-destinatario` devuelve el email del destinatario.
- El estado de las partidas vive en RAM: un redeploy tumba las activas.
- Sin validación de fuerza de contraseña.

Hay una auditoría completa en `~/CARTAS-LOTERIA--1/AUDITORIA-SEGURIDAD.md`
(ignorada por git a propósito).

## Referencia de eventos Socket.IO

**Entrantes (Lotería):** `unirse-sala` · `seleccionar-carta` · `deseleccionar-carta` ·
`apostar` · `iniciar-juego` · `detener-juego` · `barajear` · `reiniciar-partida` ·
`loteria` · `veredicto-host` · `salir-sala` · `reconectar` · `enviar-efecto-sonido` ·
`comprar-item` · `solicitar-info-usuario`

**Salientes (Lotería):** `rol-asignado` · `info-sala` · `jugadores-actualizados` ·
`cartas-desactivadas` · `bote-actualizado` · `carta-cantada` · `campana` · `corre` ·
`barajear` · `juego-iniciado` · `juego-detenido` · `partida-reiniciada` ·
`pausa-empate` · `notificar-otro-ganador` · `iniciar-validacion-secuencial` ·
`continuar-validacion` · `ganadores-multiples` · `falsa-alarma-masiva` ·
`estado-sala-restaurado` · `reproducir-sonido-apuesta` · `reproducir-efecto-sonido` ·
`usuario-actualizado` · `error-apuesta` · `actualizar-contadores`

**Otros juegos:** `entrar-serpientes` · `crear-sala-serpientes` ·
`unirse-sala-serpientes-privada` · `iniciar-serpientes-host` ·
`tirar-dado-serpientes` · `salir-sala-espera` · `entrar-pirinola` · `tirar-pirinola` ·
`crear-sala-privada` · `unirse-sala-privada` · `iniciar-juego-privado` · `comprar-skin`

## Correr local

```bash
npm install
export nicknames='{"type":"service_account", ...}'   # JSON completo en una línea
export STRIPE_SECRET_KEY='sk_test_...'
npm start          # → http://localhost:3000
```

⚠️ Ese service account apunta a la **Firestore de producción**. Para desarrollo real,
crea un proyecto de Firebase aparte y usa llaves `sk_test_` de Stripe.

No hay tests. Verificación mínima tras un cambio: `node --check server.js`.

## Tablas generadas

Las tablas que se venden en packs. `generador.js` las crea y `comprar-pack-tablas`
las cobra y guarda.

**Una tabla es una lista de 16 números**, no una imagen. Las casillas vacías van
a `null`, que solo pasa en el modo `esquinas`. Se guardan en
`usuarios/{email}/tablas`:

```js
{ cartas: [12, 45, null, ...], modo: 'normal', firma: '3-12-45-...', creada }
```

⚠️ **La generación ocurre aquí y solo aquí.** Si el cliente pudiera decidir qué
lleva su tabla, el día que el servidor valide las loterías solo, cualquiera se
haría una con las cartas ya cantadas. Es dinero decidido en el navegador.

Tres cosas del original (`generador/index.html` del frontend) que se cambiaron a
propósito:

- El barajado usaba `sort(() => Math.random() - 0.5)`, que no da permutaciones
  uniformes: medido, la primera carta salía primera un 90% más de lo que le
  tocaba. Ahora es Fisher-Yates con `crypto.randomInt`.
- La firma ordena las cartas antes de comparar. Dos tablas con las mismas 16
  cartas colocadas distinto se llenan a la vez, así que cuentan como la misma.
- Los modos quedaron atados al juego: `normal` para Tradicional y Llena,
  `esquinas` para Pozo, `dobles` para un modo que aún no existe.

`npm test` comprueba las dos partes sin necesidad de Firestore ni red.

