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
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bcrypt = require('bcryptjs'); 
const cors = require('cors');

app.use(cors());
app.use(express.json()); 

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

        const hashedPassword = await bcrypt.hash(password, 10);

        await userRef.set({
            email,
            password: hashedPassword,
            nickname,
            monedas: 20, 
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

// ==================== PAGOS STRIPE ====================

// 1. CAMBIO IMPORTANTE: Pon aquí tu nueva URL de Vercel (sin el /index.html al final)
const FRONTEND_URL = "https://loteria-online-red.vercel.app"; 

// Esta se queda igual (es tu server en Render)
const BACKEND_URL = "https://loteria-backend-3nde.onrender.com";

app.post('/api/crear-orden', async (req, res) => {
    // ... todo este bloque se queda IGUAL ...
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
            // ESTO SE QUEDA IGUAL (Redirige primero al backend para procesar)
            return_url: `${BACKEND_URL}/api/confirmar-pago?session_id={CHECKOUT_SESSION_ID}`,
        });

        res.json({ clientSecret: session.client_secret });
    } catch (error) {
        console.error("Error Stripe:", error);
        res.status(500).json({ error: "No se pudo crear la orden" });
    }
});

app.get('/api/confirmar-pago', async (req, res) => {
    // ... este bloque también se queda igual, solo la redirección final cambiará sola ...
    const { session_id } = req.query;

    try {
        const session = await stripe.checkout.sessions.retrieve(session_id);
        
        if (session.payment_status === 'paid') {
            const email = session.metadata.email_usuario;
            const monedasExtra = parseInt(session.metadata.monedas_a_dar);
            
            console.log(`💰 Pago confirmado. Acreditando ${monedasExtra} a ${email}`);

            const userRef = db.collection('usuarios').doc(email);
            const doc = await userRef.get();
            
            if (doc.exists) {
                const actuales = doc.data().monedas || 0;
                await userRef.update({ monedas: actuales + monedasExtra });
            }

            // AQUÍ ES DONDE OCURRE LA MAGIA:
            // Como ya actualizamos FRONTEND_URL arriba, ahora los mandará a Vercel
            res.redirect(`${FRONTEND_URL}/index.html?pago=exito&cantidad=${monedasExtra}`);
        } else {
            res.redirect(`${FRONTEND_URL}/index.html?pago=cancelado`);
        }
    } catch (error) {
        console.error("Error confirmando pago:", error);
        res.redirect(`${FRONTEND_URL}/index.html?pago=error`);
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
              
              // --- FIX: ACTUALIZAR HOST ID SI EL QUE REGRESA ES EL PATRÓN ---
              // Si no hacíamos esto, el servidor le hablaba al socket muerto
              if (salas[sala].hostId === viejoSocketId) {
                  salas[sala].hostId = socket.id;
                  console.log(`👑 Host ID actualizado tras reconexión: ${socket.id}`);
              }
              // -------------------------------------------------------------

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
              
              // Re-enviar rol por si acaso
              socket.emit('rol-asignado', { host: (socket.id === salas[sala].hostId) });
              
              io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
          }
      }
  });
  
  // --- AGREGAR ESTO PARA CUANDO RECARGAN LA PÁGINA (F5) ---
    socket.on('solicitar-info-usuario', async (email) => {
        try {
            const doc = await db.collection('usuarios').doc(email).get();
            if (doc.exists) {
                // Le mandamos al cliente sus datos frescos de la DB
                socket.emit('usuario-actualizado', doc.data());
            }
        } catch (e) {
            console.error(e);
        }
    });

    // --- ACTUALIZAR EL EVENTO DE COMPRA (PARA QUE CONFIRME Y SINCRONICE) ---
    socket.on('comprar-item', async ({ email, itemId, precio }) => {
        try {
            const userRef = db.collection('usuarios').doc(email);
            
            // Usamos transacción para que no haya errores de saldo negativo
            await db.runTransaction(async (t) => {
                const doc = await t.get(userRef);
                if (!doc.exists) return;

                const data = doc.data();
                const monedas = data.monedas || 0;
                const inventario = data.inventario || [];

                if (monedas >= precio && !inventario.includes(itemId)) {
                    // Cobramos y entregamos
                    t.update(userRef, {
                        monedas: monedas - precio,
                        inventario: admin.firestore.FieldValue.arrayUnion(itemId)
                    });
                }
            });

            // DESPUÉS DE LA TRANSACCIÓN: LEER Y ENVIAR ESTADO FINAL REAL
            const docFinal = await userRef.get();
            io.to(socket.id).emit('usuario-actualizado', docFinal.data());

        } catch (e) {
            console.error("Error comprando:", e);
        }
    });
  
