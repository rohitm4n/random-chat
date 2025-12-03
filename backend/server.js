// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const PORT = process.env.PORT || 5000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
app.use(cors({
  origin: CORS_ORIGIN
}));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST']
  }
});

// In-memory state (anonymous)
let waitingQueue = []; // array of socket ids waiting
const activePairs = new Map(); // socketId -> partnerSocketId
const connectedAt = new Map(); // socketId -> timestamp

// Optional simple metrics
let totalMatches = 0;
let totalReports = 0;

function pairSockets(a, b) {
  activePairs.set(a, b);
  activePairs.set(b, a);
  connectedAt.set(a, Date.now());
  connectedAt.set(b, Date.now());
  totalMatches++;
}

function unpairSocket(socketId) {
  const partner = activePairs.get(socketId);
  if (partner) {
    activePairs.delete(partner);
    activePairs.delete(socketId);
    connectedAt.delete(partner);
    connectedAt.delete(socketId);
  }
  // Also remove from waiting queue if present
  waitingQueue = waitingQueue.filter(id => id !== socketId);
  waitingQueue = waitingQueue.filter(id => id !== partner);
  return partner;
}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);
  // track connection time
  connectedAt.set(socket.id, Date.now());

  // health/status events
  socket.on('ping', (cb) => cb && cb({ pong: true, id: socket.id }));

  // FIND: join matchmaking
  socket.on('find', ({ meta } = {}) => {
    // meta is optional object with things like preferences - ignored in pure anon mode
    // If already paired or waiting, ignore duplicates
    console.log(`[find] ${socket.id}`);
    if (activePairs.has(socket.id)) {
      socket.emit('status', { state: 'already_paired' });
      return;
    }
    if (waitingQueue.includes(socket.id)) {
      socket.emit('status', { state: 'waiting' });
      return;
    }

    // Try to pair with oldest waiting user who's still connected
    while (waitingQueue.length > 0) {
      const candidateId = waitingQueue.shift();
      const candidateSocket = io.sockets.sockets.get(candidateId);
      if (!candidateSocket || candidateSocket.disconnected) {
        // skip disconnected candidate
        continue;
      }
      // pair candidate with this socket
      pairSockets(socket.id, candidateId);
      socket.emit('matched', { partnerId: candidateId });
      candidateSocket.emit('matched', { partnerId: socket.id });
      console.log(`[match] ${socket.id} <-> ${candidateId}`);
      return;
    }

    // no waiting user -> put this socket in queue
    waitingQueue.push(socket.id);
    socket.emit('status', { state: 'waiting' });
    console.log(`[waiting] ${socket.id} (queue length=${waitingQueue.length})`);
  });

  // CANCEL waiting
  socket.on('cancel', () => {
    if (waitingQueue.includes(socket.id)) {
      waitingQueue = waitingQueue.filter(id => id !== socket.id);
      socket.emit('status', { state: 'idle' });
      console.log(`[cancel] ${socket.id}`);
    }
  });

  // LEAVE: leave current pairing (if any)
  socket.on('leave', () => {
    const partner = unpairSocket(socket.id);
    if (partner) {
      const partnerSocket = io.sockets.sockets.get(partner);
      if (partnerSocket) partnerSocket.emit('partner-left');
      socket.emit('status', { state: 'idle' });
      console.log(`[leave] ${socket.id} left ${partner}`);
    } else {
      // if was waiting, remove from waiting
      waitingQueue = waitingQueue.filter(id => id !== socket.id);
      socket.emit('status', { state: 'idle' });
      console.log(`[leave] ${socket.id} (was not paired)`);
    }
  });

  // SIGNAL: used for WebRTC offer/answer and ICE candidates
  // payload: { to, type, data }
  socket.on('signal', (payload) => {
    try {
      const { to, type, data } = payload || {};
      if (!to) return;
      const target = io.sockets.sockets.get(to);
      if (target && !target.disconnected) {
        target.emit('signal', { from: socket.id, type, data });
      }
    } catch (err) {
      console.error('signal error', err);
    }
  });

  // text-message: send text message to partner
  // payload: { to, text }
  socket.on('text-message', (payload) => {
    try {
      const { to, text } = payload || {};
      if (!to || typeof text !== 'string') return;
      const target = io.sockets.sockets.get(to);
      if (target && !target.disconnected) {
        target.emit('text-message', { from: socket.id, text, ts: Date.now() });
      }
    } catch (err) {
      console.error('text-message error', err);
    }
  });

  // REPORT: anonymous report about partner
  // payload: { to, reason }
  socket.on('report', ({ to, reason } = {}) => {
    totalReports++;
    console.log(`[report] from ${socket.id} against ${to} reason=${reason || 'n/a'}`);
    // notify partner (optional)
    const target = io.sockets.sockets.get(to);
    if (target && !target.disconnected) {
      target.emit('reported', { by: socket.id });
    }
    // In a real app we'd persist reports to DB and possibly ban; here we just log.
    socket.emit('report-ack', { ok: true });
  });

  // Provide a quick API to ask who is my partner
  socket.on('whois', (cb) => {
    const p = activePairs.get(socket.id) || null;
    cb && cb({ partnerId: p });
  });

  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] ${socket.id} reason=${reason}`);
    // If in waiting queue, remove
    waitingQueue = waitingQueue.filter(id => id !== socket.id);

    // If paired, inform partner and cleanup
    const partner = activePairs.get(socket.id);
    if (partner) {
      const partnerSocket = io.sockets.sockets.get(partner);
      if (partnerSocket) {
        partnerSocket.emit('partner-left');
      }
      unpairSocket(socket.id);
    }
    connectedAt.delete(socket.id);
  });
});

// Simple admin-ish routes (no auth, for development)
app.get('/', (req, res) => {
  res.send('Random chat signaling server (anonymous) is running');
});

app.get('/_status', (req, res) => {
  res.json({
    uptime: process.uptime(),
    clientsConnected: io.of('/').sockets.size,
    waitingCount: waitingQueue.length,
    activePairsCount: Math.floor(Array.from(activePairs.keys()).length / 2),
    totalMatches,
    totalReports
  });
});

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
