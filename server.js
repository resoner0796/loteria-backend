// server.js - Backend Lotería + Serpientes + Pirinola + Hub

// ==================== CONFIG FIREBASE ====================
const admin = require('firebase-admin');
// Asegúrate de que tu variable de entorno 'nicknames' tenga el JSON correcto
const serviceAccount = JSON.parse(process.env.nicknames); 

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// --- HELPER PARA REGISTRAR MOVIMIENTOS EN EL HISTORIAL ---
async function registrarMovimiento(email, tipo, monto, descripcion, esIngreso) {
    if(!email) return; 
    try {
        await db.collection('usuarios').doc(email).collection('historial').add({
            tipo: tipo,        // Ej: 'transferencia', 'compra', 'apuesta', 'recarga', 'victoria'
            monto: parseInt(monto),
            descripcion: descripcion,
            esIngreso: esIngreso, // true (verde/positivo) o false (rojo/negativo)
            fecha: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`📜 Historial: ${tipo} | ${descripcion} | ${email}`);
    } catch (e) {
        console.error("Error guardando historial:", e);
    }
}

// ==================== CONFIG EXPRESS + SOCKET ====================
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { origin: '*' }
});
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bcrypt = require('bcryptjs'); 
const cors = require('cors');

app.use(cors());
app.use(express.json()); 

const PORT = process.env.PORT || 3000;

// ==================== VARIABLES GLOBALES ====================
const salas = {}; // Lotería
const salasSerpientes = {}; // Serpientes
const salasPirinola = {}; // Pirinola 🌀

const SNAKES = { 18:6, 25:9, 33:19, 41:24, 48:32, 53:13 };
const LADDERS = { 3:15, 11:28, 22:36, 30:44, 38:49, 46:51 };

// ==================== RUTAS DE API ====================

app.get('/', (req, res) => {
  res.send('Servidor de Lotería "Pro" funcionando ✅');
});

// 1. REGISTRO
app.post('/api/registro', async (req, res) => {
    const { email, password, nickname } = req.body;
    try {
        const userRef = db.collection('usuarios').doc(email);
        const doc = await userRef.get();
        if (doc.exists) return res.status(400).json({ error: 'El correo ya está registrado.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        await userRef.set({
            email, password: hashedPassword, nickname, monedas: 20, creado: new Date()
        });
        res.json({ success: true, nickname, monedas: 20, email });
    } catch (error) {
        console.error("Error registro:", error);
        res.status(500).json({ error: 'Error en el servidor.' });
    }
});

// 2. LOGIN
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const userRef = db.collection('usuarios').doc(email);
        const doc = await userRef.get();
        if (!doc.exists) return res.status(400).json({ error: 'Usuario no encontrado.' });

        const userData = doc.data();
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
    } catch (error) {
        console.error("Error login:", error);
        res.status(500).json({ error: 'Error en el servidor.' });
    }
});

// 3. DATOS FRESCOS
app.get('/api/usuario/datos-frescos', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Falta email" });

    try {
        const userDoc = await db.collection('usuarios').doc(email).get();
        if (!userDoc.exists) return res.status(404).json({ error: "Usuario no encontrado" });
        
        const saldoActual = userDoc.data().monedas || 0;

        const historialSnapshot = await db.collection('usuarios').doc(email).collection('historial')
            .orderBy('fecha', 'desc')
            .limit(20)
            .get();

        const historial = historialSnapshot.docs.map(doc => {
            const data = doc.data();
            const fechaObj = data.fecha ? data.fecha.toDate() : new Date();
            const fechaStr = fechaObj.toLocaleDateString("es-MX") + ' ' + fechaObj.toLocaleTimeString("es-MX", {hour: '2-digit', minute:'2-digit'});
            
            return {
                id: doc.id,
                tipo: data.tipo,
                monto: data.monto,
                descripcion: data.descripcion,
                esIngreso: data.esIngreso,
                cantidad: data.monto,
                concepto: data.descripcion,
                fecha: fechaStr
            };
        });

        res.json({ success: true, monedas: saldoActual, historial });

    } catch (error) {
        console.error("Error obteniendo datos frescos:", error);
        res.status(500).json({ error: "Error de servidor" });
    }
});

