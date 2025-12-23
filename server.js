// server.js - Backend Lotería + Serpientes + Pirinola + Hub + Admin Pro

// ==================== CONFIG FIREBASE ====================
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.nicknames); 

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

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
const io = require('socket.io')(http, { cors: { origin: '*' } });
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bcrypt = require('bcryptjs'); 
const cors = require('cors');

app.use(cors());
app.use(express.json()); 

const PORT = process.env.PORT || 3000;

// ==================== VARIABLES GLOBALES ====================
const salas = {}; // Lotería
const salasSerpientes = {}; 
const salasPirinola = {}; 

const SNAKES = { 18:6, 25:9, 33:19, 41:24, 48:32, 53:13 };
const LADDERS = { 3:15, 11:28, 22:36, 30:44, 38:49, 46:51 };
const ADMIN_EMAIL = "admin@loteria.com"; 

// ==================== RUTAS API ====================

app.get('/', (req, res) => res.send('Servidor Juegos en la Nube ☁️ Funcionando ✅'));

// 1. REGISTRO
app.post('/api/registro', async (req, res) => {
    const { email, password, nickname } = req.body;
    try {
        const userRef = db.collection('usuarios').doc(email);
        const doc = await userRef.get();
        if (doc.exists) return res.status(400).json({ error: 'Correo ya registrado.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        await userRef.set({
            email, password: hashedPassword, nickname, monedas: 20, 
            creado: new Date(), baneado: false 
        });
        res.json({ success: true, nickname, monedas: 20, email });
    } catch (error) { res.status(500).json({ error: 'Error servidor.' }); }
});

// 2. LOGIN (CON VALIDACIÓN DE BANEO)
app.post('/api/login', async (req, res) => {
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
            inventario: userData.inventario || [] 
        });
    } catch (error) { res.status(500).json({ error: 'Error servidor.' }); }
});

// 3. DATOS FRESCOS (CON HORA CDMX)
app.get('/api/usuario/datos-frescos', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Falta email" });
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
        
        res.json({ success: true, monedas: userDoc.data().monedas, historial });
    } catch (error) { res.status(500).json({ error: "Error servidor" }); }
});


