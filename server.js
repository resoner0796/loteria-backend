const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

let salas = {};

io.on('connection', (socket) => {
  console.log('Nuevo cliente conectado:', socket.id);

  socket.on('unirse-sala', ({ nickname, sala }) => {
    socket.join(sala);
    const jugadorId = socket.id;
    
    if (!salas[sala]) {
      salas[sala] = {
        jugadores: {},
        cartasCantadas: [],
        mazo: [],
        bote: 0,
        juegoIniciado: false,
        hostId: jugadorId
      };
      console.log(`Sala ${sala} creada por el host: ${nickname}`);
    }

    salas[sala].jugadores[jugadorId] = {
      nickname,
      monedas: 30,
      cartasSeleccionadas: [],
      apostado: false,
    };

    socket.sala = sala;

    const esHost = jugadorId === salas[sala].hostId;
    socket.emit('rol-asignado', { host: esHost });

    io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
    io.to(sala).emit('historial-actualizado', salas[sala].cartasCantadas);
  });
  
  socket.on('seleccionar-carta', ({ carta, sala }) => {
    const jugador = salas[sala].jugadores[socket.id];
    if (jugador.cartasSeleccionadas.length < 3 && !jugador.cartasSeleccionadas.includes(carta)) {
      jugador.cartasSeleccionadas.push(carta);
    }
  });

  socket.on('apostar', ({ sala, cantidad }) => {
    const jugador = salas[sala].jugadores[socket.id];
    if (!jugador) return socket.emit('error-apuesta', 'No estás en una sala.');
    if (jugador.apostado) return socket.emit('error-apuesta', 'Ya apostaste en esta ronda.');
    if (cantidad <= 0 || cantidad > jugador.monedas) return socket.emit('error-apuesta', 'Cantidad de apuesta no válida.');

    jugador.monedas -= cantidad;
    salas[sala].bote += cantidad;
    jugador.apostado = true;
    
    io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
    io.to(sala).emit('bote-actualizado', salas[sala].bote);
  });
  
  socket.on('barajear', (sala) => {
    const salaObj = salas[sala];
    if (!salaObj || socket.id !== salaObj.hostId) return;

    salaObj.mazo = Array.from({ length: 16 }, (_, i) => String(i + 1).padStart(2, '0'));
    salaObj.cartasCantadas = [];
    shuffleArray(salaObj.mazo);
    
    io.to(sala).emit('barajear');
    io.to(sala).emit('historial-actualizado', salaObj.cartasCantadas);
  });

  socket.on('iniciar-juego', (sala) => {
    const salaObj = salas[sala];
    if (!salaObj || socket.id !== salaObj.hostId) return;

    if (Object.values(salaObj.jugadores).some(j => j.cartasSeleccionadas.length === 0)) {
      return socket.emit('error-juego', 'Todos los jugadores deben seleccionar sus cartas.');
    }

    salaObj.juegoIniciado = true;
    cantarCarta(sala);
  });

  socket.on('detener-juego', (sala) => {
    const salaObj = salas[sala];
    if (!salaObj || socket.id !== salaObj.hostId) return;
    salaObj.juegoIniciado = false;
    io.to(sala).emit('juego-detenido');
  });

  socket.on('loteria', ({ nickname, sala }) => {
    io.to(sala).emit('loteria-anunciada', nickname);
  });

  socket.on('confirmar-ganador', ({ sala, ganadorId }) => {
    const salaObj = salas[sala];
    if (!salaObj || socket.id !== salaObj.hostId) return;
    
    // Transferir el bote al ganador
    if (salaObj.jugadores[ganadorId]) {
      salaObj.jugadores[ganadorId].monedas += salaObj.bote;
      console.log(`El ganador ${salaObj.jugadores[ganadorId].nickname} recibe ${salaObj.bote} monedas.`);
    }

    // Reiniciar el estado de apuestas para la siguiente ronda
    salaObj.bote = 0;
    Object.values(salaObj.jugadores).forEach(jugador => {
      jugador.apostado = false;
    });

    io.to(sala).emit('jugadores-actualizados', salaObj.jugadores);
    io.to(sala).emit('bote-actualizado', salaObj.bote);
  });
  
  socket.on('reiniciar-partida', (sala) => {
    const salaObj = salas[sala];
    if (!salaObj || socket.id !== salaObj.hostId) return;

    salaObj.juegoIniciado = false;
    salaObj.cartasCantadas = [];
    salaObj.bote = 0;
    
    Object.values(salaObj.jugadores).forEach(jugador => {
      jugador.cartasSeleccionadas = [];
      jugador.apostado = false;
    });

    io.to(sala).emit('partida-reiniciada');
    io.to(sala).emit('jugadores-actualizados', salaObj.jugadores);
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
    const sala = socket.sala;
    if (sala && salas[sala]) {
      delete salas[sala].jugadores[socket.id];
      if (Object.keys(salas[sala].jugadores).length === 0) {
        delete salas[sala];
        console.log(`Sala ${sala} eliminada.`);
      } else {
        if (salas[sala].hostId === socket.id) {
          const nuevosJugadores = Object.keys(salas[sala].jugadores);
          salas[sala].hostId = nuevosJugadores[0];
          io.to(nuevosJugadores[0]).emit('rol-asignado', { host: true });
        }
        io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
      }
    }
  });
});

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function cantarCarta(sala) {
  const salaObj = salas[sala];
  if (!salaObj || !salaObj.juegoIniciado) return;

  const carta = salaObj.mazo.shift();
  if (carta) {
    salaObj.cartasCantadas.push(carta);
    io.to(sala).emit('carta-cantada', carta);
    io.to(sala).emit('historial-actualizado', salaObj.cartasCantadas);

    setTimeout(() => {
      cantarCarta(sala);
    }, 4000);
  } else {
    io.to(sala).emit('juego-terminado');
  }
}

server.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
