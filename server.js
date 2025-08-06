const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Configura CORS para tu dominio de GitHub Pages
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
let juegoEnCurso = false;
let baraja = [];
let intervalo;

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
    if (socket.id !== hostId) return;
    historialCartas = [];
    juegoEnCurso = false;
    clearInterval(intervalo);
    io.emit('barajear');
  });

  socket.on('iniciar-juego', () => {
    if (socket.id !== hostId) return;

    juegoEnCurso = true;
    baraja = shuffleDeck();
    io.emit('iniciar-cantada');

    setTimeout(() => {
      cantarCartas();
    }, 3000); // Espera a que termine el sonido de campana y corre
  });

  socket.on('detener-juego', () => {
    if (socket.id !== hostId) return;
    juegoEnCurso = false;
    clearInterval(intervalo);
    io.emit('juego-detenido');
  });

  socket.on('loteria', (nickname) => {
    io.emit('loteria-anunciada', nickname);
  });

  socket.on('reiniciar-partida', () => {
    if (socket.id !== hostId) return;
    hostId = null;
    historialCartas = [];
    cartasSeleccionadas.clear();
    juegoEnCurso = false;
    clearInterval(intervalo);
    io.emit('reiniciar-cliente');
  });

  socket.on('disconnect', () => {
    console.log(`Jugador desconectado: ${socket.id}`);
    delete jugadores[socket.id];

    if (socket.id === hostId) {
      hostId = Object.keys(jugadores)[0] || null;
      if (hostId) jugadores[hostId].host = true;
    }

    io.emit('jugadores-actualizados', jugadores);
  });
});

function shuffleDeck() {
  const cartas = Array.from({ length: 10 }, (_, i) => String(i + 1).padStart(2, '0'));
  for (let i = cartas.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cartas[i], cartas[j]] = [cartas[j], cartas[i]];
  }
  return cartas;
}

function cantarCartas() {
  if (!juegoEnCurso) return;

  intervalo = setInterval(() => {
    if (baraja.length === 0) {
      clearInterval(intervalo);
      return;
    }

    const carta = baraja.shift();
    historialCartas.push(carta);
    io.emit('carta-cantada', carta);
  }, 3000);
}

app.get('/', (req, res) => {
  res.send('Servidor de Lotería funcionando 🎉');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});