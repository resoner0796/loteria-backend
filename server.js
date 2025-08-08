const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "https://resoner0796.github.io",
    methods: ["GET", "POST"]
  }
});

// Estado global por sala
const salas = {};

function generarBarajitas() {
  const total = 54;
  const barajas = Array.from({ length: total }, (_, i) => String(i + 1).padStart(2, '0'));
  return barajas.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
  console.log(`Jugador conectado: ${socket.id}`);

  socket.on('unirse-sala', ({ sala, nickname }) => {
    socket.join(sala);

    if (!salas[sala]) {
      salas[sala] = {
        jugadores: {},
        hostId: null,
        cartasSeleccionadas: new Set(),
        historial: [],
        barajitas: [],
        barajeoEnCurso: false,
        intervalo: null,
        juegoPausado: false,
        bote: 0 // Nuevo bote global
      };
    }

    const esHostCustom = nickname.toLowerCase() === `host ${sala.toLowerCase()}`;
    if (esHostCustom || !salas[sala].hostId) {
      salas[sala].hostId = socket.id;
    }

    const esHost = socket.id === salas[sala].hostId;
    salas[sala].jugadores[socket.id] = { 
      nickname, 
      host: esHost,
      monedas: 30, // Monedas iniciales por jugador
      apostado: false // Marca si ya apostó en la ronda
    };

    socket.emit('rol-asignado', { host: esHost });
    socket.emit('cartas-desactivadas', Array.from(salas[sala].cartasSeleccionadas));
    socket.emit('historial-actualizado', salas[sala].historial);
    io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
    socket.emit('bote-actualizado', salas[sala].bote);
  });

  socket.on('seleccionar-carta', ({ sala, carta }) => {
    if (!salas[sala]) return;
    salas[sala].cartasSeleccionadas.add(carta);
    io.to(sala).emit('cartas-desactivadas', Array.from(salas[sala].cartasSeleccionadas));
  });

  socket.on('barajear', (sala) => {
    if (!salas[sala]) return;
    salas[sala].historial = [];
    salas[sala].barajitas = generarBarajitas();
    salas[sala].juegoPausado = false;
    io.to(sala).emit('barajear');
  });

  socket.on('iniciar-juego', (sala) => {
    const data = salas[sala];
    if (!data || data.barajeoEnCurso || data.juegoPausado) return;

    if (data.barajitas.length === 0) {
      data.barajitas = generarBarajitas();
    }

    io.to(sala).emit('campana');

    setTimeout(() => {
      io.to(sala).emit('corre');
      let index = 0;
      data.barajeoEnCurso = true;

      data.intervalo = setInterval(() => {
        if (data.juegoPausado) return;

        if (index >= data.barajitas.length) {
          clearInterval(data.intervalo);
          data.barajeoEnCurso = false;
          return;
        }

        const carta = data.barajitas[index];
        data.historial.push(carta);
        io.to(sala).emit('carta-cantada', carta);
        index++;
      }, 4000);
    }, 2000);
  });

  socket.on('detener-juego', (sala) => {
    if (!salas[sala]) return;
    clearInterval(salas[sala].intervalo);
    salas[sala].barajeoEnCurso = false;
    salas[sala].juegoPausado = false;
    io.to(sala).emit('juego-detenido');
  });

 // Este es el evento que un jugador emite cuando canta 'Lotería'
socket.on('loteria', ({ sala, nickname }) => {
  const data = salas[sala];
  if (!data) return;

  // Detenemos el juego y las emisiones de cartas
  data.juegoPausado = true;
  clearInterval(data.intervalo);
  data.barajeoEnCurso = false;

  // Emitimos el anuncio a todos los jugadores
  io.to(sala).emit('loteria-anunciada', nickname);

  // NOTA: No es necesario llamar 'juego-detenido' dos veces.
  // La lógica para la verificación del ganador la vamos a implementar en otro lugar.
});

// Este es el nuevo evento que el host debe emitir para confirmar al ganador
// La lógica para la verificación (en el cliente) debe disparar este evento.
socket.on('confirmar-ganador', ({ sala, ganadorId }) => {
  const data = salas[sala];
  if (!data || !data.jugadores[ganadorId]) {
    return;
  }

  // Transferir el bote al ganador
  const ganador = data.jugadores[ganadorId];
  ganador.monedas += data.bote;
  data.bote = 0; // Reiniciar el bote a 0

  // Reiniciar el estado de 'apostado' para todos los jugadores
  for (const id in data.jugadores) {
    data.jugadores[id].apostado = false;
  }

  // Informar a todos los jugadores sobre la actualización
  io.to(sala).emit('jugadores-actualizados', data.jugadores);
  io.to(sala).emit('bote-actualizado', 0);
  io.to(sala).emit('juego-detenido');
});

// También modifica el evento 'reiniciar-partida' para que reinicie las apuestas
socket.on('reiniciar-partida', (sala) => {
  if (!salas[sala]) return;
  salas[sala].historial = [];
  salas[sala].cartasSeleccionadas.clear();
  salas[sala].barajitas = [];
  salas[sala].barajeoEnCurso = false;
  salas[sala].juegoPausado = false;

  // Reiniciar apuestas de todos
  salas[sala].bote = 0;
  for (const id in salas[sala].jugadores) {
    salas[sala].jugadores[id].apostado = false;
  }

  io.to(sala).emit('partida-reiniciada');
  io.to(sala).emit('bote-actualizado', 0);
});
  socket.on('apostar', ({ sala }) => { // El cliente ya no necesita enviar 'cantidad'
    const data = salas[sala];
    if (!data) return;

    const jugador = data.jugadores[socket.id];
    if (!jugador || jugador.apostado) return;

    // Buscar cuántas cartas ha seleccionado el jugador en esta sala
    // (Asumo que guardas las cartas seleccionadas por jugador, no solo globalmente)
    const cartasActivas = jugador.cartasSeleccionadas ? jugador.cartasSeleccionadas.length : 0;
    if (cartasActivas === 0) {
      socket.emit('error-apuesta', 'No puedes apostar sin tener cartas seleccionadas.');
      return;
    }

    if (jugador.monedas >= cartasActivas) {
      // Lógica de apuesta...
      jugador.monedas -= cartasActivas;
      data.bote += cartasActivas;
      jugador.apostado = true;
     
      io.to(sala).emit('jugadores-actualizados', data.jugadores);
      io.to(sala).emit('bote-actualizado', data.bote);
    } else {
      socket.emit('error-apuesta', 'No tienes suficientes monedas.');
    }
});

  socket.on('verificar-ganador', ({ sala, ganadorId }) => {
    const data = salas[sala];
    if (!data) return;

    const ganador = data.jugadores[ganadorId];
    if (!ganador) return;

    ganador.monedas += data.bote; // Entregar bote
    data.bote = 0;

    // Reiniciar estado de apuestas
    for (const id in data.jugadores) {
      data.jugadores[id].apostado = false;
    }

    io.to(sala).emit('jugadores-actualizados', data.jugadores);
    io.to(sala).emit('bote-actualizado', 0);
  });

  socket.on('reiniciar-partida', (sala) => {
    if (!salas[sala]) return;
    salas[sala].historial = [];
    salas[sala].cartasSeleccionadas.clear();
    salas[sala].barajitas = [];
    salas[sala].barajeoEnCurso = false;
    salas[sala].juegoPausado = false;

    // Reiniciar apuestas
    salas[sala].bote = 0;
    for (const id in salas[sala].jugadores) {
      salas[sala].jugadores[id].apostado = false;
    }

    io.to(sala).emit('partida-reiniciada');
    io.to(sala).emit('volver-a-seleccion');
    io.to(sala).emit('bote-actualizado', 0);
  });

  socket.on('disconnecting', () => {
    const salasUsuario = Array.from(socket.rooms).filter(s => s !== socket.id);

    salasUsuario.forEach(sala => {
      const data = salas[sala];
      if (!data || !data.jugadores[socket.id]) return;

      delete data.jugadores[socket.id];

      if (socket.id === data.hostId) {
        const nuevosJugadores = Object.keys(data.jugadores);
        data.hostId = nuevosJugadores[0] || null;
        if (data.hostId) {
          data.jugadores[data.hostId].host = true;
        }
      }

      io.to(sala).emit('jugadores-actualizados', data.jugadores);
    });
  });

  socket.on('disconnect', () => {
    console.log(`Jugador desconectado: ${socket.id}`);
  });
});

app.use(cors());

app.get('/', (req, res) => {
  res.send('🎯 Servidor de Lotería funcionando con múltiples salas + apuestas');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
