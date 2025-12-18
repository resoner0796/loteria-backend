// server.js

// ==================== CONFIG FIREBASE ====================
const admin = require('firebase-admin');
// Asegúrate de que tu variable de entorno 'nicknames' tenga el JSON correcto
const serviceAccount = JSON.parse(process.env.nicknames); 

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ==================== CONFIG EXPRESS + SOCKET ====================
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { origin: '*' }
});
// Agrega esto arriba con los otros require
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
// --- NUEVAS LIBRERÍAS DE SEGURIDAD ---
const bcrypt = require('bcryptjs'); 
const cors = require('cors');

app.use(cors());
app.use(express.json()); // Necesario para leer el Login/Registro

const PORT = process.env.PORT || 3000;

// Estado del juego por sala
const salas = {};

// ==================== RUTAS DE API (LOGIN Y REGISTRO) ====================

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

        // Encriptamos la contraseña
        const hashedPassword = await bcrypt.hash(password, 10);

        // Guardamos en Firebase (Colección 'usuarios')
        await userRef.set({
            email,
            password: hashedPassword,
            nickname,
            monedas: 20, // Bono de bienvenida
            creado: new Date()
        });

        res.json({ success: true, nickname, monedas: 50, email });
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

        // Verificamos contraseña
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

// ==================== FUNCIONES AUXILIARES ====================

function mezclarBaraja() {
  const cartas = Array.from({ length: 54 }, (_, i) => String(i + 1).padStart(2, '0'));
  return cartas.sort(() => Math.random() - 0.5);
}

function repartirCartas(sala) {
  const salaInfo = salas[sala];
  if (!salaInfo || !salaInfo.juegoIniciado) return;

  if (salaInfo.intervaloCartas) clearInterval(salaInfo.intervaloCartas);

  salaInfo.intervaloCartas = setInterval(() => {
    if (!salaInfo.juegoIniciado || salaInfo.baraja.length === 0) {
      clearInterval(salaInfo.intervaloCartas);
      salaInfo.intervaloCartas = null;
      return;
    }
    const carta = salaInfo.baraja.shift();
    salaInfo.historial.push(carta);
    io.to(sala).emit('carta-cantada', carta);
  }, 4000); // Ajustado a 4 segundos por carta para buen ritmo
}

// Función auxiliar para actualizar monedas (soporta email o nickname legacy)
async function actualizarSaldoUsuario(jugador) {
    try {
        if (jugador.email) {
            // Si tiene email (usuario registrado), actualizamos en 'usuarios'
            await db.collection('usuarios').doc(jugador.email).update({ monedas: jugador.monedas });
            console.log(`✅ Saldo actualizado para ${jugador.email}`);
        } else {
            // Fallback para usuarios viejos (solo nickname)
            await db.collection('jugadores').doc(jugador.nickname).set({ monedas: jugador.monedas }, { merge: true });
        }
    } catch (error) {
        console.error("❌ Error al guardar saldo:", error);
    }
}

// ==================== PAGOS STRIPE CORREGIDO (FINAL) ====================

// DEFINIMOS LAS URLs EXACTAS PARA NO FALLAR
const FRONTEND_URL = "https://resoner0796.github.io/CARTAS-LOTERIA-";
const BACKEND_URL = "https://loteria-backend-3nde.onrender.com";

// 1. RUTA PARA CREAR LA ORDEN DE PAGO
app.post('/api/crear-orden', async (req, res) => {
    const { cantidad, precio, email } = req.body;
    
    try {
        const session = await stripe.checkout.sessions.create({
            ui_mode: 'embedded',
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'mxn',
                        product_data: {
                            name: `Paquete de ${cantidad} Monedas`,
                        },
                        // Math.round asegura que 29.99 se convierta en 2999 centavos exactos
                        unit_amount: Math.round(precio * 100), 
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            metadata: {
                email_usuario: email,
                monedas_a_dar: cantidad
            },
            // --- CAMBIO CRÍTICO ---
            // Stripe debe regresar al BACKEND primero para procesar la recarga en la BD
            return_url: `${BACKEND_URL}/api/confirmar-pago?session_id={CHECKOUT_SESSION_ID}`,
        });

        res.json({ clientSecret: session.client_secret });
    } catch (error) {
        console.error("Error Stripe:", error);
        res.status(500).json({ error: "No se pudo crear la orden" });
    }
});