// BUSCAR USUARIO
app.get('/api/buscar-destinatario', async (req, res) => {
    const { nickname } = req.query;
    if (!nickname) return res.json({ success: false, error: "Falta nickname" });
    try {
        const snapshot = await db.collection('usuarios').where('nickname', '==', nickname).limit(1).get();
        if (snapshot.empty) return res.json({ success: false, error: "Usuario no encontrado" });
        const doc = snapshot.docs[0];
        return res.json({ 
            success: true, 
            destinatario: { email: doc.id, nickname: doc.data().nickname } 
        });
    } catch (error) {
        console.error("Error buscando usuario:", error);
        res.status(500).json({ success: false, error: "Error en servidor" });
    }
});

// TRANSFERENCIA
app.post('/api/transferir-saldo', async (req, res) => {
    const { origenEmail, destinoEmail, cantidad } = req.body;
    const monto = parseInt(cantidad);
    if (!origenEmail || !destinoEmail || monto <= 0) return res.json({ success: false, error: "Datos inválidos" });

    try {
        await db.runTransaction(async (t) => {
            const origenRef = db.collection('usuarios').doc(origenEmail);
            const destinoRef = db.collection('usuarios').doc(destinoEmail);
            const docOrigen = await t.get(origenRef);
            const docDestino = await t.get(destinoRef);

            if (!docOrigen.exists || !docDestino.exists) throw "Uno de los usuarios no existe";
            if (docOrigen.data().monedas < monto) throw "Saldo insuficiente";

            t.update(origenRef, { monedas: admin.firestore.FieldValue.increment(-monto) });
            t.update(destinoRef, { monedas: admin.firestore.FieldValue.increment(monto) });
        });

        const destinoRef = db.collection('usuarios').doc(destinoEmail);
        const origenRef = db.collection('usuarios').doc(origenEmail);
        const docDestino = await destinoRef.get();
        const docOrigen = await origenRef.get();

        await registrarMovimiento(origenEmail, 'transferencia', monto, `Envío a ${docDestino.data().nickname}`, false);
        await registrarMovimiento(destinoEmail, 'transferencia', monto, `Recibido de ${docOrigen.data().nickname}`, true);

        res.json({ success: true });
    } catch (e) {
        console.error("Error transferencia:", e);
        res.json({ success: false, error: e.toString() });
    }
});

// ==================== FUNCIONES AUXILIARES ====================

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

// ==================== PAGOS STRIPE ====================

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
                price_data: {
                    currency: 'mxn',
                    product_data: { name: `Paquete de ${cantidad} Monedas` },
                    unit_amount: Math.round(precio * 100), 
                },
                quantity: 1,
            }],
            mode: 'payment',
            metadata: { email_usuario: email, monedas_a_dar: cantidad, origen_pago: origen || 'loteria' },
            return_url: `${BACKEND_URL}/api/confirmar-pago?session_id={CHECKOUT_SESSION_ID}`,
        });
        res.json({ clientSecret: session.client_secret });
    } catch (error) { res.status(500).json({ error: "No se pudo crear la orden" }); }
});

app.get('/api/confirmar-pago', async (req, res) => {
    const { session_id } = req.query;
    try {
        const session = await stripe.checkout.sessions.retrieve(session_id);
        if (session.payment_status === 'paid') {
            const email = session.metadata.email_usuario;
            const monedasExtra = parseInt(session.metadata.monedas_a_dar);
            const origen = session.metadata.origen_pago;
            
            const userRef = db.collection('usuarios').doc(email);
            const doc = await userRef.get();
            if (doc.exists) {
                await userRef.update({ monedas: (doc.data().monedas || 0) + monedasExtra });
                await registrarMovimiento(email, 'recarga', monedasExtra, 'Recarga con Tarjeta', true);
            }

            if (origen === 'hub') {
                res.redirect(`${FRONTEND_HUB}/index.html?pago=exito&cantidad=${monedasExtra}`);
            } else {
                res.redirect(`${FRONTEND_LOTERIA}/index.html?pago=exito&cantidad=${monedasExtra}`);
            }
        } else {
            res.redirect(`${FRONTEND_HUB}/index.html?pago=cancelado`);
        }
    } catch (error) { res.redirect(`${FRONTEND_HUB}/index.html?pago=error`); }
});

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

