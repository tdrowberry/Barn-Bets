// Horse Race: fixed 3-roll Ship/Captain/Crew sequence game. See horse-race-spec.md.
// Internally still "ship/captain/crew" (fun to keep in code comments/log types), but never
// surfaced player-facing - only "Horse Race" / "Ship" / "Captain" / "Crew" wording is used
// in anything a player sees, per that spec's branding note.
const { logEvent, clampInt, rollDice, isValidFace, undoLastGeneric, nextIndexPlain } = require('./shared');

function defaultConfig() {
  return { numberOfRounds: 10, winCondition: 'highestCumulative', tieBreak: 'suddenDeathReroll' };
}

function clampConfig(raw, current) {
  const base = current || defaultConfig();
  return {
    numberOfRounds: clampInt(raw.numberOfRounds, 5, 35, base.numberOfRounds),
    winCondition: raw.winCondition === 'mostRoundWins' ? 'mostRoundWins' : 'highestCumulative',
    tieBreak: raw.tieBreak === 'sharedWin' ? 'sharedWin' : 'suddenDeathReroll',
  };
}

function freshTurnFields() {
  return {
    rollsUsed: 0,
    locked: { ship: false, captain: false, crew: false },
    lockedPositions: { ship: null, captain: null, crew: null },
    diceValues: [null, null, null, null, null],
    cargoScore: null,
  };
}

function initPlayerModeState() {
  return { cumulativeScore: 0, roundsWon: 0, ...freshTurnFields() };
}

function resetTurnFields(player) {
  Object.assign(player.modeState, freshTurnFields());
}

function onGameStart(room) {
  room.modeState = { currentRound: 1, roundResults: {}, suddenDeath: false };
  for (const p of room.players.values()) {
    p.modeState.cumulativeScore = 0;
    p.modeState.roundsWon = 0;
    resetTurnFields(p);
  }
}

function resetForNewSession(room) {
  onGameStart(room);
  room.modeState.currentRound = 0;
}

function cloneModeState(modeState) {
  return {
    ...modeState,
    locked: { ...modeState.locked },
    lockedPositions: { ...modeState.lockedPositions },
    diceValues: [...modeState.diceValues],
  };
}

// Horse Race's turn-end can reset a SECOND player's state (whoever becomes active next), so
// undo snapshots every player wholesale rather than just the acting one - safer than trying
// to enumerate every field a given action might touch as a side effect.
function snapshotState(room) {
  const allPlayers = {};
  for (const [id, p] of room.players) allPlayers[id] = cloneModeState(p.modeState);
  return {
    allPlayers,
    turnIndex: room.turnIndex,
    turnOrder: [...room.turnOrder],
    status: room.status,
    currentRound: room.modeState.currentRound,
    roundResults: { ...room.modeState.roundResults },
    suddenDeath: room.modeState.suddenDeath,
  };
}

function restoreState(room, snap) {
  for (const [id, modeState] of Object.entries(snap.allPlayers)) {
    const p = room.players.get(id);
    if (p) p.modeState = cloneModeState(modeState);
  }
  room.turnIndex = snap.turnIndex;
  room.turnOrder = [...snap.turnOrder];
  room.status = snap.status;
  room.modeState.currentRound = snap.currentRound;
  room.modeState.roundResults = { ...snap.roundResults };
  room.modeState.suddenDeath = snap.suddenDeath;
}

function resolveActingPlayer(room, playerId) {
  const currentPlayerId = room.turnOrder[room.turnIndex];
  const isPassAndPlayHost = room.isPassAndPlay && playerId === room.hostId;
  if (!isPassAndPlayHost && playerId !== currentPlayerId) return null;
  return room.players.get(currentPlayerId);
}

function isPositionLocked(player, pos) {
  const lp = player.modeState.lockedPositions;
  return lp.ship === pos || lp.captain === pos || lp.crew === pos;
}

