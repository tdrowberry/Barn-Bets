// Pigout: no shared pot, each player has their own running score and busts on their own
// turn only. See pig-mode-spec.md for the full rules this ports.
const { logEvent, clampInt, rollDice, isValidFace, undoLastGeneric, nextIndexPlain, advanceTurnWithFinalRoundCheck } = require('./shared');

function defaultConfig() {
  return {
    targetScore: 100,
    diceCount: 1,
    doubleOnesPenalty: 'reset-score',
    doublesBonus: false,
    hogModeEnabled: false,
    hogMaxDice: 6,
  };
}

function clampConfig(raw, current) {
  const base = current || defaultConfig();
  return {
    targetScore: clampInt(raw.targetScore, 50, 500, base.targetScore),
    diceCount: clampInt(raw.diceCount, 1, 2, base.diceCount),
    doubleOnesPenalty: raw.doubleOnesPenalty === 'flat-bonus' ? 'flat-bonus' : 'reset-score',
    doublesBonus: !!raw.doublesBonus,
    hogModeEnabled: !!raw.hogModeEnabled,
    hogMaxDice: clampInt(raw.hogMaxDice, 2, 6, base.hogMaxDice),
  };
}

function initPlayerModeState() {
  return { score: 0, turnTotal: 0, hasRolledThisTurn: false };
}

function onGameStart(room) {
  room.modeState = { finalRoundTriggeredBy: null };
  for (const p of room.players.values()) {
    p.modeState.turnTotal = 0;
    p.modeState.hasRolledThisTurn = false;
  }
}

function resetForNewSession(room) {
  room.modeState = { finalRoundTriggeredBy: null };
  for (const p of room.players.values()) {
    p.modeState.score = 0;
    p.modeState.turnTotal = 0;
    p.modeState.hasRolledThisTurn = false;
  }
}

function snapshotState(room, player) {
  return {
    playerId: player.id,
    playerModeState: { ...player.modeState },
    turnIndex: room.turnIndex,
    status: room.status,
    finalRoundTriggeredBy: room.modeState.finalRoundTriggeredBy,
  };
}

function restoreState(room, snap) {
  const player = room.players.get(snap.playerId);
  if (player) player.modeState = { ...snap.playerModeState };
  room.turnIndex = snap.turnIndex;
  room.status = snap.status;
  room.modeState.finalRoundTriggeredBy = snap.finalRoundTriggeredBy;
}

// Resolves who may act right now, honoring pass-and-play's "one shared device speaks for
// the current turn's player" pattern from Chicken Out.
function resolveActingPlayer(room, playerId) {
  const currentPlayerId = room.turnOrder[room.turnIndex];
  const isPassAndPlayHost = room.isPassAndPlay && playerId === room.hostId;
  if (!isPassAndPlayHost && playerId !== currentPlayerId) return null;
  return room.players.get(currentPlayerId);
}

function applyRolledFaces(room, player, faces) {
  const actingPlayerId = player.id;
  const preState = snapshotState(room, player);
  const ones = faces.filter((f) => f === 1).length;
  let busted = false;
  let scoreWiped = false;

  if (room.config.hogModeEnabled) {
    if (ones > 0) {
      busted = true;
      player.modeState.turnTotal = 0;
    } else {
      player.modeState.turnTotal += faces.reduce((a, b) => a + b, 0);
      player.modeState.hasRolledThisTurn = true;
    }
  } else if (faces.length === 1) {
    if (faces[0] === 1) {
      busted = true;
      player.modeState.turnTotal = 0;
    } else {
      player.modeState.turnTotal += faces[0];
      player.modeState.hasRolledThisTurn = true;
    }
  } else {
    // Fixed 2-dice mode: snake-eyes and doubles toggles only apply here, per spec.
    if (ones === 2) {
      if (room.config.doubleOnesPenalty === 'reset-score') {
        player.modeState.score = 0;
        player.modeState.turnTotal = 0;
        scoreWiped = true;
        busted = true;
      } else {
        player.modeState.turnTotal += 25;
        player.modeState.hasRolledThisTurn = true;
      }
    } else if (ones === 1) {
      busted = true;
      player.modeState.turnTotal = 0;
    } else {
      const sum = faces[0] + faces[1];
      const isDouble = faces[0] === faces[1];
      player.modeState.turnTotal += (isDouble && room.config.doublesBonus) ? sum * 2 : sum;
      player.modeState.hasRolledThisTurn = true;
    }
  }

  logEvent(room, 'pigRoll', actingPlayerId, { faces, busted, scoreWiped, turnTotalAfter: player.modeState.turnTotal, preState });

  if (busted) {
    logEvent(room, 'pigBust', actingPlayerId, { scoreWiped });
    room.turnIndex = nextIndexPlain(room, room.turnIndex);
  }

  return {};
}

function roll(room, playerId, payload) {
  if (room.status !== 'active') return { error: 'Game is not active.' };
  const player = resolveActingPlayer(room, playerId);
  if (!player) return { error: 'Not your turn.' };
  if (room.diceMode !== 'virtual') return { error: 'This room uses physical dice.' };

  let n;
  if (room.config.hogModeEnabled) {
    n = clampInt(payload && payload.diceCount, 1, room.config.hogMaxDice, 1);
  } else {
    n = room.config.diceCount;
  }
  const faces = rollDice(n);
  return applyRolledFaces(room, player, faces);
}

function reportRoll(room, playerId, payload) {
  if (room.status !== 'active') return { error: 'Game is not active.' };
  const player = resolveActingPlayer(room, playerId);
  if (!player) return { error: 'Not your turn.' };
  if (room.diceMode !== 'physical') return { error: 'This room uses virtual dice.' };

  const faces = (payload && payload.faces) || [];
  const expectedCount = room.config.hogModeEnabled
    ? clampInt(payload && payload.diceCount, 1, room.config.hogMaxDice, faces.length || 1)
    : room.config.diceCount;
  if (faces.length !== expectedCount || !faces.every(isValidFace)) {
    return { error: 'Invalid dice report.' };
  }
  return applyRolledFaces(room, player, faces);
}

function bank(room, playerId) {
  if (room.status !== 'active') return { error: 'Game is not active.' };
  const player = resolveActingPlayer(room, playerId);
  if (!player) return { error: 'Not your turn.' };
  if (!player.modeState.hasRolledThisTurn) return { error: 'Roll at least once before banking.' };

  const preState = snapshotState(room, player);
  const bankedAmount = player.modeState.turnTotal;
  player.modeState.score += bankedAmount;
  player.modeState.turnTotal = 0;
  player.modeState.hasRolledThisTurn = false;

  logEvent(room, 'pigBank', player.id, { amount: bankedAmount, scoreAfter: player.modeState.score, preState });

  if (!room.modeState.finalRoundTriggeredBy && player.modeState.score >= room.config.targetScore) {
    room.modeState.finalRoundTriggeredBy = player.id;
    logEvent(room, 'finalRoundTriggered', player.id, {});
  }

  advanceTurnWithFinalRoundCheck(room);
  return {};
}

function undoLast(room, hostId) {
  return undoLastGeneric(
    room,
    hostId,
    new Set(['pigRoll', 'pigBank']),
    new Set(['pigBust', 'finalRoundTriggered']),
    restoreState
  );
}

module.exports = {
  key: 'pigout',
  defaultConfig,
  clampConfig,
  initPlayerModeState,
  onGameStart,
  resetForNewSession,
  nextIndexFrom: nextIndexPlain,
  actions: {
    roll,
    reportRoll,
    bank,
  },
  undoLast,
};
