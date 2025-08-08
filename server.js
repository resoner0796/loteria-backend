const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "https://resoner0796.github.io",
    methods: ["GET", "POST"]
  }
});

// Estado global por sala
const salas = {};

function generarBarajitas() {
  const total = 54;
  const barajas = Array.from({ length: total }, (_, i) => String(i + 1).padStart(2, '0'));
  return barajas.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
  console.log(`Jugador conectado: ${socket.id}`);

  socket.on('unirse-sala', ({ sala, nickname }) => {
    socket.join(sala);

    if (!salas[sala]) {
      salas[sala] = {
        jugadores: {},
        hostId: null,
        cartasSeleccionadas: new Set(),
        historial: [],
        barajitas: [],
        barajeoEnCurso: false,
        intervalo: null,
        juegoPausado: false,
        bote: 0 // Nuevo bote global
      };
    }

    const esHostCustom = nickname.toLowerCase() === `host ${sala.toLowerCase()}`;
    if (esHostCustom || !salas[sala].hostId) {
      salas[sala].hostId = socket.id;
    }

    const esHost = socket.id === salas[sala].hostId;
    salas[sala].jugadores[socket.id] = { 
      nickname, 
      host: esHost,
      monedas: 15, // Monedas iniciales por jugador
      apostado: false // Marca si ya apostó en la ronda
    };

    socket.emit('rol-asignado', { host: esHost });
    socket.emit('cartas-desactivadas', Array.from(salas[sala].cartasSeleccionadas));
    socket.emit('historial-actualizado', salas[sala].historial);
    io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores);
    /* ===== LOGICA APUESTAS (PEGAR AQUI) ===== */
const btnApostar = document.getElementById("btnApostar");
const monedasEl = document.getElementById("monedas-valor");
const boteEl = document.getElementById("bote-valor");

// Estado cliente
let initialMonedas = {};      // snapshot de monedas al entrar para calcular bote
let haApostadoLocal = false;  // si este cliente ya apostó esta ronda
let monedasInicialesPorJugador = 15; // fallback si server no envía (ajusta si tu server usa 10)

// Botón apostar -> envía la cantidad según cartas seleccionadas
btnApostar && btnApostar.addEventListener("click", () => {
  if (!salaActual) return alert("Únete a una sala primero.");
  if (haApostadoLocal) return alert("Ya apostaste esta ronda.");
  // Cantidad a apostar = número de cartas seleccionadas (mínimo 1)
  const cantidad = Math.max(1, seleccionadas.length || 1);
  // Emitir apuesta al servidor (server espera { sala, cantidad })
  socket.emit("apostar", { sala: salaActual, cantidad });
  haApostadoLocal = true;
  btnApostar.disabled = true;
});

// Si el servidor envía errores de apuesta
socket.on("error-apuesta", msg => {
  alert(msg || "Error al apostar");
  // permitir reintentar
  haApostadoLocal = false;
  if (btnApostar) btnApostar.disabled = false;
});

// Actualizar lista de jugadores + monedas + calcular bote localmente
// *IMPORTANTE* : reemplaza o usa en conjunto con tu listener existente para "jugadores-actualizados"
socket.on("jugadores-actualizados", jugadores => {
  // 1) actualizar la lista visual (manteniendo formato original)
  jugadoresLista.innerHTML = "<h3>Jugadores conectados:</h3>" +
    Object.values(jugadores).map(j => {
      const check = j.haApostado ? "✅" : "";
      const monedas = (typeof j.monedas !== "undefined") ? j.monedas : "-";
      return `<div>${j.nickname} ${check} <span style="margin-left:8px">(${monedas})</span></div>`;
    }).join("");

  // 2) si no teníamos snapshot inicial, guardarla
  Object.entries(jugadores).forEach(([id, info]) => {
    if (initialMonedas[id] == null) {
      // si el servidor envía monedas, usar; si no, usar fallback
      initialMonedas[id] = (typeof info.monedas !== "undefined") ? info.monedas : monedasInicialesPorJugador;
    }
  });

  // 3) actualizar mi saldo mostrado (si el servidor lo manda)
  const miInfo = jugadores[socket.id];
  if (miInfo && typeof miInfo.monedas !== "undefined") {
    monedasEl.textContent = miInfo.monedas;
  }

  // 4) calcular bote: suma de (initial - current) para cada jugador
  let boteCalc = 0;
  Object.entries(jugadores).forEach(([id, info]) => {
    const init = initialMonedas[id] ?? ((typeof info.monedas !== "undefined") ? info.monedas : monedasInicialesPorJugador);
    const curr = (typeof info.monedas !== "undefined") ? info.monedas : init;
    const diff = init - curr;
    if (diff > 0) boteCalc += diff;
  });
  boteEl.textContent = boteCalc;
});

// Reset UI cuando reinician la partida
socket.on("partida-reiniciada", () => {
  initialMonedas = {};
  haApostadoLocal = false;
  if (btnApostar) btnApostar.disabled = false;
  if (boteEl) boteEl.textContent = "0";
});

// Cuando alguien canta lotería el server ya envía anuncios; asegurarse que se desbloquee el apostar en nueva ronda (opcional)
socket.on("loteria-anunciada", quien => {
  // Si el servidor reinicia apuestas, desbloqueamos el botón localmente
  haApostadoLocal = false;
  if (btnApostar) btnApostar.disabled = false;
});
/* ===== FIN LOGICA APUESTAS ===== */
    socket.emit('bote-actualizado', salas[sala].bote);
  });

  socket.on('seleccionar-carta', ({ sala, carta }) => {
    if (!salas[sala]) return;
    salas[sala].cartasSeleccionadas.add(carta);
    io.to(sala).emit('cartas-desactivadas', Array.from(salas[sala].cartasSeleccionadas));
  });

  socket.on('barajear', (sala) => {
    if (!salas[sala]) return;
    salas[sala].historial = [];
    salas[sala].barajitas = generarBarajitas();
    salas[sala].juegoPausado = false;
    io.to(sala).emit('barajear');
  });

  socket.on('iniciar-juego', (sala) => {
    const data = salas[sala];
    if (!data || data.barajeoEnCurso || data.juegoPausado) return;

    if (data.barajitas.length === 0) {
      data.barajitas = generarBarajitas();
    }

    io.to(sala).emit('campana');

    setTimeout(() => {
      io.to(sala).emit('corre');
      let index = 0;
      data.barajeoEnCurso = true;

      data.intervalo = setInterval(() => {
        if (data.juegoPausado) return;

        if (index >= data.barajitas.length) {
          clearInterval(data.intervalo);
          data.barajeoEnCurso = false;
          return;
        }

        const carta = data.barajitas[index];
        data.historial.push(carta);
        io.to(sala).emit('carta-cantada', carta);
        index++;
      }, 4000);
    }, 2000);
  });

  socket.on('detener-juego', (sala) => {
    if (!salas[sala]) return;
    clearInterval(salas[sala].intervalo);
    salas[sala].barajeoEnCurso = false;
    salas[sala].juegoPausado = false;
    io.to(sala).emit('juego-detenido');
  });

  socket.on('loteria', ({ sala, nickname }) => {
    if (!salas[sala]) return;
    const data = salas[sala];
    data.juegoPausado = true;
    clearInterval(data.intervalo);
    data.barajeoEnCurso = false;

    io.to(sala).emit('loteria-anunciada', nickname);
    io.to(sala).emit('juego-detenido');
  });

  socket.on('apostar', (sala) => {
    const data = salas[sala];
    if (!data) return;

    const jugador = data.jugadores[socket.id];
    if (!jugador || jugador.apostado) return; // Evita apostar dos veces

    // Contar cartas activas de este jugador
    let cartasActivas = Array.from(data.cartasSeleccionadas).length;
    if (cartasActivas === 0) return;

    if (jugador.monedas >= cartasActivas) {
      jugador.monedas -= cartasActivas;
      data.bote += cartasActivas;
      jugador.apostado = true;

      io.to(sala).emit('jugadores-actualizados', data.jugadores);
      io.to(sala).emit('bote-actualizado', data.bote);
    }
  });

  socket.on('verificar-ganador', ({ sala, ganadorId }) => {
    const data = salas[sala];
    if (!data) return;

    const ganador = data.jugadores[ganadorId];
    if (!ganador) return;

    ganador.monedas += data.bote; // Entregar bote
    data.bote = 0;

    // Reiniciar estado de apuestas
    for (const id in data.jugadores) {
      data.jugadores[id].apostado = false;
    }

    io.to(sala).emit('jugadores-actualizados', data.jugadores);
    io.to(sala).emit('bote-actualizado', data.bote);
  });

  socket.on('reiniciar-partida', (sala) => {
    if (!salas[sala]) return;
    salas[sala].historial = [];
    salas[sala].cartasSeleccionadas.clear();
    salas[sala].barajitas = [];
    salas[sala].barajeoEnCurso = false;
    salas[sala].juegoPausado = false;

    // Reiniciar apuestas
    salas[sala].bote = 0;
    for (const id in salas[sala].jugadores) {
      salas[sala].jugadores[id].apostado = false;
    }

    io.to(sala).emit('partida-reiniciada');
    io.to(sala).emit('volver-a-seleccion');
    io.to(sala).emit('bote-actualizado', 0);
  });

  socket.on('disconnecting', () => {
    const salasUsuario = Array.from(socket.rooms).filter(s => s !== socket.id);

    salasUsuario.forEach(sala => {
      const data = salas[sala];
      if (!data || !data.jugadores[socket.id]) return;

      delete data.jugadores[socket.id];

      if (socket.id === data.hostId) {
        const nuevosJugadores = Object.keys(data.jugadores);
        data.hostId = nuevosJugadores[0] || null;
        if (data.hostId) {
          data.jugadores[data.hostId].host = true;
        }
      }

      io.to(sala).emit('jugadores-actualizados', data.jugadores);
    });
  });

  socket.on('disconnect', () => {
    console.log(`Jugador desconectado: ${socket.id}`);
  });
});

app.use(cors());

app.get('/', (req, res) => {
  res.send('🎯 Servidor de Lotería funcionando con múltiples salas + apuestas');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});