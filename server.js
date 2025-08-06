const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Configura CORS para GitHub Pages
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
let intervaloCantar = null;

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
    historialCartas = [];
    baraja = generarBaraja();
    clearInterval(intervaloCantar);
    io.emit('barajear');
  });

  socket.on('iniciar-juego', () => {
    if (baraja.length === 0) baraja = generarBaraja();

    // Reproducir sonidos iniciales y luego comenzar a cantar
    let index = 0;
    reproducirSonidoGlobal('campana.mp3');
    setTimeout(() => {
      reproducirSonidoGlobal('corre.mp3');
      setTimeout(() => {
        intervaloCantar = setInterval(() => {
          if (index >= baraja.length) {
            clearInterval(intervaloCantar);
            return;
          }
          const carta = baraja[index++];
          historialCartas.push(carta);
          io.emit('carta-cantada', carta);
        }, 3500);
      }, 2000);
    }, 1500);
  });

  socket.on('detener-juego', () => {
    clearInterval(intervaloCantar);
    io.emit('juego-detenido');
  });

  socket.on('loteria', (nickname) => {
    io.emit('loteria-anunciada', nickname);
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

  socket.on('reiniciar-partida', () => {
    clearInterval(intervaloCantar);
    historialCartas = [];
    cartasSeleccionadas = new Set();
    baraja = [];
    io.emit('cartas-desactivadas', []);
    io.emit('historial-actualizado', []);
    io.emit('reiniciar-cliente');
  });
});

// Generar baraja aleatoria de 54 cartas
function generarBaraja() {
  const cartas = Array.from({ length: 54 }, (_, i) => String(i + 1).padStart(2, '0'));
  for (let i = cartas.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cartas[i], cartas[j]] = [cartas[j], cartas[i]];
  }
  return cartas;
}

// Reproducir un audio en todos los clientes
function reproducirSonidoGlobal(nombre) {
  io.emit('carta-cantada', nombre.replace('.mp3', '')); // Reutiliza evento para reproducir audios iniciales
}

app.get('/', (req, res) => {
  res.send('🎴 Servidor de Lotería listo 🔥');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});