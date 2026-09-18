// Quack Quack: six-dice Farkle-family scoring puzzle with hot dice. See
// dice-combo-mode-spec.md for the full rules. "Farkle" itself is never used player-facing
// or in these constants, per that spec's trademark note.
const { logEvent, clampInt, rollDice, isValidFace, tally, undoLastGeneric, nextIndexPlain, advanceTurnWithFinalRoundCheck } = require('./shared');

function defaultConfig() {
  return { targetScore: 10000, scoringScheme: 'flat', minOpeningScoreEnabled: false, minOpeningScoreValue: 500 };
}

function clampConfig(raw, current) {
  const base = current || defaultConfig();
  return {
    targetScore: clampInt(raw.targetScore, 3000, 15000, base.targetScore),
    scoringScheme: raw.scoringScheme === 'doubling' ? 'doubling' : 'flat',
    minOpeningScoreEnabled: !!raw.minOpeningScoreEnabled,
    minOpeningScoreValue: clampInt(raw.minOpeningScoreValue, 100, 5000, base.minOpeningScoreValue),
  };
}

function initPlayerModeState() {
  return {
    score: 0,
    turnTotal: 0,
    diceSetAside: [],
    diceInPlayCount: 6,
    currentRoll: null,
    wasFullSixDiceRoll: false,
    hasQualified: false,
  };
}

function resetTurnFields(player) {
  player.modeState.turnTotal = 0;
  player.modeState.diceSetAside = [];
  player.modeState.diceInPlayCount = 6;
  player.modeState.currentRoll = null;
  player.modeState.wasFullSixDiceRoll = false;
}

function onGameStart(room) {
  room.modeState = { finalRoundTriggeredBy: null };
  for (const p of room.players.values()) resetTurnFields(p);
}

