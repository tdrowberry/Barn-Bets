// Pigout client module: no shared pot, each player has their own running score and busts
// on their own turn only.
(function () {
  const B = window.BarnBets;

  let hogCount = 1;
  let lastTurnKey = null;
  let dicePicker = null;
  let lastSlotsSignature = null;

  // Recreates the picker (back to all-1s) whenever the room's event history moves forward -
  // i.e. after every roll or turn change - not just when the dice count changes, so a new
  // roll never silently inherits the previous roll's leftover tapped values.
  function ensureDiceSlots(n, signature) {
    if (lastSlotsSignature === signature && dicePicker) return;
    lastSlotsSignature = signature;
    dicePicker = B.createDiceSlotPicker(B.el('pig-dice-slots'), n);
  }

  function refreshVisibility(prefix) {
    const hogEnabled = B.el(`${prefix}-pigout-hogModeEnabled`).checked;
    const diceCount = B.el(`${prefix}-pigout-diceCount`).value;
    B.el(`${prefix}-pigout-hog-fields`).classList.toggle('hidden', !hogEnabled);
    B.el(`${prefix}-pigout-fixed-fields`).classList.toggle('hidden', hogEnabled);
    B.el(`${prefix}-pigout-twodice-fields`).classList.toggle('hidden', diceCount !== '2');
  }

  function wireSetup() {
    B.el('setup-pigout-hogModeEnabled').addEventListener('change', () => refreshVisibility('setup'));
    B.el('setup-pigout-diceCount').addEventListener('change', () => refreshVisibility('setup'));
  }

  function updateHogDisplay() {
    B.el('pig-hog-count').textContent = hogCount;
    if (B.state.room && B.state.room.diceMode === 'physical') {
      ensureDiceSlots(hogCount, `${B.state.room.events.length}-${hogCount}`);
    }
    if (B.state.room && B.state.room.status === 'active') renderGame(B.state.room, B.state);
  }

  function wireGame() {
    B.el('pig-hog-minus').addEventListener('click', () => {
      hogCount = Math.max(1, hogCount - 1);
      updateHogDisplay();
    });
    B.el('pig-hog-plus').addEventListener('click', () => {
      const max = (B.state.room && B.state.room.config.hogMaxDice) || 6;
      hogCount = Math.min(max, hogCount + 1);
      updateHogDisplay();
    });

    B.el('btn-pig-roll').addEventListener('click', () => {
      const btn = B.el('btn-pig-roll');
      btn.disabled = true;
      const payload = B.state.room.config.hogModeEnabled ? { diceCount: hogCount } : {};
      B.socket.emit('player:pigRoll', payload, (res) => {
        btn.disabled = false;
        if (!res || !res.ok) { B.showToast((res && res.error) || 'Could not roll.', true); return; }
        B.showEventToast(res.room);
      });
    });

    B.el('btn-pig-submit-roll').addEventListener('click', () => {
      if (!dicePicker) return;
      const faces = dicePicker.getValues();
      const payload = B.state.room.config.hogModeEnabled ? { faces, diceCount: faces.length } : { faces };
      B.socket.emit('player:pigReportRoll', payload, (res) => {
        if (!res || !res.ok) { B.showToast((res && res.error) || 'Could not submit roll.', true); return; }
        B.showEventToast(res.room);
      });
    });

    B.el('btn-pig-bank').addEventListener('click', () => {
      const btn = B.el('btn-pig-bank');
      btn.disabled = true;
      B.socket.emit('player:pigBank', {}, (res) => {
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

    el('pig-turn-total').textContent = turnPlayer ? turnPlayer.turnTotal : 0;

    const turnKey = `${room.code}-${room.turnIndex}`;
    if (turnKey !== lastTurnKey) {
      lastTurnKey = turnKey;
      hogCount = 1;
    }

    let hint;
    if (passAndPlay) {
      hint = room.diceMode === 'physical' ? `Report ${turnPlayerName}'s roll.` : `Tap Roll for ${turnPlayerName}.`;
    } else if (!isMyTurn) {
      hint = `Waiting for ${turnPlayerName}'s turn.`;
    } else if (turnPlayer && turnPlayer.hasRolledThisTurn) {
      hint = 'Roll again, or bank your turn total.';
    } else {
      hint = 'Roll to start your turn.';
    }
    el('game-status-hint').textContent = hint;

    const hogEnabled = room.config.hogModeEnabled;
    el('pig-hog-picker').classList.toggle('hidden', !(hogEnabled && isMyTurn));
    if (hogEnabled) {
      el('pig-hog-max').textContent = room.config.hogMaxDice;
      el('pig-hog-count').textContent = hogCount;
    }

    const diceCount = hogEnabled ? hogCount : room.config.diceCount;
    el('pig-physical-panel').classList.toggle('hidden', room.diceMode !== 'physical');
    el('pig-virtual-panel').classList.toggle('hidden', room.diceMode !== 'virtual');
    if (room.diceMode === 'physical') {
      ensureDiceSlots(diceCount, `${room.events.length}-${diceCount}`);
    }

    el('btn-pig-roll').disabled = !isMyTurn;
    el('btn-pig-submit-roll').disabled = !isMyTurn;
    el('btn-pig-bank').disabled = !isMyTurn || !(turnPlayer && turnPlayer.hasRolledThisTurn);
  }

  function describeEvent(event, room, viewerId) {
    const player = room.players.find((p) => p.id === event.playerId);
    const name = viewerId && event.playerId === viewerId ? 'You' : (player ? player.name : 'Someone');
    switch (event.type) {
      case 'pigRoll': {
        if (event.payload.busted) return null; // the paired pigBust event covers this
        return `🎲 ${name} rolled ${event.payload.faces.join(' + ')} — turn total ${event.payload.turnTotalAfter}.`;
      }
      case 'pigBust':
        return event.payload.scoreWiped
          ? `💥 Snake eyes! ${name === 'You' ? 'your' : `${name}'s`} whole score was wiped.`
          : `💥 ${name} busted — turn total lost.`;
      case 'pigBank':
        return `💰 ${name} banked ${event.payload.amount} — score now ${event.payload.scoreAfter}.`;
      case 'finalRoundTriggered':
        return `🏁 ${name} reached the target! Final lap for everyone else.`;
      default:
        return B.describeCommonEvent(event, room, viewerId);
    }
  }

  window.BarnBetsModes.pigout = {
    key: 'pigout',
    name: 'Pigout',
    icon: '🐷',
    tagline: 'Roll, bank, don’t get greedy',
    howToPlay: [
      '<strong>Roll</strong> and add each roll to your <strong>turn total</strong>.',
      'Roll a <strong>1</strong> and your turn total is lost — turn passes to the next player.',
      '<strong>Bank</strong> anytime after rolling to lock your turn total into your permanent score.',
      'With 2 dice: <strong>snake eyes</strong> (two 1s) triggers this room’s penalty, and matching doubles can double the roll.',
      'First to the <strong>target score</strong> triggers a final lap — everyone else gets one more turn to catch up or overtake.',
    ],
    configFields: ['targetScore', 'diceCount', 'doubleOnesPenalty', 'doublesBonus', 'hogModeEnabled', 'hogMaxDice'],
    setupFieldsId: 'setup-pigout',
    lobbyFieldsId: 'lobby-setup-pigout',
    playId: 'play-pigout',
    refreshVisibility,
    wireSetup,
    wireGame,
    renderGame,
    describeEvent,
    scoreboard: { getValue: (p) => p.score },
  };
})();
