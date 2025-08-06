const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// CORS para GitHub Pages
const io = new Server(server, {
  cors: {
    origin: 'https://resoner0796.github.io',
    methods: ['GET', 'POST']
  }
});

const jugadores = {};
let hostId = null;
let historialCartas = [];
let cartasSeleccionadas = new Set();
let baraja = [];
let barajaInterval = null;

// Inicializar baraja de 54 cartas
function reiniciarBaraja() {
  baraja = Array.from({ length: 54 }, (_, i) => String(i + 1).padStart(2, '0'));
  historialCartas = [];
  clearInterval(barajaInterval);
}

io.on('connection', (socket) => {
  console.log(`Jugador conectado: ${socket.id}`);

  socket.on('registrar-nickname', (nickname) => {
    if (!hostId) hostId = socket.id;

    jugadores[socket.id] = {
      nickname,
      host: socket.id === hostId
    };

    socket.emit('rol-asignado', jugadores[socket.id]);
    io.emit('jugadores-actualizados', jugadores);
    socket.emit('cartas-desactivadas', Array.from(cartasSeleccionadas));
    socket.emit('historial-actualizado', historialCartas);
  });

  socket.on('seleccionar-carta', (carta) => {
    cartasSeleccionadas.add(carta);
    io.emit('cartas-desactivadas', Array.from(cartasSeleccionadas));
  });

  socket.on('barajear', () => {
    reiniciarBaraja();
    io.emit('barajear');
  });

  socket.on('iniciarJuego', () => {
    if (socket.id !== hostId) return;

    clearInterval(barajaInterval);
    barajaInterval = setInterval(() => {
      if (baraja.length === 0) {
        clearInterval(barajaInterval);
        return;
      }

      const carta = baraja.shift();
      historialCartas.push(carta);
      io.emit('cartaCantada', carta);
    }, 3500); // Tiempo entre barajitas
  });

  socket.on('detenerJuego', () => {
    clearInterval(barajaInterval);
    io.emit('juegoDetenido');
  });

  socket.on('loteria', (nickname) => {
    io.emit('loteria-anunciada', nickname);
  });

  socket.on('reiniciarPartida', () => {
    if (socket.id !== hostId) return;

    hostId = null;
    historialCartas = [];
    cartasSeleccionadas.clear();
    reiniciarBaraja();
    io.emit('partidaReiniciada');
  });

  socket.on('disconnect', () => {
    console.log(`Jugador desconectado: ${socket.id}`);
    const eraHost = socket.id === hostId;
    delete jugadores[socket.id];

    if (eraHost) {
      const idsRestantes = Object.keys(jugadores);
      hostId = idsRestantes[0] || null;
      if (hostId && jugadores[hostId]) {
        jugadores[hostId].host = true;
        io.to(hostId).emit('rol-asignado', jugadores[hostId]);
      }
    }

    io.emit('jugadores-actualizados', jugadores);
  });
});

app.get('/', (req, res) => {
  res.send('🎉 Servidor de Lotería en funcionamiento.');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});