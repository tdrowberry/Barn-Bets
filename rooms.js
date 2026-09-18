const crypto = require('crypto');
const { logEvent } = require('./modes/shared');
const { getMode } = require('./modes');

// In-memory room store. No database - state lives here for the life of the process.
const rooms = new Map();

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I, easier to read aloud
const NAME_MAX_LEN = 24;

function cleanName(name) {
  if (typeof name !== 'string') return '';
  return name.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX_LEN);
}

function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function createPlayer(name, isHost, mode) {
  return {
    id: crypto.randomUUID(),
    name,
    isHost,
    activeThisRound: true,
    connected: true,
    socketId: null,
    joinedAt: Date.now(),
    modeState: mode.initPlayerModeState(),
  };
}

function getRoom(code) {
  if (!code || typeof code !== 'string') return null;
  return rooms.get(code.toUpperCase()) || null;
}

function createRoom({ hostName, gameMode, diceMode, confirmRolls, passAndPlay, ...rawConfig }) {
  const name = cleanName(hostName);
  if (!name) return { error: 'Enter your name.' };

  const mode = getMode(gameMode);
  if (!mode) return { error: 'Unknown game.' };

  const host = createPlayer(name, true, mode);
  const code = generateRoomCode();

  const room = {
    code,
    hostId: host.id,
    gameMode: mode.key,
    diceMode: diceMode === 'virtual' ? 'virtual' : 'physical',
    confirmRolls: !!confirmRolls, // physical mode only; default is auto-submit on tap
    isPassAndPlay: !!passAndPlay, // one shared device speaks for every player
    config: mode.clampConfig(rawConfig, mode.defaultConfig()),
    status: 'lobby', // lobby | active | finished
    turnOrder: [host.id],
    turnIndex: 0,
    players: new Map([[host.id, host]]),
    events: [],
    endedEarly: false,
    modeState: {},
    createdAt: Date.now(),
  };

  rooms.set(code, room);
  logEvent(room, 'join', host.id, { name: host.name, host: true });
  return { room, player: host };
}

// Pass-and-play only: the host adds a local player directly from the one shared device,
// instead of that player joining over the network with their own socket. Otherwise identical
// to joinRoom (same late-join-sits-out-this-round behavior).
function addLocalPlayer(room, hostId, name) {
  if (hostId !== room.hostId) return { error: 'Only the host can add players.' };
  if (!room.isPassAndPlay) return { error: 'This room is not set up for one phone play.' };
  if (room.status === 'finished') return { error: 'This game has already ended.' };

  const cleaned = cleanName(name);
  if (!cleaned) return { error: 'Enter a name.' };

  const mode = getMode(room.gameMode);
  const player = createPlayer(cleaned, false, mode);
  const late = room.status === 'active';
  if (late) player.activeThisRound = false;

  room.players.set(player.id, player);
  room.turnOrder.push(player.id);
  logEvent(room, 'join', player.id, { name: player.name, late });
  return { room, player };
}

function joinRoom({ roomCode, name }) {
  const room = getRoom(roomCode);
  if (!room) return { error: 'Room not found. Check the code and try again.' };
  if (room.status === 'finished') return { error: 'This game has already ended.' };

  const cleaned = cleanName(name);
  if (!cleaned) return { error: 'Enter your name.' };

  const mode = getMode(room.gameMode);
  const player = createPlayer(cleaned, false, mode);
  // Joining mid-session (the host re-shares the link/QR for a latecomer): they're seated
  // at zero points but sit out the round in progress, active from the next one.
  const late = room.status === 'active';
  if (late) player.activeThisRound = false;

  room.players.set(player.id, player);
  room.turnOrder.push(player.id);
  logEvent(room, 'join', player.id, { name: player.name, late });
  return { room, player };
}

function rejoinRoom({ roomCode, playerId }) {
  const room = getRoom(roomCode);
  if (!room) return { error: 'Room not found.' };
  const player = room.players.get(playerId);
  if (!player) return { error: 'Player not found in this room.' };
  player.connected = true;
  return { room, player };
}

function reorderTurnOrder(room, playerId, newOrder) {
  if (playerId !== room.hostId) return { error: 'Only the host can reorder turn order.' };
  if (room.status !== 'lobby') return { error: 'Turn order can only be changed in the lobby.' };
  if (!Array.isArray(newOrder)) return { error: 'Invalid turn order.' };

  const currentIds = new Set(room.turnOrder);
  const newIds = new Set(newOrder);
  const sameSize = currentIds.size === newIds.size && currentIds.size === newOrder.length;
  const sameMembers = sameSize && [...currentIds].every((id) => newIds.has(id));
  if (!sameMembers) return { error: 'Invalid turn order.' };

  room.turnOrder = newOrder;
  return { room };
}

function startGame(room, playerId) {
  if (playerId !== room.hostId) return { error: 'Only the host can start the game.' };
  if (room.status !== 'lobby') return { error: 'Game already started.' };
  if (room.turnOrder.length < 1) return { error: 'Need at least one player.' };

  const mode = getMode(room.gameMode);
  room.status = 'active';
  room.turnIndex = 0;
  room.endedEarly = false;
  mode.onGameStart(room);

  logEvent(room, 'hostOverride', playerId, { action: 'startGame' });
  return { room };
}

