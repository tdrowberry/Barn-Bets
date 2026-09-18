const path = require('path');
const os = require('os');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const rooms = require('./rooms');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', rooms.getRoomSnapshot(room));
}

// Every mode-specific player action (roll, bank, lock, select dice, ...) shares this exact
// reply/broadcast shape, so one wrapper handles all of them instead of repeating it per event.
function registerAction(io, socket, eventName, actionName) {
  socket.on(eventName, (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = rooms.getRoom(socket.data.roomCode);
    if (!room) return reply({ ok: false, error: 'Room not found.' });

    const result = rooms.performAction(room, socket.data.playerId, actionName, payload || {});
    if (result.error) return reply({ ok: false, error: result.error });

    reply({ ok: true, room: rooms.getRoomSnapshot(room) });
    broadcastRoom(room);
  });
}

io.on('connection', (socket) => {
  socket.on('host:createRoom', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const result = rooms.createRoom(payload || {});
    if (result.error) return reply({ ok: false, error: result.error });

    const { room, player } = result;
    player.socketId = socket.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;

    reply({ ok: true, roomCode: room.code, playerId: player.id, room: rooms.getRoomSnapshot(room) });
  });

  socket.on('player:joinRoom', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const result = rooms.joinRoom(payload || {});
    if (result.error) return reply({ ok: false, error: result.error });

    const { room, player } = result;
    player.socketId = socket.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;

    reply({ ok: true, roomCode: room.code, playerId: player.id, room: rooms.getRoomSnapshot(room) });
    broadcastRoom(room);
  });

  socket.on('player:rejoin', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const result = rooms.rejoinRoom(payload || {});
    if (result.error) return reply({ ok: false, error: result.error });

    const { room, player } = result;
    player.socketId = socket.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;

    reply({ ok: true, roomCode: room.code, playerId: player.id, room: rooms.getRoomSnapshot(room) });
    broadcastRoom(room);
  });

  socket.on('host:reorderTurnOrder', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = rooms.getRoom(socket.data.roomCode);
    if (!room) return reply({ ok: false, error: 'Room not found.' });

    const result = rooms.reorderTurnOrder(room, socket.data.playerId, (payload || {}).order);
    if (result.error) return reply({ ok: false, error: result.error });

    reply({ ok: true });
    broadcastRoom(room);
  });

  socket.on('host:addLocalPlayer', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = rooms.getRoom(socket.data.roomCode);
    if (!room) return reply({ ok: false, error: 'Room not found.' });

    const result = rooms.addLocalPlayer(room, socket.data.playerId, (payload || {}).name);
    if (result.error) return reply({ ok: false, error: result.error });

    reply({ ok: true, room: rooms.getRoomSnapshot(room) });
    broadcastRoom(room);
  });

  socket.on('host:startGame', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = rooms.getRoom(socket.data.roomCode);
    if (!room) return reply({ ok: false, error: 'Room not found.' });

    const result = rooms.startGame(room, socket.data.playerId);
    if (result.error) return reply({ ok: false, error: result.error });

    reply({ ok: true });
    broadcastRoom(room);
  });

  // Chicken Out
  registerAction(io, socket, 'player:submitRoll', 'submitRoll');
  registerAction(io, socket, 'player:chickenOut', 'chickenOut');
  registerAction(io, socket, 'host:reverseChickenOut', 'reverseChickenOut');

  // Pigout
  registerAction(io, socket, 'player:pigRoll', 'roll');
  registerAction(io, socket, 'player:pigReportRoll', 'reportRoll');
  registerAction(io, socket, 'player:pigBank', 'bank');

  // Quack Quack
  registerAction(io, socket, 'player:quackRoll', 'roll');
  registerAction(io, socket, 'player:quackReportRoll', 'reportRoll');
  registerAction(io, socket, 'player:quackSelectDice', 'selectDice');
  registerAction(io, socket, 'player:quackBank', 'bank');

  // Horse Race
  registerAction(io, socket, 'player:horseRoll', 'roll');
  registerAction(io, socket, 'player:horseReportRoll', 'reportRoll');
  registerAction(io, socket, 'player:horseLock', 'lock');

  socket.on('host:undoLastRoll', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = rooms.getRoom(socket.data.roomCode);
    if (!room) return reply({ ok: false, error: 'Room not found.' });

    const result = rooms.undoLastAction(room, socket.data.playerId);
    if (result.error) return reply({ ok: false, error: result.error });

    reply({ ok: true, room: rooms.getRoomSnapshot(room) });
    broadcastRoom(room);
  });

  socket.on('host:kickPlayer', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = rooms.getRoom(socket.data.roomCode);
    if (!room) return reply({ ok: false, error: 'Room not found.' });

    const result = rooms.kickPlayer(room, socket.data.playerId, (payload || {}).targetPlayerId);
    if (result.error) return reply({ ok: false, error: result.error });

    reply({ ok: true, room: rooms.getRoomSnapshot(room) });
    broadcastRoom(room);
  });

  socket.on('host:startNewSession', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = rooms.getRoom(socket.data.roomCode);
    if (!room) return reply({ ok: false, error: 'Room not found.' });

    const result = rooms.startNewSession(room, socket.data.playerId);
    if (result.error) return reply({ ok: false, error: result.error });

    reply({ ok: true, room: rooms.getRoomSnapshot(room) });
    broadcastRoom(room);
  });

  socket.on('host:updateSettings', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = rooms.getRoom(socket.data.roomCode);
    if (!room) return reply({ ok: false, error: 'Room not found.' });

    const result = rooms.updateSettings(room, socket.data.playerId, payload || {});
    if (result.error) return reply({ ok: false, error: result.error });

    reply({ ok: true, room: rooms.getRoomSnapshot(room) });
    broadcastRoom(room);
  });

  socket.on('host:endGame', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = rooms.getRoom(socket.data.roomCode);
    if (!room) return reply({ ok: false, error: 'Room not found.' });

    const result = rooms.endGame(room, socket.data.playerId);
    if (result.error) return reply({ ok: false, error: result.error });

    reply({ ok: true, room: rooms.getRoomSnapshot(room) });
    broadcastRoom(room);
  });

  socket.on('host:closeRoom', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = rooms.getRoom(socket.data.roomCode);
    if (!room) return reply({ ok: false, error: 'Room not found.' });
    if (socket.data.playerId !== room.hostId) return reply({ ok: false, error: 'Only the host can close the room.' });

    io.to(room.code).emit('room:closed');
    rooms.deleteRoom(room.code);
    reply({ ok: true });
  });

  socket.on('disconnect', () => {
    const room = rooms.handleDisconnect(socket.id);
    if (room) broadcastRoom(room);
  });
});

