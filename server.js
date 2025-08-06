const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*'
  }
});

let jugadores = [];
let hostId = null;

io.on('connection', (socket) => {
  console.log(`Usuario conectado: ${socket.id}`);

  socket.on('join', (nickname) => {
    const esHost = hostId === null;
    if (esHost) hostId = socket.id;

    jugadores.push({ id: socket.id, nickname, esHost });
    console.log(`${nickname} se ha unido. Host: ${esHost}`);

    socket.emit('rol', esHost); // Enviar si es host o no
    io.emit('jugadores', jugadores.map(j => j.nickname));
  });

  socket.on('loteria', (ganador) => {
    io.emit('ganador', ganador);
  });

  socket.on('disconnect', () => {
    jugadores = jugadores.filter(j => j.id !== socket.id);
    if (socket.id === hostId) {
      console.log("Host salió. Reiniciando host.");
      hostId = jugadores.length > 0 ? jugadores[0].id : null;
      if (hostId && jugadores.length > 0) {
        io.to(hostId).emit('rol', true); // Nuevo host
      }
    }
    io.emit('jugadores', jugadores.map(j => j.nickname));
  });
});

server.listen(3000, () => {
  console.log('Servidor de Lotería funcionando en el puerto 3000');
});