// ==================== PANEL ADMIN & HUB ====================
const ADMIN_EMAIL = "admin@loteria.com"; 

app.get('/api/admin/usuarios', async (req, res) => {
    const solicitante = req.headers['admin-email'];
    if (solicitante !== ADMIN_EMAIL) return res.status(403).json({ error: "Sin permiso." });
    try {
        const snapshot = await db.collection('usuarios').get();
        const usuarios = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            usuarios.push({ email: data.email, nickname: data.nickname, monedas: data.monedas });
        });
        res.json(usuarios);
    } catch (error) { res.status(500).json({ error: "Error de servidor" }); }
});

app.post('/api/admin/recargar-manual', async (req, res) => {
    const { adminEmail, targetEmail, cantidad } = req.body;
    if (adminEmail !== ADMIN_EMAIL) return res.status(403).json({ error: "Acceso denegado." });
    try {
        const userRef = db.collection('usuarios').doc(targetEmail);
        const doc = await userRef.get();
        if (!doc.exists) return res.status(404).json({ error: "Usuario no encontrado." });
        const nuevasMonedas = (doc.data().monedas || 0) + parseInt(cantidad);
        await userRef.update({ monedas: nuevasMonedas });
        await registrarMovimiento(targetEmail, 'recarga', cantidad, 'Recarga Admin', true);
        res.json({ success: true, nuevoSaldo: nuevasMonedas });
    } catch (error) { res.status(500).json({ error: "Error en recarga." }); }
});

app.get('/api/hub/juegos', async (req, res) => {
    try {
        const snapshot = await db.collection('juegos_hub').get();
        const juegos = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json({ success: true, juegos });
    } catch (error) { res.status(500).json({ error: "Error al cargar juegos" }); }
});

