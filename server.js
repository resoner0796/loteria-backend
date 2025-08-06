const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Configura CORS
const io = new Server(server, {
  cors: {
    origin: 'https://resoner0796.github.io',
    methods: ['GET', 'POST']
  }
});

// Variables del juego
const jugadores = {};
let hostId = null;
let historialCartas = [];
let cartasSeleccionadas = new Set();
let juegoEnCurso = false;
let baraja = [];
let intervaloCantar = null;

io.on('connection', (socket) => {
  console.log(`Jugador conectado: ${socket.id}`);

  // Registro nickname
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

  // Selección de carta
  socket.on('seleccionar-carta', (carta) => {
    cartasSeleccionadas.add(carta);
    io.emit('cartas-desactivadas', Array.from(cartasSeleccionadas));
  });

  // Barajear cartas (solo host)
  socket.on('barajear', () => {
    if (socket.id !== hostId) return;
    historialCartas = [];
    baraja = generarBaraja();
    io.emit('barajear');
    io.emit('historial-actualizado', historialCartas);
  });

  // Iniciar juego (solo host)
  socket.on('iniciar-juego', () => {
    if (socket.id !== hostId || juegoEnCurso || baraja.length === 0) return;

    juegoEnCurso = true;

    // Campana y corre
    io.emit('reproducir-audio', 'campana.mp3');
    setTimeout(() => {
      io.emit('reproducir-audio', 'corre.mp3');
    }, 3000);

    setTimeout(() => {
      cantarCarta();
      intervaloCantar = setInterval(cantarCarta, 6000);
    }, 6000);
  });

  // Cantar carta
  function cantarCarta() {
    if (baraja.length === 0) {
      clearInterval(intervaloCantar);
      juegoEnCurso = false;
      return;
    }

    const carta = baraja.shift();
    historialCartas.push(carta);
    io.emit('carta-cantada', carta);
    io.emit('historial-actualizado', historialCartas);
  }

  // Detener juego
  socket.on('detener-juego', () => {
    if (socket.id !== hostId) return;
    clearInterval(intervaloCantar);
    juegoEnCurso = false;
    io.emit('juego-detenido');
  });

  // Lotería
  socket.on('loteria', (nickname) => {
    io.emit('loteria-anunciada', nickname);
    clearInterval(intervaloCantar);
    juegoEnCurso = false;
  });

  // Reiniciar partida
  socket.on('reiniciar-partida', () => {
    if (socket.id !== hostId) return;

    historialCartas = [];
    cartasSeleccionadas = new Set();
    baraja = [];
    juegoEnCurso = false;
    clearInterval(intervaloCantar);

    io.emit('reiniciar');
    io.emit('cartas-desactivadas', []);
    io.emit('historial-actualizado', []);
  });

  // Desconexión
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

// Ruta de prueba
app.get('/', (req, res) => {
  res.send('Servidor de Lotería funcionando 🎉');
});

// Generar baraja aleatoria
function generarBaraja() {
  const baraja = [];
  for (let i = 1; i <= 54; i++) {
    const num = String(i).padStart(2, '0');
    baraja.push(num);
  }
  return baraja.sort(() => Math.random() - 0.5);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});