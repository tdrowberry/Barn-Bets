// Quack Quack client module: six-dice Farkle-family scoring puzzle with hot dice.
(function () {
  const B = window.BarnBets;

  let selectedIndices = new Set();
  let lastRollSignature = null;
  let dicePicker = null;
  let lastSlotsSignature = null;

  // Recreated (back to unanswered) whenever the room's event history moves forward, not
  // just when the dice count changes - so a fresh roll never inherits the previous roll's
  // leftover taps.
  function ensureDiceSlots(n, signature) {
    if (lastSlotsSignature === signature && dicePicker) return;
    lastSlotsSignature = signature;
    dicePicker = B.createDiceFacePicker(B.el('quack-dice-slots'), n, () => {
      B.el('btn-quack-submit-roll').disabled = !dicePicker.isComplete();
    });
  }

  function refreshVisibility(prefix) {
    const enabled = B.el(`${prefix}-quackquack-minOpeningScoreEnabled`).checked;
    B.el(`${prefix}-quackquack-minopen-fields`).classList.toggle('hidden', !enabled);
  }

  function wireSetup() {
    B.el('setup-quackquack-minOpeningScoreEnabled').addEventListener('change', () => refreshVisibility('setup'));
  }

  function renderCurrentRoll(values) {
    const container = B.el('quack-current-roll');
    container.innerHTML = '';
    values.forEach((v, i) => {
      const tile = document.createElement('div');
      tile.className = 'die-tile' + (selectedIndices.has(i) ? ' selected' : '');
      tile.textContent = v;
      tile.dataset.index = String(i);
      container.appendChild(tile);
    });
  }

  function wireGame() {
    B.el('quack-current-roll').addEventListener('click', (e) => {
      const tile = e.target.closest('.die-tile');
      if (!tile) return;
      const idx = parseInt(tile.dataset.index, 10);
      if (selectedIndices.has(idx)) selectedIndices.delete(idx);
      else selectedIndices.add(idx);
      tile.classList.toggle('selected');
      B.el('btn-quack-confirm-selection').disabled = selectedIndices.size === 0;
    });

    B.el('btn-quack-roll').addEventListener('click', () => {
      const btn = B.el('btn-quack-roll');
      btn.disabled = true;
      B.socket.emit('player:quackRoll', {}, (res) => {
        btn.disabled = false;
        if (!res || !res.ok) { B.showToast((res && res.error) || 'Could not roll.', true); return; }
        B.showEventToast(res.room);
      });
    });

    B.el('btn-quack-submit-roll').addEventListener('click', () => {
      if (!dicePicker || !dicePicker.isComplete()) return;
      const values = dicePicker.getValues();
      B.socket.emit('player:quackReportRoll', { values }, (res) => {
        if (!res || !res.ok) { B.showToast((res && res.error) || 'Could not submit roll.', true); return; }
        B.showEventToast(res.room);
      });
    });

    B.el('btn-quack-confirm-selection').addEventListener('click', () => {
      const indices = [...selectedIndices];
      if (!indices.length) return;
      B.el('btn-quack-confirm-selection').disabled = true;
      B.socket.emit('player:quackSelectDice', { indices }, (res) => {
        if (!res || !res.ok) {
          B.showToast((res && res.error) || 'Could not select dice.', true);
          B.el('btn-quack-confirm-selection').disabled = false;
          return;
        }
        B.showEventToast(res.room);
      });
    });

    B.el('btn-quack-bank').addEventListener('click', () => {
      const btn = B.el('btn-quack-bank');
      btn.disabled = true;
      B.socket.emit('player:quackBank', {}, (res) => {
        if (!res || !res.ok) {
          btn.disabled = false;
          B.showToast((res && res.error) || 'Could not bank.', true);
          return;
        }
        B.showEventToast(res.room);
      });
    });
  }

  function renderGame(room, state) {
    const el = B.el;
    const turnPlayerId = room.turnOrder[room.turnIndex];
    const turnPlayer = room.players.find((p) => p.id === turnPlayerId);
    const passAndPlay = !!room.isPassAndPlay && state.isHost;
    const isMyTurn = passAndPlay ? true : turnPlayerId === state.playerId;
    const turnPlayerName = turnPlayer ? turnPlayer.name : 'the next player';

    el('game-round-info').textContent = `Target score: ${room.config.targetScore}`;

    const banner = el('game-phase-banner');
    if (room.finalRoundTriggeredBy) {
      const trigger = room.players.find((p) => p.id === room.finalRoundTriggeredBy);
      banner.textContent = `🏁 Final lap! ${trigger ? trigger.name : 'A player'} reached the target — everyone else gets one more turn.`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }

    const turnEl = el('game-turn-indicator');
    turnEl.textContent = (!passAndPlay && isMyTurn) ? 'Your turn!' : `${turnPlayerName}'s turn`;
    turnEl.classList.toggle('my-turn', !passAndPlay && isMyTurn);

    el('quack-turn-total').textContent = turnPlayer ? turnPlayer.turnTotal : 0;
    el('quack-dice-in-play-hint').textContent = turnPlayer ? `${turnPlayer.diceInPlayCount} dice in play` : '';

    const hasCurrentRoll = !!(turnPlayer && Array.isArray(turnPlayer.currentRoll) && turnPlayer.currentRoll.length > 0);

    let hint;
    if (passAndPlay) {
      hint = hasCurrentRoll ? 'Pick dice to set aside.' : (room.diceMode === 'physical' ? `Report ${turnPlayerName}'s roll.` : `Tap Roll for ${turnPlayerName}.`);
    } else if (!isMyTurn) {
      hint = `Waiting for ${turnPlayerName}'s turn.`;
    } else if (hasCurrentRoll) {
      hint = 'Tap the dice you want to set aside, then confirm.';
    } else if (turnPlayer && turnPlayer.turnTotal > 0) {
      hint = 'Roll again, or bank your turn total.';
    } else {
      hint = 'Roll to start your turn.';
    }
    el('game-status-hint').textContent = hint;

    const rollSig = turnPlayer ? `${room.code}-${room.turnIndex}-${JSON.stringify(turnPlayer.currentRoll)}` : null;
    if (rollSig !== lastRollSignature) {
      lastRollSignature = rollSig;
      selectedIndices = new Set();
    }

    const showSelection = isMyTurn && hasCurrentRoll;
    el('quack-selection-panel').classList.toggle('hidden', !showSelection);
    el('quack-physical-panel').classList.toggle('hidden', !(room.diceMode === 'physical' && !hasCurrentRoll));
    el('quack-virtual-panel').classList.toggle('hidden', !(room.diceMode === 'virtual' && !hasCurrentRoll));

    if (showSelection) renderCurrentRoll(turnPlayer.currentRoll);
    if (room.diceMode === 'physical' && !hasCurrentRoll) {
      const n = turnPlayer ? turnPlayer.diceInPlayCount : 6;
      ensureDiceSlots(n, `${room.events.length}-${n}`);
    }

    el('btn-quack-roll').disabled = !isMyTurn || hasCurrentRoll;
    el('btn-quack-submit-roll').disabled = !isMyTurn || hasCurrentRoll || !(dicePicker && dicePicker.isComplete());
    el('btn-quack-confirm-selection').disabled = selectedIndices.size === 0;
    el('btn-quack-bank').disabled = !isMyTurn || hasCurrentRoll || !(turnPlayer && turnPlayer.turnTotal > 0);
  }

  function describeEvent(event, room, viewerId) {
    const player = room.players.find((p) => p.id === event.playerId);
    const name = viewerId && event.playerId === viewerId ? 'You' : (player ? player.name : 'Someone');
    switch (event.type) {
      case 'quackRoll':
        if (event.payload.bust) return null; // the paired quackBust event covers this
        return `🎲 ${name} rolled ${event.payload.values.join(', ')}.`;
      case 'quackBust':
        return `💥 ${name} busted — turn total lost.`;
      case 'quackSelect':
        return `✅ ${name} set aside ${event.payload.selectedValues.join(', ')} for ${event.payload.scoreGained} — turn total ${event.payload.turnTotalAfter}.`;
      case 'quackHotDice':
        return `🔥 ${name} got hot dice — all six back in play!`;
      case 'quackBank':
        return event.payload.scored
          ? `💰 ${name} banked ${event.payload.attemptedAmount} — score now ${event.payload.scoreAfter}.`
          : `⚠️ ${name === 'You' ? 'Your' : `${name}'s`} ${event.payload.attemptedAmount} didn't meet the minimum opening score — scored 0.`;
      case 'finalRoundTriggered':
        return `🏁 ${name} reached the target! Final lap for everyone else.`;
      default:
        return B.describeCommonEvent(event, room, viewerId);
    }
  }

  window.BarnBetsModes.quackquack = {
    key: 'quackquack',
    name: 'Quack Quack',
    icon: '🦆',
    tagline: 'Six dice, score the combo',
    logoImage: '/img/quackquack-logo.jpg',
    heroBackground: '/img/quackquack-hero.jpg',
    howToPlay: [
      'Roll all 6 dice, then <strong>set aside</strong> at least one scoring die or combo each roll.',
      'Singles: a <strong>1</strong> is worth 100, a <strong>5</strong> is worth 50. Three or more of a kind score much more.',
      'A <strong>straight</strong> (1-2-3-4-5-6) or <strong>three pairs</strong> in one roll scores big — but uses all six dice.',
      "If nothing scores on a roll, that's a <strong>bust</strong> — your whole turn total is lost.",
      '<strong>Hot dice:</strong> set aside all 6 and you get to roll all 6 again, keeping your turn total.',
      '<strong>Bank</strong> anytime to lock in your turn total. First to the target triggers one final lap for everyone else.',
    ],
    configFields: ['targetScore', 'scoringScheme', 'minOpeningScoreEnabled', 'minOpeningScoreValue'],
    setupFieldsId: 'setup-quackquack',
    lobbyFieldsId: 'lobby-setup-quackquack',
    playId: 'play-quackquack',
    refreshVisibility,
    wireSetup,
    wireGame,
    renderGame,
    describeEvent,
    scoreboard: { getValue: (p) => p.score },
  };
})();