// --- RECOMPENSA DIARIA (NUEVO) ---
app.post('/api/recompensa-diaria', async (req, res) => {
    const { email } = req.body;
    if(!email) return res.status(400).json({ error: "Falta email" });

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

// Stats Generales (VENTAS REALES vs DEUDA)
app.get('/api/admin/stats', async (req, res) => {
    const solicitante = req.headers['admin-email'];
    if (solicitante !== ADMIN_EMAIL) return res.status(403).json({ error: "Acceso denegado" });

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
    const solicitante = req.headers['admin-email'];
    if (solicitante !== ADMIN_EMAIL) return res.status(403).json({ error: "Acceso denegado" });
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
    if (adminEmail !== ADMIN_EMAIL) return res.status(403).json({ error: "Acceso denegado" });
    try {
        await db.collection('usuarios').doc(targetEmail).update({ baneado: ban });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Error ban" }); }
});

// RECARGAR SALDO (SUMAR)
app.post('/api/admin/recargar-manual', async (req, res) => {
    const { adminEmail, targetEmail, cantidad } = req.body;
    if (adminEmail !== ADMIN_EMAIL) return res.status(403).json({ error: "Acceso denegado" });
    
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

// 1. BUSCAR DESTINATARIO (Por Nickname)
app.get('/api/buscar-destinatario', async (req, res) => {
    const { nickname } = req.query;
    if (!nickname) return res.status(400).json({ error: "Falta nickname" });

    try {
        // Buscamos en toda la colección de usuarios quien tiene ese nickname
        const snapshot = await db.collection('usuarios').where('nickname', '==', nickname).limit(1).get();
        
        if (snapshot.empty) {
            return res.json({ success: false, error: "Usuario no encontrado" });
        }

        const doc = snapshot.docs[0];
        // Retornamos solo lo necesario (email y nickname) por seguridad
        res.json({ 
            success: true, 
            destinatario: { 
                email: doc.id, 
                nickname: doc.data().nickname,
                avatar: doc.data().avatar 
            } 
        });
    } catch (e) {
        console.error("Error buscar destinatario:", e);
        res.status(500).json({ error: "Error de servidor" });
    }
});

// 2. TRANSFERIR SALDO
app.post('/api/transferir-saldo', async (req, res) => {
    const { origenEmail, destinoEmail, cantidad } = req.body;
    const monto = parseInt(cantidad);

    if (!origenEmail || !destinoEmail || !monto || monto < 1) {
        return res.status(400).json({ error: "Datos inválidos" });
    }

    if (origenEmail === destinoEmail) {
        return res.status(400).json({ error: "No puedes enviarte a ti mismo" });
    }

    try {
        await db.runTransaction(async (t) => {
            const origenRef = db.collection('usuarios').doc(origenEmail);
            const destinoRef = db.collection('usuarios').doc(destinoEmail);

            const origenDoc = await t.get(origenRef);
            const destinoDoc = await t.get(destinoRef);

            if (!origenDoc.exists || !destinoDoc.exists) {
                throw new Error("Usuario no encontrado");
            }

            const saldoActual = origenDoc.data().monedas || 0;
            if (saldoActual < monto) {
                throw new Error("Saldo insuficiente");
            }

            // Restar al origen
            t.update(origenRef, { monedas: admin.firestore.FieldValue.increment(-monto) });
            
            // Sumar al destino
            t.update(destinoRef, { monedas: admin.firestore.FieldValue.increment(monto) });

            // Registrar Historial ORIGEN (Egreso)
            const historialOrigenRef = origenRef.collection('historial').doc();
            t.set(historialOrigenRef, {
                tipo: 'transferencia',
                monto: monto,
                descripcion: `Envío a ${destinoDoc.data().nickname}`,
                esIngreso: false,
                fecha: admin.firestore.FieldValue.serverTimestamp()
            });

            // Registrar Historial DESTINO (Ingreso)
            const historialDestinoRef = destinoRef.collection('historial').doc();
            t.set(historialDestinoRef, {
                tipo: 'transferencia',
                monto: monto,
                descripcion: `Recibido de ${origenDoc.data().nickname}`,
                esIngreso: true,
                fecha: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        res.json({ success: true });

    } catch (e) {
        console.error("Error transferencia:", e);
        res.status(400).json({ success: false, error: e.message || "Error al transferir" });
    }
});

// 3. HISTORIAL COMPLETO (CORREGIDO HORA CDMX)
app.get('/api/historial-usuario', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Falta email" });

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
    if (adminEmail !== ADMIN_EMAIL) return res.status(403).json({ error: "Sin permiso" });
    try {
        await db.collection('juegos_hub').add({ titulo, url, imgPoster, descripcion, estado, creado: admin.firestore.FieldValue.serverTimestamp() });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Error guardar" }); }
});
app.delete('/api/hub/eliminar-juego/:id', async (req, res) => {
    const { id } = req.params;
    const adminEmail = req.headers['admin-email'];
    if (adminEmail !== ADMIN_EMAIL) return res.status(403).json({ error: "Sin permiso" });
    try {
        await db.collection('juegos_hub').doc(id).delete();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: "Error al eliminar" }); }
});
app.post('/api/actualizar-perfil', async (req, res) => {
    const { email, nickname, avatar } = req.body;
    if (!email || !nickname) return res.status(400).json({ error: "Faltan datos" });
    try {
        await db.collection('usuarios').doc(email).update({ nickname: nickname, avatar: avatar || 'assets/avatar.png' });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: "Error al actualizar perfil" }); }
});

// --- STRIPE (CON REGISTRO DE FINANZAS) ---
const FRONTEND_LOTERIA = "https://loteria.juegosenlanube.com"; 
const FRONTEND_HUB = "https://juegosenlanube.com";
const BACKEND_URL = "https://loteria-backend-3nde.onrender.com";

app.post('/api/crear-orden', async (req, res) => {
    const { cantidad, precio, email, origen } = req.body;
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
            return_url: `${BACKEND_URL}/api/confirmar-pago?session_id={CHECKOUT_SESSION_ID}`,
        });
        res.json({ clientSecret: session.client_secret });
    } catch (error) { res.status(500).json({ error: "Error orden" }); }
});

app.get('/api/confirmar-pago', async (req, res) => {
    const { session_id } = req.query;
    try {
        const session = await stripe.checkout.sessions.retrieve(session_id);
        if (session.payment_status === 'paid') {
            const email = session.metadata.email_usuario;
            const monedasExtra = parseInt(session.metadata.monedas_a_dar);
            const origen = session.metadata.origen_pago;
            const dineroReal = session.amount_total / 100; // Centavos a Pesos
            
            const userRef = db.collection('usuarios').doc(email);
            const doc = await userRef.get();
            if (doc.exists) {
                await userRef.update({ monedas: (doc.data().monedas || 0) + monedasExtra });
                await registrarMovimiento(email, 'recarga', monedasExtra, 'Recarga con Tarjeta', true);
                
                // REGISTRAR VENTA REAL (NUEVO)
                const finanzasRef = db.collection('finanzas').doc('general');
                await finanzasRef.set({ 
                    totalVentasMXN: admin.firestore.FieldValue.increment(dineroReal),
                    ultimaActualizacion: new Date()
                }, { merge: true });
            }

            if (origen === 'hub') res.redirect(`${FRONTEND_HUB}/index.html?pago=exito&cantidad=${monedasExtra}`);
            else res.redirect(`${FRONTEND_LOTERIA}/index.html?pago=exito&cantidad=${monedasExtra}`);
        } else {
            res.redirect(`${FRONTEND_HUB}/index.html?pago=cancelado`);
        }
    } catch (error) { res.redirect(`${FRONTEND_HUB}/index.html?pago=error`); }
});

// FUNCIONES DE JUEGO (REEMBOLSOS LOTERIA)
async function procesarReembolsoPorSalida(salaId, socketId) {
    const sala = salas[salaId];
    if (!sala) return;
    const jugador = sala.jugadores[socketId];
    if (!jugador) return;

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

// FUNCIONES AUXILIARES LOTERÍA
function mezclarBaraja() {
  const cartas = Array.from({ length: 54 }, (_, i) => String(i + 1).padStart(2, '0'));
  return cartas.sort(() => Math.random() - 0.5);
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
  }, velocidad); 
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

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);
  emitirContadores();

  // --- GENERAL ---
  socket.on('solicitar-info-usuario', async (email) => {
      try {
          const doc = await db.collection('usuarios').doc(email).get();
          if (doc.exists) socket.emit('usuario-actualizado', doc.data());
      } catch (e) { console.error(e); }
  });

  // --- LOTERIA ---
  socket.on('unirse-sala', async ({ nickname, email, sala, modo }) => { 
    socket.join(sala);
    if (!salas[sala]) {
      salas[sala] = {
        jugadores: {}, baraja: [], historial: [], juegoIniciado: false, bote: 0,
        hostId: socket.id, intervaloCartas: null, modoJuego: modo || 'clasico', 
        reclamantes: [], validandoEmpate: false, timerEmpate: null
      };
      socket.emit('rol-asignado', { host: true });
    } else {
      socket.emit('rol-asignado', { host: (socket.id === salas[sala].hostId) });
    }
    let monedasIniciales = 20;
    if(email) {
        const d = await db.collection('usuarios').doc(email).get();
        if(d.exists) monedasIniciales = d.data().monedas;
    }
    salas[sala].jugadores[socket.id] = { nickname, email, monedas: monedasIniciales, apostado: false, cartas: [], id: socket.id, host: (socket.id === salas[sala].hostId) };
    io.to(sala).emit('info-sala', { modo: salas[sala].modoJuego });
    const cartasOcupadas = Object.values(salas[sala].jugadores).flatMap(j => j.cartas);
    io.to(sala).emit('cartas-desactivadas', cartasOcupadas);
    io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
    io.to(sala).emit('bote-actualizado', salas[sala].bote);
    io.to(sala).emit('historial-actualizado', salas[sala].historial);
    emitirContadores();
  });

  socket.on('seleccionar-carta', ({ carta, sala }) => {
    const salaInfo = salas[sala];
    if (salaInfo && salaInfo.jugadores[socket.id]) {
      const jugador = salaInfo.jugadores[socket.id];
      if (jugador.cartas.length < 4 && !jugador.cartas.includes(carta)) {
        jugador.cartas.push(carta);
        const cartasOcupadas = Object.values(salaInfo.jugadores).flatMap(j => j.cartas);
        io.to(sala).emit('cartas-desactivadas', cartasOcupadas);
      }
    }
  });

  socket.on('deseleccionar-carta', ({ carta, sala }) => {
    const salaInfo = salas[sala];
    if (salaInfo && salaInfo.jugadores[socket.id]) {
      const jugador = salaInfo.jugadores[socket.id];
      jugador.cartas = jugador.cartas.filter(c => c !== carta);
      const cartasOcupadas = Object.values(salaInfo.jugadores).flatMap(j => j.cartas);
      io.to(sala).emit('cartas-desactivadas', cartasOcupadas);
    }
  });

  socket.on('apostar', async (data) => {
    const sala = data.sala;
    const cantidad = data.cantidad || 1;
    const email = data.email;
    if (salas[sala] && !salas[sala].juegoIniciado) {
        const jugador = salas[sala].jugadores[socket.id];
        if (jugador && !jugador.apostado && jugador.monedas >= cantidad) {
            jugador.monedas -= cantidad;
            jugador.apostado = true;
            jugador.cantidadApostada = cantidad;
            salas[sala].bote += cantidad;
            if (email) {
                await db.collection('usuarios').doc(email).update({ monedas: jugador.monedas });
                await registrarMovimiento(email, 'apuesta', cantidad, `Apuesta Lotería: ${sala}`, false);
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
        salas[sala].baraja = mezclarBaraja();
        salas[sala].historial = [];
        salas[sala].juegoIniciado = true;
        salas[sala].pagoRealizado = false;
        salas[sala].velocidad = velocidad;
        salas[sala].reclamantes = [];
        salas[sala].validandoEmpate = false;
        if(salas[sala].timerEmpate) clearTimeout(salas[sala].timerEmpate);
        io.to(sala).emit('juego-iniciado');
        io.to(sala).emit('campana');
        setTimeout(() => { if(salas[sala]?.juegoIniciado) io.to(sala).emit('corre'); }, 2000);
        setTimeout(() => { if(salas[sala]?.juegoIniciado) repartirCartas(sala); }, 5000);
      }
    }
  });

  socket.on('detener-juego', (sala) => {
    if (salas[sala] && socket.id === salas[sala].hostId) {
      salas[sala].juegoIniciado = false;
      if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);
      io.to(sala).emit('juego-detenido');
    }
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
      }
      io.to(sala).emit('partida-reiniciada');
      io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
      io.to(sala).emit('bote-actualizado', 0);
    }
  });

  socket.on('loteria', ({ nickname, sala, boardState }) => {
    if (!salas[sala]) return;
    const salaInfo = salas[sala];
    if (!salaInfo.juegoIniciado && !salaInfo.validandoEmpate) return;
    if (!salaInfo.validandoEmpate) {
        salaInfo.juegoIniciado = false;
        salaInfo.validandoEmpate = true;
        if (salaInfo.intervaloCartas) clearInterval(salaInfo.intervaloCartas);
        salaInfo.reclamantes.push({ id: socket.id, nickname, boardState, status: 'pendiente' });
        io.to(sala).emit('pausa-empate', { primerGanador: nickname, tiempo: 4 });
        salaInfo.timerEmpate = setTimeout(() => {
            io.to(salaInfo.hostId).emit('iniciar-validacion-secuencial', salaInfo.reclamantes);
        }, 4000);
    } else {
        const yaEsta = salaInfo.reclamantes.find(r => r.id === socket.id);
        if (!yaEsta) {
            salaInfo.reclamantes.push({ id: socket.id, nickname, boardState, status: 'pendiente' });
            io.to(sala).emit('notificar-otro-ganador', nickname);
        }
    }
  });

  socket.on('veredicto-host', async ({ sala, candidatoId, esValido }) => {
      const salaInfo = salas[sala];
      if (!salaInfo || socket.id !== salaInfo.hostId) return;
      const candidato = salaInfo.reclamantes.find(r => r.id === candidatoId);
      if (candidato) candidato.status = esValido ? 'validado' : 'rechazado';
      const pendientes = salaInfo.reclamantes.filter(r => r.status === 'pendiente');
      if (pendientes.length > 0) {
          io.to(salaInfo.hostId).emit('continuar-validacion', salaInfo.reclamantes);
      } else {
          const ganadoresReales = salaInfo.reclamantes.filter(r => r.status === 'validado');
          if (ganadoresReales.length > 0) {
              const boteTotal = salaInfo.bote;
              const premioPorCabeza = Math.floor(boteTotal / ganadoresReales.length);
              for (const g of ganadoresReales) {
                  const jugador = salaInfo.jugadores[g.id];
                  if (jugador) {
                      jugador.monedas += premioPorCabeza;
                      await actualizarSaldoUsuario(jugador);
                      await registrarMovimiento(jugador.email, 'victoria', premioPorCabeza, `Premio Lotería!`, true);
                  }
              }
              salaInfo.bote = 0;
              salaInfo.pagoRealizado = true;
              salaInfo.reclamantes = [];
              salaInfo.validandoEmpate = false;
              for (const id in salaInfo.jugadores) salaInfo.jugadores[id].apostado = false;
              io.to(sala).emit('ganadores-multiples', { ganadores: ganadoresReales.map(g => g.nickname), premio: premioPorCabeza });
              io.to(sala).emit('jugadores-actualizados', salaInfo.jugadores);
              io.to(sala).emit('bote-actualizado', 0);
          } else {
              salaInfo.validandoEmpate = false;
              salaInfo.reclamantes = [];
              salaInfo.juegoIniciado = true;
              io.to(sala).emit('falsa-alarma-masiva');
              repartirCartas(sala);
          }
      }
  });

  socket.on('salir-sala', async (sala) => {
    if (salas[sala] && salas[sala].jugadores[socket.id]) {
        await procesarReembolsoPorSalida(sala, socket.id);
        const eraHost = (salas[sala].hostId === socket.id);
        socket.leave(sala);
        delete salas[sala].jugadores[socket.id];
        if (Object.keys(salas[sala].jugadores).length === 0) {
            if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);
            delete salas[sala];
        } else {
            if (eraHost) {
                const nuevoHostId = Object.keys(salas[sala].jugadores)[0];
                salas[sala].hostId = nuevoHostId;
                salas[sala].jugadores[nuevoHostId].host = true;
                io.to(nuevoHostId).emit('rol-asignado', { host: true });
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
      io.to(sala).emit("reproducir-efecto-sonido", { soundId, emisor });
  });

 // =========================================================
  // 🐍 BLOQUE SERPIENTES Y ESCALERAS (PRIVADO + PÚBLICO) 🐍
  // =========================================================

  // --- TIENDA DE SKINS (Igual que antes) ---
  socket.on('comprar-skin', async ({ email, itemId, precio }) => {
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
          socket.emit('usuario-actualizado', docFinal.data());
          await registrarMovimiento(email, 'compra', precio, `Skin: ${itemId}`, false);
      } catch (e) { console.error("Error compra skin:", e); }
  });

  // --- 1. ENTRADA PÚBLICA (MATCHMAKING) ---
  socket.on('entrar-serpientes', async ({ email, nickname, apuesta, vsCpu, skin }) => {
      // Anti-Ghost
      for (const sId in salasSerpientes) { if (salasSerpientes[sId].jugadores.some(j => j.id === socket.id)) return; }

      const monto = parseInt(apuesta);
      const userRef = db.collection('usuarios').doc(email);
      const doc = await userRef.get();
      if (!doc.exists || doc.data().monedas < monto) return socket.emit('error-apuesta', 'Saldo insuficiente');

      await userRef.update({ monedas: admin.firestore.FieldValue.increment(-monto) });
      await registrarMovimiento(email, 'apuesta', monto, 'Serpientes Publica', false);
      socket.emit('usuario-actualizado', (await userRef.get()).data());

      let salaId = null;

      if (vsCpu) {
          salaId = `cpu_${socket.id}_${Date.now()}`;
          salasSerpientes[salaId] = {
              id: salaId, apuesta: monto, jugadores: [], turnoIndex: 0, 
              enJuego: false, bote: monto * 2, esVsCpu: true, esPrivada: false
          };
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
      const monto = parseInt(apuesta);
      const userRef = db.collection('usuarios').doc(email);
      const doc = await userRef.get();
      if (doc.data().monedas < monto) return socket.emit('error-apuesta', 'Saldo insuficiente');

      await userRef.update({ monedas: admin.firestore.FieldValue.increment(-monto) });
      await registrarMovimiento(email, 'apuesta', monto, 'Crear Mesa Serpientes', false);
      socket.emit('usuario-actualizado', (await userRef.get()).data());

      const codigo = Math.floor(1000 + Math.random() * 9000).toString();
      const salaId = `privada_s_${codigo}`;

      salasSerpientes[salaId] = {
          id: salaId, codigo: codigo, apuesta: monto, bote: 0, jugadores: [], 
          turnoIndex: 0, enJuego: false, esVsCpu: false, esPrivada: true, hostId: socket.id
      };

      unirseSalaSerpientesLogica(socket, salaId, email, nickname, monto, false, skin);
  });

  // --- 3. UNIRSE A PRIVADA ---
  socket.on('unirse-sala-serpientes-privada', async ({ email, nickname, codigo, skin }) => {
      const salaId = Object.keys(salasSerpientes).find(id => salasSerpientes[id].codigo === codigo);
      
      if (!salaId) return socket.emit('error-apuesta', 'Sala no encontrada');
      const sala = salasSerpientes[salaId];
      if (sala.enJuego) return socket.emit('error-apuesta', 'Ya inició la partida');
      if (sala.jugadores.length >= 4) return socket.emit('error-apuesta', 'Sala llena');

      const monto = sala.apuesta;
      const userRef = db.collection('usuarios').doc(email);
      const doc = await userRef.get();
      if (doc.data().monedas < monto) return socket.emit('error-apuesta', `Necesitas $${monto}`);

      await userRef.update({ monedas: admin.firestore.FieldValue.increment(-monto) });
      await registrarMovimiento(email, 'apuesta', monto, `Unirse Serpientes ${codigo}`, false);
      socket.emit('usuario-actualizado', (await userRef.get()).data());

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
      io.to(sala.id).emit('inicio-partida-serpientes', { salaId: sala.id, jugadores: sala.jugadores });
      io.to(sala.id).emit('turno-asignado', sala.jugadores[0].nickname);
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
              socket.emit('usuario-actualizado', docUpd.data());
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

      const dado = Math.floor(Math.random() * 6) + 1;
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
      // Validar Saldo
      const monto = parseInt(apuesta);
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
      socket.emit('usuario-actualizado', nuevoDoc.data());

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
      const monto = parseInt(apuesta);
      const userRef = db.collection('usuarios').doc(email);
      const doc = await userRef.get();
      if (doc.data().monedas < monto) return socket.emit('error-apuesta', 'Saldo insuficiente');

      // Cobrar
      await userRef.update({ monedas: admin.firestore.FieldValue.increment(-monto) });
      await registrarMovimiento(email, 'apuesta', monto, 'Crear Mesa Privada', false);
      socket.emit('usuario-actualizado', (await userRef.get()).data());

      // Generar Código 4 Dígitos
      const codigo = Math.floor(1000 + Math.random() * 9000).toString();
      const salaId = `privada_${codigo}`;

      salasPirinola[salaId] = {
          id: salaId, codigo: codigo, apuesta: monto, bote: 0, jugadores: [], 
          turnoIndex: 0, enJuego: false, esVsCpu: false, esPrivada: true, hostId: socket.id
      };

      unirseALaSalaLogica(socket, salaId, email, nickname, monto, false);
  });

  // --- 3. UNIRSE A SALA PRIVADA (NUEVO) ---
  socket.on('unirse-sala-privada', async ({ email, nickname, codigo }) => {
      // Buscar sala por código
      const salaId = Object.keys(salasPirinola).find(id => salasPirinola[id].codigo === codigo);
      
      if (!salaId) return socket.emit('error-apuesta', 'Sala no encontrada');
      const sala = salasPirinola[salaId];
      if (sala.enJuego) return socket.emit('error-apuesta', 'La partida ya comenzó');
      if (sala.jugadores.length >= 6) return socket.emit('error-apuesta', 'Sala llena');

      const monto = sala.apuesta;
      const userRef = db.collection('usuarios').doc(email);
      const doc = await userRef.get();
      if (doc.data().monedas < monto) return socket.emit('error-apuesta', `Necesitas $${monto} para entrar`);

      // Cobrar
      await userRef.update({ monedas: admin.firestore.FieldValue.increment(-monto) });
      await registrarMovimiento(email, 'apuesta', monto, `Unirse Mesa ${codigo}`, false);
      socket.emit('usuario-actualizado', (await userRef.get()).data());

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
          sala.jugadores.push({ id: 'bot_banca', email: 'banca', nickname: '🤖 La Banca', esBot: true });
          sala.bote += monto;
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
      sala.turnoIndex = Math.floor(Math.random() * sala.jugadores.length); 
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

      const resultado = Math.floor(Math.random() * 6) + 1; 
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
      sala.bote += cantidad;
      if (!jugador.esBot) {
          const userRef = db.collection('usuarios').doc(jugador.email);
          await userRef.update({ monedas: admin.firestore.FieldValue.increment(-cantidad) });
      }
  }

  async function pagarPirinola(jugador, cantidad, sala, concepto) {
      const pago = Math.min(cantidad, sala.bote);
      sala.bote -= pago;
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
              if(Object.keys(salas[salaId].jugadores).length === 0) {
                  if(salas[salaId].intervaloCartas) clearInterval(salas[salaId].intervaloCartas);
                  delete salas[salaId];
              } else {
                  if(eraHost) {
                      const nuevoHost = Object.keys(salas[salaId].jugadores)[0];
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

http.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});