app.post('/api/hub/nuevo-juego', async (req, res) => {
    const { adminEmail, titulo, url, imgPoster, descripcion, estado } = req.body;
    if (adminEmail !== ADMIN_EMAIL) return res.status(403).json({ error: "Sin permiso" });
    try {
        await db.collection('juegos_hub').add({
            titulo, url, imgPoster, descripcion, estado, creado: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: "Error al guardar juego" }); }
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


// ==================== SOCKET.IO (LÓGICA REAL TIME) ====================

io.on('connection', (socket) => {
  console.log('Nuevo socket conectado:', socket.id);

  // --- GENERAL ---
  socket.on('solicitar-info-usuario', async (email) => {
      try {
          const doc = await db.collection('usuarios').doc(email).get();
          if (doc.exists) socket.emit('usuario-actualizado', doc.data());
      } catch (e) { console.error(e); }
  });

  // =========================================================
  // 🃏 LÓGICA DE LOTERÍA 🃏
  // =========================================================

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

    salas[sala].jugadores[socket.id] = { 
      nickname, email, monedas: monedasIniciales, apostado: false, cartas: [], id: socket.id, host: (socket.id === salas[sala].hostId) 
    };

    io.to(sala).emit('info-sala', { modo: salas[sala].modoJuego });
    const cartasOcupadas = Object.values(salas[sala].jugadores).flatMap(j => j.cartas);
    io.to(sala).emit('cartas-desactivadas', cartasOcupadas);
    io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
    io.to(sala).emit('bote-actualizado', salas[sala].bote);
    io.to(sala).emit('historial-actualizado', salas[sala].historial);
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
  });

  socket.on("enviar-efecto-sonido", ({ sala, soundId, emisor }) => {
      io.to(sala).emit("reproducir-efecto-sonido", { soundId, emisor });
  });

  // =========================================================
  // 🐍 BLOQUE SERPIENTES Y ESCALERAS 🐍
  // =========================================================

  // --- TIENDA DE SKINS ---
  socket.on('comprar-skin', async ({ email, itemId, precio }) => {
      try {
          const userRef = db.collection('usuarios').doc(email);
          await db.runTransaction(async (t) => {
              const doc = await t.get(userRef);
              if (!doc.exists) return;
              const data = doc.data();
              if ((data.monedas || 0) < precio) return;
              if ((data.inventario || []).includes(itemId)) return;

              t.update(userRef, {
                  monedas: data.monedas - precio,
                  inventario: admin.firestore.FieldValue.arrayUnion(itemId)
              });
          });
          const docFinal = await userRef.get();
          socket.emit('usuario-actualizado', docFinal.data());
          await registrarMovimiento(email, 'compra', precio, `Skin: ${itemId}`, false);
      } catch (e) { console.error("Error compra skin:", e); }
  });

  // --- ENTRADA AL JUEGO SERPIENTES ---
  socket.on('entrar-serpientes', async ({ email, nickname, apuesta, vsCpu, skin }) => {
      // ANTI-GHOST: Evitar doble entrada
      for (const sId in salasSerpientes) {
          if (salasSerpientes[sId].jugadores.some(j => j.id === socket.id)) return;
      }

      const monto = parseInt(apuesta);
      const userRef = db.collection('usuarios').doc(email);
      const doc = await userRef.get();
      if (!doc.exists || doc.data().monedas < monto) {
          socket.emit('error-apuesta', 'Saldo insuficiente');
          return;
      }

      // Cobrar entrada
      await userRef.update({ monedas: admin.firestore.FieldValue.increment(-monto) });
      await registrarMovimiento(email, 'apuesta', monto, 'Serpientes', false);
      
      const nuevoDoc = await userRef.get();
      socket.emit('usuario-actualizado', nuevoDoc.data());

      let salaId = null;

      if (vsCpu) {
          salaId = `cpu_${socket.id}_${Date.now()}`;
          salasSerpientes[salaId] = {
              id: salaId, apuesta: monto, jugadores: [], turnoIndex: 0,
              enJuego: false, bote: monto * 2, esVsCpu: true 
          };
      } else {
          // Matchmaking simple
          salaId = Object.keys(salasSerpientes).find(id => 
              !salasSerpientes[id].esVsCpu && 
              salasSerpientes[id].apuesta === monto && 
              salasSerpientes[id].jugadores.length < 4 && 
              !salasSerpientes[id].enJuego
          );

          if (!salaId) {
              salaId = `mesa_${monto}_${Date.now().toString().slice(-4)}`;
              salasSerpientes[salaId] = {
                  id: salaId, apuesta: monto, jugadores: [], turnoIndex: 0,
                  enJuego: false, bote: 0, esVsCpu: false
              };
          }
      }

      const sala = salasSerpientes[salaId];
      socket.join(salaId);

      // Agregar jugador
      if (!sala.jugadores.some(j => j.id === socket.id)) {
          sala.jugadores.push({ 
              id: socket.id, email, nickname, posicion: 1, esBot: false, skin: skin || '🔵' 
          });
          if (!sala.esVsCpu) sala.bote += monto; 
      }

      // Agregar Bot si es necesario
      if (sala.esVsCpu && !sala.jugadores.some(j => j.esBot)) {
          sala.jugadores.push({
              id: 'cpu_bot', email: 'banca@juegosenlanube.com', nickname: '🤖 La Banca',
              posicion: 1, esBot: true, skin: '🤖'
          });
      }

      socket.emit('sala-conectada', { salaId: salaId, jugadoresConectados: sala.jugadores.length });
      io.to(salaId).emit('jugador-entro', sala.jugadores.length);

      // Iniciar juego
      const listosParaIniciar = sala.esVsCpu || (sala.jugadores.length >= 2);

      if (listosParaIniciar && !sala.enJuego) {
          if (sala.timerInicio) clearTimeout(sala.timerInicio);

          const tiempoEspera = sala.esVsCpu ? 1500 : 4000;
          if(!sala.esVsCpu) io.to(salaId).emit('notificacion', 'Jugador encontrado. Iniciando...');
          
          sala.timerInicio = setTimeout(() => {
              if(salasSerpientes[salaId] && salasSerpientes[salaId].jugadores.length >= 2) {
                  sala.enJuego = true;
                  sala.timerInicio = null;
                  // Mandar la lista de jugadores para inicializar posiciones
                  io.to(salaId).emit('inicio-partida-serpientes', { salaId: salaId, jugadores: sala.jugadores });
                  io.to(salaId).emit('turno-asignado', sala.jugadores[0].nickname);
              }
          }, tiempoEspera);
      }
  });

  // --- SALIR DE SALA DE ESPERA (REEMBOLSO SERPIENTES) ---
  socket.on('salir-sala-espera', async (salaId) => {
      const sala = salasSerpientes[salaId];
      // Solo reembolsamos si la sala existe y el juego NO ha iniciado (o si es vs CPU)
      if (sala && (!sala.enJuego || sala.esVsCpu)) {
          const index = sala.jugadores.findIndex(j => j.id === socket.id);
          if (index !== -1) {
              const jugador = sala.jugadores[index];
              const reembolso = sala.apuesta;

              const userRef = db.collection('usuarios').doc(jugador.email);
              await userRef.update({ monedas: admin.firestore.FieldValue.increment(reembolso) });
              await registrarMovimiento(jugador.email, 'reembolso', reembolso, 'Salida Sala Serpientes', true);
              
              const docUpd = await userRef.get();
              socket.emit('usuario-actualizado', docUpd.data());
              socket.emit('reembolso-exitoso', docUpd.data().monedas);

              sala.jugadores.splice(index, 1);
              socket.leave(salaId);

              // Limpieza sala
              if (sala.jugadores.length === 0 || sala.esVsCpu) {
                  delete salasSerpientes[salaId];
              } else {
                  io.to(salaId).emit('jugador-entro', sala.jugadores.length);
              }
          }
      }
  });

  // --- JUEGO SERPIENTES (DADOS) ---
  socket.on('tirar-dado-serpientes', (salaId) => { procesarTurnoSerpientes(salaId, socket.id); });

  function procesarTurnoSerpientes(salaId, solicitanteId) {
      const sala = salasSerpientes[salaId];
      if (!sala || !sala.enJuego) return;

      const jugadorActual = sala.jugadores[sala.turnoIndex];
      if (!jugadorActual.esBot && jugadorActual.id !== solicitanteId) return;

      const dado = Math.floor(Math.random() * 6) + 1;
      let nuevaPos = jugadorActual.posicion + dado;

      // Rebote exacto
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
  }

  // =========================================================
  // 🌀 BLOQUE PIRINOLA ROYAL (MODO VS CPU & MULTI) 🌀
  // =========================================================

  // --- ENTRAR A PIRINOLA ---
  socket.on('entrar-pirinola', async ({ email, nickname, apuesta, vsCpu }) => {
      const monto = parseInt(apuesta);
      const userRef = db.collection('usuarios').doc(email);
      const doc = await userRef.get();
      
      if (!doc.exists || doc.data().monedas < monto) {
          socket.emit('error-apuesta', 'Saldo insuficiente');
          return;
      }

      // Cobrar Entrada (Ante)
      await userRef.update({ monedas: admin.firestore.FieldValue.increment(-monto) });
      await registrarMovimiento(email, 'apuesta', monto, 'Pirinola Royal', false);
      const nuevoDoc = await userRef.get();
      socket.emit('usuario-actualizado', nuevoDoc.data());

      let salaId = null;

      // Lógica de Matchmaking o Crear Sala
      if (vsCpu) {
          salaId = `cpu_${socket.id}_${Date.now()}`;
          salasPirinola[salaId] = {
              id: salaId, apuesta: monto, bote: 0, jugadores: [], turnoIndex: 0, enJuego: false, esVsCpu: true
          };
      } else {
          salaId = Object.keys(salasPirinola).find(id => 
              !salasPirinola[id].esVsCpu && // No unir a salas de CPU
              salasPirinola[id].apuesta === monto && 
              salasPirinola[id].jugadores.length < 6 && 
              !salasPirinola[id].enJuego
          );

          if (!salaId) {
              salaId = `pirinola_${monto}_${Date.now()}`;
              salasPirinola[salaId] = {
                  id: salaId, apuesta: monto, bote: 0, jugadores: [], turnoIndex: 0, enJuego: false, esVsCpu: false
              };
          }
      }

      const sala = salasPirinola[salaId];
      socket.join(salaId);

      // Agregar HUMANO
      sala.jugadores.push({ id: socket.id, email, nickname, esBot: false });
      sala.bote += monto; // Pone su entrada

      // Si es Vs CPU, agregar al BOT y poner su entrada
      if(vsCpu) {
          sala.jugadores.push({ id: 'bot_banca', email: 'banca', nickname: '🤖 La Banca', esBot: true });
          sala.bote += monto; // La banca iguala la entrada
      }

      socket.emit('sala-encontrada', sala);
      io.to(salaId).emit('actualizar-estado-pirinola', sala);

      // Iniciar Juego
      const jugadoresNecesarios = vsCpu ? 2 : 2; // Minimo 2 para multi
      if (sala.jugadores.length >= jugadoresNecesarios && !sala.enJuego) {
          if(sala.timerInicio) clearTimeout(sala.timerInicio);
          
          const tiempoEspera = vsCpu ? 1000 : 3000;
          sala.timerInicio = setTimeout(() => {
              sala.enJuego = true;
              io.to(salaId).emit('notificacion', '¡Juego Iniciado!');
              sala.turnoIndex = Math.floor(Math.random() * sala.jugadores.length); // Turno random
              io.to(salaId).emit('actualizar-estado-pirinola', sala);
              
              // Si le toca al bot iniciar
              verificarTurnoBot(sala);

          }, tiempoEspera);
      }
  });

  // --- TIRAR PIRINOLA (Humano) ---
  socket.on('tirar-pirinola', (salaId) => {
      procesarTurnoPirinola(salaId, socket.id);
  });

  // --- LÓGICA CENTRAL DE TURNOS PIRINOLA ---
  function procesarTurnoPirinola(salaId, solicitanteId) {
      const sala = salasPirinola[salaId];
      if (!sala || !sala.enJuego) return;

      const jugador = sala.jugadores[sala.turnoIndex];
      
      // Validar que sea turno del que llama (o si es el sistema llamando al bot)
      if (solicitanteId !== 'sistema' && jugador.id !== solicitanteId) return;

      // 1: Pon 1, 2: Pon 2, 3: Toma 1, 4: Toma 2, 5: Toma Todo, 6: Todos Ponen
      const resultado = Math.floor(Math.random() * 6) + 1; 
      const angulos = { 1: 0, 2: -60, 3: -120, 4: -180, 5: -240, 6: -300 };
      const rotacion = angulos[resultado] + (360 * 5); 

      // Notificar giro
      io.to(salaId).emit('resultado-giro', { cara: resultado, nuevaRotacion: rotacion });

      // Esperar animación (3s) y aplicar reglas
      setTimeout(async () => {
          let mensaje = "";
          const nombre = jugador.nickname;

          try {
              if (resultado === 1) { // PON 1
                  mensaje = `${nombre} puso $1`;
                  await cobrarPirinola(jugador, 1, sala);
              } 
              else if (resultado === 2) { // PON 2
                  mensaje = `${nombre} puso $2`;
                  await cobrarPirinola(jugador, 2, sala);
              } 
              else if (resultado === 3) { // TOMA 1
                  mensaje = `${nombre} tomó $1`;
                  pagarPirinola(jugador, 1, sala);
              } 
              else if (resultado === 4) { // TOMA 2
                  mensaje = `${nombre} tomó $2`;
                  pagarPirinola(jugador, 2, sala);
              } 
              else if (resultado === 5) { // TOMA TODO
                  mensaje = `¡${nombre} SE LLEVÓ EL BOTE! 🎉`;
                  const total = sala.bote;
                  pagarPirinola(jugador, total, sala);
                  io.to(salaId).emit('fin-juego-pirinola', { ganador: jugador.nickname, premio: total });
                  delete salasPirinola[salaId]; // Fin del juego
                  return; 
              } 
              else if (resultado === 6) { // TODOS PONEN
                  mensaje = "¡TODOS PONEN $1!";
                  for (let j of sala.jugadores) {
                      await cobrarPirinola(j, 1, sala);
                  }
              }

              // Siguiente turno
              sala.turnoIndex = (sala.turnoIndex + 1) % sala.jugadores.length;
              io.to(salaId).emit('actualizar-estado-pirinola', sala);
              io.to(salaId).emit('notificacion', mensaje);

              // Si sigue el bot
              verificarTurnoBot(sala);

          } catch (e) { console.error("Error lógica pirinola:", e); }

      }, 3000);
  }

  function verificarTurnoBot(sala) {
      const jugadorActual = sala.jugadores[sala.turnoIndex];
      if (jugadorActual && jugadorActual.esBot) {
          // El bot "piensa" 2 segundos y tira
          setTimeout(() => {
              procesarTurnoPirinola(sala.id, 'sistema'); 
          }, 2000);
      }
  }

  // --- HELPERS FINANCIEROS PIRINOLA (Manejan Bot vs Humano) ---
  async function cobrarPirinola(jugador, cantidad, sala) {
      sala.bote += cantidad;
      
      // Si es humano, descontamos de su DB
      if (!jugador.esBot) {
          const userRef = db.collection('usuarios').doc(jugador.email);
          await userRef.update({ monedas: admin.firestore.FieldValue.increment(-cantidad) });
      }
  }

  function pagarPirinola(jugador, cantidad, sala) {
      const pago = Math.min(cantidad, sala.bote);
      sala.bote -= pago;

      // Si es humano, le damos el dinero en DB
      if (!jugador.esBot) {
          const userRef = db.collection('usuarios').doc(jugador.email);
          userRef.update({ monedas: admin.firestore.FieldValue.increment(pago) });
      }
  }

  // ==================== DESCONEXIÓN GLOBAL UNIFICADA ====================
  socket.on('disconnect', () => {
      console.log('Socket desconectado:', socket.id);
      
      // 1. Limpieza Lotería
      for (const salaId in salas) {
          if(salas[salaId].jugadores[socket.id]) {
              const jugador = salas[salaId].jugadores[socket.id];
              if (!salas[salaId].juegoIniciado && jugador.apostado) {
                  procesarReembolsoPorSalida(salaId, socket.id);
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

      // 2. Limpieza Serpientes
      for (const sId in salasSerpientes) {
          const sala = salasSerpientes[sId];
          const idx = sala.jugadores.findIndex(j => j.id === socket.id);
          if (idx !== -1) {
              sala.jugadores.splice(idx, 1);
              if (sala.jugadores.length === 0 || sala.esVsCpu) {
                  delete salasSerpientes[sId];
              } else {
                  if(!sala.enJuego) io.to(sId).emit('jugador-entro', sala.jugadores.length);
              }
          }
      }

      // 3. Limpieza Pirinola 🌀
      for (const pId in salasPirinola) {
          const sala = salasPirinola[pId];
          const idx = sala.jugadores.findIndex(j => j.id === socket.id);
          if (idx !== -1) {
              sala.jugadores.splice(idx, 1);
              // Si queda vacío o es vs CPU, eliminar sala
              if (sala.jugadores.length === 0 || sala.esVsCpu) {
                  delete salasPirinola[pId];
              } else {
                  io.to(pId).emit('actualizar-estado-pirinola', sala);
              }
          }
      }
  });

}); // FIN DE IO.ON (IMPORTANTE)

http.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});