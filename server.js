const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Habilitar CORS para tu frontend de GitHub Pages
const io = new Server(server, {
  cors: {
    origin: 'https://resoner0796.github.io', // Tu dominio de GitHub Pages
    methods: ['GET', 'POST']
  }
});

// Variables de estado del juego
const jugadores = {};
let hostId = null;
let historialCartas = [];
let cartasSeleccionadas = new Set();

// Conexión de socket
io.on('connection', (socket) => {
  console.log(`Jugador conectado: ${socket.id}`);

  // Registro de nickname
  socket.on('registrar-nickname', (nickname) => {
    if (!hostId) hostId = socket.id;

    jugadores[socket.id] = {
      nickname,
      host: socket.id === hostId
    };

    // Responde al jugador con su rol
    socket.emit('rol-asignado', jugadores[socket.id]);

    // Enviar datos al jugador conectado
    socket.emit('cartas-desactivadas', Array.from(cartasSeleccionadas));
    socket.emit('historial-actualizado', historialCartas);

    // Actualiza lista de jugadores
    io.emit('jugadores-actualizados', jugadores);
  });

  // Guardar carta seleccionada
  socket.on('seleccionar-carta', (carta) => {
    cartasSeleccionadas.add(carta);
    io.emit('cartas-desactivadas', Array.from(cartasSeleccionadas));
  });

  // Barajear (reinicia historial)
  socket.on('barajear', () => {
    historialCartas = [];
    io.emit('barajear');
  });

  // Iniciar juego (el host lanza cartas)
  socket.on('cantar-carta', (carta) => {
    historialCartas.push(carta);
    io.emit('carta-cantada', carta);
  });

  // Detener juego
  socket.on('detener-juego', () => {
    io.emit('juego-detenido');
  });

  // Lotería
  socket.on('loteria', (nickname) => {
    io.emit('loteria-anunciada', nickname);
  });

  // Reiniciar partida
  socket.on('reiniciar-juego', () => {
    historialCartas = [];
    cartasSeleccionadas.clear();
    io.emit('reinicio-completo');
  });

  // Desconexión de jugador
  socket.on('disconnect', () => {
    console.log(`Jugador desconectado: ${socket.id}`);
    delete jugadores[socket.id];

    // Reasignar host si se fue el anterior
    if (socket.id === hostId) {
      const nuevosIds = Object.keys(jugadores);
      hostId = nuevosIds.length ? nuevosIds[0] : null;
      if (hostId) jugadores[hostId].host = true;
    }

    io.emit('jugadores-actualizados', jugadores);
  });
});

// Ruta base
app.get('/', (req, res) => {
  res.send('🎲 Servidor de Lotería funcionando correctamente.');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en el puerto ${PORT}`);
});