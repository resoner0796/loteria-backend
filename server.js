// server.js - Backend Lotería + Serpientes + Pirinola + Hub + Admin Pro

// ==================== CONFIG FIREBASE ====================
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.nicknames); 
const cron = require('node-cron');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ==========================================================
// 🎰 POZO ACUMULADO
// ==========================================================
// Bote aparte que crece $1 por partida y por jugador que se apunte, y que solo
// se lleva quien llene las 4 barajas del centro. Lo valida el anfitrión a ojo,
// igual que la lotería normal, porque las tablas son imágenes y el servidor no
// sabe qué baraja cayó en qué casilla.
//
// OJO con el nombre: ya existe un MODO llamado 'pozo' (Pozo y Esquinas, el de
// las 20 tablas especiales). Son cosas distintas. Aquí siempre es "acumulado".
//
// Vive en Firestore, no en memoria: el estado de las salas se pierde en cada
// redespliegue y esto es dinero comprado con tarjeta. Va atado a la sala Y al
// correo de quien la creó, porque las salas se identifican solo por su nombre:
// sin eso, cualquiera que abriera una sala llamada "Familia" caería en el mismo
// pozo que la tuya.

function idPozo(sala, creador) {
    // El ID de documento no admite '/'. Lo demás se deja legible a propósito,
    // para poder auditar a mano desde la consola de Firebase.
    const limpio = (s) => String(s || '').replace(/\//g, '_').trim();
    return `${limpio(sala)}__${limpio(creador).toLowerCase()}`;
}

async function leerPozo(salaInfo) {
    if (!salaInfo.pozoId) return 0;
    try {
        const doc = await db.collection('pozos').doc(salaInfo.pozoId).get();
        return doc.exists ? (doc.data().acumulado || 0) : 0;
    } catch (e) {
        console.error("Error leyendo pozo:", e.message);
        return salaInfo.pozoAcumulado || 0;
    }
}

async function moverPozo(salaInfo, delta) {
    if (!salaInfo.pozoId || !delta) return;
    try {
        await db.collection('pozos').doc(salaInfo.pozoId).set({
            sala: salaInfo.nombre || null,
            creador: salaInfo.creador || null,
            acumulado: admin.firestore.FieldValue.increment(delta),
            actualizado: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        salaInfo.pozoAcumulado = Math.max(0, (salaInfo.pozoAcumulado || 0) + delta);
    } catch (e) {
        console.error("Error moviendo pozo:", e.message);
    }
}

// --- HELPER: EMISIÓN DE LA BANCA ---
// En los modos contra la CPU el bot aporta al bote monedas que no salieron de
// ninguna cuenta. Eso infla la economía en silencio, y como las monedas se
// compran con dinero real y se transfieren entre jugadores, es un pasivo.
// No lo prohibimos —es una decisión de producto— pero lo medimos, para que el
// número exista y se pueda vigilar.
async function registrarEmisionBanca(cantidad, concepto) {
    if (!cantidad) return;
    try {
        await db.collection('finanzas').doc('general').set({
            monedasEmitidasBanca: admin.firestore.FieldValue.increment(cantidad),
            ultimaActualizacion: new Date()
        }, { merge: true });
        console.log(`🏦 Banca ${cantidad > 0 ? 'emitió' : 'recuperó'} ${Math.abs(cantidad)} (${concepto})`);
    } catch (e) { console.error("Error emisión banca:", e); }
}

// --- HELPER HISTORIAL ---
async function registrarMovimiento(email, tipo, monto, descripcion, esIngreso) {
    if(!email) return; 
    try {
        await db.collection('usuarios').doc(email).collection('historial').add({
            tipo, monto: parseInt(monto), descripcion, esIngreso,
            fecha: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`📜 ${tipo} | ${descripcion} | ${email}`);
    } catch (e) { console.error("Error historial:", e); }
}

// ==================== CONFIG EXPRESS + SOCKET ====================
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bcrypt = require('bcryptjs');
const cors = require('cors');

// ==========================================================
// 🌐 ORÍGENES PERMITIDOS (CORS)
// ==========================================================
// Estaba abierto a cualquier origen. Ahora que hay sesiones de verdad conviene
// cerrarlo, para que una web ajena no pueda llamar a esta API desde el navegador
// de alguien que tenga la sesión abierta.
//
// Se amplía sin tocar código con ORIGENES_EXTRA (separados por comas), por si
// aparece un frontend nuevo o un dominio de pruebas.
const ORIGENES = [
    'https://juegosenlanube.com',
    'https://www.juegosenlanube.com',
    'https://loteria.juegosenlanube.com',
    'https://serpientes.juegosenlanube.com',
    'https://pirinola.juegosenlanube.com',
    ...(process.env.ORIGENES_EXTRA || '').split(',').map(s => s.trim()).filter(Boolean)
];

// Servidores locales, para poder probar los frontends contra este backend sin
// tener que desplegar. Al cerrar CORS dejaron de funcionar y no es evidente por
// qué: el navegador solo dice que falló la petición.
if (process.env.PERMITIR_LOCALHOST === 'true') {
    ORIGENES.push(
        'http://localhost:8000', 'http://localhost:8123', 'http://localhost:3000',
        'http://127.0.0.1:8000', 'http://127.0.0.1:8123'
    );
    console.log('🔓 CORS abierto también a localhost (PERMITIR_LOCALHOST=true)');
}

function origenPermitido(origen, cb) {
    // Sin cabecera Origin son peticiones que no vienen de una página web: el
    // webhook de Stripe, curl, apps nativas, los health checks de Render.
    if (!origen) return cb(null, true);
    if (ORIGENES.includes(origen)) return cb(null, true);

    // Se registra en vez de fallar en silencio: si algún frontend legítimo se
    // quedó fuera de la lista, aparece en los logs de Render y se añade.
    console.warn(`🚫 Origen no permitido: ${origen}`);
    cb(null, false);
}

const io = require('socket.io')(http, {
    // `cors` solo cubre las peticiones HTTP del transporte polling.
    cors: { origin: origenPermitido },

    // Y esto cubre el resto. Un WebSocket NO está sujeto a la política de mismo
    // origen del navegador: cualquier web puede abrir uno contra este servidor,
    // así que con solo `cors` un cliente que fuera directo por websocket entraba
    // sin pasar por ningún filtro. `allowRequest` corre en el handshake, antes de
    // establecer la conexión, sea cual sea el transporte.
    //
    // El riesgo aquí era acotado porque la sesión viaja en un token que la web
    // atacante no puede leer (está en el localStorage de otro origen), no en una
    // cookie que el navegador adjunte solo. Aun así, no hay razón para aceptar
    // conexiones de sitios ajenos.
    allowRequest: (req, cb) => {
        const origen = req.headers.origin;
        if (!origen) return cb(null, true);            // apps nativas, scripts, health checks
        if (ORIGENES.includes(origen)) return cb(null, true);
        console.warn(`🚫 Socket de origen no permitido: ${origen}`);
        cb(null, false);
    }
});

app.use(cors({ origin: origenPermitido }));

// ==========================================================
// 💳 WEBHOOK DE STRIPE
// ==========================================================
// Va ANTES de express.json() a propósito: Stripe firma el cuerpo CRUDO, y si el
// parser de JSON lo toca primero, la firma deja de cuadrar y no se puede
// verificar nada.
//
// Este es el mecanismo FIABLE de acreditación. El retorno del navegador no lo
// era: si el usuario cerraba la pestaña, se le iba el internet o el móvil mataba
// la app justo después de pagar, Stripe cobraba y las monedas nunca se
// acreditaban, sin dejar ningún rastro visible. Stripe reintenta este webhook
// durante días hasta recibir un 200.
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const secreto = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secreto) {
        console.error('⚠️ Llegó un webhook pero STRIPE_WEBHOOK_SECRET no está definido.');
        return res.status(500).send('webhook sin configurar');
    }

    let evento;
    try {
        evento = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secreto);
    } catch (err) {
        // Firma inválida: o no viene de Stripe, o alguien intenta inventarse un pago.
        console.error('❌ Firma de webhook inválida:', err.message);
        return res.status(400).send(`Firma inválida: ${err.message}`);
    }

    if (evento.type === 'checkout.session.completed' ||
        evento.type === 'checkout.session.async_payment_succeeded') {
        try {
            await acreditarPago(evento.data.object, 'webhook');
        } catch (e) {
            // 500 para que Stripe lo reintente más tarde en vez de darlo por bueno.
            console.error('Error acreditando desde webhook:', e);
            return res.status(500).send('error al acreditar');
        }
    }

    res.json({ recibido: true });
});

app.use(express.json());

// Render sirve detrás de su propio proxy. Sin esto, req.ip sería siempre la IP
// del proxy y todos los usuarios compartirían el mismo contador de rate limit:
// bastaría con que uno se pasara para bloquear a todos los demás.
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// ==========================================================
// 🚦 LÍMITES DE PETICIONES
// ==========================================================
// Sin esto se puede probar contraseñas por fuerza bruta contra /login, crear
// cuentas en masa (cada una regala 20 monedas de bienvenida) y recorrer toda la
// base de usuarios llamando a /buscar-destinatario con un nickname tras otro.
const rateLimit = require('express-rate-limit');

const limitador = (minutos, maximo, mensaje) => rateLimit({
    windowMs: minutos * 60 * 1000,
    max: maximo,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: mensaje }
});

const limiteLogin    = limitador(15, 10, 'Demasiados intentos. Espera unos minutos.');
const limiteRegistro = limitador(60,  5, 'Demasiadas cuentas creadas desde aquí. Intenta más tarde.');
const limiteBusqueda = limitador(15, 40, 'Demasiadas búsquedas. Espera un momento.');

// Techo general holgado: no debe estorbar al juego, solo frenar abusos.
app.use('/api/', limitador(1, 200, 'Vas demasiado rápido. Espera un momento.'));

// ==========================================================
// 🔑 AUTENTICACIÓN JWT — FASE DE CONVIVENCIA
// ==========================================================
//
// Este servidor atiende a varios frontends (Lotería, Hub, Serpientes, Pirinola)
// y ninguno mandaba token hasta ahora. Si exigiéramos JWT de golpe, se caerían
// todos los que no se hayan redesplegado, más cualquier usuario con sesión
// abierta (su localStorage no tiene token).
//
// Por eso durante esta fase:
//   - El login y el registro EMITEN token.
//   - Si la petición trae token válido, la identidad sale de ahí y se ignora
//     cualquier email del body. Esa es la ruta segura.
//   - Si no trae token, se acepta el email del body como antes, pero se cuenta
//     en `usoHeredado` para saber cuándo ya nadie depende del camino viejo.
//
// Cerrar la puerta es cambiar MODO_ESTRICTO a true, una vez que los contadores
// de /api/admin/uso-heredado se queden en cero.
const jwt = require('jsonwebtoken');
const generador = require('./generador');
const { evaluarReclamo, NOMBRE_FIGURA } = require('./victoria');
const bots = require('./bots');

const MODO_ESTRICTO = process.env.AUTH_ESTRICTA === 'true';
const VIGENCIA_TOKEN = '30d';

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    // Sin secreto no podemos firmar de forma estable. Generamos uno efímero para
    // no tumbar el arranque, pero los tokens mueren en cada reinicio.
    JWT_SECRET = require('crypto').randomBytes(48).toString('hex');
    console.warn('⚠️ JWT_SECRET no está definido. Se generó uno temporal: los tokens');
    console.warn('   dejarán de valer en cada reinicio. Defínelo en Render.');
}

function emitirToken(email, admin) {
    return jwt.sign({ email, esAdmin: !!admin }, JWT_SECRET, { expiresIn: VIGENCIA_TOKEN });
}

function leerToken(bruto) {
    if (!bruto || typeof bruto !== 'string') return null;
    const token = bruto.startsWith('Bearer ') ? bruto.slice(7) : bruto;
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
}

// Contadores de peticiones que todavía llegan sin token, por ruta.
const usoHeredado = {};
function anotarUsoHeredado(etiqueta) {
    usoHeredado[etiqueta] = (usoHeredado[etiqueta] || 0) + 1;
    if (usoHeredado[etiqueta] === 1 || usoHeredado[etiqueta] % 100 === 0) {
        console.log(`🔓 Sin token: ${etiqueta} (${usoHeredado[etiqueta]} veces)`);
    }
}

// Middleware permisivo: si hay token válido lo deja en req.usuario, si no, null.
app.use((req, _res, next) => {
    req.usuario = leerToken(req.headers.authorization);
    next();
});

/**
 * Identidad efectiva de la petición.
 * Con token manda el token. Sin token, y solo si no estamos en modo estricto,
 * se acepta el email que venga en el body o la query, como se hacía antes.
 * Devuelve null si no hay forma legítima de identificar a quien llama.
 */
function identificar(req, emailDeclarado, etiqueta) {
    if (req.usuario?.email) return req.usuario.email;
    if (MODO_ESTRICTO) return null;
    if (!emailDeclarado) return null;
    anotarUsoHeredado(etiqueta);
    return emailDeclarado;
}

/** ¿Quien llama es administrador? Con token se confía en el claim; si no, al header. */
function solicitanteEsAdmin(req) {
    if (req.usuario) return !!req.usuario.esAdmin;
    if (MODO_ESTRICTO) return false;
    const declarado = req.headers['admin-email'] || req.body?.adminEmail;
    if (!esAdmin(declarado)) return false;
    anotarUsoHeredado('admin sin token');
    return true;
}

// ==================== VARIABLES GLOBALES ====================
const salas = {}; // Lotería
const salasSerpientes = {}; 
const salasPirinola = {}; 

const SNAKES = { 18:6, 25:9, 33:19, 41:24, 48:32, 53:13 };
const LADDERS = { 3:15, 11:28, 22:36, 30:44, 38:49, 46:51 };
// Configurable por entorno para que no tenga que vivir hardcodeado (y menos aún en el
// frontend público). Si no se define ADMIN_EMAIL en Render, se conserva el valor viejo
// para no romper el despliegue actual.
// ⚠️ TEMPORAL: comparar un email sigue siendo una autorización débil. La solución real
// es un rol 'admin' en Firestore verificado contra el JWT (Fase 1).
// Cuánto puede poner la banca en una mesa contra la CPU, como múltiplo de la
// apuesta. Acota la exposición de la casa y evita que el bot alimente el bote
// indefinidamente.
const TOPE_BANCA_POR_MESA = 3;

/**
 * Paquetes de monedas, con su precio en pesos. ESTA es la única lista válida.
 *
 * Antes el navegador mandaba `cantidad` y `precio` en el cuerpo y el servidor los
 * usaba tal cual: uno era lo que Stripe cobraba y el otro lo que se acreditaba
 * después. Nada impedía pedir 100.000 monedas por un peso — el cobro salía
 * legítimo, y la acreditación hacía el resto porque la cifra viajaba en los
 * metadatos de la propia sesión de pago.
 *
 * El cliente ahora solo dice QUÉ paquete quiere. El precio sale de aquí y de
 * ningún otro sitio.
 */
const PAQUETES_MONEDAS = {
    50: 29.99,
    150: 79.99,
    500: 199.99
};

/**
 * Todo lo que se vende por monedas, con su precio. Igual que los paquetes: el
 * cliente dice QUÉ quiere, el precio sale de aquí.
 *
 * El agujero era peor que el de los paquetes. 'comprar-item' hacía
 * `saldoActual - precio` con el precio del cliente, así que un precio NEGATIVO
 * no compraba: sumaba. Era una máquina de imprimir monedas a la que se llegaba
 * con un solo emit desde la consola del navegador.
 *
 * Si añades un artículo a la tienda de cualquier juego, tiene que aparecer aquí
 * o no se podrá comprar.
 */
const CATALOGO_ITEMS = {
    // Lotería — efectos de sonido
    snd_risa: 0, snd_corneta: 0, snd_tepasas: 8, snd_misahorros: 8,
    snd_ronquido: 8, snd_cuack: 8, snd_disparo: 8,
    // Lotería — skins de ficha
    skin_default: 0, skin_bitcoin: 5, skin_corazon: 5, skin_verde: 5, skin_frijol: 5,
    // Serpientes y Escaleras — skins de peón
    skin_bill: 5, skin_snake: 5, skin_alien: 5, skin_ninja: 5,
    skin_boy: 5, skin_girl: 5, skin_hat: 5, skin_crown: 5
};

/**
 * Lo que cuesta un pack de tablas generadas, y cuántas trae.
 *
 * Igual que el resto de precios: el cliente dice QUÉ quiere, nunca cuánto vale.
 */
const PACK_TABLAS = { precio: 20, cuantas: 4 };

/**
 * Lo que cuesta armar tablas a mano, y cuántas trae.
 *
 * Se arman las DOS antes de pagar y se cobran juntas. Cobrar por tabla obligaría
 * a llevar la cuenta de cuántas te quedan pagadas, y eso es estado que se puede
 * quedar a medias: pagas una, cierras el navegador y nadie sabe qué pasó.
 */
const TABLAS_PERSONALIZADAS = { precio: 25, cuantas: 2 };

/**
 * Tope de tablas guardadas por persona.
 *
 * Sin tope, comprar packs sin parar llena el documento del usuario y la
 * pantalla de «Mis Cartas» se vuelve inmanejable. Al llegar aquí se avisa en vez
 * de cobrar.
 */
