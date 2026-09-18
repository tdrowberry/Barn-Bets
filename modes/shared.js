// Helpers shared by every game mode module.
const crypto = require('crypto');

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

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function rollDie() {
  return 1 + Math.floor(Math.random() * 6);
}

function rollDice(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(rollDie());
  return out;
}

function isValidFace(v) {
  return Number.isInteger(v) && v >= 1 && v <= 6;
}

// { 1: count, 2: count, ..., 6: count }
function tally(values) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  return counts;
}

// Plain round-robin advance, used by modes with no "still active this round" concept
// (only Chicken Out skips players - see chickenOut.js's own nextActiveIndex).
function nextIndexPlain(room, fromIndex) {
  const n = room.turnOrder.length;
  return (fromIndex + 1) % n;
}

// Shared by Pigout and Quack Quack: once a player crosses the target score on a bank,
// everyone else gets exactly one more turn before the game ends. `room.modeState.
// finalRoundTriggeredBy` is set by the caller the moment that first happens; this just
// watches for turn order coming back around to that player and ends the game there
// instead of letting them go again.
function advanceTurnWithFinalRoundCheck(room) {
  const n = room.turnOrder.length;
  const nextIndex = nextIndexPlain(room, room.turnIndex);
  if (room.modeState.finalRoundTriggeredBy && room.turnOrder[nextIndex] === room.modeState.finalRoundTriggeredBy) {
    room.status = 'finished';
    return;
  }
  room.turnIndex = nextIndex;
}

// Generic "undo the last mutating action" for modes whose events carry a preState snapshot.
// `trailerTypes` are side-effect-only events that always immediately follow the action that
// caused them (e.g. a bust or hot-dice notice logged right after the roll) - they get peeled
// off first so undo lands on the actual mutating event underneath. `restoreState(room, snap)`
// applies that event's captured preState back onto the room/player.
function undoLastGeneric(room, hostId, mutatingTypes, trailerTypes, restoreState) {
  if (hostId !== room.hostId) return { error: 'Only the host can undo.' };

  let idx = room.events.length - 1;
  let removeCount = 0;
  while (idx >= 0 && trailerTypes.has(room.events[idx].type)) {
    idx -= 1;
    removeCount += 1;
  }

  const target = room.events[idx];
  if (!target || !mutatingTypes.has(target.type) || !target.payload.preState) {
    return { error: "Can't undo - the last thing that happened wasn't an undoable action." };
  }

  removeCount += 1;
  restoreState(room, target.payload.preState);
  room.events.splice(idx, removeCount);
  logEvent(room, 'hostOverride', hostId, { action: 'undoRoll', targetPlayerId: target.playerId });
  return {};
}

module.exports = {
  logEvent,
  clampInt,
  rollDie,
  rollDice,
  isValidFace,
  tally,
  nextIndexPlain,
  advanceTurnWithFinalRoundCheck,
  undoLastGeneric,
};