// Ship (6) -> Captain (5) -> Crew (4), in order. Null once all three are locked.
function neededFace(player) {
  if (!player.modeState.locked.ship) return 6;
  if (!player.modeState.locked.captain) return 5;
  if (!player.modeState.locked.crew) return 4;
  return null;
}

function hasEligibleLock(player) {
  const need = neededFace(player);
  if (need === null) return false;
  return player.modeState.diceValues.some((v, i) => v === need && !isPositionLocked(player, i));
}

function tallyRoundWin(room) {
  const players = room.turnOrder.map((id) => room.players.get(id)).filter(Boolean);
  const scores = players.map((p) => room.modeState.roundResults[p.id] || 0);
  const top = scores.length ? Math.max(...scores) : 0;
  players.forEach((p) => {
    if ((room.modeState.roundResults[p.id] || 0) === top) p.modeState.roundsWon += 1;
  });
}

function finishGameOrSuddenDeath(room) {
  const metric = room.config.winCondition === 'mostRoundWins'
    ? (p) => p.modeState.roundsWon
    : (p) => p.modeState.cumulativeScore;
  const players = room.turnOrder.map((id) => room.players.get(id)).filter(Boolean);
  const top = players.length ? Math.max(...players.map(metric)) : 0;
  const tied = players.filter((p) => metric(p) === top);

  if (tied.length <= 1 || room.config.tieBreak === 'sharedWin') {
    room.status = 'finished';
    return;
  }

  room.modeState.suddenDeath = true;
  room.modeState.roundResults = {};
  room.turnOrder = tied.map((p) => p.id);
  room.turnIndex = 0;
  tied.forEach(resetTurnFields);
  logEvent(room, 'suddenDeathStart', room.hostId, { playerIds: tied.map((p) => p.id) });
}

function advanceSuddenDeath(room) {
  const n = room.turnOrder.length;
  const nextIdx = (room.turnIndex + 1) % n;
  if (nextIdx !== 0) {
    room.turnIndex = nextIdx;
    resetTurnFields(room.players.get(room.turnOrder[room.turnIndex]));
    return;
  }

  const players = room.turnOrder.map((id) => room.players.get(id)).filter(Boolean);
  const scores = players.map((p) => room.modeState.roundResults[p.id] || 0);
  const top = scores.length ? Math.max(...scores) : 0;
  const winners = players.filter((p) => (room.modeState.roundResults[p.id] || 0) === top);
  room.modeState.roundResults = {};

  if (winners.length === 1) {
    room.status = 'finished';
    return;
  }

  room.turnOrder = winners.map((p) => p.id);
  room.turnIndex = 0;
  winners.forEach(resetTurnFields);
}

function advanceAfterTurn(room) {
  if (room.modeState.suddenDeath) {
    advanceSuddenDeath(room);
    return;
  }

  const n = room.turnOrder.length;
  const nextIdx = (room.turnIndex + 1) % n;
  if (nextIdx === 0) {
    tallyRoundWin(room);
    room.modeState.roundResults = {};
    room.modeState.currentRound += 1;
    if (room.modeState.currentRound > room.config.numberOfRounds) {
      finishGameOrSuddenDeath(room);
      return;
    }
  }
  room.turnIndex = nextIdx;
  resetTurnFields(room.players.get(room.turnOrder[room.turnIndex]));
}

function finishTurn(room, player, scoreThisTurn) {
  player.modeState.cumulativeScore += scoreThisTurn;
  room.modeState.roundResults[player.id] = scoreThisTurn;
  logEvent(room, 'horseTurnEnd', player.id, { cargoScore: player.modeState.cargoScore, scoreThisTurn });
  advanceAfterTurn(room);
}

// Called after every roll/lock: ends the turn the moment cargo is locked in, or once the
// player has no rolls and nothing left to lock.
function checkTurnEnd(room, player) {
  const need = neededFace(player);
  if (need === null) {
    const unlocked = [0, 1, 2, 3, 4].filter((i) => !isPositionLocked(player, i));
    const cargo = unlocked.reduce((sum, i) => sum + player.modeState.diceValues[i], 0);
    player.modeState.cargoScore = cargo;
    finishTurn(room, player, cargo);
    return;
  }
  if (player.modeState.rollsUsed >= 3 && !hasEligibleLock(player)) {
    player.modeState.cargoScore = null;
    finishTurn(room, player, 0);
  }
}

