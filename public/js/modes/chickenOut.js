// Chicken Out client module: shared-pot push-your-luck. Ported from the original
// single-mode app.js with field names updated for the multi-mode room shape
// (room.config.rounds/startingRolls, p.score instead of p.totalScore).
(function () {
  const B = window.BarnBets;

  const DIE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  let selectedSum = null;
  // Identifies "which turn" so a roll selection only resets when a genuinely new turn starts
  // for me, not on every incidental room:update (e.g. someone else chickening out mid-turn).
  let lastMyTurnKey = null;

  function isInStartingPhase(room) {
    return room.rollCountThisRound < room.config.startingRolls;
  }

  function describeName(room, playerId, viewerId) {
    if (playerId === viewerId) return 'you';
    const p = room.players.find((pl) => pl.id === playerId);
    return p ? p.name : 'that player';
  }

  function describeEvent(event, room, viewerId) {
    const player = room.players.find((p) => p.id === event.playerId);
    const name = viewerId && event.playerId === viewerId ? 'You' : (player ? player.name : 'Someone');
    switch (event.type) {
      case 'roll': {
        const p = event.payload;
        if (p.busted) return null; // the paired 'bust' event covers this instead
        if (p.potDoubled) {
          return p.sum
            ? `🎲 ${name} rolled ${p.sum} (double!) — pot doubled to ${p.potAfter}.`
            : `🎲 ${name} rolled a double! — pot doubled to ${p.potAfter}.`;
        }
        if (p.inStartingPhase && p.sum === 7) return `🎲 ${name} rolled a 7 — +70 to the pot!`;
        return `🎲 ${name} rolled ${p.sum}${p.isDouble ? ' (double)' : ''} — pot now ${p.potAfter}.`;
      }
      case 'bust':
        return `💥 ${name} rolled a 7 — bust! Pot lost.`;
      case 'chickenOut':
        return `🐔 ${name} chickened out with ${event.payload.potWon} point${event.payload.potWon === 1 ? '' : 's'}!`;
      case 'chickenOutRejected':
        return `⏱️ ${name} tried to chicken out, but the round had already ended — too late.`;
      case 'roundEnd':
        return `🏁 Everyone chickened out — round over.`;
      case 'hostOverride': {
        const a = event.payload;
        if (a.action === 'undoRoll' && 'sum' in a) {
          const rollDesc = a.sum ? `${a.sum}${a.isDouble ? ' double' : ''}` : 'a double';
          return `↩️ Host undid a roll (${rollDesc}).`;
        }
        if (a.action === 'reverseChickenOut') {
          const targetName = describeName(room, a.targetPlayerId, viewerId);
          const plural = a.amount === 1 ? '' : 's';
          if (a.direction === 'toAccepted') {
            return `↩️ Host reversed a rejected chicken-out — ${targetName} got ${a.amount} point${plural}.`;
          }
          const possessive = a.targetPlayerId === viewerId ? 'your' : `${targetName}'s`;
          return `↩️ Host reversed ${possessive} chicken-out — ${a.amount} point${plural} taken back.`;
        }
        return B.describeCommonEvent(event, room, viewerId);
      }
      default:
        return B.describeCommonEvent(event, room, viewerId);
    }
  }

  function findLastChickenOutEvent(room, playerId) {
    for (let i = room.events.length - 1; i >= 0; i--) {
      const e = room.events[i];
      if (e.playerId === playerId && (e.type === 'chickenOut' || e.type === 'chickenOutRejected')) return e;
    }
    return null;
  }

  function renderGame(room, state) {
    const el = B.el;
    el('game-round-info').textContent = `Round ${room.currentRound} of ${room.config.rounds} · Roll ${room.rollCountThisRound + 1}`;

    const inStartingPhase = isInStartingPhase(room);
    const banner = el('game-phase-banner');
    banner.classList.remove('hidden');
    banner.textContent = inStartingPhase
      ? '🛡️ Starting rolls — safe from a bust'
      : '🔥 Live — a 7 busts the round';
    banner.classList.toggle('phase-live', !inStartingPhase);

    const me = room.players.find((p) => p.id === state.playerId);
    const turnPlayerId = room.turnOrder[room.turnIndex];
    const turnPlayer = room.players.find((p) => p.id === turnPlayerId);
    const passAndPlay = !!room.isPassAndPlay && state.isHost;
    const amActive = passAndPlay ? true : !!(me && me.activeThisRound);
    const isMyTurn = passAndPlay ? true : (amActive && turnPlayerId === state.playerId);
    const turnPlayerName = turnPlayer ? turnPlayer.name : 'the next player';

    const turnEl = el('game-turn-indicator');
    turnEl.textContent = (!passAndPlay && isMyTurn) ? 'Your turn!' : `${turnPlayerName}'s turn`;
    turnEl.classList.toggle('my-turn', !passAndPlay && isMyTurn);

    let hint;
    if (passAndPlay) {
      if (room.diceMode === 'physical') {
        hint = inStartingPhase
          ? `Starting roll for ${turnPlayerName} — doubles don't affect the pot yet.`
          : `Enter ${turnPlayerName}'s roll, or tap ×2 alone if it was a double.`;
      } else {
        hint = `Tap Roll Dice for ${turnPlayerName}.`;
      }
    } else if (!amActive) {
      hint = "You're sitting out this round — hang tight, you'll be back in for the next one.";
    } else if (!isMyTurn) {
      hint = `Waiting for ${turnPlayerName}'s turn.`;
    } else if (room.diceMode === 'physical') {
      hint = inStartingPhase
        ? "Starting roll — doubles don't affect the pot yet."
        : (room.confirmRolls ? 'Tap a number then Confirm, or tap ×2 alone if it was a double.' : 'Tap your number to submit, or tap ×2 alone if it was a double.');
    } else {
      hint = "Tap Roll Dice when you're ready.";
    }
    el('game-status-hint').textContent = hint;

    el('game-pot').textContent = room.pot;
    el('btn-chicken-out').classList.toggle('hidden', passAndPlay);
    el('btn-chicken-out').disabled = !amActive;

    el('game-physical-panel').classList.toggle('hidden', room.diceMode !== 'physical');
    el('game-virtual-panel').classList.toggle('hidden', room.diceMode !== 'virtual');

    const turnKey = `${room.code}-${room.currentRound}-${room.turnIndex}`;
    if (isMyTurn && turnKey !== lastMyTurnKey) {
      lastMyTurnKey = turnKey;
      selectedSum = null;
    }

    document.querySelectorAll('.dice-btn:not(.dice-btn-double)').forEach((b) => {
      b.disabled = !isMyTurn;
      b.classList.toggle('selected', isMyTurn && selectedSum === parseInt(b.dataset.value, 10));
    });
    el('double-btn').disabled = !isMyTurn || inStartingPhase;

    if (room.confirmRolls) {
      el('btn-confirm-roll').classList.remove('hidden');
      el('btn-confirm-roll').disabled = !isMyTurn || selectedSum === null;
    } else {
      el('btn-confirm-roll').classList.add('hidden');
    }

    el('btn-roll-dice').disabled = !isMyTurn;
  }

  function submitPhysicalRoll(sum, isDouble) {
    document.querySelectorAll('.dice-btn').forEach((b) => { b.disabled = true; });
    B.socket.emit('player:submitRoll', { sum, isDouble }, (res) => {
      if (!res || !res.ok) {
        B.showToast((res && res.error) || 'Could not submit roll.', true);
        renderGame(B.state.room, B.state);
        return;
      }
      B.showEventToast(res.room);
    });
  }

  function wireGame() {
    const el = B.el;

    el('dice-grid').addEventListener('click', (e) => {
      const doubleBtn = e.target.closest('.dice-btn-double');
      if (doubleBtn) {
        if (doubleBtn.disabled) return;
        submitPhysicalRoll(null, true);
        return;
      }

      const btn = e.target.closest('.dice-btn');
      if (!btn || btn.disabled) return;
      selectedSum = parseInt(btn.dataset.value, 10);
      document.querySelectorAll('.dice-btn:not(.dice-btn-double)').forEach((b) => b.classList.toggle('selected', b === btn));

      if (B.state.room.confirmRolls) {
        el('btn-confirm-roll').disabled = false;
      } else {
        submitPhysicalRoll(selectedSum, false);
      }
    });

    el('btn-confirm-roll').addEventListener('click', () => {
      if (selectedSum === null) return;
      el('btn-confirm-roll').disabled = true;
      submitPhysicalRoll(selectedSum, false);
    });

    el('btn-roll-dice').addEventListener('click', () => {
      const btn = el('btn-roll-dice');
      const anim = el('dice-animation');
      btn.disabled = true;
      btn.textContent = '🎲 Rolling…';
      anim.textContent = '🎲';
      anim.classList.add('rolling');
      const startTime = Date.now();

      B.socket.emit('player:submitRoll', {}, (res) => {
        const elapsed = Date.now() - startTime;
        const minDelay = Math.max(0, 500 - elapsed);
        setTimeout(() => {
          anim.classList.remove('rolling');
          btn.textContent = '🎲 Roll Dice';
          if (!res || !res.ok) {
            btn.disabled = false;
            B.showToast((res && res.error) || 'Could not roll.', true);
            return;
          }
          const lastRoll = [...res.room.events].reverse().find((ev) => ev.type === 'roll');
          if (lastRoll && lastRoll.payload.dice) {
            anim.textContent = lastRoll.payload.dice.map((d) => DIE_FACES[d - 1]).join(' ');
          }
          B.showEventToast(res.room);
        }, minDelay);
      });
    });

    el('btn-chicken-out').addEventListener('click', () => {
      const btn = el('btn-chicken-out');
      btn.disabled = true;
      B.socket.emit('player:chickenOut', { round: B.state.room.currentRound }, (res) => {
        if (!res || !res.ok) {
          btn.disabled = false;
          B.showToast((res && res.error) || 'Could not chicken out.', true);
          return;
        }
        B.showEventToast(res.room);
      });
    });

    // Pass-and-play only: chicken-out is available for any active player at any time, not
    // just whoever's turn it is - each row gets its own button naming its target explicitly.
    el('game-scoreboard').addEventListener('click', (e) => {
      const chickenBtn = e.target.closest('.btn-chicken-small');
      if (chickenBtn) {
        const row = chickenBtn.closest('.player-row');
        const targetPlayerId = row && row.dataset.id;
        if (!targetPlayerId) return;
        chickenBtn.disabled = true;
        B.socket.emit('player:chickenOut', { round: B.state.room.currentRound, targetPlayerId }, (res) => {
          if (!res || !res.ok) B.showToast((res && res.error) || 'Could not chicken out.', true);
          else B.showEventToast(res.room);
        });
        return;
      }

      const reverseBtn = e.target.closest('.btn-reverse');
      if (reverseBtn) {
        const eventId = reverseBtn.dataset.eventId;
        if (!eventId) return;
        if (!B.isArmed('reverse', eventId)) {
          B.arm('reverse', eventId, B.refreshGameChrome);
          B.refreshGameChrome();
          return;
        }
        B.disarm();
        B.socket.emit('host:reverseChickenOut', { eventId }, (res) => {
          if (!res || !res.ok) B.showToast((res && res.error) || 'Could not reverse that.', true);
          B.refreshGameChrome();
        });
      }
    });
  }

  window.BarnBetsModes.chickenout = {
    key: 'chickenout',
    name: 'Chicken Out',
    icon: '🐔',
    tagline: 'Push your luck on a shared pot',
    // The only mode with real mascot art so far - other modes fall back to their emoji
    // icon and the plain gradient background until their own art is ready.
    logoImage: '/img/logo.jpg',
    heroBackground: '/img/splash.jpg',
    howToPlay: [
      '<strong>Take turns rolling</strong> two dice (or tap Roll Dice in virtual mode). Every roll adds to the shared pot.',
      'The first few rolls each round are <strong>safe</strong> — even a 7 just adds a bonus 70 to the pot.',
      "After that, it's <strong>live</strong>: a 7 busts the round and the pot is lost for everyone still in, but a double instantly <strong>doubles</strong> the pot instead.",
      'Tap <strong>🐔 Chicken Out</strong> anytime to lock in the current pot as your score — but you\'re done for that round.',
      'After all the rounds, whoever has the <strong>highest total score</strong> wins!',
    ],
    configFields: ['rounds', 'startingRolls'],
    setupFieldsId: 'setup-chickenout',
    lobbyFieldsId: 'lobby-setup-chickenout',
    playId: 'play-chickenout',
    wireGame,
    renderGame,
    describeEvent,
    canReverseEvent(event) { return event.type === 'chickenOut' || event.type === 'chickenOutRejected'; },
    scoreboard: { getValue: (p) => p.score },
    extraRowContent(p, room, state) {
      const showChickenOutButtons = room.isPassAndPlay && state.isHost && room.status === 'active';
      const showUndoRedo = state.isHost && room.status === 'active';
      const chickenBtn = (showChickenOutButtons && p.activeThisRound)
        ? '<button type="button" class="btn-chicken-small">🐔 Out</button>'
        : '';
      const lastChickenEvent = showUndoRedo ? findLastChickenOutEvent(room, p.id) : null;
      const undoArmed = lastChickenEvent && B.isArmed('reverse', lastChickenEvent.id);
      const undoBtn = lastChickenEvent
        ? `<button type="button" class="btn-reverse${undoArmed ? ' confirming' : ''}" data-event-id="${lastChickenEvent.id}">${undoArmed ? 'Confirm?' : (lastChickenEvent.reversed ? '↺' : '↩')}</button>`
        : '';
      return undoBtn + chickenBtn;
    },
  };
})();
