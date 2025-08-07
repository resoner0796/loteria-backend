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
        apuestas: {},
        monedas: {},
      };
    }

    const esHostCustom = nickname.toLowerCase() === `host ${sala.toLowerCase()}`;
    if (esHostCustom || !salas[sala].hostId) {
      salas[sala].hostId = socket.id;
    }

    const esHost = socket.id === salas[sala].hostId;
    salas[sala].jugadores[socket.id] = { nickname, host: esHost };

    if (!salas[sala].monedas[socket.id]) {
      salas[sala].monedas[socket.id] = 10; // monedas iniciales
    }

    socket.emit('rol-asignado', { host: esHost });
    socket.emit('cartas-desactivadas', Array.from(salas[sala].cartasSeleccionadas));
    socket.emit('historial-actualizado', salas[sala].historial);
    io.to(sala).emit('jugadores-actualizados', getJugadoresConApuesta(sala));
  });

  socket.on('seleccionar-carta', ({ sala, carta }) => {
    if (!salas[sala]) return;
    salas[sala].cartasSeleccionadas.add(carta);
    io.to(sala).emit('cartas-desactivadas', Array.from(salas[sala].cartasSeleccionadas));
  });

  socket.on('apostar', (sala) => {
    const data = salas[sala];
    if (!data) return;
    const jugador = data.jugadores[socket.id];
    if (!jugador || data.apuestas[socket.id]) return;

    const cartas = Object.values(data.cartasSeleccionadas).filter(c => c); // puede mejorarse
    const costo = 1 * Object.values(cartas).filter(c => c).length;
    const saldo = data.monedas[socket.id] || 0;

    if (saldo < costo) {
      socket.emit('error-apuesta', 'No tienes monedas suficientes');
      return;
    }

    data.apuestas[socket.id] = true;
    data.monedas[socket.id] -= costo;
    io.to(sala).emit('jugadores-actualizados', getJugadoresConApuesta(sala));
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

  socket.on('loteria', ({ sala, nickname }) => {
    if (!salas[sala]) return;
    const data = salas[sala];
    data.juegoPausado = true;
    clearInterval(data.intervalo);
    data.barajeoEnCurso = false;

    // Ganador cobra el bote
    const apostadores = Object.keys(data.apuestas || {});
    const bote = apostadores.length;
    if (data.monedas[socket.id] != null) {
      data.monedas[socket.id] += bote;
    }

    data.apuestas = {};
    io.to(sala).emit('loteria-anunciada', nickname);
    io.to(sala).emit('juego-detenido');
    io.to(sala).emit('jugadores-actualizados', getJugadoresConApuesta(sala));
  });

  socket.on('reiniciar-partida', (sala) => {
    if (!salas[sala]) return;
    salas[sala].historial = [];
    salas[sala].cartasSeleccionadas.clear();
    salas[sala].barajitas = [];
    salas[sala].barajeoEnCurso = false;
    salas[sala].juegoPausado = false;
    salas[sala].apuestas = {};

    io.to(sala).emit('partida-reiniciada');
    io.to(sala).emit('volver-a-seleccion');
  });

  socket.on('disconnecting', () => {
    const salasUsuario = Array.from(socket.rooms).filter(s => s !== socket.id);

    salasUsuario.forEach(sala => {
      const data = salas[sala];
      if (!data || !data.jugadores[socket.id]) return;

      delete data.jugadores[socket.id];
      delete data.apuestas[socket.id];
      delete data.monedas[socket.id];

      if (socket.id === data.hostId) {
        const nuevosJugadores = Object.keys(data.jugadores);
        data.hostId = nuevosJugadores[0] || null;
        if (data.hostId) {
          data.jugadores[data.hostId].host = true;
        }
      }

      io.to(sala).emit('jugadores-actualizados', getJugadoresConApuesta(sala));
    });
  });

  socket.on('disconnect', () => {
    console.log(`Jugador desconectado: ${socket.id}`);
  });
});

function getJugadoresConApuesta(sala) {
  const data = salas[sala];
  if (!data) return {};
  const resultado = {};
  for (const [id, info] of Object.entries(data.jugadores)) {
    resultado[id] = {
      ...info,
      haApostado: !!data.apuestas[id],
      monedas: data.monedas[id] || 0,
    };
  }
  return resultado;
}

app.use(cors());

app.get('/', (req, res) => {
  res.send('🎯 Servidor de Lotería funcionando con múltiples salas');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});