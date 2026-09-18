// Chicken Out: shared-pot push-your-luck. Ported as-is from the original single-mode
// rooms.js - behavior is unchanged, only reshaped to fit the multi-mode module interface
// (room.config for host knobs, room.modeState for pot/round runtime, player.modeState.score
// in place of the old top-level totalScore).
const { logEvent, clampInt, rollDie } = require('./shared');

const DOUBLE_ELIGIBLE_SUMS = new Set([2, 4, 6, 8, 10, 12]);

function isValidSum(sum) {
  return Number.isInteger(sum) && sum >= 2 && sum <= 12;
}

function defaultConfig() {
  return { rounds: 10, startingRolls: 3 };
}

function clampConfig(raw, current) {
  const base = current || defaultConfig();
  return {
    rounds: clampInt(raw.rounds, 5, 35, base.rounds),
    startingRolls: clampInt(raw.startingRolls, 1, 5, base.startingRolls),
  };
}

function initPlayerModeState() {
  return { score: 0 };
}

function onGameStart(room) {
  room.modeState = { pot: 0, currentRound: 1, rollCountThisRound: 0 };
  for (const p of room.players.values()) p.activeThisRound = true;
}

function resetForNewSession(room) {
  room.modeState = { pot: 0, currentRound: 0, rollCountThisRound: 0 };
  for (const p of room.players.values()) {
    p.modeState.score = 0;
    p.activeThisRound = true;
  }
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
    pot: room.modeState.pot,
    rollCountThisRound: room.modeState.rollCountThisRound,
    currentRound: room.modeState.currentRound,
    turnIndex: room.turnIndex,
    status: room.status,
    activeThisRound,
  };
}

function restoreRoundState(room, snap) {
  room.modeState.pot = snap.pot;
  room.modeState.rollCountThisRound = snap.rollCountThisRound;
  room.modeState.currentRound = snap.currentRound;
  room.turnIndex = snap.turnIndex;
  room.status = snap.status;
  for (const [id, active] of Object.entries(snap.activeThisRound)) {
    const p = room.players.get(id);
    if (p) p.activeThisRound = active;
  }
}

// Resets round state and either advances to the next round or ends the session.
function startNewRound(room, afterIndex) {
  room.modeState.currentRound += 1;
  if (room.modeState.currentRound > room.config.rounds) {
    room.status = 'finished';
    return;
  }
  room.modeState.pot = 0;
  room.modeState.rollCountThisRound = 0;
  for (const p of room.players.values()) p.activeThisRound = true;
  room.turnIndex = (afterIndex + 1) % room.turnOrder.length;
}

function submitRoll(room, playerId, payload) {
  if (room.status !== 'active') return { error: 'Game is not active.' };

  const currentPlayerId = room.turnOrder[room.turnIndex];
  const isPassAndPlayHost = room.isPassAndPlay && playerId === room.hostId;
  const actingPlayerId = isPassAndPlayHost ? currentPlayerId : playerId;
  if (!isPassAndPlayHost && playerId !== currentPlayerId) return { error: 'Not your turn.' };

  const player = room.players.get(actingPlayerId);
  if (!player || !player.activeThisRound) return { error: 'You are not active this round.' };

  const preState = snapshotRoundState(room);
  const inStartingPhase = (room.modeState.rollCountThisRound + 1) <= room.config.startingRolls;

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
      if (hasSum) {
        sum = claimedSum;
        if (!DOUBLE_ELIGIBLE_SUMS.has(sum)) return { error: 'That sum cannot be a double.' };
      }
    } else {
      if (!hasSum) return { error: 'Invalid roll.' };
      sum = claimedSum;
      if (isDouble && !DOUBLE_ELIGIBLE_SUMS.has(sum)) return { error: 'That sum cannot be a double.' };
    }
  }

  room.modeState.rollCountThisRound += 1;
  let busted = false;
  let potDoubled = false;
  const potBeforeThisRoll = room.modeState.pot;

  if (inStartingPhase) {
    room.modeState.pot += (sum === 7) ? 70 : sum;
  } else if (sum === 7) {
    busted = true;
    room.modeState.pot = 0;
  } else if (isDouble) {
    room.modeState.pot *= 2;
    potDoubled = true;
  } else {
    room.modeState.pot += sum;
  }

  logEvent(room, 'roll', actingPlayerId, {
    sum,
    isDouble,
    dice,
    diceMode: room.diceMode,
    inStartingPhase,
    busted,
    potDoubled,
    potAfter: room.modeState.pot,
    preState, // internal only - stripped before this reaches any client
  });

  const busterIndex = room.turnIndex;

  if (busted) {
    logEvent(room, 'bust', actingPlayerId, { round: room.modeState.currentRound, potLost: potBeforeThisRoll });
    startNewRound(room, busterIndex);
  } else {
    room.turnIndex = nextActiveIndex(room, room.turnIndex);
  }

  return {};
}