const TOPE_TABLAS_POR_USUARIO = 40;

/** Las tablas generadas de alguien, de la más nueva a la más vieja. */
async function tablasDe(email) {
    const snap = await db.collection('usuarios').doc(email)
        .collection('tablas').orderBy('creada', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Normaliza un monto que llega del cliente y devuelve null si no sirve.
 *
 * Las apuestas se descontaban con `increment(-monto)` sobre el monto recibido.
 * Con un monto negativo eso es un increment POSITIVO, y la guarda previa
 * (`monedas < monto`) tampoco lo frenaba: un saldo de 500 nunca es menor que
 * -100. Cuatro handlers —los de Serpientes y Pirinola— estaban así.
 *
 * Se exige entero de al menos 1. El tope superior lo pone el saldo, que sí se
 * comprueba después.
 */
function montoApuestaValido(valor) {
    const n = Number(valor);
    if (!Number.isInteger(n) || n < 1) return null;
    return n;
}

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@loteria.com").trim().toLowerCase();

function esAdmin(email) {
    return typeof email === 'string' && email.trim().toLowerCase() === ADMIN_EMAIL;
}

/**
 * Recorta un documento de usuario a lo que el navegador puede ver.
 *
 * El documento de Firestore guarda, junto al perfil, dos cosas que NO deben
 * salir del servidor: `password` (el hash bcrypt) y `fcmToken` (permite mandarle
 * notificaciones push a esa persona). Durante mucho tiempo el evento
 * 'usuario-actualizado' emitía `doc.data()` tal cual, así que el hash de la
 * contraseña llegaba al cliente en cada sincronización y quedaba a la vista en
 * la consola del navegador. Un bcrypt de coste 10 se ataca sin prisa fuera de
 * línea: basta una extensión curiosa o un XSS para llevárselo.
 *
 * Es lista blanca a propósito. Con lista negra, cualquier campo sensible que se
 * añada al documento en el futuro se filtraría solo, en silencio, y el fallo
 * volvería sin que nadie lo note.
 */
function perfilPublico(datos) {
    if (!datos) return null;
    return {
        email: datos.email,
        nickname: datos.nickname,
        monedas: datos.monedas,
        avatar: datos.avatar,
        inventario: datos.inventario || [],
        fichaActiva: datos.fichaActiva || 'assets/imagenes/ui/ficha.PNG',
        cartasFavoritas: datos.cartasFavoritas || [],
        baneado: datos.baneado || false
    };
}

/**
 * Índice de nicknames para garantizar unicidad.
 *
 * Firestore no tiene restricciones de tipo UNIQUE, así que la unicidad se
 * consigue con una colección aparte donde el ID del documento ES el nickname en
 * minúsculas: crear ese documento dentro de una transacción falla si ya existe.
 *
 * Sin esto, dos personas podían llamarse igual, y como las transferencias se
 * hacen por nickname, alguien podía registrarse con el nombre de un jugador
 * conocido para que le llegara a él el dinero destinado al otro.
 */
function refNickname(nick) {
    return db.collection('nicknames').doc(String(nick).trim().toLowerCase());
}

/**
 * El nickname lo escribe el usuario y se pinta en la sala de todos los demás y en
 * el panel de administración. Los frontends ya lo escapan al renderizar, pero
 * conviene que un payload de este tipo no llegue siquiera a la base de datos.
 * Se permiten letras con acentos y ñ, números, espacios y separadores simples,
 * porque hay nicknames legítimos como "La Gata".
 */
function nicknameValido(nick) {
    if (typeof nick !== 'string') return false;
    const limpio = nick.trim();
    if (limpio.length < 3 || limpio.length > 20) return false;
    return /^[\p{L}\p{N} ._-]+$/u.test(limpio);
}



// ==========================================
// 🔔 GESTIÓN DE NOTIFICACIONES (FINAL)
// ==========================================

// 1. GUARDAR TOKEN (Para cualquier usuario)
app.post('/api/usuario/guardar-fcm', async (req, res) => {
    const { fcmToken } = req.body;
    const email = identificar(req, req.body.email, 'POST /usuario/guardar-fcm');
    if (!email) return res.status(401).json({ error: "Sesión no válida" });
    if (!fcmToken) return res.status(400).json({ error: "Datos incompletos" });
    try {
        await db.collection('usuarios').doc(email).update({ fcmToken: fcmToken });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Error interno" }); }
});

// 2. BROADCAST (CORREGIDO ERROR 404 /BATCH)
app.post('/api/admin/broadcast', async (req, res) => {
    const { titulo, cuerpo } = req.body;
    
    // Verificación
    if (!solicitanteEsAdmin(req)) {
        return res.status(403).json({ error: "No autorizado" });
    }

    try {
        // Obtenemos todos los usuarios
        const snapshot = await db.collection('usuarios').get();
        
        if (snapshot.empty) return res.json({ success: true, enviados: 0 });

        const tokens = [];
        snapshot.forEach(doc => { 
            const data = doc.data();
            // Filtramos tokens válidos
            if(data.fcmToken && typeof data.fcmToken === 'string' && data.fcmToken.length > 10) {
                tokens.push(data.fcmToken);
            }
        });

        console.log(`📢 Intentando enviar a ${tokens.length} dispositivos...`);

        if (tokens.length > 0) {
            const message = {
                data: { 
                    titulo: String(titulo || "Aviso"), 
                    cuerpo: String(cuerpo || "...") 
                }, 
                tokens: tokens
            };
            
            // 🔥 AQUÍ ESTÁ EL CAMBIO MÁGICO 🔥
            // Cambiamos sendMulticast por sendEachForMulticast
            const response = await admin.messaging().sendEachForMulticast(message);
            
            console.log(`✅ Broadcast resultado: ${response.successCount} ok, ${response.failureCount} error.`);
            
            res.json({ success: true, enviados: response.successCount });
        } else {
            res.json({ success: true, enviados: 0 });
        }

    } catch (e) { 
        console.error("❌ ERROR BROADCAST:", e); 
        res.status(500).json({ error: e.message || "Error interno" }); 
    }
});
// 3. TAREA AUTOMÁTICA: REGALO DIARIO (6:00 PM)
cron.schedule('0 18 * * *', async () => {
    console.log("⏰ Cron: Verificando regalos diarios...");
    try {
        const snapshot = await db.collection('usuarios').where('fcmToken', '!=', null).get();
        const tokensParaEnviar = [];
        const ahora = new Date();
        const horas24 = 24 * 60 * 60 * 1000;

        snapshot.forEach(doc => {
            const data = doc.data();
            const ultima = data.ultimaRecompensa ? data.ultimaRecompensa.toDate() : new Date(0);
            if ((ahora - ultima) >= horas24) {
                if(data.fcmToken) tokensParaEnviar.push(data.fcmToken);
            }
        });

        if (tokensParaEnviar.length > 0) {
            const message = {
                data: {
                    titulo: "🎁 ¡Tu regalo está listo!",
                    cuerpo: "Tus monedas gratis te esperan. ¡Entra ya!"
                },
                tokens: tokensParaEnviar
            };
            
            // 🔥 CAMBIO AQUÍ TAMBIÉN:
            const response = await admin.messaging().sendEachForMulticast(message);
            
            console.log(`🎁 Recordatorio enviado a ${response.successCount} usuarios.`);
        }
    } catch (e) { console.error("Error cron:", e); }
});

// ==================== RUTAS API ====================

app.get('/', (req, res) => res.send('Servidor Juegos en la Nube ☁️ Funcionando ✅'));

// 1. REGISTRO
app.post('/api/registro', limiteRegistro, async (req, res) => {
    const { email, password, nickname } = req.body;
    if (!nicknameValido(nickname)) {
        return res.status(400).json({ error: 'El nickname debe tener entre 3 y 20 caracteres, sin símbolos raros.' });
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const userRef = db.collection('usuarios').doc(email);
        const nickRef = refNickname(nickname);

        // Correo y nickname se comprueban y reservan en la MISMA transacción.
        // Hacerlo en dos pasos dejaba una rendija: dos registros simultáneos con
        // el mismo nickname podían pasar los dos la comprobación antes de que
        // ninguno escribiera.
        try {
            await db.runTransaction(async (tx) => {
                const [usuario, nick] = await Promise.all([tx.get(userRef), tx.get(nickRef)]);
                if (usuario.exists) throw new Error('CORREO_YA_EXISTE');
                if (nick.exists) throw new Error('NICKNAME_OCUPADO');

                tx.set(userRef, {
                    email, password: hashedPassword, nickname, monedas: 20,
                    creado: new Date(), baneado: false
                });
                tx.set(nickRef, { email, nickname, creado: admin.firestore.FieldValue.serverTimestamp() });
            });
        } catch (e) {
            if (e.message === 'CORREO_YA_EXISTE') return res.status(400).json({ error: 'Correo ya registrado.' });
            if (e.message === 'NICKNAME_OCUPADO') return res.status(400).json({ error: 'Ese nickname ya está en uso. Elige otro.' });
            throw e;
        }

        // 🔥 NOTIFICACIÓN PUSH AL ADMIN (Usando 'data' para evitar duplicados)
        try {
            const adminDoc = await db.collection('usuarios').doc(ADMIN_EMAIL).get(); // Asegúrate que este sea tu email de admin
            if (adminDoc.exists && adminDoc.data().fcmToken) {
                const mensajePush = {
                    data: {
                        titulo: '💰 Nuevo Usuario',
                        cuerpo: `${nickname} (${email}) se ha unido.`
                    },
                    token: adminDoc.data().fcmToken
                };
                await admin.messaging().send(mensajePush);
            }
        } catch (pushError) { console.error("Error push admin:", pushError); }
        
        res.json({
            success: true, nickname, monedas: 20, email,
            esAdmin: esAdmin(email),
            token: emitirToken(email, esAdmin(email))
        });
    } catch (error) { res.status(500).json({ error: 'Error servidor.' }); }
});

// 2. LOGIN (CON VALIDACIÓN DE BANEO)
app.post('/api/login', limiteLogin, async (req, res) => {
    const { email, password } = req.body;
    try {
        const userRef = db.collection('usuarios').doc(email);
        const doc = await userRef.get();
        if (!doc.exists) return res.status(400).json({ error: 'Usuario no encontrado.' });

        const userData = doc.data();
        
        // CHECK DE BANEO
        if (userData.baneado) return res.status(403).json({ error: '⛔ TU CUENTA ESTÁ SUSPENDIDA.' });

        const validPassword = await bcrypt.compare(password, userData.password);
        if (!validPassword) return res.status(400).json({ error: 'Contraseña incorrecta.' });

        res.json({ 
            success: true, 
            nickname: userData.nickname, 
            monedas: userData.monedas, 
            email: userData.email,
            avatar: userData.avatar, 
            inventario: userData.inventario || [],
            fichaActiva: userData.fichaActiva || 'assets/imagenes/ui/ficha.PNG',
            cartasFavoritas: userData.cartasFavoritas || [],
            // El frontend usa esto solo para mostrar u ocultar el botón del panel.
            // La autorización real la sigue haciendo el servidor en cada endpoint.
            esAdmin: esAdmin(userData.email),
            // A partir de aquí el cliente debe mandar este token en cada petición
            // (Authorization: Bearer ...) y en el handshake del socket.
            token: emitirToken(userData.email, esAdmin(userData.email))
        });
    } catch (error) { res.status(500).json({ error: 'Error servidor.' }); }
});

// 3. DATOS FRESCOS (CON HORA CDMX)
app.get('/api/usuario/datos-frescos', async (req, res) => {
    const email = identificar(req, req.query.email, 'GET /usuario/datos-frescos');
    if (!email) return res.status(401).json({ error: "Sesión no válida" });
    try {
        const userDoc = await db.collection('usuarios').doc(email).get();
        if (!userDoc.exists) return res.status(404).json({ error: "No encontrado" });
        
        // CHECK BANEO EN TIEMPO REAL
        if (userDoc.data().baneado) return res.json({ success: false, baneado: true });

        const historialSnapshot = await db.collection('usuarios').doc(email).collection('historial')
            .orderBy('fecha', 'desc').limit(20).get();

        const historial = historialSnapshot.docs.map(doc => {
            const d = doc.data();
            let fechaMX = "---";
            
            // CONVERSIÓN DE HORA UTC A CDMX
            if (d.fecha) {
                const fechaObj = d.fecha.toDate ? d.fecha.toDate() : new Date(d.fecha);
                fechaMX = fechaObj.toLocaleString("es-MX", {
                    timeZone: "America/Mexico_City",
                    day: '2-digit', month: '2-digit', year: '2-digit',
                    hour: '2-digit', minute: '2-digit', hour12: true
                });
            }

            return {
                tipo: d.tipo, monto: d.monto, descripcion: d.descripcion, esIngreso: d.esIngreso,
                cantidad: d.monto, concepto: d.descripcion,
                fecha: fechaMX // Ahora envía "23/12/25 02:30 p.m." en hora local
            };
        });
        
        res.json({
            success: true,
            // email, nickname y esAdmin permiten reconstruir la sesión completa a
            // partir de un token, que es lo que necesita el SSO firmado del Hub.
            email,
            nickname: userDoc.data().nickname,
            esAdmin: esAdmin(email),
            monedas: userDoc.data().monedas,
            historial,
            fichaActiva: userDoc.data().fichaActiva || 'assets/imagenes/ui/ficha.PNG',
            cartasFavoritas: userDoc.data().cartasFavoritas || [],
            inventario: userDoc.data().inventario || []
        });
    } catch (error) { res.status(500).json({ error: "Error servidor" }); }
});


// --- GUARDAR PREFERENCIAS (FICHAS Y CARTAS) ---
// NOTA: esta ruta vivía por error DENTRO del handler de socket 'disconnect', lo que
// la registraba de nuevo en cada desconexión (fuga de memoria) y la dejaba inexistente
// hasta la primera desconexión tras cada deploy. Aquí es su lugar correcto.
app.post('/api/usuario/guardar-preferencias', async (req, res) => {
    const { fichaActiva, cartasFavoritas } = req.body;
    const email = identificar(req, req.body.email, 'POST /usuario/guardar-preferencias');
    if (!email) return res.status(401).json({ error: "Sesión no válida" });

    try {
        const updateData = {};
        if (fichaActiva) updateData.fichaActiva = fichaActiva;
        if (cartasFavoritas) updateData.cartasFavoritas = cartasFavoritas;

        await db.collection('usuarios').doc(email).update(updateData);
        res.json({ success: true });
    } catch (e) {
        console.error("Error guardando preferencias:", e);
        res.status(500).json({ error: "Error al guardar" });
    }
});

// --- RECOMPENSA DIARIA (NUEVO) ---
app.post('/api/recompensa-diaria', async (req, res) => {
    const email = identificar(req, req.body.email, 'POST /recompensa-diaria');
    if (!email) return res.status(401).json({ error: "Sesión no válida" });

    try {
        const userRef = db.collection('usuarios').doc(email);
        const doc = await userRef.get();
        if(!doc.exists) return res.status(404).json({ error: "Usuario no encontrado" });

        const data = doc.data();
        const ultima = data.ultimaRecompensa ? data.ultimaRecompensa.toDate() : new Date(0);
        const ahora = new Date();
        const diferencia = ahora - ultima;
        const horas24 = 24 * 60 * 60 * 1000;

        if (diferencia >= horas24) {
            // ¡Dar Recompensa!
            const premio = 10;
            await userRef.update({ 
                monedas: admin.firestore.FieldValue.increment(premio),
                ultimaRecompensa: admin.firestore.FieldValue.serverTimestamp()
            });
            await registrarMovimiento(email, 'premio', premio, '🎁 Regalo Diario', true);
            
            // Obtener saldo nuevo
            const nuevoSaldo = (data.monedas || 0) + premio;
            res.json({ success: true, nuevoSaldo, mensaje: "¡Recompensa cobrada!" });
        } else {
            // Aún falta tiempo
            const restanteMs = horas24 - diferencia;
            const horas = Math.floor(restanteMs / (1000 * 60 * 60));
            const minutos = Math.floor((restanteMs % (1000 * 60 * 60)) / (1000 * 60));
            res.json({ success: false, error: `Vuelve en ${horas}h ${minutos}m` });
        }
    } catch (e) { 
        console.error("Error recompensa:", e); 
        res.status(500).json({ error: "Error de servidor" }); 
    }
});

// --- ADMIN DASHBOARD API ---

// Cuántas peticiones siguen llegando sin token, desglosadas por ruta. Cuando esto
// se mantenga en cero un buen rato, se puede poner AUTH_ESTRICTA=true en Render
// para cerrar el camino viejo sabiendo que no se tumba a nadie.
app.get('/api/admin/uso-heredado', (req, res) => {
    if (!solicitanteEsAdmin(req)) return res.status(403).json({ error: "Acceso denegado" });
    res.json({
        modoEstricto: MODO_ESTRICTO,
        totalSinToken: Object.values(usoHeredado).reduce((a, b) => a + b, 0),
        servidorArrancado: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        porRuta: usoHeredado
    });
});

// Rellena el índice de nicknames con las cuentas que ya existían antes de que
// hubiera unicidad. Se ejecuta una vez y es idempotente: repetirlo no hace daño.
//
// Los duplicados que YA existan no se resuelven solos: el índice se queda con la
// cuenta más antigua y las demás se listan en la respuesta para decidir a mano.
// Renombrarle la cuenta a alguien sin avisarle no es cosa del servidor.
app.post('/api/admin/migrar-nicknames', async (req, res) => {
    if (!solicitanteEsAdmin(req)) return res.status(403).json({ error: "Acceso denegado" });

    try {
        const snapshot = await db.collection('usuarios').get();

        const porNickname = new Map();
        snapshot.forEach(doc => {
            const nick = doc.data().nickname;
            if (!nick) return;
            const clave = String(nick).trim().toLowerCase();
            if (!porNickname.has(clave)) porNickname.set(clave, []);
            porNickname.get(clave).push({
                email: doc.id,
                nickname: nick,
                creado: doc.data().creado?.toDate?.() || doc.data().creado || new Date(0)
            });
        });

        let creados = 0, yaEstaban = 0;
        const duplicados = [];

        for (const [clave, cuentas] of porNickname) {
            cuentas.sort((a, b) => new Date(a.creado) - new Date(b.creado));
            const dueño = cuentas[0];

            if (cuentas.length > 1) {
                duplicados.push({
                    nickname: dueño.nickname,
                    seQuedaCon: dueño.email,
                    enConflicto: cuentas.slice(1).map(c => c.email)
                });
            }

            const ref = db.collection('nicknames').doc(clave);
            if ((await ref.get()).exists) { yaEstaban++; continue; }

            await ref.set({
                email: dueño.email, nickname: dueño.nickname,
                creado: admin.firestore.FieldValue.serverTimestamp(),
                migrado: true
            });
            creados++;
        }

        console.log(`🔤 Índice de nicknames: ${creados} creados, ${yaEstaban} ya estaban, ${duplicados.length} en conflicto.`);
        res.json({
            success: true,
            usuariosRevisados: snapshot.size,
            nicknamesCreados: creados,
            yaEstaban,
            duplicados
        });
    } catch (e) {
        console.error("Error migrando nicknames:", e);
        res.status(500).json({ error: "Error en la migración" });
    }
});

// Stats Generales (VENTAS REALES vs DEUDA)
app.get('/api/admin/stats', async (req, res) => {
    if (!solicitanteEsAdmin(req)) return res.status(403).json({ error: "Acceso denegado" });

    try {
        const usersSnap = await db.collection('usuarios').get();
        let totalUsuarios = 0;
        let monedasCirculantes = 0; // Pasivo (Deuda)

        usersSnap.forEach(doc => {
            totalUsuarios++;
            monedasCirculantes += (doc.data().monedas || 0);
        });

        // Obtener ventas reales (Activo - MXN)
        const finanzasDoc = await db.collection('finanzas').doc('general').get();
        let ventasTotales = 0;
        if(finanzasDoc.exists) {
            ventasTotales = finanzasDoc.data().totalVentasMXN || 0;
        }

        res.json({ totalUsuarios, monedasCirculantes, ventasTotales });
    } catch (e) { res.status(500).json({ error: "Error stats" }); }
});

// Lista de Usuarios
app.get('/api/admin/usuarios', async (req, res) => {
    if (!solicitanteEsAdmin(req)) return res.status(403).json({ error: "Acceso denegado" });
    try {
        const snapshot = await db.collection('usuarios').get();
        const usuarios = snapshot.docs.map(doc => ({
            email: doc.id,
            nickname: doc.data().nickname,
            monedas: doc.data().monedas,
            baneado: doc.data().baneado || false
        }));
        res.json(usuarios);
    } catch (error) { res.status(500).json({ error: "Error usuarios" }); }
});

// Banear / Desbanear
app.post('/api/admin/banear', async (req, res) => {
    const { adminEmail, targetEmail, ban } = req.body; 
    if (!solicitanteEsAdmin(req)) return res.status(403).json({ error: "Acceso denegado" });
    try {
        await db.collection('usuarios').doc(targetEmail).update({ baneado: ban });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Error ban" }); }
});

// RECARGAR SALDO (SUMAR)
app.post('/api/admin/recargar-manual', async (req, res) => {
    const { adminEmail, targetEmail, cantidad } = req.body;
    if (!solicitanteEsAdmin(req)) return res.status(403).json({ error: "Acceso denegado" });
    
    const monto = parseInt(cantidad);
    if(isNaN(monto) || monto <= 0) return res.status(400).json({ error: "Monto inválido" });

    try {
        const userRef = db.collection('usuarios').doc(targetEmail);
        // Usamos increment para SUMAR
        await userRef.update({ monedas: admin.firestore.FieldValue.increment(monto) });
        
        await registrarMovimiento(targetEmail, 'recarga_admin', monto, `Abono Manual Admin`, true);
        
        // Obtenemos el saldo final
        const doc = await userRef.get();
        res.json({ success: true, nuevoSaldo: doc.data().monedas });
    } catch (e) { res.status(500).json({ error: "Error saldo" }); }
});

// =========================================================
// 💸 SISTEMA DE TRANSFERENCIAS Y BÚSQUEDA (NUEVO) 💸
// =========================================================

// 1. BUSCAR DESTINATARIO (MODO FLEXIBLE: IGNORA MAYÚSCULAS)
app.post('/api/buscar-destinatario', limiteBusqueda, async (req, res) => {
    const { nickname } = req.body;
    if (!nickname) return res.status(400).json({ error: "Falta nickname" });

    const busqueda = String(nickname).trim().toLowerCase();

    try {
        // Lectura directa por ID en el índice. Antes esto descargaba la colección
        // completa de usuarios y la recorría en memoria en CADA búsqueda: lento,
        // caro en lecturas de Firestore, y además se quedaba con el ÚLTIMO que
        // coincidiera, sin avisar de que hubiera varios con el mismo nombre.
        const doc = await refNickname(busqueda).get();

        if (doc.exists) {
            const d = doc.data();
            return res.json({ success: true, destinatario: { email: d.email, nickname: d.nickname } });
        }

        // Respaldo para cuentas que aún no están en el índice (creadas antes de
        // que existiera). Se puede retirar cuando la migración esté hecha.
        const snapshot = await db.collection('usuarios').get();
        let encontrado = null;
        snapshot.forEach(u => {
            const data = u.data();
            if (data.nickname && data.nickname.trim().toLowerCase() === busqueda) {
                encontrado = { email: u.id, nickname: data.nickname };
            }
        });

        if (encontrado) {
            console.log(`⚠️ "${busqueda}" resuelto por barrido: falta migrar al índice.`);
            return res.json({ success: true, destinatario: encontrado });
        }

        return res.json({ success: false, error: "Usuario no encontrado" });

    } catch (e) {
        console.error("Error buscar destinatario:", e);
        res.status(500).json({ error: "Error de servidor" });
    }
});

// 2. TRANSFERIR SALDO (CON NOTIFICACIÓN AL DESTINATARIO)
app.post('/api/transferir-saldo', async (req, res) => {
    const { destinoEmail, cantidad } = req.body;
    const monto = parseInt(cantidad);

    // 🔑 El origen sale del token, NUNCA del body. Antes se aceptaba tal cual, así
    // que bastaba con conocer el email de alguien para vaciarle la cuenta.
    const origenEmail = identificar(req, req.body.origenEmail, 'POST /transferir-saldo');
    if (!origenEmail) return res.status(401).json({ error: "Sesión no válida. Vuelve a iniciar sesión." });

    if (!destinoEmail || !monto || monto < 1) {
        return res.status(400).json({ error: "Datos inválidos" });
    }

    if (origenEmail === destinoEmail) {
        return res.status(400).json({ error: "No puedes enviarte a ti mismo" });
    }

    try {
        let nicknameOrigen = "Alguien"; // Para el mensaje

        await db.runTransaction(async (t) => {
            const origenRef = db.collection('usuarios').doc(origenEmail);
            const destinoRef = db.collection('usuarios').doc(destinoEmail);

            const origenDoc = await t.get(origenRef);
            const destinoDoc = await t.get(destinoRef);

            if (!origenDoc.exists || !destinoDoc.exists) throw "Usuario no encontrado";

            const saldoActual = origenDoc.data().monedas || 0;
            if (saldoActual < monto) throw "Saldo insuficiente";

            nicknameOrigen = origenDoc.data().nickname; // Guardamos el nombre para la noti

            // Operación Financiera
            t.update(origenRef, { monedas: admin.firestore.FieldValue.increment(-monto) });
            t.update(destinoRef, { monedas: admin.firestore.FieldValue.increment(monto) });

            // Historial Origen
            const histRef1 = origenRef.collection('historial').doc();
            t.set(histRef1, {
                tipo: 'transferencia', monto: monto, descripcion: `Envío a ${destinoDoc.data().nickname}`,
                esIngreso: false, fecha: admin.firestore.FieldValue.serverTimestamp()
            });

            // Historial Destino
            const histRef2 = destinoRef.collection('historial').doc();
            t.set(histRef2, {
                tipo: 'transferencia', monto: monto, descripcion: `Recibido de ${nicknameOrigen}`,
                esIngreso: true, fecha: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        // 🔥 NOTIFICACIÓN PUSH AL DESTINATARIO (FUERA DE LA TRANSACCIÓN)
        try {
            const destinoDoc = await db.collection('usuarios').doc(destinoEmail).get();
            const tokenDestino = destinoDoc.data().fcmToken;

            if (tokenDestino) {
                const message = {
                    data: {
                        titulo: "🤑 ¡Recibiste Monedas!",
                        cuerpo: `${nicknameOrigen} te envió $${monto}. ¡Entra a jugar!`
                    },
                    token: tokenDestino
                };
                // Usamos sendEachForMulticast o send (si es uno solo)
                // Como es uno solo, .send() funciona, pero tu corrección usa .sendEach... para arrays.
                // Para uno solo directo usamos .send():
                await admin.messaging().send(message);
                console.log(`🔔 Notificación de transferencia enviada a ${destinoEmail}`);
            }
        } catch (pushError) {
            console.error("Error enviando push transferencia:", pushError);
            // No fallamos la request principal, solo logueamos el error de push
        }

        res.json({ success: true });

    } catch (e) {
        console.error("Error transferencia:", e);
        res.status(400).json({ success: false, error: e.message || e });
    }
});


// 3. HISTORIAL COMPLETO (CORREGIDO HORA CDMX)
app.get('/api/historial-usuario', async (req, res) => {
    const email = identificar(req, req.query.email, 'GET /historial-usuario');
    if (!email) return res.status(401).json({ error: "Sesión no válida" });

    try {
        const snapshot = await db.collection('usuarios').doc(email).collection('historial')
            .orderBy('fecha', 'desc')
            .limit(50) 
            .get();

        const movimientos = snapshot.docs.map(doc => {
            const d = doc.data();
            let fechaBonita = "---";
            
            // Verificamos si existe fecha y si es un Timestamp de Firestore
            if (d.fecha) {
                // Si es Timestamp de Firestore usa .toDate(), si es string usa new Date()
                const fechaObj = d.fecha.toDate ? d.fecha.toDate() : new Date(d.fecha);
                
                // Formateamos a CDMX
                fechaBonita = fechaObj.toLocaleString("es-MX", {
                    timeZone: "America/Mexico_City",
                    day: '2-digit', month: '2-digit', year: 'numeric', // Año completo (2025)
                    hour: '2-digit', minute: '2-digit', hour12: true
                });
            }

            return {
                id: doc.id,
                tipo: d.tipo || 'varios',
                monto: d.monto || 0,
                descripcion: d.descripcion || 'Movimiento',
                esIngreso: d.esIngreso,
                fecha: fechaBonita // Enviamos la cadena ya formateada
            };
        });

        res.json({ success: true, movimientos });
    } catch (e) {
        console.error("Error historial:", e);
        res.status(500).json({ error: "Error al obtener historial" });
    }
});

// --- HUB & JUEGOS API ---
app.get('/api/hub/juegos', async (req, res) => {
    try {
        const snapshot = await db.collection('juegos_hub').get();
        const juegos = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json({ success: true, juegos });
    } catch (e) { res.status(500).json({ error: "Error juegos" }); }
});
app.post('/api/hub/nuevo-juego', async (req, res) => {
    const { adminEmail, titulo, url, imgPoster, descripcion, estado } = req.body;
    if (!solicitanteEsAdmin(req)) return res.status(403).json({ error: "Sin permiso" });
    try {
        await db.collection('juegos_hub').add({ titulo, url, imgPoster, descripcion, estado, creado: admin.firestore.FieldValue.serverTimestamp() });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Error guardar" }); }
});
app.delete('/api/hub/eliminar-juego/:id', async (req, res) => {
    const { id } = req.params;
    if (!solicitanteEsAdmin(req)) return res.status(403).json({ error: "Sin permiso" });
    try {
        await db.collection('juegos_hub').doc(id).delete();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: "Error al eliminar" }); }
});
app.post('/api/actualizar-perfil', async (req, res) => {
    const { nickname, avatar } = req.body;
    const email = identificar(req, req.body.email, 'POST /actualizar-perfil');
    if (!email) return res.status(401).json({ error: "Sesión no válida" });
    if (!nicknameValido(nickname)) {
        return res.status(400).json({ error: "El nickname debe tener entre 3 y 20 caracteres, sin símbolos raros." });
    }
    try {
        const userRef = db.collection('usuarios').doc(email);
        const nuevoNickRef = refNickname(nickname);

        await db.runTransaction(async (tx) => {
            const [usuario, nick] = await Promise.all([tx.get(userRef), tx.get(nuevoNickRef)]);
            if (!usuario.exists) throw new Error('NO_EXISTE');

            const anterior = usuario.data().nickname;
            const cambiaDeNombre = String(anterior || '').trim().toLowerCase() !== String(nickname).trim().toLowerCase();

            // Si el nickname ya lo tiene otra persona, se rechaza. Que lo tengas
            // tú mismo (por ejemplo al cambiar solo el avatar) no es conflicto.
            if (cambiaDeNombre && nick.exists && nick.data().email !== email) {
                throw new Error('NICKNAME_OCUPADO');
            }

            tx.update(userRef, { nickname, avatar: avatar || 'assets/avatar.png' });

            if (cambiaDeNombre) {
                // Se libera el anterior para que quede disponible.
                if (anterior) tx.delete(refNickname(anterior));
                tx.set(nuevoNickRef, { email, nickname, creado: admin.firestore.FieldValue.serverTimestamp() });
            }
        });

        res.json({ success: true });
    } catch (error) {
        if (error.message === 'NICKNAME_OCUPADO') return res.status(400).json({ error: "Ese nickname ya está en uso. Elige otro." });
        if (error.message === 'NO_EXISTE') return res.status(404).json({ error: "Usuario no encontrado" });
        console.error("Error perfil:", error);
        res.status(500).json({ error: "Error al actualizar perfil" });
    }
});

// --- STRIPE (CON REGISTRO DE FINANZAS) ---
const FRONTEND_LOTERIA = "https://loteria.juegosenlanube.com"; 
const FRONTEND_HUB = "https://juegosenlanube.com";
const BACKEND_URL = "https://loteria-backend-3nde.onrender.com";

app.post('/api/crear-orden', async (req, res) => {
    const { origen } = req.body;
    const email = identificar(req, req.body.email, 'POST /crear-orden');
    if (!email) return res.status(401).json({ error: "Sesión no válida" });

    // El precio NO se lee del cuerpo: sale del catálogo del servidor. Si la
    // cantidad pedida no es uno de los paquetes que vendemos, no hay orden.
    // `req.body.precio` puede seguir llegando de clientes viejos; se ignora.
    const cantidad = parseInt(req.body.cantidad, 10);
    const precio = PAQUETES_MONEDAS[cantidad];
    if (!precio) {
        console.warn(`⚠️ Orden rechazada: paquete inexistente (${req.body.cantidad}) pedido por ${email}`);
        return res.status(400).json({ error: "Paquete no válido" });
    }

    try {
        const session = await stripe.checkout.sessions.create({
            ui_mode: 'embedded',
            payment_method_types: ['card'],
            line_items: [{
                price_data: { currency: 'mxn', product_data: { name: `Paquete de ${cantidad} Monedas` }, unit_amount: Math.round(precio * 100) },
                quantity: 1,
            }],
            mode: 'payment',
            metadata: { email_usuario: email, monedas_a_dar: cantidad, origen_pago: origen || 'loteria' },
            // El origen viaja también en la URL de retorno, no solo en los
            // metadatos: si la sesión termina sin pagarse o algo falla, no
            // tenemos de dónde sacarlo y hay que saber a qué frontend devolver
            // a la persona. Antes esos dos casos mandaban siempre al Hub, así
            // que pagar desde la Lotería y cerrar el checkout te sacaba de ahí.
            return_url: `${BACKEND_URL}/api/confirmar-pago?session_id={CHECKOUT_SESSION_ID}&origen=${encodeURIComponent(origen || 'loteria')}`,
        });
        res.json({ clientSecret: session.client_secret });
    } catch (error) { res.status(500).json({ error: "Error orden" }); }
});

// --- ACREDITACIÓN DE UN PAGO ---
// Una sola función para los dos caminos: el webhook de Stripe (fiable) y el
// retorno del navegador (best effort). Es idempotente, así que da igual cuál
// llegue primero o si llegan los dos.
async function acreditarPago(session, origenLlamada) {
    if (!session || session.payment_status !== 'paid') return { acreditado: false };

    const email = session.metadata?.email_usuario;
    const monedasExtra = parseInt(session.metadata?.monedas_a_dar);
    const origen = session.metadata?.origen_pago;
    const dineroReal = session.amount_total / 100; // Centavos a Pesos

    if (!email || !monedasExtra) {
        console.error(`⚠️ Pago ${session.id} sin metadatos utilizables.`);
        return { acreditado: false, email, monedasExtra, origen };
    }

    // 🔒 IDEMPOTENCIA (OBLIGATORIO)
    // El session_id viaja en la URL a la vista del usuario, y además el webhook
    // puede reintentar. Reservamos el id ANTES de acreditar: si ya existía, este
    // pago ya se procesó y salimos sin tocar el saldo.
    const pagoRef = db.collection('pagos_procesados').doc(session.id);
    let yaProcesado = false;

    await db.runTransaction(async (t) => {
        const pagoDoc = await t.get(pagoRef);
        if (pagoDoc.exists) { yaProcesado = true; return; }
        t.set(pagoRef, {
            email, monedas: monedasExtra, montoMXN: dineroReal,
            origen: origen || 'loteria',
            acreditadoPor: origenLlamada,
            fecha: admin.firestore.FieldValue.serverTimestamp()
        });
    });

    if (yaProcesado) {
        console.log(`♻️ Pago ${session.id} ya estaba acreditado. Se ignora (${origenLlamada}).`);
        return { acreditado: false, email, monedasExtra, origen };
    }

    const userRef = db.collection('usuarios').doc(email);
    const doc = await userRef.get();

    if (doc.exists) {
        const userData = doc.data();

        // increment() en vez de leer-modificar-escribir: evita perder
        // acreditaciones concurrentes sobre la misma cuenta.
        await userRef.update({ monedas: admin.firestore.FieldValue.increment(monedasExtra) });
        await registrarMovimiento(email, 'recarga', monedasExtra, 'Recarga con Tarjeta', true);

        await db.collection('finanzas').doc('general').set({
            totalVentasMXN: admin.firestore.FieldValue.increment(dineroReal),
            ultimaActualizacion: new Date()
        }, { merge: true });

        console.log(`💰 Acreditado por ${origenLlamada}: ${monedasExtra} monedas a ${email} ($${dineroReal} MXN)`);

        // --- NOTIFICACIONES DE VENTA ---
        if (userData.fcmToken) {
            try {
                await admin.messaging().send({
                    data: { titulo: "✅ ¡Pago Exitoso!", cuerpo: `Se agregaron ${monedasExtra} monedas a tu cuenta. ¡A jugar!` },
                    token: userData.fcmToken
                });
            } catch(e) { console.error("Error push usuario:", e); }
        }
        try {
            const adminDoc = await db.collection('usuarios').doc(ADMIN_EMAIL).get();
            if (adminDoc.exists && adminDoc.data().fcmToken) {
                await admin.messaging().send({
                    data: { titulo: "🤑 ¡Nueva Venta!", cuerpo: `Usuario ${userData.nickname} compró $${dineroReal} MXN (${monedasExtra} monedas).` },
                    token: adminDoc.data().fcmToken
                });
            }
        } catch(e) { console.error("Error push admin:", e); }
    } else {
        console.error(`⚠️ Pago de ${email} acreditado en registro pero el usuario no existe.`);
    }

    return { acreditado: true, email, monedasExtra, origen };
}

// --- RETORNO DEL NAVEGADOR ---
// Solo redirige y, por si el webhook aún no ha llegado, intenta acreditar. Ya no
// es el mecanismo principal: si el usuario cierra la pestaña al pagar, este
// endpoint nunca se ejecuta y antes eso significaba cobrar sin dar monedas.
app.get('/api/confirmar-pago', async (req, res) => {
    const { session_id } = req.query;

    // De dónde salió el pago. Se usa para devolver a la persona al mismo sitio
    // pase lo que pase, incluso si no llegamos a leer la sesión de Stripe.
    const volverA = (req.query.origen === 'hub') ? FRONTEND_HUB : FRONTEND_LOTERIA;

    try {
        const session = await stripe.checkout.sessions.retrieve(session_id);

        if (session.payment_status === 'paid') {
            const r = await acreditarPago(session, 'retorno-navegador');
            const destino = r.origen === 'hub' ? FRONTEND_HUB : FRONTEND_LOTERIA;
            return res.redirect(`${destino}/index.html?pago=exito&cantidad=${r.monedasExtra}`);
        }
        res.redirect(`${volverA}/index.html?pago=cancelado`);
    } catch (error) {
        console.error(error);
        res.redirect(`${volverA}/index.html?pago=error`);
    }
});

// FUNCIONES DE JUEGO (REEMBOLSOS LOTERIA)
async function procesarReembolsoPorSalida(salaId, socketId) {
    const sala = salas[salaId];
    if (!sala) return;
    const jugador = sala.jugadores[socketId];
    if (!jugador) return;

    // Del pozo se devuelve ÚNICAMENTE lo aportado en la ronda que no llegó a
    // empezar. Lo acumulado de rondas anteriores se queda: si se devolviera
    // todo, participar saldría gratis —juegas, no ganas, te sales y recuperas—
    // y el pozo dejaría de tener riesgo para nadie.
    if (!sala.juegoIniciado && jugador.email && sala.pozoRonda?.[jugador.email]) {
        const devolver = sala.pozoRonda[jugador.email];
        delete sala.pozoRonda[jugador.email];
        jugador.pozoActivo = false;
        jugador.monedas += devolver;
        await moverPozo(sala, -devolver);
        try {
            await db.collection('usuarios').doc(jugador.email).update({
                monedas: admin.firestore.FieldValue.increment(devolver)
            });
            await registrarMovimiento(jugador.email, 'reembolso', devolver, 'Reembolso del pozo por salir', true);
        } catch (e) { console.error("Error reembolsando pozo:", e.message); }
        io.to(salaId).emit('pozo-actualizado', sala.pozoAcumulado);
    }

    if (!sala.juegoIniciado && jugador.apostado) {
        const reembolso = jugador.cantidadApostada || 10; 
        jugador.monedas += reembolso;
        sala.bote -= reembolso;
        if(sala.bote < 0) sala.bote = 0;
        try {
            if (jugador.email) {
                await db.collection('usuarios').doc(jugador.email).update({ monedas: jugador.monedas });
                await registrarMovimiento(jugador.email, 'reembolso', reembolso, 'Reembolso por salir', true);
            }
        } catch (e) { console.error("Error guardando reembolso:", e); }
    }
}

// ==================== ALEATORIEDAD ====================
// Math.random() en V8 usa xorshift128+, que NO es criptográficamente seguro:
// observando suficientes resultados se puede reconstruir su estado interno y
// predecir los siguientes. Aquí eso decide barajas, dados y códigos de mesa en
// un juego con dinero real, así que va con el generador del sistema.
const { randomInt } = require('crypto');

/** Entero al azar en [0, tope). */
const alAzar = (tope) => randomInt(tope);

// ==================== CONFIGURACIÓN DE MODOS ====================
// Las cartas del sistema: las que ve todo el mundo en la pantalla de selección.
//
// Ya no son imágenes, son DATOS: cada carta es una lista de 16 números (con null
// en las casillas vacías del modo esquinas). Las genera a mano
// `scripts/generar-cartas-sistema.js` y el resultado está commiteado, porque
// tienen que ser las mismas para todos y no cambiar entre despliegues.
//
// Que el servidor las tenga es lo que abre la puerta a validar una lotería sin
// que el anfitrión mire: aquí se sabe exactamente qué lleva cada carta.
const CARTAS_SISTEMA = require('./cartas-sistema.json');

const MODOS_JUEGO = {
    // OJO con la terminología, que se presta a confusión:
    //   - "carta"  = la rejilla de 4×4 que elige el jugador
    //   - "baraja" = cada una de las 54 que se cantan
    // Son dos conjuntos distintos, y son los nombres que ve la gente que juega.
    // En sitios antiguos del código «tabla» significa lo mismo que «carta».
    //
    // `conjunto` dice de cuál de los dos grupos de `cartas-sistema.json` se sirve
    // el modo. El Pozo usa cartas de ocho casillas —cuatro esquinas y el centro—
    // y los otros dos las llenan enteras.
    'tradicional': { costo: 1, conjunto: 'normal' },
    'llena':       { costo: 2, conjunto: 'normal' },
    'pozo':        { costo: 2, conjunto: 'esquinas' },
    // En Doble una baraja ocupa las dos casillas del centro: cuando la cantan,
    // se tapan dos de golpe. Eso acerca el cuadro del centro y las dos líneas
    // que pasan por ahí, así que las partidas son más rápidas.
    'doble':       { costo: 2, conjunto: 'dobles' }
};

/** Las cartas del sistema que le tocan a un modo, listas para mandar al cliente. */
const cartasDelModo = (modo) =>
    CARTAS_SISTEMA.conjuntos[MODOS_JUEGO[modo]?.conjunto] || [];

/** Las 16 barajas de una carta del sistema, o null si ese id no existe. */
const barajasDeCartaSistema = (modo, id) =>
    cartasDelModo(modo).find(c => c.id === String(id))?.cartas || null;

// Función baraja SIEMPRE 54 (No importa el modo)
function mezclarBaraja() {
    // 1. Crear la baraja ordenada (01 al 54)
    const cartas = Array.from({ length: 54 }, (_, i) => String(i + 1).padStart(2, '0'));

    // 2. Algoritmo Fisher-Yates (Aleatoriedad Real)
    // Recorremos el mazo de atrás para adelante e intercambiamos con una posición al azar
    for (let i = cartas.length - 1; i > 0; i--) {
        const j = alAzar(i + 1);
        [cartas[i], cartas[j]] = [cartas[j], cartas[i]];
    }

    // 3. "Cortar" la baraja (Toque extra para romper patrones psicológicos)
    // Cortamos el mazo en un punto aleatorio y pasamos lo de arriba para abajo
    const puntoCorte = alAzar(cartas.length - 10) + 5;
    const arriba = cartas.slice(0, puntoCorte);
    const abajo = cartas.slice(puntoCorte);

    return [...abajo, ...arriba];
}

function repartirCartas(sala) {
  const salaInfo = salas[sala];
  if (!salaInfo || !salaInfo.juegoIniciado) return;
  if (salaInfo.intervaloCartas) clearInterval(salaInfo.intervaloCartas);
  const velocidad = salaInfo.velocidad || 3000;

  salaInfo.intervaloCartas = setInterval(() => {
    if (!salaInfo.juegoIniciado || salaInfo.baraja.length === 0) {
      clearInterval(salaInfo.intervaloCartas);
      salaInfo.intervaloCartas = null;
      return;
    }
    const carta = salaInfo.baraja.shift();
    salaInfo.historial.push(carta);
    io.to(sala).emit('carta-cantada', carta);

    // Los bots la oyen igual que todo el mundo. Van tapando con retardo y se
    // les pasan barajas según su nivel; cuando uno cree tener figura, grita por
    // el MISMO camino que una persona y el servidor lo juzga igual.
    bots.alCantarBaraja(sala, salaInfo, carta,
        (cartaId) => barajasDeCartaSistema(salaInfo.modoJuego, cartaId),
        (bot, nivel) => {
            const reloj = setTimeout(() => {
                if (!salaInfo.jugadores[bot.id]) return;
                procesarLoteria(sala, bot.id, bot.nickname, bots.tableroDe(bot));
            }, bots.entre(nivel.grito));
            bot.relojes.push(reloj);
        });
  }, velocidad); 
}

/**
 * Reparte el bote y cierra la ronda.
 *
 * Antes esto vivía dentro de `veredicto-host`, que corría cada vez que el
 * anfitrión juzgaba a alguien y pagaba al juzgar al último. Ahora que valida
 * el servidor no hay a quién esperar: se llama una sola vez, cuando se cierra
 * la ventana de empates.
 */
async function cerrarRonda(sala) {
    const salaInfo = salas[sala];
    if (!salaInfo) return;

    const ganadoresReales = salaInfo.reclamantes.filter(r => r.status === 'validado');
    if (ganadoresReales.length > 0) {
    const boteTotal = salaInfo.bote;
    const premioPorCabeza = Math.floor(boteTotal / ganadoresReales.length);

    // Lista de IDs ganadores para fácil acceso
    const idsGanadores = ganadoresReales.map(g => g.id);

    // RECORREMOS TODOS LOS JUGADORES PARA ACTUALIZAR RACHAS
    for (const playerId in salaInfo.jugadores) {
        const jugador = salaInfo.jugadores[playerId];

        if (idsGanadores.includes(playerId)) {
            // ES GANADOR: Aumenta racha y da premio
            jugador.racha = (jugador.racha || 0) + 1;
            jugador.monedas += premioPorCabeza;

            // Un bot no tiene cuenta: su premio vuelve a la banca y no se
            // escribe nada. Sin esta rama, `actualizarSaldoUsuario` cae en su
            // camino sin email y crearía un documento en `jugadores` por cada
            // bot que ganase — basura permanente en Firestore.
            if (jugador.esBot) {
                registrarEmisionBanca(-premioPorCabeza, `premio recuperado de ${jugador.nickname}`);
            } else {
                await actualizarSaldoUsuario(jugador);
                // Solo registramos movimiento si tiene email
                if(jugador.email) await registrarMovimiento(jugador.email, 'victoria', premioPorCabeza, `Premio Lotería!`, true);
            }
        } else {
            // PERDEDOR: Se le apaga la flama
            jugador.racha = 0;
        }

        // Resetear apuesta
        jugador.apostado = false;
    }

    // --- POZO ACUMULADO ---
    // Se paga aparte del bote y vacía el acumulado. Solo si el anfitrión
    // lo marcó y esa persona aportó en esta ronda.
    let pozoPagado = 0;
    let quienGanoElPozo = null;
    if (salaInfo.ganadorPozo && idsGanadores.includes(salaInfo.ganadorPozo)) {
        const jug = salaInfo.jugadores[salaInfo.ganadorPozo];
        const monto = salaInfo.pozoAcumulado || 0;
        if (jug && jug.pozoActivo && monto > 0) {
            jug.monedas += monto;
            await actualizarSaldoUsuario(jug);
            if (jug.email) await registrarMovimiento(jug.email, 'premio', monto, '🎰 ¡Se llevó el POZO!', true);
            await moverPozo(salaInfo, -monto);
            pozoPagado = monto;
            quienGanoElPozo = jug.nickname;
        }
    }

    // La ronda terminó: se limpian las aportaciones y los apuntados.
    salaInfo.pozoRonda = {};
    salaInfo.ganadorPozo = null;
    for (const id in salaInfo.jugadores) salaInfo.jugadores[id].pozoActivo = false;

    salaInfo.bote = 0;
    salaInfo.pagoRealizado = true;
    salaInfo.reclamantes = [];
    salaInfo.validandoEmpate = false;

    io.to(sala).emit('ganadores-multiples', {
        ganadores: ganadoresReales.map(g => g.nickname),
        premio: premioPorCabeza,
        // Una por ganador: en un empate se enseñan todas, para que la sala vea
        // con qué ganó cada quien y no tenga que fiarse. Antes había una sola
        // por sala y se guardaba la del primero que gritara.
        pruebas: ganadoresReales.map(g => g.prueba).filter(Boolean),
        pozoGanado: pozoPagado,
        ganadorPozo: quienGanoElPozo
    });
    io.to(sala).emit('pozo-actualizado', salaInfo.pozoAcumulado || 0);
    io.to(sala).emit('jugadores-actualizados', salaInfo.jugadores); // Aquí se envían las nuevas rachas
    io.to(sala).emit('bote-actualizado', 0);
} 
    else {
        salaInfo.validandoEmpate = false;
        salaInfo.reclamantes = [];
        salaInfo.juegoIniciado = true;
        io.to(sala).emit('falsa-alarma-masiva');
        repartirCartas(sala);
    }
}

/**
 * Procesa un grito de lotería, venga de una persona o de un bot.
 *
 * Está fuera del closure de la conexión a propósito: un bot no tiene socket, y
 * si esto viviera dentro habría que duplicar la lógica que decide quién gana —
 * que es justo la que no puede tener dos versiones.
 *
 * `avisar` es cómo se le dice a quien gritó que no tiene nada. Para una persona
 * es un `socket.emit`; para un bot no es nada, porque el bot ya lo sabía y solo
 * grita cuando cree tener figura.
 */
function procesarLoteria(sala, jugadorId, nickname, boardState, avisar = () => {}) {
    const salaInfo = salas[sala];
    if (!salaInfo) return;
    const jugador = salaInfo.jugadores[jugadorId];
    if (!jugador) return;
    if (!salaInfo.juegoIniciado && !salaInfo.validandoEmpate) return;

    // Las barajas de cada carta las pone el SERVIDOR, nunca el cliente. Si se
    // aceptaran las que manda el navegador, bastaría con editar el evento y
    // mandar las barajas que acaban de cantarse.
    //
    // Salen de dos sitios según de quién sea la carta. Las del sistema están en
    // `cartas-sistema.json`, iguales para todos; las compradas se guardaron al
    // seleccionarlas, leídas de Firestore.
    const cartas = {};
    (boardState?.cards || []).forEach(id => {
        const guardadas = jugador.barajasPropias?.[id]
                       || barajasDeCartaSistema(salaInfo.modoJuego, id);
        if (guardadas) cartas[id] = guardadas;
    });

    // AQUÍ decide el servidor, y ya no el anfitrión mirando. Compara las
    // barajas de las cartas con su propio historial de lo cantado.
    const veredicto = evaluarReclamo({
        cartas,
        marcadas: boardState?.marcadas || {},
        historial: salaInfo.historial || [],
        modo: salaInfo.modoJuego
    });

    // Un grito en falso ya no para la partida: se le contesta a quien lo dio y
    // el juego sigue cantando. Antes bastaba con picar el botón de broma para
    // congelar a toda la sala hasta que el anfitrión resolviera.
    if (!veredicto.gano) {
        // `barajaPerdida` va solo cuando se le pasó: es la que cerraba su
        // figura, para poder enseñársela en vez de dejarlo adivinando cuál era.
        avisar(veredicto.motivo, veredicto.barajaPerdida);
        return;
    }

    // La prueba de ESTE ganador viaja con él. Antes había una sola por sala y
    // se guardaba solo la del primero: en un empate, la sala veía una carta y
    // se quedaba sin saber con qué ganaron los demás.
    const reclamante = {
        id: jugadorId, nickname, boardState, status: 'validado', veredicto,
        prueba: {
            tabla: veredicto.carta,
            fichas: boardState?.chips?.[veredicto.carta] || [],
            skin: boardState?.skin || null,
            nickname,
            barajas: cartas[veredicto.carta] || null,
            figura: veredicto.tipo,
            casillas: veredicto.casillas,
            // Con cuál cerró: la de la figura que salió más tarde. Es la que la
            // gente recuerda — «gané con el gallo».
            barajaFinal: veredicto.barajaFinal
        }
    };

    // El pozo acumulado se lleva por llenar las cuatro del centro, y solo si esa
    // persona aportó en esta ronda: quien no se apuntó queda fuera aunque haya
    // ganado la lotería.
    if (veredicto.ganoCentro && jugador.pozoActivo) salaInfo.ganadorPozo = jugadorId;

    if (!salaInfo.validandoEmpate) {
        salaInfo.juegoIniciado = false;
        salaInfo.validandoEmpate = true;
        if (salaInfo.intervaloCartas) clearInterval(salaInfo.intervaloCartas);
        salaInfo.reclamantes.push(reclamante);

        // La pausa se mantiene aunque ya no haya nada que juzgar: es para
        // recoger a quien complete su figura con la MISMA baraja. Sin ella, el
        // primero en reaccionar se llevaría el bote entero por unos milisegundos.
        io.to(sala).emit('pausa-empate', { primerGanador: nickname, tiempo: 4 });
        salaInfo.timerEmpate = setTimeout(() => cerrarRonda(sala), 4000);
    } else if (!salaInfo.reclamantes.find(r => r.id === jugadorId)) {
        salaInfo.reclamantes.push(reclamante);
        io.to(sala).emit('notificar-otro-ganador', nickname);
    }
}

async function actualizarSaldoUsuario(jugador) {
    try {
        if (jugador.email) {
            await db.collection('usuarios').doc(jugador.email).update({ monedas: jugador.monedas });
        } else {
            await db.collection('jugadores').doc(jugador.nickname).set({ monedas: jugador.monedas }, { merge: true });
        }
    } catch (error) { console.error("❌ Error al guardar saldo:", error); }
}


// ==================== SOCKET.IO & CONTADORES EN VIVO ====================

function emitirContadores() {
    let loteriaCount = 0;
    for (let s in salas) loteriaCount += Object.keys(salas[s].jugadores).length;
    let serpientesCount = 0;
    for (let s in salasSerpientes) serpientesCount += salasSerpientes[s].jugadores.filter(j => !j.esBot).length;
    let pirinolaCount = 0;
    for (let s in salasPirinola) pirinolaCount += salasPirinola[s].jugadores.filter(j => !j.esBot).length;

    io.emit('actualizar-contadores', {
        loteria: loteriaCount, serpientes: serpientesCount, pirinola: pirinolaCount,
        total: loteriaCount + serpientesCount + pirinolaCount
    });
}

// 🔑 Handshake: si el cliente manda token en `auth`, dejamos la identidad
// verificada pegada al socket. A partir de ahí ya no importa lo que declare en
// los payloads de cada evento.
io.use((socket, next) => {
    const datos = leerToken(socket.handshake.auth?.token);
    socket.data.email = datos?.email || null;
    socket.data.esAdmin = !!datos?.esAdmin;
    next(); // Nunca rechazamos: durante la convivencia los clientes viejos siguen entrando.
});

/**
 * Identidad efectiva de un evento de socket: manda la del handshake; si no hay,
 * se acepta la que declare el payload (y se cuenta), salvo en modo estricto.
 */
function emailDeSocket(socket, emailDeclarado, etiqueta) {
    if (socket.data.email) return socket.data.email;
    if (MODO_ESTRICTO) return null;
    if (!emailDeclarado) return null;
    anotarUsoHeredado(`socket ${etiqueta}`);
    return emailDeclarado;
}

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);
  emitirContadores();

  // --- GENERAL ---
  socket.on('solicitar-info-usuario', async (email) => {
      email = emailDeSocket(socket, email, 'solicitar-info-usuario');
      if (!email) return;
      try {
          const doc = await db.collection('usuarios').doc(email).get();
          if (doc.exists) socket.emit('usuario-actualizado', perfilPublico(doc.data()));
      } catch (e) { console.error(e); }
  });

  // --- LOTERIA ---
  socket.on('unirse-sala', async ({ nickname, email, sala, modo }) => {
    email = emailDeSocket(socket, email, 'unirse-sala');
    socket.join(sala);
    
    // Configuración Inicial de la Sala
    if (!salas[sala]) {
      const modoSeleccionado = modo || 'tradicional';
      const config = MODOS_JUEGO[modoSeleccionado];
      
      salas[sala] = {
        jugadores: {}, 
        baraja: [], 
        historial: [], 
        juegoIniciado: false, 
        bote: 0,
        hostId: socket.id, 
        intervaloCartas: null, 
        
        // GUARDAMOS DATOS DEL MODO
        modoJuego: modoSeleccionado,
        costoCarta: config.costo, 
        
        reclamantes: [],
        validandoEmpate: false,
        timerEmpate: null,
        silenciados: [],

        // Pozo acumulado: atado a la sala Y a quien la creó.
        nombre: sala,
        creador: email || null,
        pozoId: email ? idPozo(sala, email) : null,
        pozoAcumulado: 0,
        pozoRonda: {}       // { correo: monto aportado en la ronda en curso }
      };
      socket.emit('rol-asignado', { host: true });

      // Rescatamos lo que quedó acumulado de sesiones anteriores.
      leerPozo(salas[sala]).then(monto => {
          salas[sala].pozoAcumulado = monto;
          io.to(sala).emit('pozo-actualizado', monto);
      });
    } else {
      socket.emit('rol-asignado', { host: (socket.id === salas[sala].hostId) });
    }

    // Si esta consulta falla, el jugador NO debe quedarse fuera de la sala: antes
    // el await sin proteger abortaba el resto del handler y la persona aparecía
    // conectada pero invisible para todos, sin ningún error a la vista. Se entra
    // con el saldo por defecto y el siguiente 'usuario-actualizado' lo corrige.
    let monedasIniciales = 20;
    if (email) {
        try {
            const d = await db.collection('usuarios').doc(email).get();
            if (d.exists) monedasIniciales = d.data().monedas;
        } catch (e) {
            console.error(`No se pudo leer el saldo de ${email} al entrar a la sala:`, e.message);
        }
    }

    salas[sala].jugadores[socket.id] = { 
        nickname, email, monedas: monedasIniciales, apostado: false, cartas: [], id: socket.id, host: (socket.id === salas[sala].hostId), 
    racha: 0
    };

    // LE DECIMOS AL CLIENTE QUÉ MODO ES (Para que cargue las imágenes correctas)
    //
    // Va SOLO a quien acaba de entrar. Antes se mandaba a toda la sala, y como
    // el cliente reacciona regenerando el tablero de selección, cada vez que
    // llegaba alguien los demás perdían de vista sus tablas marcadas y su botón
    // de apostar volvía a "Selecciona cartas" aunque ya hubieran elegido.
    // El modo y el costo no cambian cuando entra gente, así que nadie más
    // necesita enterarse.
    socket.emit('info-sala', {
        modo: salas[sala].modoJuego,
        costo: salas[sala].costoCarta,
        // Las cartas del modo viajan aquí, con sus barajas, para que el cliente
        // pinte la pantalla de selección. Son unos 2 KB de números; mandarlas
        // con el resto de la información de la sala evita otro viaje de ida y
        // vuelta justo cuando la persona está esperando a ver algo.
        //
        // Que el cliente las conozca no es un problema: son públicas, las mismas
        // para todos, y quien gana se decide con las que tiene el servidor.
        cartas: cartasDelModo(salas[sala].modoJuego)
    });

    const cartasOcupadas = Object.values(salas[sala].jugadores).flatMap(j => j.cartas);
    io.to(sala).emit('cartas-desactivadas', cartasOcupadas);
    io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
    io.to(sala).emit('bote-actualizado', salas[sala].bote);
    io.to(sala).emit('historial-actualizado', salas[sala].historial);
    socket.emit('silenciados-actualizados', salas[sala].silenciados || []);
    socket.emit('pozo-actualizado', salas[sala].pozoAcumulado || 0);
    emitirContadores();
  });

  /** Prefijo con el que viajan las cartas compradas por el jugador. */
  const PREFIJO_PROPIA = 'propia:';
  const esPropia = (id) => typeof id === 'string' && id.startsWith(PREFIJO_PROPIA);

  /**
   * Las que se apartan para que nadie repita.
   *
   * Solo las 53 de siempre: esas son las mismas para todo el mundo. Una carta
   * comprada es de una sola persona, así que apartarla no tendría sentido — y
   * además su id revelaría a los demás qué cartas tiene.
   */
  const cartasQueSeApartan = (salaInfo) =>
      Object.values(salaInfo.jugadores).flatMap(j => j.cartas).filter(c => !esPropia(c));

  socket.on('seleccionar-carta', async ({ carta, sala }) => {
    const salaInfo = salas[sala];
    if (!salaInfo || !salaInfo.jugadores[socket.id]) return;

    const jugador = salaInfo.jugadores[socket.id];
    if (jugador.cartas.length >= 4 || jugador.cartas.includes(carta)) return;

    // Una carta propia hay que comprobarla: que exista y que sea de quien dice.
    // Sin esto, cualquiera manda `propia:loquesea` y luego, al gritar lotería,
    // envía las barajas que le convengan — las que acaban de cantarse, por
    // ejemplo. Las barajas se guardan AQUÍ, leídas de Firestore, y son las que
    // se usan para validar: las que mande el cliente se ignoran.
    if (esPropia(carta)) {
      const email = emailDeSocket(socket, null, 'seleccionar-carta');
      if (!email) return;

      try {
        const idTabla = carta.slice(PREFIJO_PROPIA.length);
        const doc = await db.collection('usuarios').doc(email)
            .collection('tablas').doc(idTabla).get();
        if (!doc.exists) {
          console.warn(`⚠️ ${email} intentó usar una carta que no es suya: ${carta}`);
          return socket.emit('error-apuesta', 'Esa carta no es tuya');
        }
        if (!jugador.barajasPropias) jugador.barajasPropias = {};
        jugador.barajasPropias[carta] = doc.data().cartas;
      } catch (e) {
        console.error('Error comprobando carta propia:', e);
        return;
      }
    }

    jugador.cartas.push(carta);
    io.to(sala).emit('cartas-desactivadas', cartasQueSeApartan(salaInfo));
  });

  socket.on('deseleccionar-carta', ({ carta, sala }) => {
    const salaInfo = salas[sala];
    if (salaInfo && salaInfo.jugadores[socket.id]) {
      const jugador = salaInfo.jugadores[socket.id];
      jugador.cartas = jugador.cartas.filter(c => c !== carta);
      if (jugador.barajasPropias) delete jugador.barajasPropias[carta];
      io.to(sala).emit('cartas-desactivadas', cartasQueSeApartan(salaInfo));
    }
  });

// --- RECONEXIÓN INTELIGENTE (ANTI-F5) ---
  socket.on('reconectar', ({ sala, email }) => {
      if (!salas[sala]) return;

      // Unir el nuevo socket al canal de comunicación
      socket.join(sala);

      // Buscar si este email ya estaba jugando en esa sala
      let socketIdViejo = null;
      let datosJugador = null;

      for (const [id, jugador] of Object.entries(salas[sala].jugadores)) {
          if (jugador.email === email) {
              socketIdViejo = id;
              datosJugador = jugador;
              break;
          }
      }

      if (datosJugador && socketIdViejo) {
          // INTERCAMBIO DE IDENTIDAD: Borramos el ID viejo y ponemos el nuevo
          delete salas[sala].jugadores[socketIdViejo];
          
          datosJugador.id = socket.id; // Actualizamos al nuevo ID
          salas[sala].jugadores[socket.id] = datosJugador;

          console.log(`🔄 Usuario reconectado: ${datosJugador.nickname} en sala ${sala}`);

          // Si era el Host, le devolvemos la corona
          if (salas[sala].hostId === socketIdViejo) {
              salas[sala].hostId = socket.id;
              socket.emit('rol-asignado', { host: true });
          } else {
              socket.emit('rol-asignado', { host: false });
          }

          // La información de la sala va ANTES que el tablero, y el orden
          // importa: aquí viajan las cartas del modo con sus barajas, y sin
          // ellas el cliente no sabe pintar nada. Al recargar la página se
          // pierde todo lo que tenía en memoria.
          //
          // Antes no hacía falta porque una carta era un JPG y su nombre bastaba
          // para pedirla. Eso escondía un fallo: al recargar en una sala de
          // Pozo, el modo volvía al valor por defecto y se pintaban las cartas
          // del set que no era.
          socket.emit('info-sala', {
              modo: salas[sala].modoJuego,
              costo: salas[sala].costoCarta,
              cartas: cartasDelModo(salas[sala].modoJuego)
          });

          // LE DEVOLVEMOS SU TABLERO (Estado Restaurado)
          // Esto hace que el frontend vuelva a pintar sus cartas seleccionadas
          socket.emit('estado-sala-restaurado', {
              enJuego: salas[sala].juegoIniciado,
              cartas: datosJugador.cartas || [],
              apostado: datosJugador.apostado || false,
              monedas: datosJugador.monedas || 0
          });

          // Avisamos a todos que "revivió"
          io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
      }
  });

  // --- APOSTAR (CORREGIDO: COBRO POR CARTA) ---
  socket.on('apostar', async (data) => {
    // El payload lo manda el cliente: puede venir null o no ser un objeto.
    if (!data || typeof data !== 'object') return;

    const sala = data.sala;
    const email = emailDeSocket(socket, data.email, 'apostar');
    
    if (salas[sala] && !salas[sala].juegoIniciado) {
        const jugador = salas[sala].jugadores[socket.id];

        // Si el socket no está registrado en esta sala, jugador es undefined.
        // Sin esta guarda, la línea de abajo lanza TypeError y tumba el proceso.
        if (!jugador || !Array.isArray(jugador.cartas)) return;

        // 1. Verificamos que tenga cartas seleccionadas
        const numCartas = jugador.cartas.length;
        if (numCartas === 0) return; // No puede apostar si no eligió cartas

        // 2. Calculamos el TOTAL: Costo de la sala x Número de cartas
        const costoUnitario = salas[sala].costoCarta || 1;
        const costoTotal = costoUnitario * numCartas;
        
        // El pozo es opcional y cuesta $1 aparte de la apuesta. Solo se puede
        // entrar en Tradicional y solo si la sala tiene pozo (la creó alguien
        // con correo, que es de donde sale su identificador).
        const quierePozo = !!data.conPozo
            && salas[sala].modoJuego === 'tradicional'
            && !!salas[sala].pozoId
            && !!email;
        const costoPozo = quierePozo ? 1 : 0;

        // 3. Verificamos si le alcanza para EL TOTAL
        //
        // Si no alcanza hay que DECIRLO. Antes esta condición simplemente no se
        // cumplía y el evento moría en silencio: el navegador ya había hecho
        // volar las monedas, así que se veía la animación, el bote no subía y
        // no aparecía ningún aviso. Parecía que el juego se había colgado.
        if (jugador.apostado) {
            socket.emit('apuesta-rechazada', { motivo: 'Ya apostaste esta ronda.' });
            return;
        }
        if (jugador.monedas < costoTotal + costoPozo) {
            const falta = (costoTotal + costoPozo) - jugador.monedas;
            socket.emit('apuesta-rechazada', {
                motivo: costoPozo
                    ? `No te alcanza: ${numCartas} cartas cuestan $${costoTotal} y el pozo $${costoPozo}. Te faltan $${falta}.`
                    : `No te alcanza: ${numCartas} cartas cuestan $${costoTotal}. Te faltan $${falta}.`
            });
            // Se reenvía la lista para que el saldo del navegador vuelva a la
            // realidad: acaba de pintar monedas volando que no salieron.
            socket.emit('jugadores-actualizados', salas[sala].jugadores);
            return;
        }

        if (jugador && !jugador.apostado && jugador.monedas >= costoTotal + costoPozo) {
            jugador.monedas -= (costoTotal + costoPozo);
            jugador.apostado = true;
            jugador.cantidadApostada = costoTotal;
            salas[sala].bote += costoTotal;

            if (costoPozo) {
                // Se lleva la cuenta POR CORREO, no por socket: si a alguien se
                // le va el internet y vuelve, su socket cambia pero su aportación
                // tiene que seguir siendo suya.
                jugador.pozoActivo = true;
                salas[sala].pozoRonda[email] = (salas[sala].pozoRonda[email] || 0) + costoPozo;
                await moverPozo(salas[sala], costoPozo);
                io.to(sala).emit('pozo-actualizado', salas[sala].pozoAcumulado);
            }

            if (email) {
                await db.collection('usuarios').doc(email).update({ monedas: jugador.monedas });
                // Registramos el movimiento con el detalle del cálculo
                await registrarMovimiento(email, 'apuesta', costoTotal, `Apuesta ${salas[sala].modoJuego} (${numCartas} cartas)`, false);
                if (costoPozo) await registrarMovimiento(email, 'apuesta', costoPozo, 'Aporte al pozo acumulado', false);
            }

            io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
            io.to(sala).emit('bote-actualizado', salas[sala].bote);
            io.to(sala).emit("reproducir-sonido-apuesta");
        }
    }
  });

  socket.on('iniciar-juego', (data) => {
    const sala = (typeof data === 'object') ? data.sala : data;
    const velocidad = (typeof data === 'object' && data.velocidad) ? parseInt(data.velocidad) : 3000;
    
    if (salas[sala] && socket.id === salas[sala].hostId) {
      if (!salas[sala].juegoIniciado) {
        
        // 1. Preparar la mesa (Barajear)
        salas[sala].baraja = mezclarBaraja();
        salas[sala].historial = [];
        salas[sala].juegoIniciado = true;
        salas[sala].pagoRealizado = false;
        salas[sala].velocidad = velocidad;
        salas[sala].reclamantes = [];
        salas[sala].validandoEmpate = false;
        salas[sala].pausado = false;
        
        if(salas[sala].timerEmpate) clearTimeout(salas[sala].timerEmpate);
        
        // Los bots ponen su apuesta justo aquí, cuando ya nadie va a cambiar
        // de carta. El dinero sale de la BANCA: un bot no tiene cuenta, así que
        // esto no se escribe en Firestore, solo engorda el bote.
        const puestoPorBots = bots.apostarBots(
            salas[sala],
            cartasDelModo(salas[sala].modoJuego).map(c => c.id)
        );
        if (puestoPorBots > 0) {
            registrarEmisionBanca(puestoPorBots, 'apuesta de bots');
            io.to(sala).emit('bote-actualizado', salas[sala].bote);
        }

        // 2. Avisar que arranca
        io.to(sala).emit('juego-iniciado');
        
        // 🔥🔥 ESTA ES LA LÍNEA QUE TE FALTA 🔥🔥
        // Enviamos la lista actualizada para que se vea la FLAMA desde el inicio
        io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores); 

        io.to(sala).emit('campana');
        
        // 3. Secuencia de arranque
        setTimeout(() => { if(salas[sala]?.juegoIniciado) io.to(sala).emit('corre'); }, 2000);
        
        // OJO: Aquí tu función se llama 'repartirCartas', pero en realidad es 'iniciarCanto'
        setTimeout(() => { if(salas[sala]?.juegoIniciado) repartirCartas(sala); }, 2000); 
      }
    }
});

  /**
   * Pausa el canto sin tocar nada más.
   *
   * `juegoIniciado` se pone en false porque es lo que mira el intervalo para
   * cortarse, pero la BARAJA y el HISTORIAL se quedan como están: eso es lo que
   * permite reanudar por donde iba. Reiniciar aquí obligaría a barajear de nuevo
   * y la partida se perdería.
   */
  socket.on('detener-juego', (sala) => {
    if (salas[sala] && socket.id === salas[sala].hostId) {
      salas[sala].juegoIniciado = false;
      salas[sala].pausado = true;
      if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);
      io.to(sala).emit('juego-detenido');
    }
  });

  /**
   * Sigue cantando desde donde se quedó.
   *
   * Solo si la partida estaba PAUSADA: si no, este evento serviría para arrancar
   * una sin barajear ni cobrar, saltándose todo lo que hace 'iniciar-juego'.
   */
  socket.on('reanudar-juego', (sala) => {
    const salaInfo = salas[sala];
    if (!salaInfo || socket.id !== salaInfo.hostId) return;
    if (!salaInfo.pausado || salaInfo.juegoIniciado) return;
    if (!salaInfo.baraja || salaInfo.baraja.length === 0) return;

    salaInfo.juegoIniciado = true;
    salaInfo.pausado = false;
    io.to(sala).emit('juego-reanudado');
    io.to(sala).emit('corre');
    repartirCartas(sala);
  });

  socket.on('barajear', (sala) => {
    if (salas[sala] && socket.id === salas[sala].hostId) {
      salas[sala].baraja = mezclarBaraja();
      salas[sala].historial = [];
      io.to(sala).emit('barajear');
    }
  });

  socket.on('reiniciar-partida', (sala) => {
    if (salas[sala] && socket.id === salas[sala].hostId) {
      salas[sala].juegoIniciado = false;
      salas[sala].historial = [];
      salas[sala].bote = 0;
      salas[sala].pagoRealizado = false;
      salas[sala].reclamantes = [];
      salas[sala].validandoEmpate = false;
      if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);
      for (const id in salas[sala].jugadores) {
        salas[sala].jugadores[id].apostado = false;
        salas[sala].jugadores[id].cartas = [];
        salas[sala].jugadores[id].pozoActivo = false;
      }
      // Lo ya aportado NO se devuelve: se queda para la siguiente ronda.
      salas[sala].pozoRonda = {};
      io.to(sala).emit('partida-reiniciada');
      io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
      io.to(sala).emit('bote-actualizado', 0);
    }
  });

  /**
   * El anfitrión suma un bot a su sala.
   *
   * Solo el anfitrión, y solo antes de empezar: un bot que entra a media
   * partida no ha visto las barajas anteriores y jugaría con una carta que ya
   * nace perdida.
   */
  socket.on('agregar-bot', ({ sala, nivel }) => {
      const salaInfo = salas[sala];
      if (!salaInfo || socket.id !== salaInfo.hostId) return;

      const r = bots.agregarBot(salaInfo, nivel || 'normal');
      if (!r.ok) {
          socket.emit('bot-rechazado', { motivo: r.motivo });
          return;
      }
      io.to(sala).emit('jugadores-actualizados', salaInfo.jugadores);
  });

  socket.on('quitar-bot', ({ sala, id }) => {
      const salaInfo = salas[sala];
      if (!salaInfo || socket.id !== salaInfo.hostId) return;
      if (salaInfo.juegoIniciado) return;

      // Lo que tenía apostado se devuelve al bote, o mejor dicho se le quita:
      // era dinero de la banca y no puede quedarse en un bote que ya no le
      // corresponde.
      const bot = salaInfo.jugadores[id];
      if (bot && bot.esBot && bot.apostado) {
          salaInfo.bote = Math.max(0, salaInfo.bote - (bot.cantidadApostada || 0));
          registrarEmisionBanca(-(bot.cantidadApostada || 0), 'bot retirado antes de jugar');
          io.to(sala).emit('bote-actualizado', salaInfo.bote);
      }

      if (bots.quitarBot(salaInfo, id)) {
          io.to(sala).emit('jugadores-actualizados', salaInfo.jugadores);
          io.to(sala).emit('cartas-desactivadas', cartasQueSeApartan(salaInfo));
      }
  });

  socket.on('loteria', ({ nickname, sala, boardState }) => {
    procesarLoteria(sala, socket.id, nickname, boardState,
        (motivo, baraja) => socket.emit('loteria-rechazada', { motivo, baraja }));
  });

  socket.on('salir-sala', async (sala) => {
    if (salas[sala] && salas[sala].jugadores[socket.id]) {
        await procesarReembolsoPorSalida(sala, socket.id);
        const eraHost = (salas[sala].hostId === socket.id);
        socket.leave(sala);
        delete salas[sala].jugadores[socket.id];
        // Una sala donde solo quedan bots está vacía: no hay nadie a quien
        // enseñarle la partida. Se cierra igual que si no quedara nadie.
        const humanos = Object.values(salas[sala].jugadores).filter(j => !j.esBot);
        if (humanos.length === 0) {
            if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);
            // Los relojes de los bots sobreviven a la sala si no se paran: al
            // dispararse buscarían un objeto que ya no existe.
            bots.pararBots(salas[sala]);
            delete salas[sala];
        } else {
            if (eraHost) {
                // El anfitrión nuevo tiene que ser una persona: un bot no puede
                // iniciar la partida ni añadir a nadie, y la sala se quedaría
                // congelada esperando a que hiciera algo.
                const nuevoHostId = Object.values(salas[sala].jugadores)
                    .filter(j => !j.esBot)[0]?.id;
                if (nuevoHostId) {
                    salas[sala].hostId = nuevoHostId;
                    salas[sala].jugadores[nuevoHostId].host = true;
                    io.to(nuevoHostId).emit('rol-asignado', { host: true });
                }
            }
            const cartasOcupadas = Object.values(salas[sala].jugadores).flatMap(j => j.cartas);
            io.to(sala).emit('cartas-desactivadas', cartasOcupadas);
            io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
            io.to(sala).emit('bote-actualizado', salas[sala].bote);
        }
    }
    emitirContadores();
  });

  socket.on("enviar-efecto-sonido", ({ sala, soundId, emisor }) => {
      const salaInfo = salas[sala];
      if (!salaInfo) return;

      // El tablero de sonidos es divertido hasta que alguien lo usa de metralla.
      // El silencio es por partida y por jugador, y lo decide el anfitrión.
      const quien = salaInfo.jugadores[socket.id];
      if (quien && salaInfo.silenciados && salaInfo.silenciados.includes(quien.email)) {
          // Se le confirma a él solo, para que no crea que la app se trabó.
          socket.emit("estas-silenciado");
          return;
      }

      io.to(sala).emit("reproducir-efecto-sonido", { soundId, emisor });
  });

  socket.on("silenciar-jugador", ({ sala, email, silenciar }) => {
      const salaInfo = salas[sala];
      if (!salaInfo || socket.id !== salaInfo.hostId) return;   // solo el anfitrión
      if (!email) return;

      if (!salaInfo.silenciados) salaInfo.silenciados = [];

      if (silenciar) {
          if (!salaInfo.silenciados.includes(email)) salaInfo.silenciados.push(email);
      } else {
          salaInfo.silenciados = salaInfo.silenciados.filter(e => e !== email);
      }

      // Se avisa a toda la sala para que la lista de jugadores muestre el estado.
      io.to(sala).emit("silenciados-actualizados", salaInfo.silenciados);
      io.to(sala).emit('jugadores-actualizados', salaInfo.jugadores);
  });


// =========================================================
  // 🛒 TIENDA GENERAL (LOTERÍA: SONIDOS Y FICHAS) 🛒
  // =========================================================

  // =========================================================
  // TABLAS GENERADAS
  // =========================================================
  // Las tablas que se venden en packs. Se generan AQUÍ, nunca en el navegador:
  // si el cliente decidiera qué lleva su tabla, el día que el servidor valide
  // las loterías solo, cualquiera se haría una con las cartas ya cantadas.

  socket.on('solicitar-mis-tablas', async () => {
      const email = emailDeSocket(socket, null, 'solicitar-mis-tablas');
      if (!email) return;
      try {
          socket.emit('mis-tablas', await tablasDe(email));
      } catch (e) {
          console.error('Error leyendo tablas:', e);
      }
  });

  socket.on('comprar-tablas-personalizadas', async ({ tablas, modo }) => {
      const email = emailDeSocket(socket, null, 'comprar-tablas-personalizadas');
      if (!email) return;

      if (!Array.isArray(tablas) || tablas.length !== TABLAS_PERSONALIZADAS.cuantas) {
          return socket.emit('error-pack',
              `Hay que armar las ${TABLAS_PERSONALIZADAS.cuantas} tablas`);
      }

      // El navegador ya avisa mientras se arman, pero eso es comodidad: este
      // evento se puede mandar a mano desde la consola. Aquí se revisan TODAS
      // otra vez, porque de esto depende que sean jugables.
      const revisadas = [];
      for (const cartas of tablas) {
          const revision = generador.validarTablaManual(cartas, modo);
          if (!revision.ok) return socket.emit('error-pack', revision.motivo);
          revisadas.push(revision.cartas);
      }

      const firmas = revisadas.map(generador.firmaDeTabla);
      if (new Set(firmas).size !== firmas.length) {
          return socket.emit('error-pack', 'Las dos tablas tienen las mismas cartas');
      }

      try {
          const yaTiene = await tablasDe(email);
          if (yaTiene.length + TABLAS_PERSONALIZADAS.cuantas > TOPE_TABLAS_POR_USUARIO) {
              return socket.emit('error-pack',
                  `Ya tienes ${yaTiene.length} tablas. El máximo son ${TOPE_TABLAS_POR_USUARIO}.`);
          }
          if (firmas.some(f => yaTiene.some(t => t.firma === f))) {
              return socket.emit('error-pack', 'Ya tienes una tabla con esas mismas cartas');
          }

          // Un solo cobro por las dos: se arman antes de pagar, así no hay
          // tablas pagadas a medias esperando a que alguien vuelva.
          const userRef = db.collection('usuarios').doc(email);
          await db.runTransaction(async (t) => {
              const doc = await t.get(userRef);
              if (!doc.exists) throw new Error('Usuario no existe');
              if ((doc.data().monedas || 0) < TABLAS_PERSONALIZADAS.precio) throw new Error('SALDO');
              t.update(userRef, {
                  monedas: admin.firestore.FieldValue.increment(-TABLAS_PERSONALIZADAS.precio)
              });
          });

          const lote = db.batch();
          revisadas.forEach((cartas, i) => {
              lote.set(userRef.collection('tablas').doc(), {
                  cartas,
                  modo,
                  firma: firmas[i],
                  personalizada: true,
                  creada: admin.firestore.FieldValue.serverTimestamp()
              });
          });
          await lote.commit();

          await registrarMovimiento(email, 'compra', TABLAS_PERSONALIZADAS.precio,
              `${TABLAS_PERSONALIZADAS.cuantas} tablas a la carta (${modo})`, false);

          socket.emit('usuario-actualizado', perfilPublico((await userRef.get()).data()));
          socket.emit('mis-tablas', await tablasDe(email));
          socket.emit('tablas-personalizadas-creadas', { cuantas: revisadas.length });

      } catch (e) {
          if (e.message === 'SALDO') {
              return socket.emit('error-pack', `Necesitas $${TABLAS_PERSONALIZADAS.precio} monedas`);
          }
          console.error('Error creando tablas personalizadas:', e);
          socket.emit('error-pack', 'No se pudieron crear las tablas');
      }
  });

  socket.on('comprar-pack-tablas', async ({ modo }) => {
      const email = emailDeSocket(socket, null, 'comprar-pack-tablas');
      if (!email) return;

      // El modo lo elige quien compra, pero de una lista cerrada: con uno
      // inventado, generarTabla lanzaría y la compra quedaría a medias.
      if (!generador.MODOS.includes(modo)) {
          return socket.emit('error-pack', 'Ese tipo de tablas no existe');
      }

      try {
          const yaTiene = await tablasDe(email);
          if (yaTiene.length + PACK_TABLAS.cuantas > TOPE_TABLAS_POR_USUARIO) {
              return socket.emit('error-pack',
                  `Ya tienes ${yaTiene.length} tablas. El máximo son ${TOPE_TABLAS_POR_USUARIO}.`);
          }

          // El cobro va en transacción, como el resto de compras: sin ella, dos
          // clics seguidos cobran una vez y entregan dos packs.
          const userRef = db.collection('usuarios').doc(email);
          await db.runTransaction(async (t) => {
              const doc = await t.get(userRef);
              if (!doc.exists) throw new Error('Usuario no existe');
              if ((doc.data().monedas || 0) < PACK_TABLAS.precio) throw new Error('SALDO');
              t.update(userRef, {
                  monedas: admin.firestore.FieldValue.increment(-PACK_TABLAS.precio)
              });
          });

          // Ya cobrado: se generan y se guardan. Las nuevas no repiten ninguna
          // de las que ya tenía.
          const firmas = yaTiene.map(t => t.firma).filter(Boolean);
          const nuevas = generador.generarPack(PACK_TABLAS.cuantas, modo, firmas);

          const lote = db.batch();
          nuevas.forEach(cartas => {
              const ref = userRef.collection('tablas').doc();
              lote.set(ref, {
                  cartas,
                  modo,
                  firma: generador.firmaDeTabla(cartas),
                  creada: admin.firestore.FieldValue.serverTimestamp()
              });
          });
          await lote.commit();

          await registrarMovimiento(email, 'compra', PACK_TABLAS.precio,
              `Pack de ${PACK_TABLAS.cuantas} tablas (${modo})`, false);

          socket.emit('usuario-actualizado', perfilPublico((await userRef.get()).data()));
          socket.emit('mis-tablas', await tablasDe(email));
          socket.emit('pack-comprado', { cuantas: PACK_TABLAS.cuantas, modo });

      } catch (e) {
          if (e.message === 'SALDO') {
              return socket.emit('error-pack', `Necesitas $${PACK_TABLAS.precio} monedas`);
          }
          console.error('Error comprando pack:', e);
          socket.emit('error-pack', 'No se pudo completar la compra');
      }
  });

  socket.on('comprar-item', async ({ email, itemId }) => {
      email = emailDeSocket(socket, email, 'comprar-item');
      if (!email || !itemId) return;

      // El precio sale del catálogo, nunca del cliente. Un `precio` en el evento
      // se ignora. Ojo con el 0: es válido (hay artículos gratis), así que se
      // comprueba la EXISTENCIA de la clave, no que el valor sea verdadero.
      if (!Object.prototype.hasOwnProperty.call(CATALOGO_ITEMS, itemId)) {
          console.warn(`⚠️ Compra rechazada: item inexistente (${itemId}) pedido por ${email}`);
          return socket.emit('error-compra', 'Ese artículo no existe');
      }
      const precio = CATALOGO_ITEMS[itemId];

      try {
          const userRef = db.collection('usuarios').doc(email);

          await db.runTransaction(async (t) => {
              const doc = await t.get(userRef);
              if (!doc.exists) throw "Usuario no existe";

              const data = doc.data();
              const saldoActual = data.monedas || 0;
              const inventario = data.inventario || [];

              // Validaciones
              if (saldoActual < precio) throw "Saldo insuficiente";
              if (inventario.includes(itemId)) throw "Ya tienes este item";

              // Ejecutar compra
              const nuevoSaldo = saldoActual - precio;
              const nuevoInventario = [...inventario, itemId];

              t.update(userRef, { 
                  monedas: nuevoSaldo, 
                  inventario: nuevoInventario 
              });

              // Registrar en Historial (Dentro de la transacción para seguridad)
              const historialRef = userRef.collection('historial').doc();
              t.set(historialRef, {
                  tipo: 'compra',
                  monto: precio,
                  descripcion: `Compra: ${itemId}`, // Ej: "Compra: skin_bitcoin"
                  esIngreso: false,
                  fecha: admin.firestore.FieldValue.serverTimestamp()
              });
          });

          // Éxito: Enviamos datos actualizados al cliente
          const docActualizado = await userRef.get();
          socket.emit('usuario-actualizado', perfilPublico(docActualizado.data()));
          
          // Opcional: Feedback específico
          socket.emit('compra-exitosa', { itemId });

      } catch (e) {
          console.error("Error en compra:", e);
          // Podrías emitir un error al cliente si quisieras
          // socket.emit('error-compra', e);
      }
  });

 // =========================================================
  // 🐍 BLOQUE SERPIENTES Y ESCALERAS (PRIVADO + PÚBLICO) 🐍
  // =========================================================

  // --- TIENDA DE SKINS (Igual que antes) ---
  socket.on('comprar-skin', async ({ email, itemId }) => {
      email = emailDeSocket(socket, email, 'comprar-skin');
      if (!email) return;

      if (!Object.prototype.hasOwnProperty.call(CATALOGO_ITEMS, itemId)) {
          console.warn(`⚠️ Compra rechazada: skin inexistente (${itemId}) pedida por ${email}`);
          return;
      }
      const precio = CATALOGO_ITEMS[itemId];

      try {
          const userRef = db.collection('usuarios').doc(email);
          await db.runTransaction(async (t) => {
              const doc = await t.get(userRef);
              if (!doc.exists) return;
              const data = doc.data();
              if ((data.monedas || 0) < precio) return;
              if ((data.inventario || []).includes(itemId)) return;
              t.update(userRef, { monedas: data.monedas - precio, inventario: admin.firestore.FieldValue.arrayUnion(itemId) });
          });
          const docFinal = await userRef.get();
          socket.emit('usuario-actualizado', perfilPublico(docFinal.data()));
          await registrarMovimiento(email, 'compra', precio, `Skin: ${itemId}`, false);
      } catch (e) { console.error("Error compra skin:", e); }
  });

  // --- 1. ENTRADA PÚBLICA (MATCHMAKING) ---
  socket.on('entrar-serpientes', async ({ email, nickname, apuesta, vsCpu, skin }) => {
      email = emailDeSocket(socket, email, 'entrar-serpientes');
      if (!email) return socket.emit('error-apuesta', 'Sesión no válida');
      // Anti-Ghost
      for (const sId in salasSerpientes) { if (salasSerpientes[sId].jugadores.some(j => j.id === socket.id)) return; }

      // Sin esta guarda, una apuesta negativa se convertía en increment(+monto):
      // en vez de cobrar, regalaba monedas.
      const monto = montoApuestaValido(apuesta);
      if (!monto) return socket.emit('error-apuesta', 'Apuesta no válida');
      const userRef = db.collection('usuarios').doc(email);
      const doc = await userRef.get();
      if (!doc.exists || doc.data().monedas < monto) return socket.emit('error-apuesta', 'Saldo insuficiente');

      await userRef.update({ monedas: admin.firestore.FieldValue.increment(-monto) });
      await registrarMovimiento(email, 'apuesta', monto, 'Serpientes Publica', false);
      socket.emit('usuario-actualizado', perfilPublico((await userRef.get()).data()));

      let salaId = null;

      if (vsCpu) {
          salaId = `cpu_${socket.id}_${Date.now()}`;
          // El bote es el doble de la apuesta: el jugador pone una y la casa
          // pone la otra. Esa segunda mitad no sale de ninguna cuenta, así que
          // la contabilizamos como emisión para poder vigilarla.
          salasSerpientes[salaId] = {
              id: salaId, apuesta: monto, jugadores: [], turnoIndex: 0,
              enJuego: false, bote: monto * 2, esVsCpu: true, esPrivada: false
          };
          registrarEmisionBanca(monto, 'Ante de la banca en Serpientes');
      } else {
          // Buscar Pública
          salaId = Object.keys(salasSerpientes).find(id => 
              !salasSerpientes[id].esVsCpu && 
              !salasSerpientes[id].esPrivada &&
              salasSerpientes[id].apuesta === monto && 
              salasSerpientes[id].jugadores.length < 4 && 
              !salasSerpientes[id].enJuego
          );

          if (!salaId) {
              salaId = `mesa_${monto}_${Date.now().toString().slice(-4)}`;
              salasSerpientes[salaId] = {
                  id: salaId, apuesta: monto, jugadores: [], turnoIndex: 0, 
                  enJuego: false, bote: 0, esVsCpu: false, esPrivada: false
              };
          }
      }
      
      unirseSalaSerpientesLogica(socket, salaId, email, nickname, monto, vsCpu, skin);
  });

  // --- 2. CREAR SALA PRIVADA ---
  socket.on('crear-sala-serpientes', async ({ email, nickname, apuesta, skin }) => {
      email = emailDeSocket(socket, email, 'crear-sala-serpientes');
      if (!email) return socket.emit('error-apuesta', 'Sesión no válida');
      // Sin esta guarda, una apuesta negativa se convertía en increment(+monto):
      // en vez de cobrar, regalaba monedas.
      const monto = montoApuestaValido(apuesta);
      if (!monto) return socket.emit('error-apuesta', 'Apuesta no válida');
      const userRef = db.collection('usuarios').doc(email);
      const doc = await userRef.get();
      if (!doc.exists || doc.data().monedas < monto) return socket.emit('error-apuesta', 'Saldo insuficiente');

      await userRef.update({ monedas: admin.firestore.FieldValue.increment(-monto) });
      await registrarMovimiento(email, 'apuesta', monto, 'Crear Mesa Serpientes', false);
      socket.emit('usuario-actualizado', perfilPublico((await userRef.get()).data()));

      const codigo = (1000 + alAzar(9000)).toString();
      const salaId = `privada_s_${codigo}`;

      salasSerpientes[salaId] = {
          id: salaId, codigo: codigo, apuesta: monto, bote: 0, jugadores: [], 
          turnoIndex: 0, enJuego: false, esVsCpu: false, esPrivada: true, hostId: socket.id
      };

      unirseSalaSerpientesLogica(socket, salaId, email, nickname, monto, false, skin);
  });

  // --- 3. UNIRSE A PRIVADA ---
  socket.on('unirse-sala-serpientes-privada', async ({ email, nickname, codigo, skin }) => {
      email = emailDeSocket(socket, email, 'unirse-sala-serpientes-privada');
      if (!email) return socket.emit('error-apuesta', 'Sesión no válida');
      const salaId = Object.keys(salasSerpientes).find(id => salasSerpientes[id].codigo === codigo);
      
      if (!salaId) return socket.emit('error-apuesta', 'Sala no encontrada');
      const sala = salasSerpientes[salaId];
      if (sala.enJuego) return socket.emit('error-apuesta', 'Ya inició la partida');
      if (sala.jugadores.length >= 4) return socket.emit('error-apuesta', 'Sala llena');

      const monto = sala.apuesta;
      const userRef = db.collection('usuarios').doc(email);
      const doc = await userRef.get();
      if (!doc.exists || doc.data().monedas < monto) return socket.emit('error-apuesta', `Necesitas $${monto}`);

      await userRef.update({ monedas: admin.firestore.FieldValue.increment(-monto) });
      await registrarMovimiento(email, 'apuesta', monto, `Unirse Serpientes ${codigo}`, false);
      socket.emit('usuario-actualizado', perfilPublico((await userRef.get()).data()));

      unirseSalaSerpientesLogica(socket, salaId, email, nickname, monto, false, skin);
  });

  // --- LÓGICA COMÚN DE UNIÓN ---
  function unirseSalaSerpientesLogica(socket, salaId, email, nickname, monto, vsCpu, skin) {
      const sala = salasSerpientes[salaId];
      socket.join(salaId);

      // Agregar Jugador
      if (!sala.jugadores.some(j => j.id === socket.id)) {
          sala.jugadores.push({ 
              id: socket.id, email, nickname, posicion: 1, esBot: false, skin: skin || '🔵' 
          });
          if (!sala.esVsCpu) sala.bote += monto; 
      }

      // Agregar Bot
      if (sala.esVsCpu && !sala.jugadores.some(j => j.esBot)) {
          sala.jugadores.push({
              id: 'cpu_bot', email: 'banca@juegosenlanube.com', nickname: '🤖 La Banca',
              posicion: 1, esBot: true, skin: '🤖'
          });
      }

      socket.emit('sala-conectada', { salaId: salaId, jugadoresConectados: sala.jugadores.length, esPrivada: sala.esPrivada, codigo: sala.codigo, hostId: sala.hostId });
      io.to(salaId).emit('jugador-entro', sala.jugadores.length);
      emitirContadores();

      // INICIO AUTOMÁTICO (Solo Públicas/CPU)
      if (!sala.esPrivada) {
          const listos = sala.esVsCpu || (sala.jugadores.length >= 2);
          if (listos && !sala.enJuego) {
              if (sala.timerInicio) clearTimeout(sala.timerInicio);
              const tiempoEspera = sala.esVsCpu ? 1500 : 5000;
              if(!sala.esVsCpu) io.to(salaId).emit('notificacion', `Iniciando en ${tiempoEspera/1000}s...`);
              
              sala.timerInicio = setTimeout(() => {
                  if(salasSerpientes[salaId] && (salasSerpientes[salaId].jugadores.length >= 2 || sala.esVsCpu)) {
                      iniciarJuegoSerpientesReal(sala);
                  }
              }, tiempoEspera);
          }
      } else {
          io.to(salaId).emit('notificacion', 'Esperando al anfitrión...');
      }
  }

  // --- 4. INICIAR PRIVADA MANUALMENTE ---
  socket.on('iniciar-serpientes-host', (salaId) => {
      const sala = salasSerpientes[salaId];
      if (sala && sala.hostId === socket.id && !sala.enJuego) {
          if (sala.jugadores.length < 2) return;
          iniciarJuegoSerpientesReal(sala);
      }
  });

  function iniciarJuegoSerpientesReal(sala) {
      sala.enJuego = true;
      sala.timerInicio = null;
      // El turno inicial se sortea. Antes empezaba siempre el jugador de la
      // posición 0, que contra la CPU era siempre el humano; en serpientes y
      // escaleras tirar primero es una ventaja medible, así que contra la banca
      // el juego no era una moneda al aire.
      sala.turnoIndex = alAzar(sala.jugadores.length);
      io.to(sala.id).emit('inicio-partida-serpientes', { salaId: sala.id, jugadores: sala.jugadores });
      io.to(sala.id).emit('turno-asignado', sala.jugadores[sala.turnoIndex].nickname);

      // Si le tocó a la banca, hay que arrancarle el turno.
      if (sala.jugadores[sala.turnoIndex].esBot) {
          setTimeout(() => procesarTurnoSerpientes(sala.id, 'sistema'), 2000);
      }
  }

  // --- SALIR / REEMBOLSO (Igual que antes pero adaptado) ---
  socket.on('salir-sala-espera', async (salaId) => {
      const sala = salasSerpientes[salaId];
      if (sala && (!sala.enJuego || sala.esVsCpu)) {
          const index = sala.jugadores.findIndex(j => j.id === socket.id);
          if (index !== -1) {
              const jugador = sala.jugadores[index];
              const reembolso = sala.apuesta;
              const userRef = db.collection('usuarios').doc(jugador.email);
              await userRef.update({ monedas: admin.firestore.FieldValue.increment(reembolso) });
              await registrarMovimiento(jugador.email, 'reembolso', reembolso, 'Salida Serpientes', true);
              const docUpd = await userRef.get();
              socket.emit('usuario-actualizado', perfilPublico(docUpd.data()));
              socket.emit('reembolso-exitoso');

              sala.jugadores.splice(index, 1);
              socket.leave(salaId);

              if (sala.jugadores.length === 0 || sala.esVsCpu) { delete salasSerpientes[salaId]; } 
              else { io.to(salaId).emit('jugador-entro', sala.jugadores.length); }
          }
      }
      emitirContadores();
  });

  // --- JUEGO (DADOS) ---
  socket.on('tirar-dado-serpientes', (salaId) => { procesarTurnoSerpientes(salaId, socket.id); });

  function procesarTurnoSerpientes(salaId, solicitanteId) {
      const sala = salasSerpientes[salaId];
      if (!sala || !sala.enJuego) return;

      const jugadorActual = sala.jugadores[sala.turnoIndex];
      if (!jugadorActual.esBot && jugadorActual.id !== solicitanteId) return;

      const dado = alAzar(6) + 1;
      let nuevaPos = jugadorActual.posicion + dado;

      if (nuevaPos > 54) { nuevaPos = 54 - (nuevaPos - 54); }

      let esSerpiente = false; let esEscalera = false;
      if (SNAKES[nuevaPos]) { nuevaPos = SNAKES[nuevaPos]; esSerpiente = true; } 
      else if (LADDERS[nuevaPos]) { nuevaPos = LADDERS[nuevaPos]; esEscalera = true; }

      const posAnterior = jugadorActual.posicion;
      jugadorActual.posicion = nuevaPos;

      io.to(salaId).emit('movimiento-jugador', {
          nickname: jugadorActual.nickname, dado, posAnterior, posNueva: nuevaPos, esSerpiente, esEscalera
      });

      if (nuevaPos === 54) {
          sala.enJuego = false;
          finalizarJuegoSerpientes(sala, jugadorActual);
      } else {
          sala.turnoIndex = (sala.turnoIndex + 1) % sala.jugadores.length;
          const siguienteJugador = sala.jugadores[sala.turnoIndex];
          io.to(salaId).emit('turno-asignado', siguienteJugador.nickname);

          if (siguienteJugador.esBot) {
              setTimeout(() => { procesarTurnoSerpientes(salaId, 'sistema'); }, 5000); 
          }
      }
  }

  async function finalizarJuegoSerpientes(sala, ganador) {
      const premio = sala.bote;
      // Si gana la banca el bote no se paga a nadie: descontamos de la emisión
      // lo que había puesto, para que el contador refleje el neto real.
      if (ganador.esBot && sala.esVsCpu) {
          await registrarEmisionBanca(-sala.apuesta, 'La banca gana en Serpientes');
      }
      if (!ganador.esBot) {
          const userRef = db.collection('usuarios').doc(ganador.email);
          await userRef.update({ monedas: admin.firestore.FieldValue.increment(premio) });
          await registrarMovimiento(ganador.email, 'victoria', premio, 'Ganador Serpientes', true);
      }
      io.to(sala.id).emit('fin-juego-serpientes', { ganador: ganador.nickname, premio });
      delete salasSerpientes[sala.id];
      emitirContadores();
  }

  // =========================================================
  // 🌀 BLOQUE PIRINOLA ROYAL (PRIVADAS + PÚBLICAS) 🌀
  // =========================================================

  // --- 1. JUEGO PÚBLICO (MATCHMAKING) ---
  socket.on('entrar-pirinola', async ({ email, nickname, apuesta, vsCpu }) => {
      email = emailDeSocket(socket, email, 'entrar-pirinola');
      if (!email) return socket.emit('error-apuesta', 'Sesión no válida');
      // Validar Saldo
      // Sin esta guarda, una apuesta negativa se convertía en increment(+monto):
      // en vez de cobrar, regalaba monedas.
      const monto = montoApuestaValido(apuesta);
      if (!monto) return socket.emit('error-apuesta', 'Apuesta no válida');
      const userRef = db.collection('usuarios').doc(email);
      const doc = await userRef.get();
      if (!doc.exists || doc.data().monedas < monto) {
          socket.emit('error-apuesta', 'Saldo insuficiente');
          return;
      }

      // Cobrar y Registrar
      await userRef.update({ monedas: admin.firestore.FieldValue.increment(-monto) });
      await registrarMovimiento(email, 'apuesta', monto, 'Pirinola Publica', false);
      const nuevoDoc = await userRef.get();
      socket.emit('usuario-actualizado', perfilPublico(nuevoDoc.data()));

      let salaId = null;

      if (vsCpu) {
          salaId = `cpu_${socket.id}_${Date.now()}`;
          salasPirinola[salaId] = {
              id: salaId, apuesta: monto, bote: 0, jugadores: [], turnoIndex: 0, 
              enJuego: false, esVsCpu: true, esPrivada: false
          };
      } else {
          // Buscar sala pública disponible
          salaId = Object.keys(salasPirinola).find(id => 
              !salasPirinola[id].esVsCpu && 
              !salasPirinola[id].esPrivada && // IMPORTANTE: No mezclar con privadas
              salasPirinola[id].apuesta === monto && 
              salasPirinola[id].jugadores.length < 6 && 
              !salasPirinola[id].enJuego
          );

          if (!salaId) {
              salaId = `pirinola_${monto}_${Date.now()}`;
              salasPirinola[salaId] = {
                  id: salaId, apuesta: monto, bote: 0, jugadores: [], turnoIndex: 0, 
                  enJuego: false, esVsCpu: false, esPrivada: false
              };
          }
      }

      unirseALaSalaLogica(socket, salaId, email, nickname, monto, vsCpu);
  });

  // --- 2. CREAR SALA PRIVADA (NUEVO) ---
  socket.on('crear-sala-privada', async ({ email, nickname, apuesta }) => {
      email = emailDeSocket(socket, email, 'crear-sala-privada');
      if (!email) return socket.emit('error-apuesta', 'Sesión no válida');
      // Sin esta guarda, una apuesta negativa se convertía en increment(+monto):
      // en vez de cobrar, regalaba monedas.
      const monto = montoApuestaValido(apuesta);
      if (!monto) return socket.emit('error-apuesta', 'Apuesta no válida');
      const userRef = db.collection('usuarios').doc(email);
      const doc = await userRef.get();
      if (!doc.exists || doc.data().monedas < monto) return socket.emit('error-apuesta', 'Saldo insuficiente');

      // Cobrar
      await userRef.update({ monedas: admin.firestore.FieldValue.increment(-monto) });
      await registrarMovimiento(email, 'apuesta', monto, 'Crear Mesa Privada', false);
      socket.emit('usuario-actualizado', perfilPublico((await userRef.get()).data()));

      // Generar Código 4 Dígitos
      const codigo = (1000 + alAzar(9000)).toString();
      const salaId = `privada_${codigo}`;

      salasPirinola[salaId] = {
          id: salaId, codigo: codigo, apuesta: monto, bote: 0, jugadores: [], 
          turnoIndex: 0, enJuego: false, esVsCpu: false, esPrivada: true, hostId: socket.id
      };

      unirseALaSalaLogica(socket, salaId, email, nickname, monto, false);
  });

  // --- 3. UNIRSE A SALA PRIVADA (NUEVO) ---
  socket.on('unirse-sala-privada', async ({ email, nickname, codigo }) => {
      email = emailDeSocket(socket, email, 'unirse-sala-privada');
      if (!email) return socket.emit('error-apuesta', 'Sesión no válida');
      // Buscar sala por código
      const salaId = Object.keys(salasPirinola).find(id => salasPirinola[id].codigo === codigo);
      
      if (!salaId) return socket.emit('error-apuesta', 'Sala no encontrada');
      const sala = salasPirinola[salaId];
      if (sala.enJuego) return socket.emit('error-apuesta', 'La partida ya comenzó');
      if (sala.jugadores.length >= 6) return socket.emit('error-apuesta', 'Sala llena');

      const monto = sala.apuesta;
      const userRef = db.collection('usuarios').doc(email);
      const doc = await userRef.get();
      if (!doc.exists || doc.data().monedas < monto) return socket.emit('error-apuesta', `Necesitas $${monto} para entrar`);

      // Cobrar
      await userRef.update({ monedas: admin.firestore.FieldValue.increment(-monto) });
      await registrarMovimiento(email, 'apuesta', monto, `Unirse Mesa ${codigo}`, false);
      socket.emit('usuario-actualizado', perfilPublico((await userRef.get()).data()));

      unirseALaSalaLogica(socket, salaId, email, nickname, monto, false);
  });

  // --- LÓGICA COMÚN DE UNIÓN ---
  function unirseALaSalaLogica(socket, salaId, email, nickname, monto, vsCpu) {
      const sala = salasPirinola[salaId];
      socket.join(salaId);

      // Agregar Jugador
      if(!sala.jugadores.some(j => j.id === socket.id)) {
          sala.jugadores.push({ id: socket.id, email, nickname, esBot: false });
          sala.bote += monto; 
      }

      // Agregar Bot (Solo si es Vs CPU)
      if(vsCpu && !sala.jugadores.some(j => j.esBot)) {
          // El bot juega con una bolsa FINITA. Antes pagaba ilimitadamente: cada
          // vez que caía en "pon $1" el bote crecía sin que nadie pusiera esas
          // monedas, y el jugador podía llevárselas como saldo real. Eso era un
          // generador de monedas explotable en bucle.
          sala.jugadores.push({
              id: 'bot_banca', email: 'banca', nickname: '🤖 La Banca', esBot: true,
              bolsa: monto * TOPE_BANCA_POR_MESA
          });
          sala.bote += monto;
          registrarEmisionBanca(monto, 'Ante de la banca en Pirinola');
      }

      socket.emit('sala-encontrada', sala); // Envía info de sala al cliente
      io.to(salaId).emit('actualizar-estado-pirinola', sala);
      emitirContadores();

      // --- LOGICA DE INICIO ---
      
      // CASO A: PÚBLICA / CPU -> Timer Automático
      if (!sala.esPrivada) {
          const jugadoresNecesarios = 2;
          if (sala.jugadores.length >= jugadoresNecesarios && !sala.enJuego) {
              if(sala.timerInicio) clearTimeout(sala.timerInicio);
              
              const tiempoEspera = vsCpu ? 1000 : 6000; // 6 seg para públicas (dar tiempo a amigos)
              io.to(salaId).emit('notificacion', vsCpu ? 'Iniciando...' : `Iniciando en ${tiempoEspera/1000}s...`);

              sala.timerInicio = setTimeout(() => {
                  if (sala.jugadores.length < jugadoresNecesarios) {
                      io.to(salaId).emit('notificacion', 'Esperando jugadores...');
                      return;
                  }
                  iniciarJuegoReal(sala);
              }, tiempoEspera);
          }
      } 
      // CASO B: PRIVADA -> Esperar al Host
      else {
          io.to(salaId).emit('notificacion', 'Esperando al anfitrión...');
      }
  }

  // --- 4. INICIAR MANUALMENTE (SOLO PRIVADAS) ---
  socket.on('iniciar-juego-privado', (salaId) => {
      const sala = salasPirinola[salaId];
      if (sala && sala.hostId === socket.id && !sala.enJuego) {
          if (sala.jugadores.length < 2) return; // Mínimo 2
          iniciarJuegoReal(sala);
      }
  });

  function iniciarJuegoReal(sala) {
      sala.enJuego = true;
      io.to(sala.id).emit('notificacion', '¡Juego Iniciado!');
      sala.turnoIndex = alAzar(sala.jugadores.length); 
      io.to(sala.id).emit('juego-arrancado', sala); // Evento especial para quitar botones de espera
      io.to(sala.id).emit('actualizar-estado-pirinola', sala);
      verificarTurnoBot(sala);
  }

  // --- JUGABILIDAD (TIRAR Y PAGAR) ---
  socket.on('tirar-pirinola', (salaId) => { procesarTurnoPirinola(salaId, socket.id); });

  function procesarTurnoPirinola(salaId, solicitanteId) {
      const sala = salasPirinola[salaId];
      if (!sala || !sala.enJuego) return;

      const jugador = sala.jugadores[sala.turnoIndex];
      if (solicitanteId !== 'sistema' && jugador.id !== solicitanteId) return;

      const resultado = alAzar(6) + 1; 
      io.to(salaId).emit('resultado-giro', { cara: resultado });

      setTimeout(async () => {
          let mensaje = "";
          const nombre = jugador.nickname;
          try {
              if (resultado === 1) { mensaje = `${nombre} puso $1`; await cobrarPirinola(jugador, 1, sala); } 
              else if (resultado === 2) { mensaje = `${nombre} puso $2`; await cobrarPirinola(jugador, 2, sala); } 
              else if (resultado === 3) { mensaje = `${nombre} tomó $1`; await pagarPirinola(jugador, 1, sala, 'Premio Toma 1'); } 
              else if (resultado === 4) { mensaje = `${nombre} tomó $2`; await pagarPirinola(jugador, 2, sala, 'Premio Toma 2'); } 
              else if (resultado === 5) { 
                  mensaje = `¡${nombre} SE LLEVÓ EL BOTE! 🎉`;
                  const total = sala.bote;
                  await pagarPirinola(jugador, total, sala, 'Premio TOMA TODO');
                  io.to(salaId).emit('fin-juego-pirinola', { ganador: jugador.nickname, premio: total });
                  delete salasPirinola[salaId]; emitirContadores(); return; 
              } 
              else if (resultado === 6) { mensaje = "¡TODOS PONEN $1!"; for (let j of sala.jugadores) { await cobrarPirinola(j, 1, sala); } }
              
              sala.turnoIndex = (sala.turnoIndex + 1) % sala.jugadores.length;
              io.to(salaId).emit('actualizar-estado-pirinola', sala);
              io.to(salaId).emit('notificacion', mensaje);
              verificarTurnoBot(sala);
          } catch (e) { console.error("Error pirinola:", e); }
      }, 3200);
  }

  function verificarTurnoBot(sala) {
      const jugadorActual = sala.jugadores[sala.turnoIndex];
      if (jugadorActual && jugadorActual.esBot) {
          setTimeout(() => { procesarTurnoPirinola(sala.id, 'sistema'); }, 2000);
      }
  }

  async function cobrarPirinola(jugador, cantidad, sala) {
      // El bot paga de su bolsa finita. Si se le acaba, no pone: el bote
      // simplemente no crece. Antes ponía sin límite y sin respaldo.
      if (jugador.esBot) {
          const puede = Math.min(cantidad, jugador.bolsa || 0);
          jugador.bolsa = (jugador.bolsa || 0) - puede;
          sala.bote += puede;
          if (puede > 0) registrarEmisionBanca(puede, 'Aporte de la banca en Pirinola');
          return;
      }

      // Al jugador real solo se le cobra lo que tiene. Antes se descontaba sin
      // mirar el saldo, así que con la cara de "todos ponen" una cuenta podía
      // quedarse en números rojos.
      try {
          const userRef = db.collection('usuarios').doc(jugador.email);
          let cobrado = 0;
          await db.runTransaction(async (tx) => {
              const doc = await tx.get(userRef);
              if (!doc.exists) return;
              const saldo = doc.data().monedas || 0;
              cobrado = Math.min(cantidad, saldo);
              if (cobrado > 0) tx.update(userRef, { monedas: saldo - cobrado });
          });
          sala.bote += cobrado;
      } catch (e) { console.error("Error cobrando pirinola:", e); }
  }

  async function pagarPirinola(jugador, cantidad, sala, concepto) {
      const pago = Math.min(cantidad, sala.bote);
      sala.bote -= pago;
      // Lo que se lleva el bot vuelve a su bolsa y se descuenta de la emisión:
      // así el contador refleja lo que la banca realmente puso, no lo que pasó
      // por el bote.
      if (jugador.esBot && pago > 0) {
          jugador.bolsa = (jugador.bolsa || 0) + pago;
          registrarEmisionBanca(-pago, 'La banca recupera bote de Pirinola');
      }
      if (!jugador.esBot && pago > 0) {
          const userRef = db.collection('usuarios').doc(jugador.email);
          await userRef.update({ monedas: admin.firestore.FieldValue.increment(pago) });
          await registrarMovimiento(jugador.email, 'victoria', pago, concepto || 'Ganancia Pirinola', true);
      }
  }

  // --- DESCONEXIÓN ---
  socket.on('disconnect', async () => {
      console.log('Socket desconectado:', socket.id);
      
      // Lotería
      for (const salaId in salas) {
          if(salas[salaId].jugadores[socket.id]) {
              const jugador = salas[salaId].jugadores[socket.id];
              if (!salas[salaId].juegoIniciado && jugador.apostado) {
                  await procesarReembolsoPorSalida(salaId, socket.id);
              }
              const eraHost = (salas[salaId].hostId === socket.id);
              delete salas[salaId].jugadores[socket.id];

              // Una sala donde solo quedan bots está vacía. Si se contaran, la
              // sala viviría para siempre con sus relojes en marcha y sin nadie
              // mirando.
              const quedanHumanos = Object.values(salas[salaId].jugadores).filter(j => !j.esBot);
              if(quedanHumanos.length === 0) {
                  if(salas[salaId].intervaloCartas) clearInterval(salas[salaId].intervaloCartas);
                  bots.pararBots(salas[salaId]);
                  delete salas[salaId];
              } else {
                  if(eraHost) {
                      // El anfitrión nuevo tiene que ser una persona: un bot no
                      // puede iniciar la partida ni añadir a nadie.
                      const nuevoHost = quedanHumanos[0].id;
                      salas[salaId].hostId = nuevoHost;
                      io.to(nuevoHost).emit('rol-asignado', { host: true });
                  }
                  io.to(salaId).emit('jugadores-actualizados', salas[salaId].jugadores);
              }
          }
      }

      // Serpientes
      for (const sId in salasSerpientes) {
          const sala = salasSerpientes[sId];
          const idx = sala.jugadores.findIndex(j => j.id === socket.id);
          if (idx !== -1) {
              const jugador = sala.jugadores[idx];
              if (!sala.enJuego && !sala.esVsCpu) {
                   try {
                       const userRef = db.collection('usuarios').doc(jugador.email);
                       await userRef.update({ monedas: admin.firestore.FieldValue.increment(sala.apuesta) });
                       await registrarMovimiento(jugador.email, 'reembolso', sala.apuesta, 'Reembolso Serpientes (Desc)', true);
                   } catch(e) { console.error(e); }
              }
              sala.jugadores.splice(idx, 1);
              if (sala.jugadores.length === 0 || sala.esVsCpu) { delete salasSerpientes[sId]; } 
              else { if(!sala.enJuego) io.to(sId).emit('jugador-entro', sala.jugadores.length); }
          }
      }

      // Pirinola
      for (const pId in salasPirinola) {
          const sala = salasPirinola[pId];
          const idx = sala.jugadores.findIndex(j => j.id === socket.id);
          if (idx !== -1) {
              const jugador = sala.jugadores[idx];
              if (!sala.enJuego && !jugador.esBot) {
                  try {
                      const reembolso = sala.apuesta; 
                      const userRef = db.collection('usuarios').doc(jugador.email);
                      await userRef.update({ monedas: admin.firestore.FieldValue.increment(reembolso) });
                      await registrarMovimiento(jugador.email, 'reembolso', reembolso, 'Reembolso Pirinola', true);
                  } catch(e) { console.error("Error reembolso pirinola:", e); }
              }
              sala.jugadores.splice(idx, 1);
              if (sala.jugadores.filter(j => !j.esBot).length === 0) {
                  delete salasPirinola[pId];
              } else {
                  io.to(pId).emit('actualizar-estado-pirinola', sala);
                  io.to(pId).emit('notificacion', `${jugador.nickname} salió.`);
              }
          }
      }
      emitirContadores();
  });

}); 

// ==================== RED DE SEGURIDAD ====================
// Node 15+ termina el proceso ante una promesa rechazada sin capturar. Muchos handlers
// de socket son async y no tienen try/catch, así que un solo payload malformado podía
// tumbar el servidor y con él todas las partidas activas (el estado vive en memoria).
// Aquí lo registramos y seguimos vivos. El try/catch por handler llega en la Fase 2.
process.on('unhandledRejection', (motivo, promesa) => {
    console.error('⚠️ Promesa rechazada sin capturar:', motivo);
});

http.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
