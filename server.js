const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

let jugadores = {};
let hostId = null;
let cartasSeleccionadas = [];
let historial = [];

io.on("connection", (socket) => {
  console.log("Nuevo jugador conectado:", socket.id);

  socket.on("registrarJugador", (nickname) => {
    jugadores[socket.id] = { nickname, esHost: false };

    if (!hostId) {
      hostId = socket.id;
      jugadores[socket.id].esHost = true;
      socket.emit("esHost");
    }

    socket.emit("cartasOcupadas", cartasSeleccionadas);
    socket.emit("actualizarHistorial", historial);
  });

  socket.on("cartasSeleccionadas", (cartas) => {
    cartasSeleccionadas.push(...cartas);
    io.emit("cartasOcupadas", cartasSeleccionadas);
  });

  socket.on("cartaCantada", (carta) => {
    historial.push(carta);
    io.emit("actualizarHistorial", historial);
  });

  socket.on("reiniciarJuego", () => {
    historial = [];
    cartasSeleccionadas = [];
    io.emit("cartasOcupadas", cartasSeleccionadas);
    io.emit("actualizarHistorial", historial);
  });

  socket.on("disconnect", () => {
    console.log("Jugador desconectado:", socket.id);
    delete jugadores[socket.id];

    if (socket.id === hostId) {
      hostId = null;
      const siguientes = Object.keys(jugadores);
      if (siguientes.length > 0) {
        hostId = siguientes[0];
        jugadores[hostId].esHost = true;
        io.to(hostId).emit("esHost");
      }
    }
  });
});

app.get("/", (req, res) => {
  res.send("Servidor de lotería funcionando.");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Servidor escuchando en puerto", PORT);
});