function resetForNewSession(room) {
  room.modeState = { finalRoundTriggeredBy: null };
  for (const p of room.players.values()) {
    p.modeState.score = 0;
    p.modeState.hasQualified = false;
    resetTurnFields(p);
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

function resolveActingPlayer(room, playerId) {
  const currentPlayerId = room.turnOrder[room.turnIndex];
  const isPassAndPlayHost = room.isPassAndPlay && playerId === room.hostId;
  if (!isPassAndPlayHost && playerId !== currentPlayerId) return null;
  return room.players.get(currentPlayerId);
}

function isStraight(values) {
  if (values.length !== 6) return false;
  const counts = tally(values);
  for (let f = 1; f <= 6; f++) if (counts[f] !== 1) return false;
  return true;
}

function isThreePairs(values) {
  if (values.length !== 6) return false;
  const counts = tally(values);
  let pairFaces = 0;
  for (let f = 1; f <= 6; f++) {
    if (counts[f] === 2) pairFaces += 1;
    else if (counts[f] !== 0) return false;
  }
  return pairFaces === 3;
}

function threeOfAKindValue(face) {
  return face === 1 ? 1000 : face * 100;
}

function nOfAKindValue(face, count, scheme) {
  if (count === 3) return threeOfAKindValue(face);
  if (scheme === 'doubling') return threeOfAKindValue(face) * Math.pow(2, count - 3);
  return count === 4 ? 1000 : count === 5 ? 2000 : 3000;
}

function isBust(values, wasFullSixDiceRoll) {
  if (wasFullSixDiceRoll && (isStraight(values) || isThreePairs(values))) return false;
  const counts = tally(values);
  for (let f = 1; f <= 6; f++) if (counts[f] >= 3) return false;
  if (counts[1] > 0 || counts[5] > 0) return false;
  return true;
}

// Scores exactly the dice the player selected (by index into the current roll). Whole-roll
// patterns (straight, three pairs) only apply when the entire fresh 6-dice roll is selected
// together, per the spec's stated priority over counting individual 1s/5s. Otherwise groups
// the selection by face value; any face left over that isn't part of a 3+ group and isn't a
// 1 or 5 makes the whole selection invalid (a player can't bank non-scoring dice).
function scoreSelection(fullRoll, selectedIndices, wasFullSixDiceRoll, scoringScheme) {
  if (wasFullSixDiceRoll && fullRoll.length === 6 && selectedIndices.length === 6) {
    if (isStraight(fullRoll)) return { valid: true, score: 2500 };
    if (isThreePairs(fullRoll)) return { valid: true, score: 1500 };
  }

  const selectedValues = selectedIndices.map((i) => fullRoll[i]);
  const counts = tally(selectedValues);
  let score = 0;
  for (let face = 1; face <= 6; face++) {
    const c = counts[face];
    if (!c) continue;
    if (c >= 3) {
      score += nOfAKindValue(face, c, scoringScheme);
    } else if (face === 1) {
      score += c * 100;
    } else if (face === 5) {
      score += c * 50;
    } else {
      return { valid: false };
    }
  }
  if (score === 0) return { valid: false };
  return { valid: true, score };
}

function applyRolledValues(room, player, values) {
  const preState = snapshotState(room, player);
  const wasFullSix = player.modeState.diceInPlayCount === 6;
  const bust = isBust(values, wasFullSix);

  if (bust) {
    logEvent(room, 'quackRoll', player.id, { values, bust: true, preState });
    resetTurnFields(player);
    logEvent(room, 'quackBust', player.id, {});
    room.turnIndex = nextIndexPlain(room, room.turnIndex);
  } else {
    player.modeState.wasFullSixDiceRoll = wasFullSix;
    player.modeState.currentRoll = values;
    logEvent(room, 'quackRoll', player.id, { values, bust: false, preState });
  }
  return {};
}

function roll(room, playerId) {
  if (room.status !== 'active') return { error: 'Game is not active.' };
  const player = resolveActingPlayer(room, playerId);
  if (!player) return { error: 'Not your turn.' };
  if (room.diceMode !== 'virtual') return { error: 'This room uses physical dice.' };
  if (player.modeState.currentRoll) return { error: 'Select dice from your last roll first.' };

  return applyRolledValues(room, player, rollDice(player.modeState.diceInPlayCount));
}

function reportRoll(room, playerId, payload) {
  if (room.status !== 'active') return { error: 'Game is not active.' };
  const player = resolveActingPlayer(room, playerId);
  if (!player) return { error: 'Not your turn.' };
  if (room.diceMode !== 'physical') return { error: 'This room uses virtual dice.' };
  if (player.modeState.currentRoll) return { error: 'Select dice from your last roll first.' };

  const values = (payload && payload.values) || [];
  if (values.length !== player.modeState.diceInPlayCount || !values.every(isValidFace)) {
    return { error: 'Invalid dice report.' };
  }
  return applyRolledValues(room, player, values);
}

function selectDice(room, playerId, payload) {
  if (room.status !== 'active') return { error: 'Game is not active.' };
  const player = resolveActingPlayer(room, playerId);
  if (!player) return { error: 'Not your turn.' };
  const roll = player.modeState.currentRoll;
  if (!roll) return { error: 'Roll first.' };

  const indices = [...new Set((payload && payload.indices) || [])];
  if (!indices.length || indices.some((i) => !Number.isInteger(i) || i < 0 || i >= roll.length)) {
    return { error: 'Invalid selection.' };
  }

  const result = scoreSelection(roll, indices, player.modeState.wasFullSixDiceRoll, room.config.scoringScheme);
  if (!result.valid) return { error: 'That selection includes non-scoring dice.' };

  const preState = snapshotState(room, player);
  const selectedValues = indices.map((i) => roll[i]);
  player.modeState.diceSetAside.push(...selectedValues);
  player.modeState.turnTotal += result.score;
  player.modeState.diceInPlayCount -= indices.length;
  player.modeState.currentRoll = null;
  player.modeState.wasFullSixDiceRoll = false;

  let hotDice = false;
  if (player.modeState.diceInPlayCount === 0) {
    hotDice = true;
    player.modeState.diceInPlayCount = 6;
    player.modeState.diceSetAside = [];
  }

  logEvent(room, 'quackSelect', player.id, {
    selectedValues,
    scoreGained: result.score,
    turnTotalAfter: player.modeState.turnTotal,
    hotDice,
    preState,
  });
  if (hotDice) logEvent(room, 'quackHotDice', player.id, {});

  return {};
}

function bank(room, playerId) {
  if (room.status !== 'active') return { error: 'Game is not active.' };
  const player = resolveActingPlayer(room, playerId);
  if (!player) return { error: 'Not your turn.' };
  if (player.modeState.currentRoll) return { error: 'Select dice from your last roll before banking.' };
  if (player.modeState.turnTotal <= 0) return { error: 'Nothing to bank yet.' };

  const preState = snapshotState(room, player);
  const attemptedAmount = player.modeState.turnTotal;
  let scored = false;

  if (room.config.minOpeningScoreEnabled && !player.modeState.hasQualified) {
    if (attemptedAmount >= room.config.minOpeningScoreValue) {
      player.modeState.hasQualified = true;
      player.modeState.score += attemptedAmount;
      scored = true;
    }
  } else {
    player.modeState.score += attemptedAmount;
    scored = true;
  }

  resetTurnFields(player);

  logEvent(room, 'quackBank', player.id, { attemptedAmount, scored, scoreAfter: player.modeState.score, preState });

  if (scored && !room.modeState.finalRoundTriggeredBy && player.modeState.score >= room.config.targetScore) {
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
    new Set(['quackRoll', 'quackSelect', 'quackBank']),
    new Set(['quackBust', 'quackHotDice', 'finalRoundTriggered']),
    restoreState
  );
}

module.exports = {
  key: 'quackquack',
  defaultConfig,
  clampConfig,
  initPlayerModeState,
  onGameStart,
  resetForNewSession,
  nextIndexFrom: nextIndexPlain,
  actions: {
    roll,
    reportRoll,
    selectDice,
    bank,
  },
  undoLast,
};