// EFECTOS DE SONIDO EN JUEGO
    socket.on("enviar-efecto-sonido", ({ sala, soundId, emisor }) => {
        // Reenviar a TODOS en la sala (incluyendo al que lo envió para que confirme que salió)
        io.to(sala).emit("reproducir-efecto-sonido", { soundId, emisor });
    });
  
  // --- UNIRSE A SALA (ACTUALIZADO: MODOS Y EMPATES) ---
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
        // --- NUEVOS DATOS PARA MODO Y EMPATE ---
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

    // Avisamos a todos del Modo de Juego configurado
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

  // --- APOSTAR ($1 POR CARTA) ---
  socket.on('apostar', async (data) => {
    const sala = (typeof data === 'object') ? data.sala : data;
    const cantidadCartas = (typeof data === 'object' && data.cantidad) ? parseInt(data.cantidad) : 1;

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
                }
            } catch (e) { console.error("Error cobrando apuesta:", e); }

            io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
            io.to(sala).emit('bote-actualizado', salas[sala].bote);
            io.to(sala).emit('sonido-apuesta'); 
            io.to(sala).emit("reproducir-sonido-apuesta");
        }
    }
  });

// COMPRA EN TIENDA
    socket.on('comprar-item', async ({ email, itemId, precio }) => {
        try {
            const userRef = db.collection('usuarios').doc(email);
            const doc = await userRef.get();

            if (doc.exists) {
                const data = doc.data();
                const monedasActuales = data.monedas || 0;
                let inventario = data.inventario || [];

                // Validación servidor: ¿Tiene saldo y NO tiene el item aún?
                if (monedasActuales >= precio && !inventario.includes(itemId)) {
                    await userRef.update({
                        monedas: admin.firestore.FieldValue.increment(-precio),
                        inventario: admin.firestore.FieldValue.arrayUnion(itemId)
                    });
                    console.log(`Usuario ${email} compró ${itemId} por ${precio}`);
                    
                    // Emitir evento de vuelta para asegurar sincronización
                    // (Opcional si confías en la UI optimista, pero recomendado)
                    const userActualizado = await userRef.get();
                    io.to(socket.id).emit('usuario-actualizado', userActualizado.data());
                }
            }
        } catch (e) {
            console.error("Error en compra:", e);
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
        
        // --- LIMPIEZA DE EMPATES ---
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
      
      // Reset variables empate
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
  // 🔥 NUEVA LÓGICA DE LOTERÍA (GESTIÓN DE EMPATES) 🔥
  // =========================================================

  socket.on('loteria', ({ nickname, sala, boardState }) => {
    if (!salas[sala]) return;
    const salaInfo = salas[sala];
    
    // Si el juego NO está iniciado Y NO estamos en periodo de validación, ignorar
    if (!salaInfo.juegoIniciado && !salaInfo.validandoEmpate) return;

    // 1. PRIMER GRITO (Inicia la ventana de tiempo)
    if (!salaInfo.validandoEmpate) {
        console.log(`⚡ Primer grito de Lotería en ${sala}: ${nickname}`);
        
        salaInfo.juegoIniciado = false; // Pausa oficial
        salaInfo.validandoEmpate = true;
        
        if (salaInfo.intervaloCartas) clearInterval(salaInfo.intervaloCartas);

        // Agregamos al primer ganador
        salaInfo.reclamantes.push({ id: socket.id, nickname, boardState, status: 'pendiente' });

        // Avisamos a todos (4 segundos de espera)
        io.to(sala).emit('pausa-empate', { primerGanador: nickname, tiempo: 4 });

        // Timer para cerrar la ventana de reclamos
        salaInfo.timerEmpate = setTimeout(() => {
            const hostId = salaInfo.hostId;
            // IMPORTANTE: Enviamos al ID actual del host (que puede haber cambiado si reconectó)
            io.to(hostId).emit('iniciar-validacion-secuencial', salaInfo.reclamantes);
        }, 4000);

    } else {
        // 2. GRITOS ADICIONALES (Dentro de los 4 segundos)
        const yaEsta = salaInfo.reclamantes.find(r => r.id === socket.id);
        if (!yaEsta) {
            console.log(`⚡ Empate detectado en ${sala}: ${nickname}`);
            salaInfo.reclamantes.push({ id: socket.id, nickname, boardState, status: 'pendiente' });
            io.to(sala).emit('notificar-otro-ganador', nickname);
        }
    }
  });

  // --- HOST VALIDA A UN JUGADOR (NUEVO) ---
  socket.on('veredicto-host', async ({ sala, candidatoId, esValido }) => {
      const salaInfo = salas[sala];
      if (!salaInfo || socket.id !== salaInfo.hostId) return;

      // Actualizamos estado del candidato
      const candidato = salaInfo.reclamantes.find(r => r.id === candidatoId);
      if (candidato) {
          candidato.status = esValido ? 'validado' : 'rechazado';
      }

      // Checamos si faltan por validar
      const pendientes = salaInfo.reclamantes.filter(r => r.status === 'pendiente');

      if (pendientes.length > 0) {
          // Si faltan, el Host debe validar al siguiente
          io.to(salaInfo.hostId).emit('continuar-validacion', salaInfo.reclamantes);
      } else {
          // --- TODOS VALIDADOS: HORA DE PAGAR ---
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
              // Todos rechazados
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
        res.json({ success: true, nuevoSaldo: nuevasMonedas });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error en recarga." });
    }
});

http.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});

