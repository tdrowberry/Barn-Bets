const crypto = require('crypto');

// In-memory room store. No database - state lives here for the life of the process.
const rooms = new Map();

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I, easier to read aloud
const NAME_MAX_LEN = 24;

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

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

function logEvent(room, type, playerId, payload = {}) {
  const event = {
    id: crypto.randomUUID(),
    type,
    playerId,
    payload,
    serverTimestamp: Date.now(),
  };
  room.events.push(event);
  return event;
}

function createPlayer(name, isHost) {
  return {
    id: crypto.randomUUID(),
    name,
    isHost,
    totalScore: 0,
    activeThisRound: true,
    connected: true,
    socketId: null,
    joinedAt: Date.now(),
  };
}

function getRoom(code) {
  if (!code || typeof code !== 'string') return null;
  return rooms.get(code.toUpperCase()) || null;
}

function createRoom({ hostName, rounds, startingRolls, diceMode, confirmRolls }) {
  const name = cleanName(hostName);
  if (!name) return { error: 'Enter your name.' };

  const roundsTotal = clampInt(rounds, 5, 35, 10);
  const startingRollsClamped = clampInt(startingRolls, 1, 5, 3);
  const mode = diceMode === 'virtual' ? 'virtual' : 'physical';

  const host = createPlayer(name, true);
  const code = generateRoomCode();

  const room = {
    code,
    hostId: host.id,
    roundsTotal,
    startingRolls: startingRollsClamped,
    diceMode: mode,
    confirmRolls: !!confirmRolls, // physical mode only; default is auto-submit on tap
    status: 'lobby', // lobby | active | finished
    currentRound: 0,
    rollCountThisRound: 0,
    pot: 0,
    turnOrder: [host.id],
    turnIndex: 0,
    players: new Map([[host.id, host]]),
    events: [],
    createdAt: Date.now(),
  };

  rooms.set(code, room);
  logEvent(room, 'join', host.id, { name: host.name, host: true });
  return { room, player: host };
}

function joinRoom({ roomCode, name }) {
  const room = getRoom(roomCode);
  if (!room) return { error: 'Room not found. Check the code and try again.' };
  if (room.status === 'finished') return { error: 'This game has already ended.' };

  const cleaned = cleanName(name);
  if (!cleaned) return { error: 'Enter your name.' };

  const player = createPlayer(cleaned, false);
  // Joining mid-session (the host re-shares the link/QR for a latecomer): they're seated
  // at zero points but sit out the round in progress, same as chickening out would leave
  // them - the next round's blanket reactivation brings them in automatically.
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

  room.status = 'active';
  room.currentRound = 1;
  room.rollCountThisRound = 0;
  room.pot = 0;
  room.turnIndex = 0;
  for (const p of room.players.values()) p.activeThisRound = true;

  logEvent(room, 'hostOverride', playerId, { action: 'startGame' });
  return { room };
}

const DOUBLE_ELIGIBLE_SUMS = new Set([2, 4, 6, 8, 10, 12]);

function isValidSum(sum) {
  return Number.isInteger(sum) && sum >= 2 && sum <= 12;
}

function rollDie() {
  return 1 + Math.floor(Math.random() * 6);
}

// Turn passes to the next ACTIVE player, wrapping around turnOrder.
function nextActiveIndex(room, fromIndex) {
  const n = room.turnOrder.length;
  for (let step = 1; step <= n; step++) {
    const idx = (fromIndex + step) % n;
    const player = room.players.get(room.turnOrder[idx]);
    if (player && player.activeThisRound) return idx;
  }
  return fromIndex;
}

// Captures everything a roll can change, so a host undo can restore it exactly.
function snapshotRoundState(room) {
  const activeThisRound = {};
  for (const [id, p] of room.players) activeThisRound[id] = p.activeThisRound;
  return {
    pot: room.pot,
    rollCountThisRound: room.rollCountThisRound,
    currentRound: room.currentRound,
    turnIndex: room.turnIndex,
    status: room.status,
    activeThisRound,
  };
}

function restoreRoundState(room, snap) {
  room.pot = snap.pot;
  room.rollCountThisRound = snap.rollCountThisRound;
  room.currentRound = snap.currentRound;
  room.turnIndex = snap.turnIndex;
  room.status = snap.status;
  for (const [id, active] of Object.entries(snap.activeThisRound)) {
    const p = room.players.get(id);
    if (p) p.activeThisRound = active;
  }
}

// Resets round state and either advances to the next round or ends the session.
function startNewRound(room, afterIndex) {
  room.currentRound += 1;
  if (room.currentRound > room.roundsTotal) {
    room.status = 'finished';
    return;
  }
  room.pot = 0;
  room.rollCountThisRound = 0;
  for (const p of room.players.values()) p.activeThisRound = true;
  room.turnIndex = (afterIndex + 1) % room.turnOrder.length;
}

