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
 function shuffleArray(array) {
   for (let i = array.length - 1; i > 0; i--) {
     const j = Math.floor(Math.random() * (i + 1));
     [array[i], array[j]] = [array[j], array[i]];
   }
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
       monedas: 30, // Monedas iniciales por jugador 
       apostado: false // Marca si ya apostó en la ronda 
     }; 

     socket.emit('rol-asignado', { host: esHost }); 
     socket.emit('cartas-desactivadas', Array.from(salas[sala].cartasSeleccionadas)); 
     socket.emit('historial-actualizado', salas[sala].historial); 
     io.to(sala).emit('jugadores-actualizados', salas[sala].jugadores); 
     io.to(sala).emit('bote-actualizado', salas[sala].bote);
   }); 

   socket.on('seleccionar-carta', ({ sala, carta }) => { 
     if (!salas[sala]) return; 
     salas[sala].cartasSeleccionadas.add(carta); 
     io.to(sala).emit('cartas-desactivadas', Array.from(salas[sala].cartasSeleccionadas)); 
   }); 

   socket.on('barajear', (sala) => { 
     const salaObj = salas[sala];
     if (!salaObj) return; 
     salaObj.historial = []; 
     salaObj.barajitas = generarBarajitas(); 
     salaObj.juegoPausado = false; 
     io.to(sala).emit('barajear');
     io.to(sala).emit('historial-actualizado', salaObj.historial);
     
     // Reiniciar estado de apuestas
     salaObj.bote = 0;
     for (const id in salaObj.jugadores) {
       salaObj.jugadores[id].apostado = false;
     }
     io.to(sala).emit('jugadores-actualizados', salaObj.jugadores);
     io.to(sala).emit('bote-actualizado', 0);
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
     salas[sala].juegoPausado = true;
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

   socket.on('apostar', ({ sala, cantidad }) => { 
     const data = salas[sala]; 
     if (!data) return; 

     const jugador = data.jugadores[socket.id]; 
     if (!jugador) return socket.emit('error-apuesta', 'No estás en una sala.');
     if (jugador.apostado) return socket.emit('error-apuesta', 'Ya apostaste en esta ronda.');

     if (jugador.monedas >= cantidad) { 
       jugador.monedas -= cantidad; 
       data.bote += cantidad; 
       jugador.apostado = true; 
       
       io.to(sala).emit('jugadores-actualizados', data.jugadores); 
       io.to(sala).emit('bote-actualizado', data.bote);   
     } else {
       socket.emit('error-apuesta', 'No tienes suficientes monedas.');
     }
   }); 

   socket.on('confirmar-ganador', ({ sala, ganadorId }) => { 
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
     io.to(sala).emit('bote-actualizado', 0); 
   }); 

   socket.on('reiniciar-partida', (sala) => { 
     const salaObj = salas[sala];
     if (!salaObj) return; 
     salaObj.historial = []; 
     salaObj.cartasSeleccionadas.clear(); 
     salaObj.barajitas = []; 
     salaObj.barajeoEnCurso = false; 
     salaObj.juegoPausado = false; 

     // Reiniciar apuestas 
     salaObj.bote = 0; 
     for (const id in salaObj.jugadores) { 
       salaObj.jugadores[id].apostado = false; 
     } 

     io.to(sala).emit('partida-reiniciada'); 
     io.to(sala).emit('jugadores-actualizados', salaObj.jugadores);
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
