// server.js

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
    if(!email) return; // Si no hay email, no guardamos nada
    try {
        await db.collection('usuarios').doc(email).collection('historial').add({
            tipo: tipo,        // Ej: 'transferencia', 'compra', 'apuesta', 'recarga'
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

// Estado del juego por sala
const salas = {};

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

        if (doc.exists) {
            return res.status(400).json({ error: 'El correo ya está registrado.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await userRef.set({
            email,
            password: hashedPassword,
            nickname,
            monedas: 20, 
            creado: new Date()
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

        if (!doc.exists) {
            return res.status(400).json({ error: 'Usuario no encontrado.' });
        }

        const userData = doc.data();

        const validPassword = await bcrypt.compare(password, userData.password);
        if (!validPassword) {
            return res.status(400).json({ error: 'Contraseña incorrecta.' });
        }

        res.json({ 
            success: true, 
            nickname: userData.nickname, 
            monedas: userData.monedas, 
            email: userData.email 
        });

    } catch (error) {
        console.error("Error login:", error);
        res.status(500).json({ error: 'Error en el servidor.' });
    }
});

// OBTENER HISTORIAL DE MOVIMIENTOS
app.get('/api/historial-usuario', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.json({ success: false, error: "Falta email" });

    try {
        const snapshot = await db.collection('usuarios').doc(email)
            .collection('historial')
            .orderBy('fecha', 'desc') // Los más nuevos primero
            .limit(50) // Traemos los últimos 50 para no saturar
            .get();

        const movimientos = snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                ...data,
                // Convertimos el Timestamp de Firebase a fecha legible
                fecha: data.fecha ? data.fecha.toDate() : new Date() 
            };
        });

        res.json({ success: true, movimientos });
    } catch (e) {
        console.error("Error obteniendo historial:", e);
        res.status(500).json({ success: false, error: "Error servidor" });
    }
});

// BUSCAR USUARIO POR NICKNAME (Para transferencias)
app.get('/api/buscar-destinatario', async (req, res) => {
    const { nickname } = req.query;

    if (!nickname) return res.json({ success: false, error: "Falta nickname" });

    try {
        // Buscamos en toda la colección de usuarios quién tiene ese nickname
        const snapshot = await db.collection('usuarios')
            .where('nickname', '==', nickname)
            .limit(1)
            .get();

        if (snapshot.empty) {
            return res.json({ success: false, error: "Usuario no encontrado" });
        }

        // Si lo encuentra, devolvemos su email (que es el ID real)
        const doc = snapshot.docs[0];
        return res.json({ 
            success: true, 
            destinatario: { 
                email: doc.id, // IMPORTANTE: Necesitamos el email para transferirle
                nickname: doc.data().nickname 
            } 
        });

    } catch (error) {
        console.error("Error buscando usuario:", error);
        res.status(500).json({ success: false, error: "Error en servidor" });
    }
});