function submitRoll(room, playerId, payload) {
  if (room.status !== 'active') return { error: 'Game is not active.' };

  const currentPlayerId = room.turnOrder[room.turnIndex];
  if (playerId !== currentPlayerId) return { error: 'Not your turn.' };

  const player = room.players.get(playerId);
  if (!player || !player.activeThisRound) return { error: 'You are not active this round.' };

  const preState = snapshotRoundState(room);
  const inStartingPhase = (room.rollCountThisRound + 1) <= room.startingRolls;

  let sum = null;
  let isDouble;
  let dice = null;

  if (room.diceMode === 'virtual') {
    const d1 = rollDie();
    const d2 = rollDie();
    dice = [d1, d2];
    sum = d1 + d2;
    isDouble = d1 === d2;
  } else {
    isDouble = !!(payload && payload.isDouble);
    const claimedSum = payload && payload.sum;
    const hasSum = isValidSum(claimedSum);

    if (isDouble && !inStartingPhase) {
      // Live-phase double: the pot just doubles no matter which double it was, so the ×2
      // button is a complete submission on its own - a sum is optional, not required.
      if (hasSum) {
        sum = claimedSum;
        if (!DOUBLE_ELIGIBLE_SUMS.has(sum)) return { error: 'That sum cannot be a double.' };
      }
    } else {
      // Every other case needs a real sum: plain rolls always, and a starting-phase double
      // too, since it just adds its sum like any other roll there.
      if (!hasSum) return { error: 'Invalid roll.' };
      sum = claimedSum;
      if (isDouble && !DOUBLE_ELIGIBLE_SUMS.has(sum)) return { error: 'That sum cannot be a double.' };
    }
  }

  room.rollCountThisRound += 1;
  let busted = false;
  let potDoubled = false;
  const potBeforeThisRoll = room.pot;

  if (inStartingPhase) {
    room.pot += (sum === 7) ? 70 : sum;
  } else if (sum === 7) {
    busted = true;
    room.pot = 0;
  } else if (isDouble) {
    room.pot *= 2;
    potDoubled = true;
  } else {
    room.pot += sum;
  }

  logEvent(room, 'roll', playerId, {
    sum,
    isDouble,
    dice,
    diceMode: room.diceMode,
    inStartingPhase,
    busted,
    potDoubled,
    potAfter: room.pot,
    preState, // internal only - stripped before this reaches any client
  });

  const busterIndex = room.turnIndex;

  if (busted) {
    logEvent(room, 'bust', playerId, { round: room.currentRound, potLost: potBeforeThisRoll });
    startNewRound(room, busterIndex);
  } else {
    room.turnIndex = nextActiveIndex(room, room.turnIndex);
  }

  return { room };
}

// Reverts the most recent roll (and the bust it may have caused) using the snapshot taken
// right before it ran. Only works when that roll is still the very last thing that
// happened - if anything else occurred since (another roll, a chicken-out), reverting could
// silently orphan a score that was already paid out against the now-stale state, so it's
// refused instead of guessed at.
function undoLastRoll(room, hostId) {
  if (hostId !== room.hostId) return { error: 'Only the host can undo a roll.' };

  const lastIndex = room.events.length - 1;
  const last = room.events[lastIndex];
  let rollEvent = null;
  let removeCount = 0;

  if (last && last.type === 'bust') {
    rollEvent = room.events[lastIndex - 1];
    removeCount = 2;
  } else if (last && last.type === 'roll') {
    rollEvent = last;
    removeCount = 1;
  }

  if (!rollEvent || rollEvent.type !== 'roll' || !rollEvent.payload.preState) {
    return { error: "Can't undo - the last thing that happened wasn't a roll." };
  }

  restoreRoundState(room, rollEvent.payload.preState);
  room.events.splice(lastIndex - removeCount + 1, removeCount);

  logEvent(room, 'hostOverride', hostId, {
    action: 'undoRoll',
    targetPlayerId: rollEvent.playerId,
    sum: rollEvent.payload.sum,
    isDouble: rollEvent.payload.isDouble,
  });

  return { room };
}

// The race: every action is timestamped and processed strictly in arrival order (the
// server's event loop is single-threaded and this handler never awaits mid-mutation), so
// whichever message gets here first wins. A chicken-out request carries the round it was
// issued against; if a bust already advanced the room to a new round by the time this is
// processed, the request is stale and gets rejected instead of silently paying out against
// the new round's fresh (empty) pot.
// Looks back for the pot value a round ended with, so a chicken-out rejected purely on
// timing (the round it targeted just ended) can still be reversed for its true value later,
// even though the live pot has already reset to 0 for the round that followed it.
function findPotFromRecentRoundEnd(room) {
  for (let i = room.events.length - 1; i >= 0; i--) {
    const e = room.events[i];
    if (e.type === 'bust') return e.payload.potLost;
    if (e.type === 'roundEnd') return e.payload.potAtEnd;
  }
  return 0;
}

