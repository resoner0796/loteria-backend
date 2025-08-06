const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors({ origin: "https://resoner0796.github.io" })); // <-- PERMITE conexiones desde GitHub Pages

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "https://resoner0796.github.io", // <-- PERMITE frontend externo
    methods: ["GET", "POST"]
  }
});

app.get("/", (req, res) => {
  res.send("Servidor de Lotería funcionando 🎉");
});

let cartasSeleccionadas = [];

io.on("connection", (socket) => {
  console.log("Jugador conectado");

  socket.on("registrarJugador", (nickname) => {
    socket.nickname = nickname;
    console.log(`Jugador registrado: ${nickname}`);
    socket.emit("registrado", nickname);
  });

  socket.on("seleccionarCarta", (carta) => {
    cartasSeleccionadas.push(carta);
    io.emit("actualizarCartasSeleccionadas", cartasSeleccionadas);
  });

  socket.on("limpiarCartas", () => {
    cartasSeleccionadas = [];
    io.emit("actualizarCartasSeleccionadas", cartasSeleccionadas);
  });

  socket.on("disconnect", () => {
    console.log("Jugador desconectado");
  });
});

server.listen(3000, () => {
  console.log("Servidor escuchando en el puerto 3000");
});
