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
        hostId: socket.id,
        cartasSeleccionadas: new Set(),
        historial: [],
        barajitas: [],
        barajeoEnCurso: false,
        intervalo: null
      };
    }

    const esHost = socket.id === salas[sala].hostId;
    salas[sala].jugadores[socket.id] = { nickname, host: esHost };
    
    socket.emit('rol-asignado', { host: esHost });
    socket.emit('cartas-desactivadas', Array.from(salas[sala].cartasSeleccionadas));
    socket.emit('historial-actualizado', salas[sala].historial);
    io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
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
    io.to(sala).emit('barajear');
  });

  socket.on('iniciar-juego', (sala) => {
    const data = salas[sala];
    if (!data || data.barajeoEnCurso) return;

    if (data.barajitas.length === 0) {
      data.barajitas = generarBarajitas();
    }

    io.to(sala).emit('campana');

    setTimeout(() => {
      io.to(sala).emit('corre');
      let index = 0;
      data.barajeoEnCurso = true;

      data.intervalo = setInterval(() => {
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
    io.to(sala).emit('juego-detenido');
  });

  socket.on('reiniciar-partida', (sala) => {
    if (!salas[sala]) return;
    salas[sala].historial = [];
    salas[sala].cartasSeleccionadas.clear();
    salas[sala].barajitas = [];
    salas[sala].barajeoEnCurso = false;
    io.to(sala).emit('partida-reiniciada');
  });

  socket.on('loteria', ({ sala, nickname }) => {
    io.to(sala).emit('loteria-anunciada', nickname);
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

app.get('/', (req, res) => {
  res.send('🎯 Servidor de Lotería funcionando con múltiples salas');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});