function chickenOut(room, playerId, payload) {
  if (room.status !== 'active') return { error: 'Game is not active.' };

  const player = room.players.get(playerId);
  if (!player) return { error: 'Player not found.' };
  if (!player.activeThisRound) return { error: 'You have already chickened out this round.' };

  const claimedRound = payload && payload.round;
  if (claimedRound !== room.currentRound) {
    logEvent(room, 'chickenOutRejected', playerId, {
      claimedRound,
      actualRound: room.currentRound,
      potAtRejection: findPotFromRecentRoundEnd(room),
    });
    return { error: 'Too late — the round already ended.' };
  }

  const potWon = room.pot;
  player.activeThisRound = false;
  player.totalScore += potWon;

  logEvent(room, 'chickenOut', playerId, { potWon, scoreAfter: player.totalScore, round: room.currentRound });

  const wasCurrentTurn = room.turnOrder[room.turnIndex] === playerId;
  const anyoneStillActive = room.turnOrder.some((id) => {
    const p = room.players.get(id);
    return p && p.activeThisRound;
  });

  if (!anyoneStillActive) {
    logEvent(room, 'roundEnd', playerId, { reason: 'allChickenedOut', round: room.currentRound, potAtEnd: room.pot });
    startNewRound(room, room.turnOrder.length - 1);
  } else if (wasCurrentTurn) {
    room.turnIndex = nextActiveIndex(room, room.turnIndex);
  }

  return { room };
}

// Flips a past chicken-out ruling: an accepted one gets its score clawed back (and the
// player reactivated, if that round is still the current one); a rejected one gets paid out
// for what the pot was worth when it should have landed. Each ruling can only be reversed
// once.
function reverseChickenOut(room, hostId, eventId) {
  if (hostId !== room.hostId) return { error: 'Only the host can do that.' };

  const event = room.events.find((e) => e.id === eventId);
  if (!event) return { error: 'Event not found.' };
  if (event.type !== 'chickenOut' && event.type !== 'chickenOutRejected') {
    return { error: 'That event is not a chicken-out ruling.' };
  }
  if (event.reversed) return { error: 'That ruling has already been reversed.' };

  const player = room.players.get(event.playerId);
  if (!player) return { error: 'Player not found.' };

  let amount = 0;
  let direction;

  if (event.type === 'chickenOut') {
    amount = event.payload.potWon;
    player.totalScore -= amount;
    direction = 'toRejected';
    if (room.status === 'active' && event.payload.round === room.currentRound) {
      player.activeThisRound = true;
    }
  } else {
    amount = typeof event.payload.potAtRejection === 'number' ? event.payload.potAtRejection : 0;
    player.totalScore += amount;
    direction = 'toAccepted';
  }

  event.reversed = true;
  logEvent(room, 'hostOverride', hostId, {
    action: 'reverseChickenOut',
    direction,
    targetPlayerId: event.playerId,
    amount,
  });

  return { room };
}

function kickPlayer(room, hostId, targetPlayerId) {
  if (hostId !== room.hostId) return { error: 'Only the host can remove a player.' };
  if (targetPlayerId === room.hostId) return { error: "The host can't remove themselves." };

  const player = room.players.get(targetPlayerId);
  if (!player) return { error: 'Player not found.' };

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
      // unless they're inactive, in which case keep searching forward from there.
      const candidateIndex = room.turnIndex % n;
      const candidate = room.players.get(room.turnOrder[candidateIndex]);
      room.turnIndex = candidate && candidate.activeThisRound
        ? candidateIndex
        : nextActiveIndex(room, (candidateIndex - 1 + n) % n);
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

  room.status = 'lobby';
  room.currentRound = 0;
  room.rollCountThisRound = 0;
  room.pot = 0;
  room.turnIndex = 0;
  for (const p of room.players.values()) {
    p.totalScore = 0;
    p.activeThisRound = true;
  }
  room.events = [];

  return { room };
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
    roundsTotal: room.roundsTotal,
    startingRolls: room.startingRolls,
    diceMode: room.diceMode,
    confirmRolls: room.confirmRolls,
    status: room.status,
    currentRound: room.currentRound,
    rollCountThisRound: room.rollCountThisRound,
    pot: room.pot,
    turnOrder: room.turnOrder,
    turnIndex: room.turnIndex,
    players: room.turnOrder
      .map((id) => room.players.get(id))
      .filter(Boolean)
      .map((p) => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        totalScore: p.totalScore,
        activeThisRound: p.activeThisRound,
        connected: p.connected,
      })),
    events: room.events.slice(-50).map((e) => {
      if (e.type !== 'roll' || !e.payload.preState) return e;
      const { preState, ...rest } = e.payload;
      return { ...e, payload: rest };
    }),
  };
}

module.exports = {
  getRoom,
  createRoom,
  joinRoom,
  rejoinRoom,
  reorderTurnOrder,
  startGame,
  submitRoll,
  chickenOut,
  undoLastRoll,
  reverseChickenOut,
  kickPlayer,
  startNewSession,
  handleDisconnect,
  getRoomSnapshot,
};
