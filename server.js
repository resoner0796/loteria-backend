const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
  cors: {
    origin: "*"
  }
});

const PORT = process.env.PORT || 3000;

let baraja = [];
let historial = [];
let juegoIniciado = false;

app.get("/", (req, res) => {
  res.send("Servidor de Lotería funcionando.");
});

io.on("connection", socket => {
  console.log("Nuevo jugador conectado:", socket.id);

  // Enviar historial al nuevo jugador
  socket.emit("historial", historial);

  // Jugador dice que ganó
  socket.on("loteria", () => {
    io.emit("mensaje", `🎉 El jugador ${socket.id} cantó ¡Lotería!`);
    io.emit("detener");
  });

  socket.on("limpiar", () => {
    socket.emit("limpiarFichas");
  });

  socket.on("iniciar", () => {
    if (!juegoIniciado) {
      baraja = mezclarBaraja();
      historial = [];
      juegoIniciado = true;
      io.emit("juego-iniciado");
      repartirCartas();
    }
  });

  socket.on("barajear", () => {
    io.emit("barajeando");
  });

  socket.on("detener", () => {
    juegoIniciado = false;
    io.emit("detener");
  });

  socket.on("disconnect", () => {
    console.log("Jugador desconectado:", socket.id);
  });
});

function mezclarBaraja() {
  return Array.from({ length: 54 }, (_, i) => String(i + 1).padStart(2, "0")).sort(() => Math.random() - 0.5);
}

function repartirCartas() {
  let index = 0;
  const intervalo = setInterval(() => {
    if (!juegoIniciado || index >= baraja.length) {
      clearInterval(intervalo);
      return;
    }
    const carta = baraja[index++];
    historial.push(carta);
    io.emit("carta", carta);
  }, 4000);
}

http.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});