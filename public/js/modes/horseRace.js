// Horse Race client module: fixed 3-roll Ship/Captain/Crew sequence game.
(function () {
  const B = window.BarnBets;

  let heldPositions = new Set();
  let lastRollSignature = null;
  let dicePicker = null;
  let lastSlotsSignature = null;

  // Recreated (back to unanswered) whenever the room's event history moves forward, not
  // just when the reroll count changes - so a fresh roll never inherits the previous roll's
  // leftover taps.
  function ensureDiceSlots(n, signature) {
    if (lastSlotsSignature === signature && dicePicker) return;
    lastSlotsSignature = signature;
    dicePicker = B.createDiceFacePicker(B.el('horse-dice-slots'), n, () => {
      B.el('btn-horse-submit-roll').disabled = !dicePicker.isComplete();
    });
  }

  function isLocked(player, pos) {
    const lp = player.lockedPositions;
    return lp.ship === pos || lp.captain === pos || lp.crew === pos;
  }

  function neededFace(player) {
    if (!player.locked.ship) return 6;
    if (!player.locked.captain) return 5;
    if (!player.locked.crew) return 4;
    return null;
  }

  function roleFor(player, pos) {
    const lp = player.lockedPositions;
    if (lp.ship === pos) return 'ship';
    if (lp.captain === pos) return 'captain';
    if (lp.crew === pos) return 'crew';
    return null;
  }

  function unlockedRerollPositions(player) {
    return [0, 1, 2, 3, 4].filter((i) => !isLocked(player, i) && !heldPositions.has(i));
  }

  function renderDiceRow(player) {
    const container = B.el('horse-dice-row');
    container.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const tile = document.createElement('div');
      const value = player.diceValues[i];
      const locked = isLocked(player, i);
      const role = locked ? roleFor(player, i) : null;
      let cls = 'die-tile';
      if (locked) cls += ' locked';
      else if (value == null) cls += ' disabled';
      else if (heldPositions.has(i)) cls += ' held';
      tile.className = cls;
      tile.dataset.position = String(i);
      const roleBadge = role ? `<div class="die-tile-role">${role.charAt(0).toUpperCase() + role.slice(1)}</div>` : '';
      tile.innerHTML = `<div>${value == null ? '?' : value}</div>${roleBadge}`;
      container.appendChild(tile);
    }
  }

  function activePlayerAndTurn(room, state) {
    const turnPlayerId = room.turnOrder[room.turnIndex];
    const turnPlayer = room.players.find((p) => p.id === turnPlayerId);
    const passAndPlay = !!room.isPassAndPlay && state.isHost;
    const isMyTurn = passAndPlay ? true : turnPlayerId === state.playerId;
    return { turnPlayer, isMyTurn, passAndPlay };
  }

  function wireGame() {
    B.el('horse-dice-row').addEventListener('click', (e) => {
      const tile = e.target.closest('.die-tile');
      if (!tile || tile.classList.contains('locked') || tile.classList.contains('disabled')) return;
      const room = B.state.room;
      const { turnPlayer, isMyTurn } = activePlayerAndTurn(room, B.state);
      if (!isMyTurn || !turnPlayer) return;

      const pos = parseInt(tile.dataset.position, 10);
      const need = neededFace(turnPlayer);
      if (need !== null && turnPlayer.diceValues[pos] === need) {
        B.socket.emit('player:horseLock', { position: pos }, (res) => {
          if (!res || !res.ok) B.showToast((res && res.error) || 'Could not lock that die.', true);
          else B.showEventToast(res.room);
        });
      } else {
        if (heldPositions.has(pos)) heldPositions.delete(pos);
        else heldPositions.add(pos);
        renderDiceRow(turnPlayer);
        if (room.diceMode === 'physical') {
          const n = Math.max(1, unlockedRerollPositions(turnPlayer).length);
          ensureDiceSlots(n, `${room.events.length}-${n}-${[...heldPositions].join(',')}`);
        }
      }
    });

    B.el('btn-horse-roll').addEventListener('click', () => {
      const room = B.state.room;
      const { turnPlayer } = activePlayerAndTurn(room, B.state);
      if (!turnPlayer) return;
      const positions = unlockedRerollPositions(turnPlayer);
      if (!positions.length) { B.showToast('Hold at least one die back to have something to reroll.', true); return; }
      const btn = B.el('btn-horse-roll');
      btn.disabled = true;
      B.socket.emit('player:horseRoll', { positions }, (res) => {
        btn.disabled = false;
        if (!res || !res.ok) { B.showToast((res && res.error) || 'Could not roll.', true); return; }
        B.showEventToast(res.room);
      });
    });

    B.el('btn-horse-submit-roll').addEventListener('click', () => {
      if (!dicePicker || !dicePicker.isComplete()) return;
      const room = B.state.room;
      const { turnPlayer } = activePlayerAndTurn(room, B.state);
      if (!turnPlayer) return;
      const positions = unlockedRerollPositions(turnPlayer);
      if (!positions.length) { B.showToast('Hold at least one die back to have something to reroll.', true); return; }
      const values = dicePicker.getValues().slice(0, positions.length);
      B.socket.emit('player:horseReportRoll', { positions, values }, (res) => {
        if (!res || !res.ok) { B.showToast((res && res.error) || 'Could not submit roll.', true); return; }
        B.showEventToast(res.room);
      });
    });
  }

  function renderGame(room, state) {
    const el = B.el;
    const { turnPlayer, isMyTurn, passAndPlay } = activePlayerAndTurn(room, state);
    const turnPlayerId = room.turnOrder[room.turnIndex];
    const turnPlayerObj = room.players.find((p) => p.id === turnPlayerId);
    const turnPlayerName = turnPlayerObj ? turnPlayerObj.name : 'the next player';

    el('game-round-info').textContent = `Round ${room.currentRound} of ${room.config.numberOfRounds}`;

    const banner = el('game-phase-banner');
    if (room.suddenDeath) {
      banner.textContent = '⚡ Sudden death! Tied players go again.';
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }

    const turnEl = el('game-turn-indicator');
    turnEl.textContent = (!passAndPlay && isMyTurn) ? 'Your turn!' : `${turnPlayerName}'s turn`;
    turnEl.classList.toggle('my-turn', !passAndPlay && isMyTurn);

    let hint;
    if (passAndPlay) hint = room.diceMode === 'physical' ? `Report ${turnPlayerName}'s roll.` : `Roll for ${turnPlayerName}.`;
    else if (!isMyTurn) hint = `Waiting for ${turnPlayerName}'s turn.`;
    else hint = 'Lock Ship, then Captain, then Crew before your rolls run out.';
    el('game-status-hint').textContent = hint;

    if (!turnPlayer) return;

    ['ship', 'captain', 'crew'].forEach((role) => {
      const slotEl = document.querySelector(`#horse-checklist .sequence-slot[data-role="${role}"]`);
      const done = turnPlayer.locked[role];
      slotEl.classList.toggle('complete', done);
      slotEl.querySelector('.sequence-check').textContent = done ? '✓' : '—';
    });

    el('horse-rolls-left').textContent = `Rolls left: ${Math.max(0, 3 - turnPlayer.rollsUsed)}`;

    const rollSig = `${room.code}-${turnPlayerId}-${turnPlayer.rollsUsed}`;
    if (rollSig !== lastRollSignature) {
      lastRollSignature = rollSig;
      heldPositions = new Set();
    }

    renderDiceRow(turnPlayer);

    const hasRolledOnce = turnPlayer.diceValues.some((v) => v != null);
    el('horse-physical-panel').classList.toggle('hidden', room.diceMode !== 'physical');
    el('horse-virtual-panel').classList.toggle('hidden', room.diceMode !== 'virtual');
    el('horse-hold-hint').classList.toggle('hidden', !hasRolledOnce || !isMyTurn);

    const rollsLeft = turnPlayer.rollsUsed < 3;
    const unlockedCount = [0, 1, 2, 3, 4].filter((i) => !isLocked(turnPlayer, i)).length;
    const canRoll = isMyTurn && rollsLeft && unlockedCount > 0;
    el('btn-horse-roll').disabled = !canRoll;
    el('btn-horse-submit-roll').disabled = !canRoll || !(dicePicker && dicePicker.isComplete());

    if (room.diceMode === 'physical' && canRoll) {
      const n = Math.max(1, unlockedRerollPositions(turnPlayer).length);
      ensureDiceSlots(n, `${room.events.length}-${n}-${[...heldPositions].join(',')}`);
    }
  }

  function describeEvent(event, room, viewerId) {
    const player = room.players.find((p) => p.id === event.playerId);
    const name = viewerId && event.playerId === viewerId ? 'You' : (player ? player.name : 'Someone');
    switch (event.type) {
      case 'horseRoll':
        return `🎲 ${name} rolled ${event.payload.values.join(', ')}.`;
      case 'horseLock': {
        const role = event.payload.role;
        return `🔒 ${name} locked in ${role.charAt(0).toUpperCase() + role.slice(1)}.`;
      }
      case 'horseTurnEnd':
        return event.payload.cargoScore == null
          ? `⚓ ${name} didn't complete the sequence — scored 0.`
          : `⚓ ${name} finished with cargo ${event.payload.cargoScore}.`;
      case 'suddenDeathStart':
        return '⚡ Sudden death! Tied players go again.';
      default:
        return B.describeCommonEvent(event, room, viewerId);
    }
  }

  window.BarnBetsModes.horserace = {
    key: 'horserace',
    name: 'Horse Race',
    icon: '🐎',
    tagline: 'Three rolls, build your hand',
    logoImage: '/img/horserace-logo.jpg',
    heroBackground: '/img/horserace-hero.jpg',
    howToPlay: [
      'Five dice, <strong>3 rolls</strong> per turn — no open-ended pushing your luck here.',
      'Lock in a <strong>6 (Ship)</strong>, then a <strong>5 (Captain)</strong>, then a <strong>4 (Crew)</strong>, strictly in that order.',
      'Between rolls, choose which unlocked dice to reroll — you can hold one back if you like its value.',
      "Complete all three and your <strong>cargo</strong> (the sum of your last two dice) is your score for the turn.",
      "Don't complete the sequence in 3 rolls and you score zero for the turn — no shame, it happens often.",
      'Highest score after all the rounds (or most rounds won, depending on the host’s settings) wins.',
    ],
    configFields: ['numberOfRounds', 'winCondition', 'tieBreak'],
    setupFieldsId: 'setup-horserace',
    lobbyFieldsId: 'lobby-setup-horserace',
    playId: 'play-horserace',
    wireGame,
    renderGame,
    describeEvent,
    scoreboard: {
      getValue: (p, room) => (room.config.winCondition === 'mostRoundWins' ? p.roundsWon : p.cumulativeScore),
    },
  };
})();
