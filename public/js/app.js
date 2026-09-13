(function () {
  const socket = io();

  const state = {
    roomCode: null,
    playerId: null,
    isHost: false,
    room: null,
  };

  let hasHandledInitialConnect = false;

  const screens = ['screen-landing', 'screen-host-setup', 'screen-join', 'screen-lobby', 'screen-game'];
  const HERO_BG_SCREENS = new Set(['screen-landing', 'screen-host-setup', 'screen-join']);

  const AVATAR_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
  function avatarColor(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  }

  const DRAG_HANDLE_SVG = '<svg class="drag-handle" viewBox="0 0 20 20" width="20" height="20" fill="currentColor">'
    + '<circle cx="6" cy="4" r="1.6"/><circle cx="14" cy="4" r="1.6"/>'
    + '<circle cx="6" cy="10" r="1.6"/><circle cx="14" cy="10" r="1.6"/>'
    + '<circle cx="6" cy="16" r="1.6"/><circle cx="14" cy="16" r="1.6"/></svg>';

  const DIE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  let selectedSum = null;
  let toastTimer = null;
  // Identifies "which turn" so a roll selection only resets when a genuinely new turn
  // starts for me, not on every incidental room:update (e.g. someone else chickening out
  // mid-turn) - includes the room code so a fresh room can never collide with a stale key.
  let lastMyTurnKey = null;

  // Host action lists (players, event log) are rebuilt wholesale on every room:update,
  // which fires constantly during live play - so a "confirm?" arm state stored only on the
  // DOM node would get silently wiped mid-confirm by an unrelated broadcast. Tracking it
  // here instead means every render can re-apply it to the right row.
  let armedAction = null; // { type: 'kick' | 'reverse', id }

  function isArmed(type, id) {
    return !!armedAction && armedAction.type === type && armedAction.id === id;
  }

  function disarm() {
    if (armedAction) clearTimeout(armedAction.timer);
    armedAction = null;
  }

  function arm(type, id, onExpire) {
    disarm();
    const timer = setTimeout(() => { armedAction = null; onExpire(); }, 3000);
    armedAction = { type, id, timer };
  }

  // For static buttons that are never rebuilt by a re-render (so, unlike kick/reverse, a
  // DOM-local flag is safe here) - tap once to arm ("Confirm?"), tap again within 3s to fire.
  function wireConfirmButton(btn, defaultLabel, onConfirmed) {
    let confirming = false;
    let timer = null;
    btn.addEventListener('click', () => {
      if (!confirming) {
        confirming = true;
        btn.classList.add('confirming');
        btn.textContent = 'Confirm?';
        timer = setTimeout(() => {
          confirming = false;
          btn.classList.remove('confirming');
          btn.textContent = defaultLabel;
        }, 3000);
        return;
      }
      clearTimeout(timer);
      confirming = false;
      btn.classList.remove('confirming');
      btn.textContent = defaultLabel;
      onConfirmed();
    });
  }

  function el(id) { return document.getElementById(id); }

  function showScreen(id) {
    screens.forEach((s) => el(s).classList.toggle('hidden', s !== id));
    document.body.classList.toggle('bg-hero', HERO_BG_SCREENS.has(id));
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function saveSession(roomCode, playerId, isHost) {
    try {
      sessionStorage.setItem('chicken.session', JSON.stringify({ roomCode, playerId, isHost }));
    } catch (e) { /* storage unavailable, non-fatal */ }
  }

  function loadSession() {
    try {
      return JSON.parse(sessionStorage.getItem('chicken.session'));
    } catch (e) {
      return null;
    }
  }

  function clearSession() {
    try { sessionStorage.removeItem('chicken.session'); } catch (e) { /* ignore */ }
  }

  // Shows the splash only for a genuine fresh arrival via QR/link - not on a reload or a
  // dropped-connection reconnect mid-game, since forcing everyone through a 5s splash again
  // there would just be annoying, not a nice intro.
  function maybeShowSplash() {
    const roomFromUrl = new URLSearchParams(location.search).get('room');
    if (!roomFromUrl) return;
    const session = loadSession();
    const isReconnectToSameRoom = session && session.roomCode === roomFromUrl.toUpperCase() && session.playerId;
    if (isReconnectToSameRoom) return;

    const splash = el('splash-screen');
    splash.classList.remove('hidden');
    setTimeout(() => {
      splash.classList.add('fade-out');
      setTimeout(() => splash.classList.add('hidden'), 500);
    }, 5000);
  }
  // The landing screen is visible by default straight from the static HTML (no JS needed
  // to show it), so without this, bg-hero never gets applied until the user navigates away
  // and back - this makes the initial paint consistent with every later showScreen() call.
  showScreen('screen-landing');
  maybeShowSplash();

  function prefillJoin(code) {
    el('join-code').value = code.toUpperCase();
    showScreen('screen-join');
  }

  function maybePrefillFromUrl() {
    const roomFromUrl = new URLSearchParams(location.search).get('room');
    if (roomFromUrl) prefillJoin(roomFromUrl);
  }

  function applyJoinedState(res, isHost) {
    state.roomCode = res.roomCode;
    state.playerId = res.playerId;
    state.isHost = isHost;
    state.room = res.room;
    lastMyTurnKey = null; // fresh join/host - don't carry over stale turn-tracking
    saveSession(res.roomCode, res.playerId, isHost);
    renderFromRoom();
  }

  function renderFromRoom() {
    const room = state.room;
    if (!room) return;
    if (room.status === 'lobby') {
      renderLobby();
      showScreen('screen-lobby');
    } else if (room.status === 'active') {
      renderGame();
      showScreen('screen-game');
    } else if (room.status === 'finished') {
      renderGameFinished();
      showScreen('screen-game');
    }
  }

  function renderLobby() {
    const room = state.room;
    el('lobby-room-code').textContent = room.code;

    el('lobby-join-section').classList.toggle('hidden', !!room.isPassAndPlay);
    el('lobby-add-player-row').classList.toggle('hidden', !(room.isPassAndPlay && state.isHost));

    const joinUrl = `${window.location.origin}/?room=${room.code}`;
    el('lobby-join-link').value = joinUrl;

    const qrEl = el('lobby-qr');
    qrEl.innerHTML = '';
    if (window.QRCode) {
      new QRCode(qrEl, { text: joinUrl, width: 180, height: 180 });
    }

    renderLobbySettingsForm(room);
    renderPlayerList(room);

    const startBtn = el('btn-start-game');
    const waitingMsg = el('lobby-waiting-msg');
    const hostHint = el('lobby-host-hint');
    const settingsHint = el('lobby-settings-hint');
    if (state.isHost) {
      startBtn.classList.remove('hidden');
      waitingMsg.classList.add('hidden');
      hostHint.classList.remove('hidden');
      settingsHint.classList.add('hidden');
    } else {
      startBtn.classList.add('hidden');
      waitingMsg.classList.remove('hidden');
      hostHint.classList.add('hidden');
      settingsHint.classList.remove('hidden');
    }
  }

  function renderLobbySettingsForm(room) {
    el('lobby-rounds').value = room.roundsTotal;
    el('lobby-starting-rolls').value = room.startingRolls;
    el('lobby-dice-mode').value = room.diceMode;
    el('lobby-confirm-rolls').checked = room.confirmRolls;

    ['lobby-rounds', 'lobby-starting-rolls', 'lobby-dice-mode', 'lobby-confirm-rolls'].forEach((id) => {
      el(id).disabled = !state.isHost;
    });

    el('lobby-confirm-rolls-row').classList.toggle('hidden', room.diceMode === 'virtual');
  }

  function renderPlayerList(room) {
    const ul = el('lobby-player-list');
    ul.innerHTML = '';
    room.players.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'player-row';
      li.dataset.id = p.id;
      const initial = escapeHtml((p.name.charAt(0) || '?').toUpperCase());
      li.innerHTML =
        (state.isHost ? DRAG_HANDLE_SVG : '') +
        `<span class="player-avatar" style="background:${avatarColor(p.id)}">${initial}</span>` +
        `<span class="player-name">${escapeHtml(p.name)}${p.isHost ? ' <span class="host-tag">Host</span>' : ''}</span>` +
        `<span class="conn-dot ${p.connected ? 'online' : 'offline'}"></span>`;
      ul.appendChild(li);
    });
  }

  function showToast(message, isError) {
    const toast = el('roll-toast');
    toast.textContent = message;
    toast.classList.toggle('error', !!isError);
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
  }

  function isInStartingPhase(room) {
    return room.rollCountThisRound < room.startingRolls;
  }

  // Turns one event into plain English, from `viewerId`'s point of view ("You" vs a name).
  // Shared by the personal action toast and the live event log so the wording matches.
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
        if (a.action === 'undoRoll') {
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
        return null;
      }
      case 'remove':
        return `🚪 ${event.payload.name} was removed from the game.`;
      default:
        return null;
    }
  }

  function describeName(room, playerId, viewerId) {
    if (playerId === viewerId) return 'you';
    const p = room.players.find((pl) => pl.id === playerId);
    return p ? p.name : 'that player';
  }

  function showEventToast(room) {
    const last = room.events[room.events.length - 1];
    if (!last) return;
    const msg = describeEvent(last, room, state.playerId);
    if (msg) showToast(msg, false);
  }

  function renderEventLog(room) {
    const ul = el('event-log');
    ul.innerHTML = '';
    const LOGGED_TYPES = new Set(['roll', 'bust', 'chickenOut', 'chickenOutRejected', 'roundEnd', 'remove', 'hostOverride']);
    const candidates = room.events.filter((e) => LOGGED_TYPES.has(e.type)).slice(-15).reverse();
    // describeEvent returns null for some matched types (e.g. the startGame hostOverride) -
    // the empty-state check has to run on what's actually renderable, not the raw type match,
    // or a room with only silent events shows a blank box instead of the empty-state message.
    const entries = candidates
      .map((event) => ({ event, msg: describeEvent(event, room, state.playerId) }))
      .filter((entry) => entry.msg);

    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'event-log-empty';
      li.textContent = 'Nothing yet — rolls and chicken-outs will show up here.';
      ul.appendChild(li);
      return;
    }

    entries.forEach(({ event, msg }) => {
      const li = document.createElement('li');
      li.className = 'event-log-item' + (event.type === 'chickenOutRejected' ? ' rejected' : '');
      li.dataset.eventId = event.id;
      const canReverse = state.isHost
        && (event.type === 'chickenOut' || event.type === 'chickenOutRejected')
        && !event.reversed;
      const armed = isArmed('reverse', event.id);
      li.innerHTML = `<span class="event-text">${escapeHtml(msg)}</span>`
        + (canReverse ? `<button type="button" class="btn-reverse${armed ? ' confirming' : ''}">${armed ? 'Confirm?' : '↩ Reverse'}</button>` : '');
      ul.appendChild(li);
    });
  }

  function hideTurnUi() {
    el('btn-chicken-out').classList.add('hidden');
    el('game-physical-panel').classList.add('hidden');
    el('game-virtual-panel').classList.add('hidden');
    el('host-controls').classList.add('hidden');
    el('btn-new-session').classList.add('hidden');
    el('btn-close-room').classList.add('hidden');
    el('new-session-waiting-msg').classList.add('hidden');
  }

  function showRemovedState() {
    el('game-pot').textContent = '0';
    el('game-round-info').textContent = '';
    el('game-phase-banner').classList.add('hidden');
    el('game-status-hint').textContent = '';
    const turnEl = el('game-turn-indicator');
    turnEl.textContent = '🚪 You were removed from this game.';
    turnEl.classList.remove('my-turn');
    hideTurnUi();
    el('game-scoreboard').innerHTML = '';
    el('event-log').innerHTML = '';
    clearSession();
  }

  function renderGame() {
    const room = state.room;
    const me = room.players.find((p) => p.id === state.playerId);
    if (!me) { showRemovedState(); return; }

    // Undo the finished-screen's one-way hides, in case this is a new session continuing
    // in the same page load rather than a fresh navigation.
    el('event-log-wrap').classList.remove('hidden');
    el('btn-new-session').classList.add('hidden');
    el('btn-close-room').classList.add('hidden');
    el('new-session-waiting-msg').classList.add('hidden');
    el('btn-chicken-out').classList.remove('hidden');
    el('host-controls').classList.toggle('hidden', !state.isHost);

    el('game-pot').textContent = room.pot;
    el('game-round-info').textContent = `Round ${room.currentRound} of ${room.roundsTotal} · Roll ${room.rollCountThisRound + 1}`;

    const inStartingPhase = isInStartingPhase(room);
    const banner = el('game-phase-banner');
    banner.classList.remove('hidden');
    banner.textContent = inStartingPhase
      ? '🛡️ Starting rolls — safe from a bust'
      : '🔥 Live — a 7 busts the round';
    banner.classList.toggle('phase-live', !inStartingPhase);

    const turnPlayerId = room.turnOrder[room.turnIndex];
    const turnPlayer = room.players.find((p) => p.id === turnPlayerId);
    // Pass-and-play has one shared device speaking for whoever's turn it currently is, so
    // there's no fixed "me" to gate controls on - the device is always the active turn's
    // controller, and per-player chicken-out buttons (in the scoreboard) cover the "anytime"
    // case instead of the single global button. Scoped to the host specifically (matching
    // the server) so a guest who joined a pass-and-play room by normal link still only ever
    // controls their own turn, not everyone's.
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

    // The single global button only makes sense when it's tied to one connected player;
    // pass-and-play instead gets a chicken-out button per active player in the scoreboard.
    el('btn-chicken-out').classList.toggle('hidden', passAndPlay);
    el('btn-chicken-out').disabled = !amActive;

    // The number grid (and the virtual roll button) always show for everyone in the room's
    // dice mode - only whether they're tappable changes with whose turn it is. Keeping the
    // panel itself constantly present (instead of swapping it in and out) is what stops the
    // screen from visibly resizing every time the turn passes to someone else.
    el('game-physical-panel').classList.toggle('hidden', room.diceMode !== 'physical');
    el('game-virtual-panel').classList.toggle('hidden', room.diceMode !== 'virtual');

    // Only reset an in-progress selection when a genuinely new turn starts for me - not on
    // every render, since other players' actions (e.g. someone chickening out) also trigger
    // a room:update while it's still my turn and shouldn't wipe what I've already tapped.
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

    renderScoreboard(room);
    renderEventLog(room);
    renderHostControls(room);
  }

  const RANK_EGGS = { 1: 'gold', 2: 'silver', 3: 'bronze' };
  function rankMedal(rank) {
    const egg = RANK_EGGS[rank];
    if (egg) return `<img class="rank-egg" src="/img/egg-${egg}.png" alt="">`;
    return `#${rank}`;
  }

  function renderGameFinished() {
    const room = state.room;
    // A future session could land on the same round/turnIndex this one ended on; clearing
    // this here guarantees the next renderGame() always treats it as a fresh turn instead
    // of maybe skipping the selection reset on a key collision.
    lastMyTurnKey = null;
    el('game-pot').textContent = '0';
    el('game-round-info').textContent = room.endedEarly
      ? `Game ended early — ${room.roundsTotal} rounds planned`
      : `Game complete — ${room.roundsTotal} rounds played`;
    el('game-phase-banner').classList.add('hidden');
    el('game-status-hint').textContent = '';

    const sorted = [...room.players].sort((a, b) => b.totalScore - a.totalScore);
    const topScore = sorted.length ? sorted[0].totalScore : 0;
    const winners = sorted.filter((p) => p.totalScore === topScore);

    const turnEl = el('game-turn-indicator');
    turnEl.textContent = winners.length > 1
      ? `🏆 It's a tie! ${winners.map((w) => w.name).join(' & ')} win with ${topScore}!`
      : `🏆 ${winners[0] ? winners[0].name : '?'} wins with ${topScore} points!`;
    turnEl.classList.remove('my-turn');

    hideTurnUi();
    el('event-log-wrap').classList.add('hidden');

    el('btn-new-session').classList.toggle('hidden', !state.isHost);
    el('btn-close-room').classList.toggle('hidden', !state.isHost);
    el('new-session-waiting-msg').classList.toggle('hidden', state.isHost);

    renderScoreboard(room);
  }

  function renderScoreboard(room) {
    const ul = el('game-scoreboard');
    ul.innerHTML = '';
    const isFinal = room.status === 'finished';
    const showChickenOutButtons = room.isPassAndPlay && state.isHost && room.status === 'active';
    const sorted = [...room.players].sort((a, b) => b.totalScore - a.totalScore);

    let rank = 0;
    let lastScore = null;
    sorted.forEach((p, idx) => {
      if (p.totalScore !== lastScore) { rank = idx + 1; lastScore = p.totalScore; }
      const li = document.createElement('li');
      li.className = 'player-row' + (isFinal && rank === 1 ? ' rank-1' : '');
      li.dataset.id = p.id;
      const initial = escapeHtml((p.name.charAt(0) || '?').toUpperCase());
      const isTurn = room.status === 'active' && room.turnOrder[room.turnIndex] === p.id;
      const rankBadge = isFinal ? `<span class="rank-badge">${rankMedal(rank)}</span>` : '';
      const chickenBtn = (showChickenOutButtons && p.activeThisRound)
        ? '<button type="button" class="btn-chicken-small">🐔 Out</button>'
        : '';
      li.innerHTML =
        rankBadge +
        `<span class="player-avatar" style="background:${avatarColor(p.id)}">${initial}</span>` +
        `<span class="player-name">${escapeHtml(p.name)}${p.isHost ? ' <span class="host-tag">Host</span>' : ''}${isTurn ? ' <span class="turn-tag">Turn</span>' : ''}</span>` +
        `<span class="score-value">${p.totalScore}</span>` +
        chickenBtn;
      ul.appendChild(li);
    });
  }

  function renderHostControls(room) {
    const wrap = el('host-controls');
    wrap.classList.toggle('hidden', !state.isHost);
    if (!state.isHost) return;

    const joinUrl = `${window.location.origin}/?room=${room.code}`;
    el('host-room-code').textContent = room.code;
    el('host-join-link').value = joinUrl;

    const lastEvent = room.events[room.events.length - 1];
    const canUndo = lastEvent && (lastEvent.type === 'roll'
      || (lastEvent.type === 'bust' && room.events[room.events.length - 2] && room.events[room.events.length - 2].type === 'roll'));
    el('btn-undo-roll').disabled = !canUndo;

    const ul = el('host-player-list');
    ul.innerHTML = '';
    room.players.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'player-row';
      li.dataset.id = p.id;
      const initial = escapeHtml((p.name.charAt(0) || '?').toUpperCase());
      const armed = isArmed('kick', p.id);
      li.innerHTML =
        `<span class="player-avatar" style="background:${avatarColor(p.id)}">${initial}</span>` +
        `<span class="player-name">${escapeHtml(p.name)}${p.isHost ? ' <span class="host-tag">Host</span>' : ''}</span>` +
        `<span class="score-value">${p.totalScore}</span>` +
        (p.isHost ? '' : `<button type="button" class="btn-kick${armed ? ' confirming' : ''}">${armed ? 'Confirm?' : 'Kick'}</button>`);
      ul.appendChild(li);
    });
  }

  function showError(id, message) {
    const errEl = el(id);
    errEl.textContent = message;
    errEl.classList.remove('hidden');
  }

  function clearError(id) {
    el(id).classList.add('hidden');
  }

  // Drag-to-reorder via Pointer Events (covers touch and mouse in one code path).
  function makeListDraggable(listEl, onReorder) {
    let dragEl = null;

    function getRows() {
      return Array.from(listEl.querySelectorAll('.player-row'));
    }

    function onPointerMove(e) {
      if (!dragEl) return;
      const rows = getRows().filter((r) => r !== dragEl);
      const y = e.clientY;
      let target = null;
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (y < mid) { target = row; break; }
      }
      if (target) listEl.insertBefore(dragEl, target);
      else listEl.appendChild(dragEl);
    }

    function onPointerUp() {
      if (!dragEl) return;
      dragEl.classList.remove('dragging');
      const finishedEl = dragEl;
      dragEl = null;
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      const order = getRows().map((r) => r.dataset.id);
      onReorder(order, finishedEl);
    }

    listEl.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.drag-handle');
      if (!handle) return;
      const row = handle.closest('.player-row');
      if (!row) return;
      dragEl = row;
      dragEl.classList.add('dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      e.preventDefault();
    });
  }

  // --- Wiring ---

  el('btn-how-to-play').addEventListener('click', () => el('how-to-play-modal').classList.remove('hidden'));
  function closeHowToPlay() { el('how-to-play-modal').classList.add('hidden'); }
  el('btn-close-how-to-play').addEventListener('click', closeHowToPlay);
  el('how-to-play-backdrop').addEventListener('click', closeHowToPlay);

  // Both "Host a Game" and "Pass & Play" land on the same setup form (same settings fields
  // apply to both) - this flag just tags which one so btn-create-room knows what to send,
  // and the copy on-screen reflects which mode was picked.
  let pendingPassAndPlay = false;

  el('btn-host').addEventListener('click', () => {
    pendingPassAndPlay = false;
    el('host-setup-title').textContent = 'Host a Game';
    el('pass-play-hint').classList.add('hidden');
    el('btn-create-room').textContent = '🎲 Create Room';
    showScreen('screen-host-setup');
  });
  el('btn-join').addEventListener('click', () => showScreen('screen-join'));
  el('btn-pass-play').addEventListener('click', () => {
    pendingPassAndPlay = true;
    el('host-setup-title').textContent = 'One Phone Play Setup';
    el('pass-play-hint').classList.remove('hidden');
    el('btn-create-room').textContent = '📱 Start One Phone Play';
    showScreen('screen-host-setup');
  });
  document.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => showScreen(btn.dataset.back));
  });

  el('btn-create-room').addEventListener('click', () => {
    clearError('host-setup-error');
    const name = el('host-name').value.trim();
    if (!name) return showError('host-setup-error', 'Enter your name.');

    socket.emit('host:createRoom', {
      hostName: name,
      rounds: el('host-rounds').value,
      startingRolls: el('host-starting-rolls').value,
      diceMode: el('host-dice-mode').value,
      confirmRolls: el('host-confirm-rolls').checked,
      passAndPlay: pendingPassAndPlay,
    }, (res) => {
      if (!res || !res.ok) return showError('host-setup-error', (res && res.error) || 'Could not create room.');
      applyJoinedState(res, true);
    });
  });

  function updateConfirmRollsVisibility() {
    el('host-confirm-rolls-row').classList.toggle('hidden', el('host-dice-mode').value === 'virtual');
  }
  el('host-dice-mode').addEventListener('change', updateConfirmRollsVisibility);
  updateConfirmRollsVisibility();

  el('btn-join-room').addEventListener('click', () => {
    clearError('join-error');
    const code = el('join-code').value.trim().toUpperCase();
    const name = el('join-name').value.trim();
    if (!code || !name) return showError('join-error', 'Enter the room code and your name.');

    socket.emit('player:joinRoom', { roomCode: code, name }, (res) => {
      if (!res || !res.ok) return showError('join-error', (res && res.error) || 'Could not join room.');
      applyJoinedState(res, false);
    });
  });

  el('btn-copy-link').addEventListener('click', () => {
    const input = el('lobby-join-link');
    input.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).catch(() => {});
    }
  });

  el('btn-start-game').addEventListener('click', () => {
    clearError('lobby-error');
    socket.emit('host:startGame', {}, (res) => {
      if (!res || !res.ok) showError('lobby-error', (res && res.error) || 'Could not start game.');
    });
  });

  el('lobby-settings-form').addEventListener('change', (e) => {
    if (!state.isHost) return;
    if (e.target.id === 'lobby-dice-mode') {
      el('lobby-confirm-rolls-row').classList.toggle('hidden', e.target.value === 'virtual');
    }
    socket.emit('host:updateSettings', {
      rounds: el('lobby-rounds').value,
      startingRolls: el('lobby-starting-rolls').value,
      diceMode: el('lobby-dice-mode').value,
      confirmRolls: el('lobby-confirm-rolls').checked,
    }, (res) => {
      if (!res || !res.ok) {
        showError('lobby-error', (res && res.error) || 'Could not update settings.');
        renderLobbySettingsForm(state.room);
      }
    });
  });

  function addLocalPlayerFromInput() {
    const input = el('lobby-new-player-name');
    const name = input.value.trim();
    clearError('lobby-add-player-error');
    if (!name) return showError('lobby-add-player-error', 'Enter a name.');

    socket.emit('host:addLocalPlayer', { name }, (res) => {
      if (!res || !res.ok) return showError('lobby-add-player-error', (res && res.error) || 'Could not add player.');
      input.value = '';
      input.focus();
    });
  }
  el('btn-add-local-player').addEventListener('click', addLocalPlayerFromInput);
  el('lobby-new-player-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addLocalPlayerFromInput(); }
  });

  makeListDraggable(el('lobby-player-list'), (order) => {
    if (!state.isHost) return;
    socket.emit('host:reorderTurnOrder', { order }, (res) => {
      if (!res || !res.ok) renderLobby(); // resync from last known state on rejection
    });
  });

  function submitPhysicalRoll(sum, isDouble) {
    document.querySelectorAll('.dice-btn').forEach((b) => { b.disabled = true; });
    socket.emit('player:submitRoll', { sum, isDouble }, (res) => {
      if (!res || !res.ok) {
        showToast((res && res.error) || 'Could not submit roll.', true);
        renderGame(); // resync the panel from last known state (turn hasn't moved)
        return;
      }
      showEventToast(res.room);
    });
  }

  el('dice-grid').addEventListener('click', (e) => {
    // ×2 is a complete roll on its own: no sum needed, tapping it submits immediately and
    // passes the turn, in both auto-submit and confirm-roll rooms - there's nothing else to
    // confirm, since past the starting rolls a double's value doesn't change what it does.
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

    if (state.room.confirmRolls) {
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

    socket.emit('player:submitRoll', {}, (res) => {
      const elapsed = Date.now() - startTime;
      const minDelay = Math.max(0, 500 - elapsed);
      setTimeout(() => {
        anim.classList.remove('rolling');
        btn.textContent = '🎲 Roll Dice';
        if (!res || !res.ok) {
          btn.disabled = false;
          showToast((res && res.error) || 'Could not roll.', true);
          return;
        }
        const lastRoll = [...res.room.events].reverse().find((e) => e.type === 'roll');
        if (lastRoll && lastRoll.payload.dice) {
          anim.textContent = lastRoll.payload.dice.map((d) => DIE_FACES[d - 1]).join(' ');
        }
        showEventToast(res.room);
      }, minDelay);
    });
  });

  el('btn-chicken-out').addEventListener('click', () => {
    const btn = el('btn-chicken-out');
    btn.disabled = true;
    socket.emit('player:chickenOut', { round: state.room.currentRound }, (res) => {
      if (!res || !res.ok) {
        btn.disabled = false;
        showToast((res && res.error) || 'Could not chicken out.', true);
        return;
      }
      showEventToast(res.room);
    });
  });

  // Pass-and-play only: chicken-out is available for any active player at any time, not
  // just whoever's turn it is, since there's no single "me" to tie the global button to -
  // each row gets its own button instead, naming its target explicitly.
  el('game-scoreboard').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-chicken-small');
    if (!btn) return;
    const row = btn.closest('.player-row');
    const targetPlayerId = row && row.dataset.id;
    if (!targetPlayerId) return;

    btn.disabled = true;
    socket.emit('player:chickenOut', { round: state.room.currentRound, targetPlayerId }, (res) => {
      if (!res || !res.ok) showToast((res && res.error) || 'Could not chicken out.', true);
      else showEventToast(res.room);
    });
  });

  el('btn-toggle-host-controls').addEventListener('click', () => {
    el('host-controls-panel').classList.toggle('hidden');
  });

  el('btn-toggle-event-log').addEventListener('click', () => {
    const nowHidden = el('event-log').classList.toggle('hidden');
    el('event-log-arrow').textContent = nowHidden ? '▾' : '▴';
  });

  el('btn-host-copy-link').addEventListener('click', () => {
    const input = el('host-join-link');
    input.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).catch(() => {});
    }
  });

  el('btn-undo-roll').addEventListener('click', () => {
    const btn = el('btn-undo-roll');
    btn.disabled = true;
    socket.emit('host:undoLastRoll', {}, (res) => {
      if (!res || !res.ok) {
        showToast((res && res.error) || 'Could not undo.', true);
        btn.disabled = false;
      }
    });
  });

  wireConfirmButton(el('btn-end-game'), '🏁 End Game', () => {
    el('btn-end-game').disabled = true;
    socket.emit('host:endGame', {}, (res) => {
      el('btn-end-game').disabled = false;
      if (!res || !res.ok) showToast((res && res.error) || 'Could not end the game.', true);
    });
  });

  wireConfirmButton(el('btn-close-room'), '🚪 Close Room', () => {
    el('btn-close-room').disabled = true;
    socket.emit('host:closeRoom', {}, (res) => {
      if (!res || !res.ok) {
        el('btn-close-room').disabled = false;
        showToast((res && res.error) || 'Could not close the room.', true);
      }
      // On success, the room:closed broadcast (which this client also receives) handles
      // the actual navigation back to the landing screen.
    });
  });

  // A destructive host action needs a safety net, but native confirm() dialogs render
  // inconsistently (or not at all) across mobile browsers and the TWA wrapper planned for
  // later - so instead the button arms itself on first tap ("Confirm?") and only fires on
  // a second tap within a few seconds. The armed state lives in `armedAction`, not on the
  // button itself, because host-player-list and event-log both get fully rebuilt on every
  // room:update (which fires constantly during live play) - a DOM-only flag would get
  // silently wiped before the second tap could land.
  el('host-player-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-kick');
    if (!btn) return;
    const row = btn.closest('.player-row');
    const targetPlayerId = row && row.dataset.id;
    if (!targetPlayerId) return;

    if (!isArmed('kick', targetPlayerId)) {
      arm('kick', targetPlayerId, () => renderHostControls(state.room));
      renderHostControls(state.room);
      return;
    }

    disarm();
    btn.disabled = true;
    socket.emit('host:kickPlayer', { targetPlayerId }, (res) => {
      if (!res || !res.ok) showToast((res && res.error) || 'Could not remove player.', true);
      renderHostControls(state.room);
    });
  });

  el('event-log').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-reverse');
    if (!btn) return;
    const li = btn.closest('.event-log-item');
    const eventId = li && li.dataset.eventId;
    if (!eventId) return;

    if (!isArmed('reverse', eventId)) {
      arm('reverse', eventId, () => renderEventLog(state.room));
      renderEventLog(state.room);
      return;
    }

    disarm();
    btn.disabled = true;
    socket.emit('host:reverseChickenOut', { eventId }, (res) => {
      if (!res || !res.ok) showToast((res && res.error) || 'Could not reverse that.', true);
      renderEventLog(state.room);
    });
  });

  el('btn-new-session').addEventListener('click', () => {
    const btn = el('btn-new-session');
    btn.disabled = true;
    socket.emit('host:startNewSession', {}, (res) => {
      if (!res || !res.ok) {
        showToast((res && res.error) || 'Could not start a new session.', true);
        btn.disabled = false;
      }
    });
  });

  socket.on('room:update', (room) => {
    if (!state.roomCode || room.code !== state.roomCode) return;
    state.room = room;
    renderFromRoom();
  });

  socket.on('room:closed', () => {
    clearSession();
    state.roomCode = null;
    state.playerId = null;
    state.isHost = false;
    state.room = null;
    showToast('The host closed the room.', false);
    showScreen('screen-landing');
  });

  socket.on('connect', () => {
    const session = loadSession();
    if (session && session.roomCode && session.playerId) {
      socket.emit('player:rejoin', { roomCode: session.roomCode, playerId: session.playerId }, (res) => {
        if (res && res.ok) {
          applyJoinedState(res, session.isHost);
        } else if (!hasHandledInitialConnect) {
          clearSession();
          maybePrefillFromUrl();
        }
        hasHandledInitialConnect = true;
      });
    } else {
      if (!hasHandledInitialConnect) maybePrefillFromUrl();
      hasHandledInitialConnect = true;
    }
  });

  window.__chicken = { socket, getState: () => state };
})();