function undoLast(room, hostId) {
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

  return {};
}

// Looks back for the pot value a round ended with, so a chicken-out rejected purely on
// timing can still be reversed for its true value later.
function findPotFromRecentRoundEnd(room) {
  for (let i = room.events.length - 1; i >= 0; i--) {
    const e = room.events[i];
    if (e.type === 'bust') return e.payload.potLost;
    if (e.type === 'roundEnd') return e.payload.potAtEnd;
  }
  return 0;
}

function chickenOutAction(room, playerId, payload) {
  if (room.status !== 'active') return { error: 'Game is not active.' };

  const isPassAndPlayHost = room.isPassAndPlay && playerId === room.hostId;
  const targetPlayerId = isPassAndPlayHost && payload && payload.targetPlayerId
    ? payload.targetPlayerId
    : playerId;

  const player = room.players.get(targetPlayerId);
  if (!player) return { error: 'Player not found.' };
  if (!player.activeThisRound) return { error: 'You have already chickened out this round.' };

  const claimedRound = payload && payload.round;
  if (claimedRound !== room.modeState.currentRound) {
    logEvent(room, 'chickenOutRejected', targetPlayerId, {
      claimedRound,
      actualRound: room.modeState.currentRound,
      potAtRejection: findPotFromRecentRoundEnd(room),
    });
    return { error: 'Too late — the round already ended.' };
  }

  const potWon = room.modeState.pot;
  player.activeThisRound = false;
  player.modeState.score += potWon;

  logEvent(room, 'chickenOut', targetPlayerId, { potWon, scoreAfter: player.modeState.score, round: room.modeState.currentRound });

  const wasCurrentTurn = room.turnOrder[room.turnIndex] === targetPlayerId;
  const anyoneStillActive = room.turnOrder.some((id) => {
    const p = room.players.get(id);
    return p && p.activeThisRound;
  });

  if (!anyoneStillActive) {
    logEvent(room, 'roundEnd', playerId, { reason: 'allChickenedOut', round: room.modeState.currentRound, potAtEnd: room.modeState.pot });
    startNewRound(room, room.turnOrder.length - 1);
  } else if (wasCurrentTurn) {
    room.turnIndex = nextActiveIndex(room, room.turnIndex);
  }

  return {};
}

function reverseChickenOut(room, hostId, payload) {
  if (hostId !== room.hostId) return { error: 'Only the host can do that.' };
  const eventId = payload && payload.eventId;

  const event = room.events.find((e) => e.id === eventId);
  if (!event) return { error: 'Event not found.' };
  if (event.type !== 'chickenOut' && event.type !== 'chickenOutRejected') {
    return { error: 'That event is not a chicken-out ruling.' };
  }

  const player = room.players.get(event.playerId);
  if (!player) return { error: 'Player not found.' };

  const nowReversed = !event.reversed;
  const sign = nowReversed ? 1 : -1;

  let amount = 0;
  let direction;

  if (event.type === 'chickenOut') {
    amount = event.payload.potWon;
    player.modeState.score -= sign * amount;
    direction = nowReversed ? 'toRejected' : 'toAccepted';
    if (room.status === 'active' && event.payload.round === room.modeState.currentRound) {
      player.activeThisRound = nowReversed;
    }
  } else {
    amount = typeof event.payload.potAtRejection === 'number' ? event.payload.potAtRejection : 0;
    player.modeState.score += sign * amount;
    direction = nowReversed ? 'toAccepted' : 'toRejected';
  }

  event.reversed = nowReversed;
  logEvent(room, 'hostOverride', hostId, {
    action: 'reverseChickenOut',
    direction,
    targetPlayerId: event.playerId,
    amount,
  });

  return {};
}

module.exports = {
  key: 'chickenout',
  defaultConfig,
  clampConfig,
  initPlayerModeState,
  onGameStart,
  resetForNewSession,
  nextIndexFrom: nextActiveIndex,
  actions: {
    submitRoll,
    chickenOut: chickenOutAction,
    reverseChickenOut,
  },
  undoLast,
};
