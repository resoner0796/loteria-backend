// === server.js actualizado ===
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const io = new Server(http);
const path = require("path");

const PORT = process.env.PORT || 3000;

let jugadores = {};
let historial = [];
let cartasSeleccionadas = [];
let hostId = null;

app.use(express.static(path.join(__dirname, ".")));

io.on("connection", (socket) => {
  console.log("Nuevo jugador conectado:", socket.id);

  socket.on("registrarJugador", (nickname) => {
    const esHost = !hostId;
    if (esHost) hostId = socket.id;

    jugadores[socket.id] = { nickname, esHost };

    socket.emit("rolAsignado", { esHost });
    socket.emit("actualizarCartasOcupadas", cartasSeleccionadas);
    socket.emit("actualizarHistorial", historial);
    io.emit("jugadorConectado", jugadores);
  });

  socket.on("cartasSeleccionadas", (cartas) => {
    cartasSeleccionadas.push(...cartas);
    io.emit("actualizarCartasOcupadas", cartasSeleccionadas);
  });

  socket.on("barajar", () => {
    historial = [];
    io.emit("limpiarHistorial");
  });

  socket.on("cantarCarta", (carta) => {
    historial.push(carta);
    io.emit("nuevaCartaCantada", carta);
  });

  socket.on("reiniciarJuego", () => {
    historial = [];
    cartasSeleccionadas = [];
    io.emit("reiniciarPartida");
  });

  socket.on("disconnect", () => {
    console.log("Jugador desconectado:", socket.id);
    delete jugadores[socket.id];
    if (socket.id === hostId) {
      hostId = null;
      io.emit("hostDesconectado");
    }
    io.emit("jugadorConectado", jugadores);
  });
});

http.listen(PORT, () => {
  console.log(`Servidor de Lotería funcionando en http://localhost:${PORT}`);
});