// 2. RUTA QUE GUARDA LAS MONEDAS Y LUEGO TE MANDA AL JUEGO
app.get('/api/confirmar-pago', async (req, res) => {
    const { session_id } = req.query;

    try {
        const session = await stripe.checkout.sessions.retrieve(session_id);
        
        if (session.payment_status === 'paid') {
            const email = session.metadata.email_usuario;
            const monedasExtra = parseInt(session.metadata.monedas_a_dar);
            
            console.log(`💰 Pago confirmado. Acreditando ${monedasExtra} a ${email}`);

            // 1. Guardamos en Firebase (Base de datos real)
            const userRef = db.collection('usuarios').doc(email);
            const doc = await userRef.get();
            
            if (doc.exists) {
                const actuales = doc.data().monedas || 0;
                await userRef.update({ monedas: actuales + monedasExtra });
            }

            // 2. Redirigimos al usuario al JUEGO (Frontend) con el aviso de éxito
            res.redirect(`${FRONTEND_URL}/index.html?pago=exito&cantidad=${monedasExtra}`);
        } else {
            // Si falló el pago, lo mandamos al juego con aviso de cancelación
            res.redirect(`${FRONTEND_URL}/index.html?pago=cancelado`);
        }
    } catch (error) {
        console.error("Error confirmando pago:", error);
        res.redirect(`${FRONTEND_URL}/index.html?pago=error`);
    }
});

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  console.log('Nuevo socket conectado:', socket.id);

  // --- LÓGICA DE RECONEXIÓN (NUEVO) ---
  socket.on('reconectar', ({ sala, email }) => {
      if (sala && salas[sala]) {
          // Buscamos si el jugador ya estaba en la sala por su email
          const jugadorExistente = Object.values(salas[sala].jugadores).find(j => j.email === email);
          
          if (jugadorExistente) {
              socket.join(sala);
              
              // Actualizamos el ID del socket viejo por el nuevo
              const viejoSocketId = jugadorExistente.id;
              
              // Actualizamos la referencia
              salas[sala].jugadores[socket.id] = jugadorExistente;
              salas[sala].jugadores[socket.id].id = socket.id; 
              
              // Borramos la referencia vieja
              if (viejoSocketId !== socket.id) {
                  delete salas[sala].jugadores[viejoSocketId];
              }
              
              console.log(`♻️ Jugador ${jugadorExistente.nickname} RECONECTADO.`);
              
              // Le enviamos su estado actual para que no empiece de cero
              socket.emit('estado-sala-restaurado', { 
                  enJuego: salas[sala].juegoIniciado,
                  cartas: jugadorExistente.cartas,
                  apostado: jugadorExistente.apostado,
                  monedas: jugadorExistente.monedas
              });
              
              // Actualizamos lista a todos por si acaso
              io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
          }
      }
  });

  // --- UNIRSE A SALA (MODIFICADO PARA EMAIL) ---
  socket.on('unirse-sala', async ({ nickname, email, sala }) => { // Agregamos email
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
        loteriaPendiente: null,
        pagoRealizado: false
      };
      socket.emit('rol-asignado', { host: true });
      console.log(`Sala '${sala}' creada por ${nickname}`);
    } else {
      socket.emit('rol-asignado', { host: false });
    }

    // Buscamos monedas actuales (prioridad DB)
    let monedasIniciales = 30;
    try {
        if(email) {
            const userDoc = await db.collection('usuarios').doc(email).get();
            if (userDoc.exists) monedasIniciales = userDoc.data().monedas;
        } else {
             // Legacy check
             const jugadorDoc = await db.collection('jugadores').doc(nickname).get();
             if (jugadorDoc.exists) monedasIniciales = jugadorDoc.data().monedas;
        }
    } catch (error) { console.error("Error cargando monedas DB", error); }

    salas[sala].jugadores[socket.id] = { 
      nickname, 
      email, // Guardamos email para identificar
      monedas: monedasIniciales, 
      apostado: false, 
      cartas: [], 
      id: socket.id 
    };

    console.log(`${nickname} entró a '${sala}'`);
    
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
      
      // Filtramos la carta para quitarla de la lista del jugador
      jugador.cartas = jugador.cartas.filter(c => c !== carta);
      
      // Actualizamos a todos para que sepan que esa carta ya está libre
      const cartasOcupadas = Object.values(salaInfo.jugadores).flatMap(j => j.cartas);
      io.to(sala).emit('cartas-desactivadas', cartasOcupadas);
    }
  });

  socket.on('apostar', async ({ sala, cantidad }) => {
    if (salas[sala] && salas[sala].jugadores[socket.id] && !salas[sala].jugadores[socket.id].apostado) {
      const jugador = salas[sala].jugadores[socket.id];
      if (jugador.monedas >= cantidad) {
        jugador.monedas -= cantidad;
        salas[sala].bote += cantidad;
        jugador.apostado = true;

        // FIX: Solo enviamos la lista completa, NO el evento individual 'monedas-actualizado'
        io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
        io.to(sala).emit('bote-actualizado', salas[sala].bote);

        // Guardar cambios en Firebase (Usando la nueva función que soporta email)
        await actualizarSaldoUsuario(jugador);
      } else {
        socket.emit('error-apuesta', 'No tienes suficientes monedas.');
      }
    }
  });

  socket.on('iniciar-juego', (sala) => {
    if (salas[sala] && socket.id === salas[sala].hostId) {
      if (!salas[sala].juegoIniciado) {
        // 1. Preparamos el juego
        salas[sala].baraja = mezclarBaraja();
        salas[sala].historial = [];
        salas[sala].juegoIniciado = true;
        salas[sala].loteriaPendiente = null;
        salas[sala].pagoRealizado = false;
        
        // 2. Avisamos inicio + CAMPANA
        io.to(sala).emit('juego-iniciado');
        io.to(sala).emit('campana'); 

        console.log(`Sala ${sala}: Iniciando secuencia...`);

        // 3. Esperamos 2s y mandamos CORRE
        setTimeout(() => {
            if(salas[sala] && salas[sala].juegoIniciado) {
               io.to(sala).emit('corre');
            }
        }, 2000);

        // 4. Esperamos 3s más y arrancan las cartas
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
      salas[sala].loteriaPendiente = null;
      salas[sala].pagoRealizado = false;
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
    if (salas[sala] && salas[sala].juegoIniciado) {
      salas[sala].juegoIniciado = false;
      if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);

      salas[sala].loteriaPendiente = {
        ganadorId: socket.id,
        nickname,
        boardState,
        timestamp: Date.now()
      };
      salas[sala].pagoRealizado = false;

      io.to(salas[sala].hostId).emit('loteria-anunciada', nickname, socket.id, boardState);
    }
  });
  
  socket.on('confirmar-ganador', async ({ sala, ganadorId, esValido }) => {
    const salaInfo = salas[sala];
    
    if (!salaInfo || socket.id !== salaInfo.hostId || !salaInfo.loteriaPendiente || salaInfo.pagoRealizado || ganadorId !== salaInfo.loteriaPendiente.ganadorId) {
      return;
    }
    
    const jugadorGanador = salaInfo.jugadores[ganadorId];
    if (!jugadorGanador) return;
    
    if (esValido === false) {
      io.to(sala).emit('ganador-rechazado', ganadorId);
      salaInfo.loteriaPendiente = null;
      salaInfo.juegoIniciado = true;
      repartirCartas(sala); 
      return; 
    }
    
    const boteActual = Number(salaInfo.bote) || 0;
    
    if (boteActual > 0) {
      jugadorGanador.monedas += boteActual;
      salaInfo.bote = 0;
      salaInfo.pagoRealizado = true;

      // Guardar cambios en Firebase (función nueva)
      await actualizarSaldoUsuario(jugadorGanador);
    }
    
    for (const id in salaInfo.jugadores) {
      salaInfo.jugadores[id].apostado = false;
    }
    
    salaInfo.loteriaPendiente = null;
    salaInfo.juegoIniciado = false;
    if (salaInfo.intervaloCartas) {
      clearInterval(salaInfo.intervaloCartas);
      salaInfo.intervaloCartas = null;
    }
    
    io.to(sala).emit('ganador-confirmado', ganadorId);
    io.to(sala).emit('jugadores-actualizados', salaInfo.jugadores);
    io.to(sala).emit('bote-actualizado', salaInfo.bote);
  });

  socket.on('salir-sala', (sala) => {
    if (salas[sala] && salas[sala].jugadores[socket.id]) {
      const nickname = salas[sala].jugadores[socket.id].nickname;
      socket.leave(sala);
      delete salas[sala].jugadores[socket.id];
      
      const cartasOcupadas = Object.values(salas[sala].jugadores).flatMap(j => j.cartas);
      io.to(sala).emit('cartas-desactivadas', cartasOcupadas);
      io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
      
      if (Object.keys(salas[sala].jugadores).length === 0) {
        if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);
        delete salas[sala];
      }
    }
  });

  socket.on('disconnect', () => {
    // PROTECCIÓN DE DESCONEXIÓN:
    console.log('Jugador desconectado (esperando posible reconexión):', socket.id);
    
    // Dejamos un timeout de 10 segundos antes de declararlo "muerto"
    setTimeout(() => {
        for (const sala in salas) {
            // Buscamos si el ID VIEJO sigue en la sala.
            // Si el jugador se reconectó, la función 'reconectar' ya habría cambiado su ID 
            // y borrado este ID viejo, por lo que este IF daría falso y no pasaría nada (éxito).
            if (salas[sala].jugadores[socket.id]) {
                
                // === SI ENTRAMOS AQUÍ, ES QUE NO VOLVIÓ ===
                const jugadorSaliente = salas[sala].jugadores[socket.id];
                const eraHost = (salas[sala].hostId === socket.id); // ¿Era el Host?

                // 1. Lo borramos definitivamente
                delete salas[sala].jugadores[socket.id];
                console.log(`❌ ${jugadorSaliente.nickname} eliminado de ${sala} tras timeout.`);

                // 2. Verificamos si la sala quedó vacía
                if (Object.keys(salas[sala].jugadores).length === 0) {
                    if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);
                    delete salas[sala];
                    console.log(`🗑️ Sala '${sala}' eliminada por inactividad.`);
                } else {
                    // 3. LA SALA SIGUE VIVA: MIGRACIÓN DE HOST
                    if (eraHost) {
                        const idsRestantes = Object.keys(salas[sala].jugadores);
                        if (idsRestantes.length > 0) {
                            // El heredero es el siguiente en la lista
                            const nuevoHostId = idsRestantes[0];
                            salas[sala].hostId = nuevoHostId;
                            
                            // Le avisamos al nuevo rey
                            io.to(nuevoHostId).emit('rol-asignado', { host: true });
                            console.log(`👑 Nuevo Host asignado en '${sala}': ${salas[sala].jugadores[nuevoHostId].nickname}`);
                        }
                    }

                    // 4. Actualizamos a los sobrevivientes
                    const cartasOcupadas = Object.values(salas[sala].jugadores).flatMap(j => j.cartas);
                    io.to(sala).emit('cartas-desactivadas', cartasOcupadas);
                    io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
                }
            }
        }
    }, 20000); // 10 segundos de gracia
  });
});
// ==================== INICIO SERVIDOR ====================
http.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});