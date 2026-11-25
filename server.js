const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

// Track active live rooms & host sockets so stale rooms close instantly on disconnect
const activeSocketLives = new Map(); // liveId -> { hostSocketId, startedAt }

io.on('connection', (socket) => {
  socket.on('unirse_al_live', ({ liveId, userId, isHost } = {}) => {
    if (!liveId) return;
    socket.join(liveId);
    socket.data.liveId = liveId;
    socket.data.userId = userId;
    socket.data.isHost = Boolean(isHost);

    if (isHost) {
      activeSocketLives.set(liveId, {
        hostSocketId: socket.id,
        startedAt: Date.now()
      });
    }

    const espectadores = io.sockets.adapter.rooms.get(liveId)?.size || 1;
    io.to(liveId).emit('actualizar_espectadores', espectadores);
  });

  socket.on('salir_del_live', ({ liveId } = {}) => {
    if (!liveId) return;
    socket.leave(liveId);
    const espectadores = io.sockets.adapter.rooms.get(liveId)?.size || 0;
    io.to(liveId).emit('actualizar_espectadores', espectadores);
  });

  socket.on('finalizar_live', ({ liveId } = {}) => {
    if (!liveId) return;
    activeSocketLives.delete(liveId);
    io.to(liveId).emit('sala_finalizada', { liveId });
  });

  socket.on('nuevo_comentario', ({ liveId, usuario, texto } = {}) => {
    if (!liveId || !texto) return;
    io.to(liveId).emit('mostrar_comentario', {
      usuario: String(usuario || 'User').slice(0, 32),
      texto: String(texto).slice(0, 140)
    });
  });

  socket.on('enviar_regalo', (payload = {}) => {
    const { liveId } = payload;
    if (!liveId) return;
    io.to(liveId).emit('animacion_regalo', payload);
  });

  socket.on('disconnect', () => {
    const liveId = socket.data?.liveId;
    if (!liveId) return;
    const roomMeta = activeSocketLives.get(liveId);
    if (roomMeta && roomMeta.hostSocketId === socket.id) {
      activeSocketLives.delete(liveId);
      io.to(liveId).emit('sala_finalizada', { liveId });
    } else {
      const espectadores = io.sockets.adapter.rooms.get(liveId)?.size || 0;
      io.to(liveId).emit('actualizar_espectadores', espectadores);
    }
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, activeLives: activeSocketLives.size, ts: Date.now() });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('StarVibe server + Socket.IO running on port', PORT);
});