// Every mode-specific player action (roll, bank, lock, chicken out, ...) routes through here,
// so server.js's socket handlers stay a thin, uniform "look up room, dispatch, broadcast"
// shape regardless of which game is running.
function performAction(room, playerId, actionName, payload) {
  const mode = getMode(room.gameMode);
  const action = mode.actions[actionName];
  if (!action) return { error: 'Unknown action.' };
  return action(room, playerId, payload || {});
}

function undoLastAction(room, hostId) {
  const mode = getMode(room.gameMode);
  return mode.undoLast(room, hostId);
}

function kickPlayer(room, hostId, targetPlayerId) {
  if (hostId !== room.hostId) return { error: 'Only the host can remove a player.' };
  if (targetPlayerId === room.hostId) return { error: "The host can't remove themselves." };

  const player = room.players.get(targetPlayerId);
  if (!player) return { error: 'Player not found.' };

  const mode = getMode(room.gameMode);
  const currentPlayerId = room.turnOrder[room.turnIndex];
  const wasCurrentTurn = room.status === 'active' && currentPlayerId === targetPlayerId;

  room.players.delete(targetPlayerId);
  room.turnOrder = room.turnOrder.filter((id) => id !== targetPlayerId);

  logEvent(room, 'remove', hostId, { name: player.name });

  if (room.status === 'active' && room.turnOrder.length > 0) {
    if (wasCurrentTurn) {
      const n = room.turnOrder.length;
      // Removing an element shifts everything after it back one slot, so the old numeric
      // index now naturally lands on whoever was next in line - reuse it as the new turn
      // unless the mode considers them ineligible, in which case keep searching forward.
      const candidateIndex = room.turnIndex % n;
      const candidate = room.players.get(room.turnOrder[candidateIndex]);
      room.turnIndex = (candidate && candidate.activeThisRound)
        ? candidateIndex
        : mode.nextIndexFrom(room, (candidateIndex - 1 + n) % n);
    } else {
      room.turnIndex = room.turnOrder.indexOf(currentPlayerId);
    }
  } else {
    room.turnIndex = 0;
  }

  return { room };
}

// Same room code, players, turn order, and settings; scores and history wiped, back to the
// lobby so the host can re-shuffle turn order or double check settings before starting.
function startNewSession(room, hostId) {
  if (hostId !== room.hostId) return { error: 'Only the host can start a new session.' };
  if (room.status !== 'finished') return { error: 'The current game has not finished yet.' };

  const mode = getMode(room.gameMode);
  room.status = 'lobby';
  room.turnIndex = 0;
  room.events = [];
  mode.resetForNewSession(room);

  return { room };
}

// Lets the host tweak this mode's config knobs (plus shared dice-input settings) for players
// who are sticking around for another game, without recreating the room from scratch.
function updateSettings(room, hostId, { diceMode, confirmRolls, ...rawConfig }) {
  if (hostId !== room.hostId) return { error: 'Only the host can change settings.' };
  if (room.status !== 'lobby') return { error: 'Settings can only be changed in the lobby.' };

  const mode = getMode(room.gameMode);
  room.diceMode = diceMode === 'virtual' ? 'virtual' : 'physical';
  room.confirmRolls = !!confirmRolls;
  room.config = mode.clampConfig(rawConfig, room.config);

  return { room };
}

// Ends the session right now, whatever round it's on, and shows the leaderboard as it
// stands - the same screen a game reaching its natural end lands on.
function endGame(room, hostId) {
  if (hostId !== room.hostId) return { error: 'Only the host can end the game.' };
  if (room.status !== 'active') return { error: 'Game is not active.' };

  room.status = 'finished';
  room.endedEarly = true;

  return { room };
}

function deleteRoom(code) {
  if (!code || typeof code !== 'string') return;
  rooms.delete(code.toUpperCase());
}

function handleDisconnect(socketId) {
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      if (p.socketId === socketId) {
        p.connected = false;
        p.socketId = null;
        return room;
      }
    }
  }
  return null;
}

function getRoomSnapshot(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    gameMode: room.gameMode,
    diceMode: room.diceMode,
    confirmRolls: room.confirmRolls,
    isPassAndPlay: room.isPassAndPlay,
    config: room.config,
    status: room.status,
    endedEarly: room.endedEarly,
    turnOrder: room.turnOrder,
    turnIndex: room.turnIndex,
    ...room.modeState,
    players: room.turnOrder
      .map((id) => room.players.get(id))
      .filter(Boolean)
      .map((p) => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        activeThisRound: p.activeThisRound,
        connected: p.connected,
        ...p.modeState,
      })),
    events: room.events.slice(-50).map((e) => {
      if (!e.payload || !e.payload.preState) return e;
      const { preState, ...rest } = e.payload;
      return { ...e, payload: rest };
    }),
  };
}

module.exports = {
  getRoom,
  createRoom,
  addLocalPlayer,
  joinRoom,
  rejoinRoom,
  reorderTurnOrder,
  startGame,
  performAction,
  undoLastAction,
  kickPlayer,
  startNewSession,
  updateSettings,
  endGame,
  deleteRoom,
  handleDisconnect,
  getRoomSnapshot,
};