// REALIZAR TRANSFERENCIA ENTRE USUARIOS (CON HISTORIAL)
app.post('/api/transferir-saldo', async (req, res) => {
    const { origenEmail, destinoEmail, cantidad } = req.body;
    const monto = parseInt(cantidad);

    if (!origenEmail || !destinoEmail || monto <= 0) {
        return res.json({ success: false, error: "Datos inválidos" });
    }

    try {
        await db.runTransaction(async (t) => {
            const origenRef = db.collection('usuarios').doc(origenEmail);
            const destinoRef = db.collection('usuarios').doc(destinoEmail);

            const docOrigen = await t.get(origenRef);
            const docDestino = await t.get(destinoRef);

            if (!docOrigen.exists || !docDestino.exists) {
                throw "Uno de los usuarios no existe";
            }

            const saldoOrigen = docOrigen.data().monedas || 0;

            if (saldoOrigen < monto) {
                throw "Saldo insuficiente";
            }

            // Ejecutar el movimiento
            t.update(origenRef, { monedas: admin.firestore.FieldValue.increment(-monto) });
            t.update(destinoRef, { monedas: admin.firestore.FieldValue.increment(monto) });
            
            // --- NUEVO: Nicks para el historial ---
            const nickDestino = docDestino.data().nickname || "Usuario";
            const nickOrigen = docOrigen.data().nickname || "Usuario";

            // Guardar Historial (Fuera de la transacción estricta o aquí mismo)
            // Nota: En Firestore Admin, es mejor hacerlo aquí o justo después.
            // Para simplificar, lo haremos post-transacción para no bloquear si el log falla.
        });

        // REGISTRAR HISTORIAL (Después del éxito)
        const origenRef = db.collection('usuarios').doc(origenEmail);
        const destinoRef = db.collection('usuarios').doc(destinoEmail);
        const docDestino = await destinoRef.get(); // Obtenemos datos frescos para el nick
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

  console.log(`Sala ${sala}: Repartiendo cartas a velocidad ${velocidad}ms`);

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
            console.log(`✅ Saldo actualizado para ${jugador.email}`);
        } else {
            await db.collection('jugadores').doc(jugador.nickname).set({ monedas: jugador.monedas }, { merge: true });
        }
    } catch (error) {
        console.error("❌ Error al guardar saldo:", error);
    }
}

// ==================== PAGOS STRIPE (SOPORTE MULTI-DOMINIO) ====================

const FRONTEND_LOTERIA = "https://loteria-online-red.vercel.app"; 
const FRONTEND_HUB = "https://juegosenlanube.com"; // TU NUEVO DOMINIO
const BACKEND_URL = "https://loteria-backend-3nde.onrender.com";

app.post('/api/crear-orden', async (req, res) => {
    // Agregamos 'origen' para saber de dónde viene el pago
    const { cantidad, precio, email, origen } = req.body;
    
    try {
        const session = await stripe.checkout.sessions.create({
            ui_mode: 'embedded',
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'mxn',
                        product_data: { name: `Paquete de ${cantidad} Monedas` },
                        unit_amount: Math.round(precio * 100), 
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            metadata: {
                email_usuario: email,
                monedas_a_dar: cantidad,
                origen_pago: origen || 'loteria' // Guardamos quién pidió el pago
            },
            return_url: `${BACKEND_URL}/api/confirmar-pago?session_id={CHECKOUT_SESSION_ID}`,
        });

        res.json({ clientSecret: session.client_secret });
    } catch (error) {
        console.error("Error Stripe:", error);
        res.status(500).json({ error: "No se pudo crear la orden" });
    }
});

app.get('/api/confirmar-pago', async (req, res) => {
    const { session_id } = req.query;

    try {
        const session = await stripe.checkout.sessions.retrieve(session_id);
        
        if (session.payment_status === 'paid') {
            const email = session.metadata.email_usuario;
            const monedasExtra = parseInt(session.metadata.monedas_a_dar);
            const origen = session.metadata.origen_pago; // Recuperamos el origen
            
            console.log(`💰 Pago confirmado (${origen}). Acreditando ${monedasExtra} a ${email}`);

            const userRef = db.collection('usuarios').doc(email);
            const doc = await userRef.get();
            
            if (doc.exists) {
                const actuales = doc.data().monedas || 0;
                await userRef.update({ monedas: actuales + monedasExtra });
                await registrarMovimiento(email, 'recarga', monedasExtra, 'Recarga con Tarjeta', true);
            }

            // REDIRECCIÓN INTELIGENTE
            if (origen === 'hub') {
                res.redirect(`${FRONTEND_HUB}/index.html?pago=exito&cantidad=${monedasExtra}`);
            } else {
                res.redirect(`${FRONTEND_LOTERIA}/index.html?pago=exito&cantidad=${monedasExtra}`);
            }

        } else {
            // Cancelado (Redirigir al Hub por defecto o según origen también si quieres pulirlo más)
            res.redirect(`${FRONTEND_HUB}/index.html?pago=cancelado`);
        }
    } catch (error) {
        console.error("Error confirmando pago:", error);
        res.redirect(`${FRONTEND_HUB}/index.html?pago=error`);
    }
});

