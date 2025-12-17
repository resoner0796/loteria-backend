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
            monedas: 50, // Bono de bienvenida
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
    // No borramos al jugador inmediatamente para darle chance de volver.
    // Solo lo sacamos si pasa mucho tiempo o si la sala se vacía.
    console.log('Jugador desconectado (esperando posible reconexión):', socket.id);
    
    // Dejamos un timeout de limpieza por si acaso nunca vuelve
    setTimeout(() => {
        // En un sistema más complejo verificaríamos si ya se reconectó con otro socket.
        // Por ahora, dejamos que la lógica de limpieza de salas lo maneje si todos se van.
        for (const sala in salas) {
            if (salas[sala].jugadores[socket.id]) {
                // Si sigue aquí con el MISMO id viejo, es que no volvió. Borramos.
                // Pero si ya se reconectó, este socket.id ya no existe en la sala (fue reemplazado).
                const nick = salas[sala].jugadores[socket.id].nickname;
                delete salas[sala].jugadores[socket.id];
                io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
            }
        }
    }, 10000); // 10 segundos de gracia
  });
});

// ==================== INICIO SERVIDOR ====================
http.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});