const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e6
});

app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html' || req.path === '/sw.js') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(__dirname));

const activeSocketLives = new Map(); // liveId -> { hostSocketId, startedAt }
const latestFrameByRoom = new Map();

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
      socket.to(liveId).emit('webrtc_host_ready', { liveId });
    } else if (latestFrameByRoom.has(liveId)) {
      socket.emit('live_video_frame', { liveId, frame: latestFrameByRoom.get(liveId) });
    }

    const espectadores = io.sockets.adapter.rooms.get(liveId)?.size || 1;
    io.to(liveId).emit('actualizar_espectadores', espectadores);
  });

  // WebRTC Peer Signaling (Opus continuous voice + 30fps video)
  socket.on('webrtc_host_ready', ({ liveId } = {}) => {
    if (!liveId) return;
    activeSocketLives.set(liveId, {
      hostSocketId: socket.id,
      startedAt: Date.now()
    });
    socket.to(liveId).emit('webrtc_host_ready', { liveId });
  });

  socket.on('webrtc_viewer_ready', ({ liveId } = {}) => {
    if (!liveId) return;
    const roomMeta = activeSocketLives.get(liveId);
    if (roomMeta && roomMeta.hostSocketId && roomMeta.hostSocketId !== socket.id) {
      io.to(roomMeta.hostSocketId).emit('webrtc_viewer_ready', {
        liveId,
        viewerSocketId: socket.id
      });
    }
  });

  socket.on('webrtc_offer', ({ liveId, targetSocketId, sdp } = {}) => {
    if (!liveId || !targetSocketId || !sdp) return;
    io.to(targetSocketId).emit('webrtc_offer', {
      liveId,
      hostSocketId: socket.id,
      sdp
    });
  });

  socket.on('webrtc_answer', ({ liveId, targetSocketId, sdp } = {}) => {
    if (!liveId || !targetSocketId || !sdp) return;
    io.to(targetSocketId).emit('webrtc_answer', {
      liveId,
      fromSocketId: socket.id,
      sdp
    });
  });

  socket.on('webrtc_ice', ({ liveId, targetSocketId, candidate } = {}) => {
    if (!liveId || !targetSocketId || !candidate) return;
    io.to(targetSocketId).emit('webrtc_ice', {
      liveId,
      fromSocketId: socket.id,
      candidate
    });
  });

  // Fallback visual frame relay
  socket.on('live_video_frame', ({ liveId, frame } = {}) => {
    if (!liveId || !frame) return;
    latestFrameByRoom.set(liveId, frame);
    socket.volatile.to(liveId).emit('live_video_frame', { liveId, frame });
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
    latestFrameByRoom.delete(liveId);
    io.to(liveId).emit('sala_finalizada', { liveId });
  });

  socket.on('nuevo_comentario', ({ liveId, usuario, texto } = {}) => {
    if (!liveId || !texto) return;
    io.to(liveId).emit('mostrar_comentario', {
      usuario: String(usuario || 'User').slice(0, 32),
      texto: String(texto).slice(0, 140)
    });
  });

  socket.on('enviar_like_live', ({ liveId, totalLikes } = {}) => {
    if (!liveId) return;
    socket.to(liveId).emit('mostrar_like_live', { liveId, totalLikes });
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
      latestFrameByRoom.delete(liveId);
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
  console.log('StarVibe WebRTC + Socket.IO Live Server running on port', PORT);
});
