const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Habilitar CORS para tu GitHub Pages
const io = new Server(server, {
  cors: {
    origin: "https://resoner0796.github.io",
    methods: ["GET", "POST"]
  }
});

// Estado global del juego
const jugadores = {};
let hostId = null;
let cartasSeleccionadas = new Set();
let historial = [];
let barajitas = [];
let barajeoEnCurso = false;
let intervalo;

// Generar barajitas del 01 al 54 en orden aleatorio
function generarBarajitas() {
  const total = 54;
  const barajas = Array.from({ length: total }, (_, i) => String(i + 1).padStart(2, '0'));
  return barajas.sort(() => Math.random() - 0.5);
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
    socket.emit('cartas-desactivadas', Array.from(cartasSeleccionadas));
    socket.emit('historial-actualizado', historial);
    io.emit('jugadores-actualizados', jugadores);
  });

  socket.on('seleccionar-carta', (carta) => {
    cartasSeleccionadas.add(carta);
    io.emit('cartas-desactivadas', Array.from(cartasSeleccionadas));
  });

  socket.on('barajear', () => {
    historial = [];
    barajitas = generarBarajitas();
    io.emit('barajear');
  });

  socket.on('iniciar-juego', () => {
    if (barajeoEnCurso) return;
    if (barajitas.length === 0) barajitas = generarBarajitas();

    io.emit('campana');
    setTimeout(() => {
      io.emit('corre');

      let index = 0;
      barajeoEnCurso = true;

      intervalo = setInterval(() => {
        if (index >= barajitas.length) {
          clearInterval(intervalo);
          barajeoEnCurso = false;
          return;
        }

        const carta = barajitas[index];
        historial.push(carta);
        io.emit('carta-cantada', carta);
        index++;
      }, 4000);
    }, 2000);
  });

  socket.on('detener-juego', () => {
    clearInterval(intervalo);
    barajeoEnCurso = false;
    io.emit('juego-detenido');
  });

  socket.on('reiniciar-partida', () => {
    historial = [];
    cartasSeleccionadas.clear();
    hostId = null;
    barajitas = [];
    barajeoEnCurso = false;
    io.emit('partida-reiniciada');
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
});

app.get('/', (req, res) => {
  res.send('🎯 Servidor de Lotería en línea y funcionando');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});