// ==================== CONFIG FIREBASE ====================
const admin = require('firebase-admin');
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

const PORT = process.env.PORT || 3000;

// Estado del juego por sala
const salas = {};

app.get('/', (req, res) => {
  res.send('Servidor de Lotería funcionando con Firebase ✅');
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
  }, 6000);
}

// Guardar datos de jugador en Firestore
async function guardarJugador(nickname, datosJugador) {
  try {
    const jugadorRef = db.collection('jugadores').doc(nickname);
    await jugadorRef.set(datosJugador, { merge: true });
    console.log(`✅ Datos del jugador ${nickname} guardados en Firebase.`);
  } catch (error) {
    console.error("❌ Error al guardar jugador:", error);
  }
}

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  console.log('Nuevo jugador conectado:', socket.id);

  socket.on('unirse-sala', async ({ nickname, sala }) => {
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
      console.log(`Sala '${sala}' creada por ${nickname} (${socket.id})`);
      socket.emit('rol-asignado', { host: true });
    } else {
      socket.emit('rol-asignado', { host: false });
    }

    // 🔹 Revisar si el jugador ya existe en Firebase
    let monedasIniciales = 30;
    try {
      const jugadorDoc = await db.collection('jugadores').doc(nickname).get();
      if (jugadorDoc.exists) {
        monedasIniciales = jugadorDoc.data().monedas || 30;
      } else {
        await db.collection('jugadores').doc(nickname).set({
          nickname,
          monedas: monedasIniciales
        });
      }
    } catch (error) {
      console.error("❌ Error al cargar jugador de Firebase:", error);
    }

    salas[sala].jugadores[socket.id] = { 
      nickname, 
      monedas: monedasIniciales, 
      apostado: false, 
      cartas: [], 
      id: socket.id 
    };

    console.log(`${nickname} se ha unido a la sala '${sala}'`);
    
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

  // En server.js - Modifica la sección de 'apostar'

socket.on('apostar', async ({ sala, cantidad }) => {
    if (salas[sala] && salas[sala].jugadores[socket.id] && !salas[sala].jugadores[socket.id].apostado) {
      const jugador = salas[sala].jugadores[socket.id];
      if (jugador.monedas >= cantidad) {
        jugador.monedas -= cantidad;
        salas[sala].bote += cantidad;
        jugador.apostado = true;

        // ESTA LÍNEA ES LA CLAVE DE LA SOLUCIÓN:
        // Usamos 'jugadores-actualizados' para que cada quien busque su propio saldo en la lista.
        io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
        
        // --- BORRA O COMENTA ESTA LÍNEA QUE CAUSA EL BUG ---
        // io.to(sala).emit('monedas-actualizado', jugador.monedas); 
        // ---------------------------------------------------

        io.to(sala).emit('bote-actualizado', salas[sala].bote);

        // Guardar cambios en Firebase
        await guardarJugador(jugador.nickname, { monedas: jugador.monedas });
      } else {
        socket.emit('error-apuesta', 'No tienes suficientes monedas.');
      }
    }
  });

  // En server.js

socket.on('iniciar-juego', (sala) => {
  if (salas[sala] && socket.id === salas[sala].hostId) {
    if (!salas[sala].juegoIniciado) {
      // 1. Preparamos el juego
      salas[sala].baraja = mezclarBaraja();
      salas[sala].historial = [];
      salas[sala].juegoIniciado = true;
      salas[sala].loteriaPendiente = null;
      salas[sala].pagoRealizado = false;
      
      // 2. Avisamos que inicia (opcional) y tocamos CAMPANA
      io.to(sala).emit('juego-iniciado');
      io.to(sala).emit('campana'); // <--- ¡IMPORTANTE!

      console.log(`Sala ${sala}: Iniciando secuencia de arranque...`);

      // 3. Esperamos 2 segundos y mandamos "CORRE Y SE VA"
      setTimeout(() => {
          if(salas[sala] && salas[sala].juegoIniciado) {
             io.to(sala).emit('corre'); // <--- ¡IMPORTANTE!
          }
      }, 2000);

      // 4. Esperamos otros 3 segundos (lo que dura el audio de "corre") y empezamos a dar cartas
      setTimeout(() => {
          if(salas[sala] && salas[sala].juegoIniciado) {
             repartirCartas(sala); // <--- Aquí ya arrancan las cartas
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
      console.warn(`[SALA: ${sala}] Intento de confirmación inválido.`);
      return;
    }
  
    const jugadorGanador = salaInfo.jugadores[ganadorId];
    if (!jugadorGanador) {
      console.error(`[SALA: ${sala}] Error: El jugador con ID ${ganadorId} no fue encontrado.`);
      return;
    }
  
    if (esValido === false) {
      console.log(`[SALA: ${sala}] El Host RECHAZÓ la victoria de ${jugadorGanador.nickname}.`);
      io.to(sala).emit('ganador-rechazado', ganadorId);
      salaInfo.loteriaPendiente = null;
      salaInfo.juegoIniciado = true;
      repartirCartas(sala); 
      return; 
    }
  
    const boteActual = Number(salaInfo.bote) || 0;
    console.log(`[SALA: ${sala}] El Host ACEPTÓ la victoria de ${jugadorGanador.nickname}.`);
  
    if (boteActual > 0) {
      jugadorGanador.monedas += boteActual;
      salaInfo.bote = 0;
      salaInfo.pagoRealizado = true;

      // 🔹 Guardar cambios en Firebase
      await guardarJugador(jugadorGanador.nickname, { monedas: jugadorGanador.monedas });
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
      console.log(`${nickname} ha dejado la sala '${sala}'`);
      const cartasOcupadas = Object.values(salas[sala].jugadores).flatMap(j => j.cartas);
      io.to(sala).emit('cartas-desactivadas', cartasOcupadas);
      io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
      if (Object.keys(salas[sala].jugadores).length === 0) {
        if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);
        delete salas[sala];
        console.log(`Sala '${sala}' eliminada.`);
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('Jugador desconectado:', socket.id);
    for (const sala in salas) {
      if (salas[sala].jugadores[socket.id]) {
        const nickname = salas[sala].jugadores[socket.id].nickname;
        delete salas[sala].jugadores[socket.id];
        console.log(`${nickname} ha dejado la sala '${sala}'`);
        
        const cartasOcupadas = Object.values(salas[sala].jugadores).flatMap(j => j.cartas);
        io.to(sala).emit('cartas-desactivadas', cartasOcupadas);
        io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);

        if (Object.keys(salas[sala].jugadores).length === 0) {
          if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);
          delete salas[sala];
          console.log(`Sala '${sala}' eliminada.`);
        }
      }
    }
  });
});

// ==================== INICIO SERVIDOR ====================
http.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});