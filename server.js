const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// Estado del juego por sala
const salas = {};

app.get('/', (req, res) => {
  res.send('Servidor de Lotería funcionando.');
});

io.on('connection', (socket) => {
  console.log('Nuevo jugador conectado:', socket.id);

  socket.on('unirse-sala', ({ nickname, sala }) => {
    socket.join(sala);
    if (!salas[sala]) {
      salas[sala] = {
        jugadores: {},
        baraja: [],
        historial: [],
        juegoIniciado: false,
        bote: 0,
        hostId: socket.id,
        intervaloCartas: null,
        loteriaPendiente: null,
        pagoRealizado: false
      };
      console.log(`Sala '${sala}' creada por ${nickname} (${socket.id})`);
      socket.emit('rol-asignado', { host: true });
    } else {
      socket.emit('rol-asignado', { host: false });
    }
    salas[sala].jugadores[socket.id] = { nickname, monedas: 30, apostado: false, cartas: [], id: socket.id };
    console.log(`${nickname} se ha unido a la sala '${sala}'`);

    io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
    io.to(sala).emit('bote-actualizado', salas[sala].bote);
    io.to(sala).emit('historial-actualizado', salas[sala].historial);
  });

  socket.on('seleccionar-carta', ({ carta, sala }) => {
    if (salas[sala] && salas[sala].jugadores[socket.id]) {
      const jugador = salas[sala].jugadores[socket.id];
      if (jugador.cartas.length < 4) {
        jugador.cartas.push(carta);
      }
    }
  });

  socket.on('apostar', ({ sala, cantidad }) => {
    if (salas[sala] && salas[sala].jugadores[socket.id] && !salas[sala].jugadores[socket.id].apostado) {
      const jugador = salas[sala].jugadores[socket.id];
      if (jugador.monedas >= cantidad) {
        jugador.monedas -= cantidad;
        salas[sala].bote += cantidad;
        jugador.apostado = true;
        io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
        io.to(sala).emit('monedas-actualizado', jugador.monedas);
        io.to(sala).emit('bote-actualizado', salas[sala].bote);
      } else {
        socket.emit('error-apuesta', 'No tienes suficientes monedas.');
      }
    }
  });

  socket.on('iniciar-juego', (sala) => {
    if (salas[sala] && socket.id === salas[sala].hostId) {
      if (!salas[sala].juegoIniciado) {
        salas[sala].baraja = mezclarBaraja();
        salas[sala].historial = [];
        salas[sala].juegoIniciado = true;
        salas[sala].loteriaPendiente = null;
        salas[sala].pagoRealizado = false;
        io.to(sala).emit('juego-iniciado');
        repartirCartas(sala);
      }
    }
  });

  socket.on('detener-juego', (sala) => {
    if (salas[sala] && socket.id === salas[sala].hostId) {
      salas[sala].juegoIniciado = false;
      if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);
      io.to(sala).emit('juego-detenido');
    }
  });

  socket.on('barajear', (sala) => {
    if (salas[sala] && socket.id === salas[sala].hostId) {
      salas[sala].baraja = mezclarBaraja();
      salas[sala].historial = [];
      io.to(sala).emit('barajear');
    }
  });

  socket.on('reiniciar-partida', (sala) => {
    if (salas[sala] && socket.id === salas[sala].hostId) {
      salas[sala].juegoIniciado = false;
      salas[sala].historial = [];
      salas[sala].bote = 0;
      salas[sala].loteriaPendiente = null;
      salas[sala].pagoRealizado = false;
      if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);
      for (const id in salas[sala].jugadores) {
        salas[sala].jugadores[id].apostado = false;
        salas[sala].jugadores[id].cartas = [];
      }
      io.to(sala).emit('partida-reiniciada');
      io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
      io.to(sala).emit('bote-actualizado', 0);
    }
  });

  socket.on('loteria', ({ nickname, sala }) => {
    if (salas[sala] && salas[sala].juegoIniciado) {
      salas[sala].juegoIniciado = false;
      if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);

      salas[sala].loteriaPendiente = {
        ganadorId: socket.id,
        nickname,
        timestamp: Date.now()
      };
      salas[sala].pagoRealizado = false;

      io.to(salas[sala].hostId).emit('loteria-anunciada', nickname, socket.id);
    }
  });
  
  // ✅✅✅ CÓDIGO CORREGIDO ✅✅✅
  socket.on('confirmar-ganador', ({ sala, ganadorId, esValido }) => {
    const salaInfo = salas[sala];
  
    // --- 1. Validaciones ---
    // (Estas validaciones están bien, aseguran que solo el host pueda confirmar una victoria válida y pendiente)
    if (!salaInfo || socket.id !== salaInfo.hostId || !salaInfo.loteriaPendiente || salaInfo.pagoRealizado || ganadorId !== salaInfo.loteriaPendiente.ganadorId) {
      console.warn(`[SALA: ${sala}] Intento de confirmación inválido.`);
      return;
    }
  
    const jugadorGanador = salaInfo.jugadores[ganadorId];
    if (!jugadorGanador) {
      console.error(`[SALA: ${sala}] Error: El jugador con ID ${ganadorId} no fue encontrado.`);
      return;
    }
  
    // --- 2. Lógica de Decisión (Aceptar vs Rechazar) ---
  
    // CASO B: El Host RECHAZA la victoria (esValido es false)
    if (esValido === false) {
      console.log(`[SALA: ${sala}] El Host RECHAZÓ la victoria de ${jugadorGanador.nickname}. El juego continúa.`);
      
      // Notificamos a todos que la victoria fue rechazada.
      io.to(sala).emit('ganador-rechazado', ganadorId);
  
      // Limpiamos el estado de "victoria pendiente" para que alguien más pueda ganar.
      salaInfo.loteriaPendiente = null;
      
      // Reanudamos el juego.
      salaInfo.juegoIniciado = true;
      repartirCartas(sala); // Función que sigue sacando cartas.
      
      // ***** LA CORRECCIÓN CLAVE *****
      // Usamos 'return' para detener la ejecución aquí. 
      // Si no lo hiciéramos, el código continuaría y pagaría el bote incorrectamente.
      return; 
    }
  
    // CASO A: El Host ACEPTA la victoria (esValido es true)
    // Si el código llega a este punto, significa que la victoria fue aceptada.
    const boteActual = Number(salaInfo.bote) || 0;
    console.log(`[SALA: ${sala}] El Host ACEPTÓ la victoria de ${jugadorGanador.nickname}.`);
  
    // Transferimos el bote al ganador.
    if (boteActual > 0) {
      jugadorGanador.monedas += boteActual;
      salaInfo.bote = 0;
      salaInfo.pagoRealizado = true; // Marcamos que el pago se hizo para evitar dobles pagos.
    }
  
    // Reiniciamos el estado de apuesta de todos para la siguiente ronda.
    for (const id in salaInfo.jugadores) {
      salaInfo.jugadores[id].apostado = false;
    }
  
    // Limpiamos la victoria pendiente y detenemos el juego.
    salaInfo.loteriaPendiente = null;
    salaInfo.juegoIniciado = false;
    if (salaInfo.intervaloCartas) {
      clearInterval(salaInfo.intervaloCartas);
      salaInfo.intervaloCartas = null;
    }
  
    // Notificamos a todos los clientes sobre el resultado final.
    io.to(sala).emit('ganador-confirmado', ganadorId);
    io.to(sala).emit('jugadores-actualizados', salaInfo.jugadores);
    io.to(sala).emit('bote-actualizado', salaInfo.bote);
  });

  
  socket.on('salir-sala', (sala) => {
    if (salas[sala] && salas[sala].jugadores[socket.id]) {
      const nickname = salas[sala].jugadores[socket.id].nickname;
      socket.leave(sala);
      delete salas[sala].jugadores[socket.id];
      console.log(`${nickname} ha dejado la sala '${sala}'`);
      io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
      if (Object.keys(salas[sala].jugadores).length === 0) {
        if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);
        delete salas[sala];
        console.log(`Sala '${sala}' eliminada.`);
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('Jugador desconectado:', socket.id);
    for (const sala in salas) {
      if (salas[sala].jugadores[socket.id]) {
        const nickname = salas[sala].jugadores[socket.id].nickname;
        delete salas[sala].jugadores[socket.id];
        console.log(`${nickname} ha dejado la sala '${sala}'`);
        io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
        if (Object.keys(salas[sala].jugadores).length === 0) {
          if (salas[sala].intervaloCartas) clearInterval(salas[sala].intervaloCartas);
          delete salas[sala];
          console.log(`Sala '${sala}' eliminada.`);
        }
      }
    }
  });
});

function mezclarBaraja() {
  const cartas = Array.from({ length: 54 }, (_, i) => String(i + 1).padStart(2, '0'));
  return cartas.sort(() => Math.random() - 0.5);
}

function repartirCartas(sala) {
  const salaInfo = salas[sala];
  if (!salaInfo || !salaInfo.juegoIniciado) return;

  let index = 0;
  if (salaInfo.intervaloCartas) clearInterval(salaInfo.intervaloCartas);

  salaInfo.intervaloCartas = setInterval(() => {
    if (!salaInfo.juegoIniciado || index >= salaInfo.baraja.length) {
      clearInterval(salaInfo.intervaloCartas);
      salaInfo.intervaloCartas = null;
      return;
    }
    const carta = salaInfo.baraja[index++];
    salaInfo.historial.push(carta);
    io.to(sala).emit('carta-cantada', carta);
    io.to(sala).emit('historial-actualizado', salaInfo.historial);
  }, 4000);
}

http.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