function applyRoll(room, player, positions, values) {
  const preState = snapshotState(room);
  positions.forEach((pos, i) => { player.modeState.diceValues[pos] = values[i]; });
  player.modeState.rollsUsed += 1;
  logEvent(room, 'horseRoll', player.id, { positions, values, rollsUsed: player.modeState.rollsUsed, preState });
  checkTurnEnd(room, player);
  return {};
}

function validatePositions(positions, player) {
  return positions.length > 0 && positions.every((p) => Number.isInteger(p) && p >= 0 && p <= 4 && !isPositionLocked(player, p));
}

function roll(room, playerId, payload) {
  if (room.status !== 'active') return { error: 'Game is not active.' };
  const player = resolveActingPlayer(room, playerId);
  if (!player) return { error: 'Not your turn.' };
  if (room.diceMode !== 'virtual') return { error: 'This room uses physical dice.' };
  if (player.modeState.rollsUsed >= 3) return { error: 'No rolls left this turn.' };

  const requested = (payload && payload.positions)
    || [0, 1, 2, 3, 4].filter((i) => !isPositionLocked(player, i));
  const positions = [...new Set(requested)];
  if (!validatePositions(positions, player)) return { error: 'Invalid dice to reroll.' };

  return applyRoll(room, player, positions, rollDice(positions.length));
}

function reportRoll(room, playerId, payload) {
  if (room.status !== 'active') return { error: 'Game is not active.' };
  const player = resolveActingPlayer(room, playerId);
  if (!player) return { error: 'Not your turn.' };
  if (room.diceMode !== 'physical') return { error: 'This room uses virtual dice.' };
  if (player.modeState.rollsUsed >= 3) return { error: 'No rolls left this turn.' };

  const positions = [...new Set((payload && payload.positions) || [])];
  const values = (payload && payload.values) || [];
  if (!validatePositions(positions, player) || positions.length !== values.length || !values.every(isValidFace)) {
    return { error: 'Invalid dice report.' };
  }
  return applyRoll(room, player, positions, values);
}

function lock(room, playerId, payload) {
  if (room.status !== 'active') return { error: 'Game is not active.' };
  const player = resolveActingPlayer(room, playerId);
  if (!player) return { error: 'Not your turn.' };

  const position = payload && payload.position;
  if (!Number.isInteger(position) || position < 0 || position > 4) return { error: 'Invalid die.' };
  if (isPositionLocked(player, position)) return { error: 'That die is already locked.' };
  if (player.modeState.diceValues[position] == null) return { error: 'Roll first.' };

  const need = neededFace(player);
  if (need === null) return { error: 'Ship, Captain, and Crew are all already locked.' };
  if (player.modeState.diceValues[position] !== need) return { error: "That die can't lock yet." };

  const preState = snapshotState(room);
  const role = need === 6 ? 'ship' : need === 5 ? 'captain' : 'crew';
  player.modeState.locked[role] = true;
  player.modeState.lockedPositions[role] = position;

  logEvent(room, 'horseLock', player.id, { role, position, preState });
  checkTurnEnd(room, player);
  return {};
}

function undoLast(room, hostId) {
  return undoLastGeneric(
    room,
    hostId,
    new Set(['horseRoll', 'horseLock']),
    new Set(['horseTurnEnd', 'suddenDeathStart']),
    restoreState
  );
}

module.exports = {
  key: 'horserace',
  defaultConfig,
  clampConfig,
  initPlayerModeState,
  onGameStart,
  resetForNewSession,
  nextIndexFrom: nextIndexPlain,
  actions: {
    roll,
    reportRoll,
    lock,
  },
  undoLast,
};