// Ranks non-internal IPv4 addresses by how likely they are to be the LAN
// address other phones on the same wifi can actually reach - useful during
// local testing before this is deployed, since "localhost" only works on
// this machine. Not used by the app itself.
function getLikelyLanUrls(port) {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        candidates.push({ name, address: addr.address });
      }
    }
  }

  function score({ name, address }) {
    const n = name.toLowerCase();
    let s = 0;
    if (/^192\.168\./.test(address)) s += 30;
    else if (/^10\./.test(address)) s += 20;
    else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) s += 5;
    if (/wi-?fi|wlan|wireless/.test(n)) s += 15;
    if (/ethernet/.test(n) && !/virtual/.test(n)) s += 10;
    if (/virtualbox|vmware|hyper-v|vethernet|docker|wsl|loopback|tailscale|zerotier|\btap\b|\btun\b|vpn/.test(n)) s -= 50;
    return s;
  }

  return candidates
    .map((c) => ({ ...c, score: score(c) }))
    .sort((a, b) => b.score - a.score)
    .map((c) => `http://${c.address}:${port}`);
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Barn Bets server running on port ${PORT}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  const lanUrls = getLikelyLanUrls(PORT);
  if (lanUrls.length) {
    console.log('  On your wifi (open this on phones to test before deploying):');
    lanUrls.forEach((u) => console.log(`    ${u}`));
  }
});
