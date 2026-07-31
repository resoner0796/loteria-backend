# CLAUDE.md — Backend Juegos en la Nube

Contexto para agentes trabajando en este repo. Léelo antes de tocar código.

## Qué es esto

Un **único proceso Node** que da servicio a todo el ecosistema *Juegos en la Nube*:
Lotería, Serpientes y Escaleras, Pirinola y la API del Hub. Expone una API REST
(`/api/*`) y un servidor Socket.IO en el mismo puerto.

Son literalmente **dos archivos**: `server.js` (~1,760 líneas) y `package.json`.
No hay carpetas, módulos, tests ni build.

Corre en **Render**: <https://loteria-backend-3nde.onrender.com>

## Los dos repos

| Repo | Contenido | Deploy | Ruta local |
|---|---|---|---|
| `resoner0796/loteria-backend` | Este. `server.js` | Render (auto en push a `main`) | `~/loteria-backend-repo` |
| `resoner0796/CARTAS-LOTERIA-` | Frontend de Lotería | Vercel (auto en push a `main`) | `~/CARTAS-LOTERIA--1` |

**Casi cualquier cambio de comportamiento toca los dos repos.** Antes de renombrar un
evento de socket o cambiar el shape de una respuesta, revisa
`~/CARTAS-LOTERIA--1/js/app.js`.

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

`PORT` lo inyecta Render.

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

finanzas/general          totalVentasMXN, ultimaActualizacion
juegos_hub/{auto}         titulo, url, imgPoster, descripcion, estado
```

Notas:
- Que el email sea el ID hace imposible cambiar de correo sin migrar el documento.
- `historial` es subcolección: se consulta por usuario, nunca globalmente.
- Las fechas se guardan en UTC y se formatean a `America/Mexico_City` al leerlas.

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
  tradicional: { costo: 1, cartasJugador: 54 },
  llena:       { costo: 2, cartasJugador: 54 },
  pozo:        { costo: 2, cartasJugador: 20 },
}
```

La baraja que se canta **siempre es de 54**, sin importar el modo. `mezclarBaraja()`
usa Fisher-Yates más un "corte" aleatorio.

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

## ⚠️ Seguridad — deuda crítica

**No hay autenticación.** El servidor confía en el email que venga en el body o en un
header. Con dinero real de por medio (Stripe live), estos son huecos explotables:

1. **Vaciado de cuentas.** `/api/buscar-destinatario` devuelve el email de cualquier
   nickname; `/api/transferir-saldo` acepta `origenEmail` del body sin verificar que
   quien llama sea el dueño. Cadena completa de dos peticiones.
2. **Monedas infinitas.** Los `/api/admin/*` se autorizan comparando el header
   `admin-email` (o `adminEmail` del body) contra la constante `ADMIN_EMAIL`, que
   además está hardcodeada en el `app.js` público del frontend.
3. **Fuga de datos.** `/api/admin/usuarios` expone la lista completa de usuarios con
   el mismo header trivial.
4. **SSO falsificable.** El Hub pasa el usuario como JSON en base64 sin firmar.
5. Los eventos de socket (`comprar-item`, `apostar`, `entrar-serpientes`) toman el
   email del payload del cliente sin verificar identidad.
6. `/api/registro` no valida fuerza de contraseña ni formato de email, y no hay rate
   limiting en ningún endpoint.

**Dirección acordada:** JWT firmado emitido en `/api/login`, leído del header
`Authorization`, más un handshake autenticado en Socket.IO. Al implementarlo hay que
desplegar backend y frontend de forma coordinada.

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