// Función de Reembolso
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

        console.log(`🛡️ REEMBOLSO: Regresando ${reembolso} monedas a ${jugador.nickname}`);

        try {
            if (jugador.email) {
                await db.collection('usuarios').doc(jugador.email).update({ 
                    monedas: jugador.monedas 
                });
                // Historial de reembolso
                await registrarMovimiento(jugador.email, 'reembolso', reembolso, 'Reembolso por salir', true);
            }
        } catch (e) { console.error("Error guardando reembolso:", e); }
    }
}


// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  console.log('Nuevo socket conectado:', socket.id);

  socket.on('reconectar', ({ sala, email }) => {
      if (sala && salas[sala]) {
          const jugadorExistente = Object.values(salas[sala].jugadores).find(j => j.email === email);
          
          if (jugadorExistente) {
              socket.join(sala);
              const viejoSocketId = jugadorExistente.id;
              
              if (salas[sala].hostId === viejoSocketId) {
                  salas[sala].hostId = socket.id;
                  console.log(`👑 Host ID actualizado tras reconexión: ${socket.id}`);
              }

              salas[sala].jugadores[socket.id] = jugadorExistente;
              salas[sala].jugadores[socket.id].id = socket.id; 
              
              if (viejoSocketId !== socket.id) {
                  delete salas[sala].jugadores[viejoSocketId];
              }
              
              console.log(`♻️ Jugador ${jugadorExistente.nickname} RECONECTADO.`);
              
              socket.emit('estado-sala-restaurado', { 
                  enJuego: salas[sala].juegoIniciado,
                  cartas: jugadorExistente.cartas,
                  apostado: jugadorExistente.apostado,
                  monedas: jugadorExistente.monedas
              });
              
              socket.emit('rol-asignado', { host: (socket.id === salas[sala].hostId) });
              io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
          }
      }
  });
   
    socket.on('solicitar-info-usuario', async (email) => {
        try {
            const doc = await db.collection('usuarios').doc(email).get();
            if (doc.exists) {
                socket.emit('usuario-actualizado', doc.data());
            }
        } catch (e) {
            console.error(e);
        }
    });

    // --- COMPRA DE ITEMS (CON HISTORIAL) ---
    socket.on('comprar-item', async ({ email, itemId, precio }) => {
        try {
            const userRef = db.collection('usuarios').doc(email);
            
            await db.runTransaction(async (t) => {
                const doc = await t.get(userRef);
                if (!doc.exists) return;

                const data = doc.data();
                const monedas = data.monedas || 0;
                const inventario = data.inventario || [];

                if (monedas >= precio && !inventario.includes(itemId)) {
                    t.update(userRef, {
                        monedas: monedas - precio,
                        inventario: admin.firestore.FieldValue.arrayUnion(itemId)
                    });
                }
            });

            // Registrar historial y confirmar
            const docFinal = await userRef.get();
            await registrarMovimiento(email, 'compra', precio, `Compra: ${itemId}`, false);
            
            io.to(socket.id).emit('usuario-actualizado', docFinal.data());

        } catch (e) {
            console.error("Error comprando:", e);
        }
    });
   
    // EFECTOS DE SONIDO EN JUEGO
    socket.on("enviar-efecto-sonido", ({ sala, soundId, emisor }) => {
        io.to(sala).emit("reproducir-efecto-sonido", { soundId, emisor });
    });
   
  // --- UNIRSE A SALA ---
  socket.on('unirse-sala', async ({ nickname, email, sala, modo }) => { 
    socket.join(sala);

    if (!salas[sala]) {
      salas[sala] = {
        jugadores: {},
        baraja: [],
        historial: [],
        juegoIniciado: false,
        bote: 0,
        hostId: socket.id,
        intervaloCartas: null,
        pagoRealizado: false,
        velocidad: 3000,
        modoJuego: modo || 'clasico', 
        reclamantes: [],        
        validandoEmpate: false, 
        timerEmpate: null
      };
      socket.emit('rol-asignado', { host: true });
      console.log(`Sala '${sala}' creada por ${nickname} (Modo: ${salas[sala].modoJuego})`);
    } else {
      const esHost = (socket.id === salas[sala].hostId);
      socket.emit('rol-asignado', { host: esHost });
    }

    let monedasIniciales = 30;
    try {
        if(email) {
            const userDoc = await db.collection('usuarios').doc(email).get();
            if (userDoc.exists) monedasIniciales = userDoc.data().monedas;
        } else {
             const jugadorDoc = await db.collection('jugadores').doc(nickname).get();
             if (jugadorDoc.exists) monedasIniciales = jugadorDoc.data().monedas;
        }
    } catch (error) { console.error("Error cargando monedas DB", error); }

    salas[sala].jugadores[socket.id] = { 
      nickname, 
      email, 
      monedas: monedasIniciales, 
      apostado: false, 
      cartas: [], 
      id: socket.id,
      host: (socket.id === salas[sala].hostId) 
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

  // --- APOSTAR (ACTUALIZADO: SONIDO + HISTORIAL) ---
  socket.on('apostar', async (data) => {
    // Manejo robusto de datos (puede venir como objeto o string antiguo)
    const sala = (typeof data === 'object') ? data.sala : data;
    const cantidadCartas = (typeof data === 'object' && data.cantidad) ? parseInt(data.cantidad) : 1;
    const emailUsuario = (typeof data === 'object') ? data.email : null; // Necesario para el historial

    if (salas[sala] && !salas[sala].juegoIniciado) {
        const jugador = salas[sala].jugadores[socket.id];
        
        const COSTO_POR_CARTA = 1; 
        const costoTotal = cantidadCartas * COSTO_POR_CARTA;

        if (jugador && !jugador.apostado && jugador.monedas >= costoTotal) {
            
            jugador.monedas -= costoTotal;
            jugador.apostado = true;
            jugador.cantidadApostada = costoTotal; 
            
            salas[sala].bote += costoTotal;

            try {
                if (jugador.email) {
                    await db.collection('usuarios').doc(jugador.email).update({ 
                        monedas: jugador.monedas 
                    });
                    
                    // --- NUEVO: Registrar Historial de Apuesta ---
                    await registrarMovimiento(jugador.email, 'apuesta', costoTotal, `Apuesta Mesa: ${sala}`, false);
                }
            } catch (e) { console.error("Error cobrando apuesta:", e); }

            io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
            io.to(sala).emit('bote-actualizado', salas[sala].bote);
            
            // --- NUEVO: Emitir Sonido a todos ---
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

        console.log(`Sala ${sala}: Iniciando secuencia... (Velocidad: ${velocidad}ms)`);

        setTimeout(() => {
            if(salas[sala] && salas[sala].juegoIniciado) {
               io.to(sala).emit('corre');
            }
        }, 2000);

        setTimeout(() => {
            if(salas[sala] && salas[sala].juegoIniciado) {
               repartirCartas(sala);
            }
        }, 5000); 
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

  // =========================================================
  // 🔥 LÓGICA DE LOTERÍA (MODOS Y EMPATES) 🔥
  // =========================================================

  socket.on('loteria', ({ nickname, sala, boardState }) => {
    if (!salas[sala]) return;
    const salaInfo = salas[sala];
    
    if (!salaInfo.juegoIniciado && !salaInfo.validandoEmpate) return;

    if (!salaInfo.validandoEmpate) {
        console.log(`⚡ Primer grito de Lotería en ${sala}: ${nickname}`);
        
        salaInfo.juegoIniciado = false; 
        salaInfo.validandoEmpate = true;
        
        if (salaInfo.intervaloCartas) clearInterval(salaInfo.intervaloCartas);

        salaInfo.reclamantes.push({ id: socket.id, nickname, boardState, status: 'pendiente' });

        io.to(sala).emit('pausa-empate', { primerGanador: nickname, tiempo: 4 });

        salaInfo.timerEmpate = setTimeout(() => {
            const hostId = salaInfo.hostId;
            io.to(hostId).emit('iniciar-validacion-secuencial', salaInfo.reclamantes);
        }, 4000);

    } else {
        const yaEsta = salaInfo.reclamantes.find(r => r.id === socket.id);
        if (!yaEsta) {
            console.log(`⚡ Empate detectado en ${sala}: ${nickname}`);
            salaInfo.reclamantes.push({ id: socket.id, nickname, boardState, status: 'pendiente' });
            io.to(sala).emit('notificar-otro-ganador', nickname);
        }
    }
  });

  socket.on('veredicto-host', async ({ sala, candidatoId, esValido }) => {
      const salaInfo = salas[sala];
      if (!salaInfo || socket.id !== salaInfo.hostId) return;

      const candidato = salaInfo.reclamantes.find(r => r.id === candidatoId);
      if (candidato) {
          candidato.status = esValido ? 'validado' : 'rechazado';
      }

      const pendientes = salaInfo.reclamantes.filter(r => r.status === 'pendiente');

      if (pendientes.length > 0) {
          io.to(salaInfo.hostId).emit('continuar-validacion', salaInfo.reclamantes);
      } else {
          const ganadoresReales = salaInfo.reclamantes.filter(r => r.status === 'validado');

          if (ganadoresReales.length > 0) {
              const boteTotal = salaInfo.bote;
              const premioPorCabeza = Math.floor(boteTotal / ganadoresReales.length); 
              
              console.log(`🏆 Ganadores: ${ganadoresReales.length}. Premio: ${premioPorCabeza}`);

              for (const g of ganadoresReales) {
                  const jugador = salaInfo.jugadores[g.id];
                  if (jugador) {
                      jugador.monedas += premioPorCabeza;
                      await actualizarSaldoUsuario(jugador);
                      // --- NUEVO: Historial de Victoria ---
                      await registrarMovimiento(jugador.email, 'victoria', premioPorCabeza, `Premio Lotería!`, true);
                  }
              }

              salaInfo.bote = 0; 
              salaInfo.pagoRealizado = true;
              salaInfo.reclamantes = []; 
              salaInfo.validandoEmpate = false;

              for (const id in salaInfo.jugadores) {
                salaInfo.jugadores[id].apostado = false;
              }

              io.to(sala).emit('ganadores-multiples', { 
                  ganadores: ganadoresReales.map(g => g.nickname),
                  premio: premioPorCabeza
              });
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

        const nickname = salas[sala].jugadores[socket.id].nickname;
        const eraHost = (salas[sala].hostId === socket.id); 

        socket.leave(sala);
        delete salas[sala].jugadores[socket.id];
        
        if (Object.keys(salas[sala].jugadores).length === 0) {
            if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);
            delete salas[sala];
            console.log(`🗑️ Sala '${sala}' eliminada.`);
        } else {
            if (eraHost) {
                const idsRestantes = Object.keys(salas[sala].jugadores);
                if (idsRestantes.length > 0) {
                    const nuevoHostId = idsRestantes[0];
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
  });

  socket.on('disconnect', () => {
    console.log('Jugador desconectado:', socket.id);
    setTimeout(async () => {
        for (const sala in salas) {
            if (salas[sala].jugadores[socket.id]) {
                await procesarReembolsoPorSalida(sala, socket.id);

                const eraHost = (salas[sala].hostId === socket.id); 
                delete salas[sala].jugadores[socket.id];

                if (Object.keys(salas[sala].jugadores).length === 0) {
                    if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);
                    delete salas[sala];
                } else {
                    if (eraHost) {
                        const idsRestantes = Object.keys(salas[sala].jugadores);
                        if (idsRestantes.length > 0) {
                            const nuevoHostId = idsRestantes[0];
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
        }
    }, 20000); 
  });
});

// ==================== PANEL ADMINISTRATIVO ====================

const ADMIN_EMAIL = "admin@loteria.com"; 

app.get('/api/admin/usuarios', async (req, res) => {
    const solicitante = req.headers['admin-email'];
    if (solicitante !== ADMIN_EMAIL) return res.status(403).json({ error: "Sin permiso." });

    try {
        const snapshot = await db.collection('usuarios').get();
        const usuarios = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            usuarios.push({
                email: data.email,
                nickname: data.nickname,
                monedas: data.monedas
            });
        });
        res.json(usuarios);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error de servidor" });
    }
});

app.post('/api/admin/recargar-manual', async (req, res) => {
    const { adminEmail, targetEmail, cantidad } = req.body;

    if (adminEmail !== ADMIN_EMAIL) return res.status(403).json({ error: "Acceso denegado." });

    try {
        const userRef = db.collection('usuarios').doc(targetEmail);
        const doc = await userRef.get();

        if (!doc.exists) return res.status(404).json({ error: "Usuario no encontrado." });

        const monedasActuales = doc.data().monedas || 0;
        const nuevasMonedas = monedasActuales + parseInt(cantidad);

        await userRef.update({ monedas: nuevasMonedas });
        console.log(`⚡ ADMIN: Recarga de ${cantidad} a ${targetEmail}`);
        
        // Historial de admin
        await registrarMovimiento(targetEmail, 'recarga', cantidad, 'Recarga Admin', true);

        res.json({ success: true, nuevoSaldo: nuevasMonedas });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error en recarga." });
    }
});


// ==================== API DEL HUB (JUEGOS EN LA NUBE) ====================

// 1. OBTENER TODOS LOS JUEGOS (Público)
app.get('/api/hub/juegos', async (req, res) => {
    try {
        const snapshot = await db.collection('juegos_hub').get();
        const juegos = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json({ success: true, juegos });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al cargar juegos" });
    }
});

// 2. AGREGAR NUEVO JUEGO (Solo Admin)
app.post('/api/hub/nuevo-juego', async (req, res) => {
    const { adminEmail, titulo, url, imgPoster, descripcion, estado } = req.body;

    if (adminEmail !== ADMIN_EMAIL) return res.status(403).json({ error: "Sin permiso" });

    try {
        await db.collection('juegos_hub').add({
            titulo,
            url,
            imgPoster, // URL de la imagen
            descripcion,
            estado, // 'activo' o 'proximamente'
            creado: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Error al guardar juego" });
    }
});

// 3. ELIMINAR JUEGO (Solo Admin)
app.delete('/api/hub/eliminar-juego/:id', async (req, res) => {
    const { id } = req.params;
    const adminEmail = req.headers['admin-email'];

    if (adminEmail !== ADMIN_EMAIL) return res.status(403).json({ error: "Sin permiso" });

    try {
        await db.collection('juegos_hub').doc(id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Error al eliminar" });
    }
});

http.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});


// ACTUALIZAR PERFIL (HUB)
app.post('/api/actualizar-perfil', async (req, res) => {
    const { email, nickname, avatar } = req.body;
    
    if (!email || !nickname) return res.status(400).json({ error: "Faltan datos" });

    try {
        const userRef = db.collection('usuarios').doc(email);
        
        // Actualizamos en la DB
        await userRef.update({ 
            nickname: nickname,
            avatar: avatar || 'assets/avatar.png' 
        });

        res.json({ success: true });
    } catch (error) {
        console.error("Error actualización perfil:", error);
        res.status(500).json({ error: "Error al actualizar perfil" });
    }
});
