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
  res.send('Servidor de Lotería funcionando.');
});

io.on('connection', (socket) => {
  console.log('Nuevo jugador conectado:', socket.id);

  socket.on('unirse-sala', ({ nickname, sala }) => {
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
    // Guardar cartas vacías al inicio
    salas[sala].jugadores[socket.id] = { nickname, monedas: 30, apostado: false, cartas: [], id: socket.id };
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

  socket.on('apostar', ({ sala, cantidad }) => {
      // Lógica de apuestas...
  });

  socket.on('iniciar-juego', (sala) => {
    if (salas[sala] && socket.id === salas[sala].hostId) {
      if (!salas[sala].juegoIniciado) {
        salas[sala].baraja = mezclarBaraja();
        salas[sala].historial = [];
        salas[sala].juegoIniciado = true;
        salas[sala].loteriaPendiente = null;
        salas[sala].pagoRealizado = false;
        io.to(sala).emit('juego-iniciado');
        repartirCartas(sala);
      }
    }
  });

  // ...otros eventos como detener, barajear, reiniciar...

  // --- ✅ EVENTO MODIFICADO PARA RECIBIR Y REENVIAR EL ESTADO DEL JUEGO ✅ ---
  socket.on('loteria', ({ nickname, sala, estadoJuego }) => {
    const salaInfo = salas[sala];
    if (salaInfo && salaInfo.juegoIniciado) {
      salaInfo.juegoIniciado = false;
      if (salaInfo.intervaloCartas) clearInterval(salaInfo.intervaloCartas);

      salaInfo.loteriaPendiente = {
        ganadorId: socket.id,
        nickname,
        estadoJuego, // Guardamos el estado del juego para referencia
        timestamp: Date.now()
      };
      salaInfo.pagoRealizado = false;

      // Enviamos toda la información necesaria al Host para que pueda verificar
      io.to(salaInfo.hostId).emit('loteria-anunciada', { 
          nicknameGanador: nickname, 
          idGanador: socket.id, 
          estadoJuego 
      });
    }
  });
  
  socket.on('confirmar-ganador', ({ sala, ganadorId, esValido }) => {
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
    // Lógica para salir de la sala...
  });

  socket.on('disconnect', () => {
    // Lógica de desconexión...
  });
});

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
  }, 4000);
}

http.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});