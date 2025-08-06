const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Configura CORS para aceptar tu dominio de GitHub Pages
const io = new Server(server, {
  cors: {
    origin: 'https://resoner0796.github.io', // <--- PON TU DOMINIO GITHUB AQUÍ
    methods: ['GET', 'POST']
  }
});

const jugadores = {};
let hostId = null;
let historialCartas = [];
let cartasSeleccionadas = new Set();

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
    io.emit('barajear');
  });

  socket.on('cantar-carta', (carta) => {
    historialCartas.push(carta);
    io.emit('carta-cantada', carta);
  });

  socket.on('detener-juego', () => {
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
});

app.get('/', (req, res) => {
  res.send('Servidor de Lotería funcionando 🎉');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
