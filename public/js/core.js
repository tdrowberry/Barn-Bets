// Shared infrastructure reused by every game mode's client module: socket wiring, screen
// navigation, session storage, the hub/mode-picker, generic lobby/host-controls/event-log/
// scoreboard rendering, and small reusable UI widgets (the physical-dice-slot picker).
// Each mode registers itself into window.BarnBetsModes (see js/modes/*.js) before app.js
// boots the app.
window.BarnBetsModes = {};

window.BarnBets = (function () {
  const socket = io();

  const state = {
    roomCode: null,
    playerId: null,
    isHost: false,
    room: null,
    selectedMode: null, // gameMode key chosen on the hub, before a room exists
  };

  let hasHandledInitialConnect = false;

  const screens = [
    'screen-hub', 'screen-mode-landing', 'screen-host-setup', 'screen-join', 'screen-lobby', 'screen-game',
  ];
  const HERO_BG_SCREENS = new Set(['screen-hub', 'screen-mode-landing', 'screen-host-setup', 'screen-join']);

  const GAME_MODE_ORDER = ['chickenout', 'pigout', 'quackquack', 'horserace'];

  function currentMode() {
    return window.BarnBetsModes[state.selectedMode] || null;
  }

  function modeFor(room) {
    return window.BarnBetsModes[room.gameMode] || null;
  }

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

  let toastTimer = null;

  // Host action lists (players, event log) are rebuilt wholesale on every room:update, which
  // fires constantly during live play - a "confirm?" arm state stored only on the DOM node
  // would get silently wiped mid-confirm by an unrelated broadcast. Tracking it here instead
  // means every render can re-apply it to the right row.
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
    // Being back on the hub means no game is chosen yet - without this, How to Play would
    // keep showing whichever mode was last played instead of the game-picker overview.
    if (id === 'screen-hub') state.selectedMode = null;
    updateHeaderChrome(id);
  }

  // The header's logo icon and the pre-game hero background are only ever art for a
  // specific mode (so far, only Chicken Out has any) - shown while that mode is selected,
  // hidden/plain everywhere else until each mode gets its own art.
  function updateHeaderChrome(screenId) {
    const mode = currentMode();

    el('app-tagline').textContent = mode ? mode.name : 'Pick a game, place your bets';

    const logo = el('app-logo-icon');
    if (mode && mode.logoImage) {
      logo.src = mode.logoImage;
      logo.classList.remove('hidden');
    } else {
      logo.classList.add('hidden');
    }

    const heroImage = mode && mode.heroBackground;
    document.body.style.setProperty('--hero-bg-image', heroImage ? `url('${heroImage}')` : 'none');
    document.body.classList.toggle('bg-hero', HERO_BG_SCREENS.has(screenId) && !!heroImage);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showToast(message, isError) {
    const toast = el('roll-toast');
    toast.textContent = message;
    toast.classList.toggle('error', !!isError);
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
  }

  function showError(id, message) {
    const errEl = el(id);
    errEl.textContent = message;
    errEl.classList.remove('hidden');
  }

  function clearError(id) {
    el(id).classList.add('hidden');
  }

  // --- Session storage (rejoin after a reload/dropped connection) ---

  function saveSession(roomCode, playerId, isHost) {
    try {
      sessionStorage.setItem('barnbets.session', JSON.stringify({ roomCode, playerId, isHost }));
    } catch (e) { /* storage unavailable, non-fatal */ }
  }

  function loadSession() {
    try {
      return JSON.parse(sessionStorage.getItem('barnbets.session'));
    } catch (e) {
      return null;
    }
  }

  function clearSession() {
    try { sessionStorage.removeItem('barnbets.session'); } catch (e) { /* ignore */ }
  }

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

  function prefillJoin(code) {
    el('join-code').value = code.toUpperCase();
    showScreen('screen-join');
  }

  function maybePrefillFromUrl() {
    const roomFromUrl = new URLSearchParams(location.search).get('room');
    if (roomFromUrl) prefillJoin(roomFromUrl);
  }

  // --- Hub / mode picker ---

  function renderHub() {
    const grid = el('hub-game-grid');
    grid.innerHTML = '';
    GAME_MODE_ORDER.forEach((key) => {
      const mode = window.BarnBetsModes[key];
      if (!mode) return;
      const card = document.createElement('div');
      card.className = 'game-card';
      card.dataset.mode = key;
      const iconHtml = mode.logoImage
        ? `<img class="game-card-icon-img" src="${mode.logoImage}" alt="">`
        : `<span class="game-card-icon">${mode.icon}</span>`;
      card.innerHTML = iconHtml
        + `<span class="game-card-name">${escapeHtml(mode.name)}</span>`
        + `<span class="game-card-tagline">${escapeHtml(mode.tagline)}</span>`;
      card.addEventListener('click', () => selectMode(key));
      grid.appendChild(card);
    });
  }

  function selectMode(key) {
    state.selectedMode = key;
    const mode = window.BarnBetsModes[key];
    if (!mode) return;
    el('mode-landing-title').textContent = mode.name;
    el('mode-landing-tagline').textContent = mode.tagline;
    showScreen('screen-mode-landing');
  }

  // --- How to play modal (hub overview, or the selected mode's rules) ---

  const HUB_OVERVIEW = [
    '<strong>Chicken Out</strong> — push your luck on a shared pot with the whole table.',
    '<strong>Pigout</strong> — your own running score, bust on your own turn only.',
    '<strong>Quack Quack</strong> — six dice, a scoring puzzle, and hot dice streaks.',
    '<strong>Horse Race</strong> — three rolls to build Ship, Captain, Crew, then cargo.',
    'Pick a game from the list, then Host, Join, or play One Phone.',
  ];

  function renderHowToPlay() {
    const mode = currentMode();
    el('how-to-play-title').textContent = mode ? `${mode.icon} How to Play` : '🎲 How to Play';
    const items = mode ? mode.howToPlay : HUB_OVERVIEW;
    const ul = el('how-to-play-list');
    ul.innerHTML = items.map((line) => `<li>${line}</li>`).join('');
  }

  // --- Config field helpers shared by host-setup and lobby-settings forms ---

  function readConfigFields(prefix, mode) {
    const out = {};
    mode.configFields.forEach((field) => {
      const fieldEl = el(`${prefix}-${mode.key}-${field}`);
      if (!fieldEl) return;
      out[field] = fieldEl.type === 'checkbox' ? fieldEl.checked : fieldEl.value;
    });
    return out;
  }

  function populateConfigFields(prefix, mode, config, disabled) {
    mode.configFields.forEach((field) => {
      const fieldEl = el(`${prefix}-${mode.key}-${field}`);
      if (!fieldEl || !(field in config)) return;
      if (fieldEl.type === 'checkbox') fieldEl.checked = !!config[field];
      else fieldEl.value = config[field];
      fieldEl.disabled = !!disabled;
    });
    if (mode.refreshVisibility) mode.refreshVisibility(prefix);
  }

  // --- Host setup screen ---

  let pendingPassAndPlay = false;

  function showSetupFieldsFor(mode) {
    GAME_MODE_ORDER.forEach((key) => {
      const m = window.BarnBetsModes[key];
      if (m) el(m.setupFieldsId).classList.toggle('hidden', key !== mode.key);
    });
    if (mode.refreshVisibility) mode.refreshVisibility('setup');
  }

  function openHostSetup(passAndPlay) {
    pendingPassAndPlay = passAndPlay;
    const mode = currentMode();
    el('host-setup-title').textContent = passAndPlay ? 'One Phone Play Setup' : `Host ${mode.name}`;
    el('pass-play-hint').classList.toggle('hidden', !passAndPlay);
    el('btn-create-room').textContent = passAndPlay ? '📱 Start One Phone Play' : '🎲 Create Room';
    showSetupFieldsFor(mode);
    showScreen('screen-host-setup');
  }

  function updateConfirmRollsVisibility() {
    el('host-confirm-rolls-row').classList.toggle('hidden', el('host-dice-mode').value === 'virtual');
  }

  // --- Lobby ---

  function renderLobby() {
    const room = state.room;
    const mode = modeFor(room);
    el('lobby-room-code').textContent = room.code;
    el('lobby-title').textContent = `${mode.icon} ${mode.name} Lobby`;

    el('lobby-join-section').classList.toggle('hidden', !!room.isPassAndPlay);
    el('lobby-add-player-row').classList.toggle('hidden', !(room.isPassAndPlay && state.isHost));

    const joinUrl = `${window.location.origin}/?room=${room.code}`;
    el('lobby-join-link').value = joinUrl;

    const qrEl = el('lobby-qr');
    qrEl.innerHTML = '';
    if (window.QRCode) {
      new QRCode(qrEl, { text: joinUrl, width: 180, height: 180 });
    }

    renderLobbySettingsForm(room, mode);
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

  function renderLobbySettingsForm(room, mode) {
    GAME_MODE_ORDER.forEach((key) => {
      const m = window.BarnBetsModes[key];
      if (m) el(m.lobbyFieldsId).classList.toggle('hidden', key !== mode.key);
    });
    populateConfigFields('lobby', mode, room.config, !state.isHost);

    el('lobby-dice-mode').value = room.diceMode;
    el('lobby-confirm-rolls').checked = room.confirmRolls;
    ['lobby-dice-mode', 'lobby-confirm-rolls'].forEach((id) => { el(id).disabled = !state.isHost; });
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

  // --- Generic scoreboard (mode supplies which field/label to show) ---

  const RANK_EGGS = { 1: 'gold', 2: 'silver', 3: 'bronze' };
  function rankMedal(rank) {
    const egg = RANK_EGGS[rank];
    if (egg) return `<img class="rank-egg" src="/img/egg-${egg}.png" alt="">`;
    return `#${rank}`;
  }

  function renderScoreboard(room) {
    const mode = modeFor(room);
    const ul = el('game-scoreboard');
    ul.innerHTML = '';
    const isFinal = room.status === 'finished';
    const getValue = (p) => mode.scoreboard.getValue(p, room);
    const sorted = [...room.players].sort((a, b) => getValue(b) - getValue(a));

    let rank = 0;
    let lastScore = null;
    sorted.forEach((p, idx) => {
      const value = getValue(p);
      if (value !== lastScore) { rank = idx + 1; lastScore = value; }
      const li = document.createElement('li');
      li.className = 'player-row' + (isFinal && rank === 1 ? ' rank-1' : '');
      li.dataset.id = p.id;
      const initial = escapeHtml((p.name.charAt(0) || '?').toUpperCase());
      const isTurn = room.status === 'active' && room.turnOrder[room.turnIndex] === p.id;
      const rankBadge = isFinal ? `<span class="rank-badge">${rankMedal(rank)}</span>` : '';
      const extra = mode.extraRowContent ? (mode.extraRowContent(p, room, state) || '') : '';
      li.innerHTML =
        rankBadge +
        `<span class="player-avatar" style="background:${avatarColor(p.id)}">${initial}</span>` +
        `<span class="player-name">${escapeHtml(p.name)}${p.isHost ? ' <span class="host-tag">Host</span>' : ''}${isTurn ? ' <span class="turn-tag">Turn</span>' : ''}</span>` +
        `<span class="score-value">${value}</span>` +
        extra;
      ul.appendChild(li);
    });
  }

  // --- Generic event log ---

  function renderEventLog(room) {
    const mode = modeFor(room);
    const ul = el('event-log');
    ul.innerHTML = '';
    const candidates = room.events.slice(-15).reverse();
    const entries = candidates
      .map((event) => ({ event, msg: mode.describeEvent(event, room, state.playerId) }))
      .filter((entry) => entry.msg);

    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'event-log-empty';
      li.textContent = 'Nothing yet — actions will show up here.';
      ul.appendChild(li);
      return;
    }

    entries.forEach(({ event, msg }) => {
      const li = document.createElement('li');
      li.className = 'event-log-item' + (event.type === 'chickenOutRejected' ? ' rejected' : '');
      li.dataset.eventId = event.id;
      const canReverse = state.isHost && mode.canReverseEvent && mode.canReverseEvent(event);
      const armed = isArmed('reverse', event.id);
      const reverseLabel = armed ? 'Confirm?' : (event.reversed ? '↺ Redo' : '↩ Undo');
      li.innerHTML = `<span class="event-text">${escapeHtml(msg)}</span>`
        + (canReverse ? `<button type="button" class="btn-reverse${armed ? ' confirming' : ''}">${reverseLabel}</button>` : '');
      ul.appendChild(li);
    });
  }

  // Event types every mode can produce (a player joining/leaving, a generic host undo) get
  // one shared phrasing here, so each mode's own describeEvent only has to handle the event
  // types unique to its own rules.
  function describeCommonEvent(event, room, viewerId) {
    switch (event.type) {
      case 'join':
        return event.payload.host ? null : `👋 ${event.payload.name} joined${event.payload.late ? ' (sitting out this round)' : ''}.`;
      case 'remove':
        return `🚪 ${event.payload.name} was removed from the game.`;
      case 'hostOverride':
        if (event.payload.action === 'undoRoll' && !('sum' in event.payload)) {
          const targetId = event.payload.targetPlayerId;
          const target = room.players.find((p) => p.id === targetId);
          const targetName = targetId === viewerId ? 'your' : (target ? `${target.name}'s` : 'their');
          return `↩️ Host undid ${targetName} last action.`;
        }
        return null;
      default:
        return null;
    }
  }

  function showEventToast(room) {
    const mode = modeFor(room);
    const last = room.events[room.events.length - 1];
    if (!last) return;
    const msg = mode.describeEvent(last, room, state.playerId);
    if (msg) showToast(msg, false);
  }

  // --- Host controls (generic across every mode) ---

  function renderHostControls(room) {
    const wrap = el('host-controls');
    wrap.classList.toggle('hidden', !state.isHost);
    if (!state.isHost) return;

    const joinUrl = `${window.location.origin}/?room=${room.code}`;
    el('host-room-code').textContent = room.code;
    el('host-join-link').value = joinUrl;
    el('btn-undo-roll').disabled = room.events.length === 0;

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
        (p.isHost ? '' : `<button type="button" class="btn-kick${armed ? ' confirming' : ''}">${armed ? 'Confirm?' : 'Kick'}</button>`);
      ul.appendChild(li);
    });
  }

  function renderReverseUi() {
    renderEventLog(state.room);
    renderScoreboard(state.room);
  }

  function handleReverseClick(eventId) {
    if (!eventId) return;
    if (!isArmed('reverse', eventId)) {
      arm('reverse', eventId, renderReverseUi);
      renderReverseUi();
      return;
    }
    disarm();
    socket.emit('host:reverseChickenOut', { eventId }, (res) => {
      if (!res || !res.ok) showToast((res && res.error) || 'Could not reverse that.', true);
      renderReverseUi();
    });
  }

  // --- Finished screen ---

  function renderGameFinished() {
    const room = state.room;
    const mode = modeFor(room);
    el('game-phase-banner').classList.add('hidden');
    el('game-status-hint').textContent = '';
    el('game-round-info').textContent = room.endedEarly ? 'Game ended early' : 'Game complete';

    GAME_MODE_ORDER.forEach((key) => {
      const m = window.BarnBetsModes[key];
      if (m) el(m.playId).classList.add('hidden');
    });

    const getValue = (p) => mode.scoreboard.getValue(p, room);
    const sorted = [...room.players].sort((a, b) => getValue(b) - getValue(a));
    const topScore = sorted.length ? getValue(sorted[0]) : 0;
    const winners = sorted.filter((p) => getValue(p) === topScore);

    const turnEl = el('game-turn-indicator');
    turnEl.textContent = winners.length > 1
      ? `🏆 It's a tie! ${winners.map((w) => w.name).join(' & ')} win with ${topScore}!`
      : `🏆 ${winners[0] ? winners[0].name : '?'} wins with ${topScore}!`;
    turnEl.classList.remove('my-turn');

    el('btn-new-session').classList.toggle('hidden', !state.isHost);
    el('btn-close-room').classList.toggle('hidden', !state.isHost);
    el('new-session-waiting-msg').classList.toggle('hidden', state.isHost);
    el('event-log-wrap').classList.add('hidden');
    el('host-controls').classList.toggle('hidden', !state.isHost);

    renderScoreboard(room);
  }

  // --- Top-level render dispatch ---

  function applyJoinedState(res, isHost) {
    state.roomCode = res.roomCode;
    state.playerId = res.playerId;
    state.isHost = isHost;
    state.room = res.room;
    state.selectedMode = res.room.gameMode;
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

  function renderGame() {
    const room = state.room;
    const mode = modeFor(room);
    const me = room.players.find((p) => p.id === state.playerId);
    if (!me) { showRemovedState(); return; }

    el('event-log-wrap').classList.remove('hidden');
    el('btn-new-session').classList.add('hidden');
    el('btn-close-room').classList.add('hidden');
    el('new-session-waiting-msg').classList.add('hidden');
    el('host-controls').classList.toggle('hidden', !state.isHost);

    GAME_MODE_ORDER.forEach((key) => {
      const m = window.BarnBetsModes[key];
      if (m) el(m.playId).classList.toggle('hidden', key !== mode.key);
    });

    mode.renderGame(room, state);

    renderScoreboard(room);
    renderEventLog(room);
    renderHostControls(room);
  }

  function showRemovedState() {
    el('game-round-info').textContent = '';
    el('game-phase-banner').classList.add('hidden');
    el('game-status-hint').textContent = '';
    const turnEl = el('game-turn-indicator');
    turnEl.textContent = '🚪 You were removed from this game.';
    turnEl.classList.remove('my-turn');
    GAME_MODE_ORDER.forEach((key) => {
      const m = window.BarnBetsModes[key];
      if (m) el(m.playId).classList.add('hidden');
    });
    el('host-controls').classList.add('hidden');
    el('btn-new-session').classList.add('hidden');
    el('btn-close-room').classList.add('hidden');
    el('new-session-waiting-msg').classList.add('hidden');
    el('game-scoreboard').innerHTML = '';
    el('event-log').innerHTML = '';
    clearSession();
  }

  // --- Small reusable widget: N-slot tap-to-cycle (1-6) physical dice entry ---

  function createDiceSlotPicker(containerEl, count) {
    const values = new Array(count).fill(1);
    containerEl.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dice-slot-btn';
      btn.textContent = '1';
      btn.addEventListener('click', () => {
        values[i] = (values[i] % 6) + 1;
        btn.textContent = String(values[i]);
      });
      containerEl.appendChild(btn);
    }
    return { getValues: () => values.slice() };
  }

  // --- Wiring: hub, mode-landing, host-setup, join ---

  function wireCore() {
    el('btn-how-to-play').addEventListener('click', () => {
      renderHowToPlay();
      el('how-to-play-modal').classList.remove('hidden');
    });
    function closeHowToPlay() { el('how-to-play-modal').classList.add('hidden'); }
    el('btn-close-how-to-play').addEventListener('click', closeHowToPlay);
    el('how-to-play-backdrop').addEventListener('click', closeHowToPlay);

    document.querySelectorAll('[data-back]').forEach((btn) => {
      btn.addEventListener('click', () => showScreen(btn.dataset.back));
    });

    el('btn-mode-host').addEventListener('click', () => openHostSetup(false));
    el('btn-mode-pass-play').addEventListener('click', () => openHostSetup(true));
    el('btn-mode-join').addEventListener('click', () => showScreen('screen-join'));

    el('host-dice-mode').addEventListener('change', updateConfirmRollsVisibility);

    el('btn-create-room').addEventListener('click', () => {
      clearError('host-setup-error');
      const name = el('host-name').value.trim();
      if (!name) return showError('host-setup-error', 'Enter your name.');
      const mode = currentMode();
      if (!mode) return showError('host-setup-error', 'Pick a game first.');

      const rawConfig = readConfigFields('setup', mode);
      socket.emit('host:createRoom', {
        hostName: name,
        gameMode: mode.key,
        diceMode: el('host-dice-mode').value,
        confirmRolls: el('host-confirm-rolls').checked,
        passAndPlay: pendingPassAndPlay,
        ...rawConfig,
      }, (res) => {
        if (!res || !res.ok) return showError('host-setup-error', (res && res.error) || 'Could not create room.');
        applyJoinedState(res, true);
      });
    });

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

    el('btn-host-copy-link').addEventListener('click', () => {
      const input = el('host-join-link');
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
      const mode = modeFor(state.room);
      if (e.target.id === 'lobby-dice-mode') {
        el('lobby-confirm-rolls-row').classList.toggle('hidden', e.target.value === 'virtual');
      }
      if (mode.refreshVisibility) mode.refreshVisibility('lobby');

      const rawConfig = readConfigFields('lobby', mode);
      socket.emit('host:updateSettings', {
        diceMode: el('lobby-dice-mode').value,
        confirmRolls: el('lobby-confirm-rolls').checked,
        ...rawConfig,
      }, (res) => {
        if (!res || !res.ok) {
          showError('lobby-error', (res && res.error) || 'Could not update settings.');
          renderLobbySettingsForm(state.room, mode);
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
        if (!res || !res.ok) renderLobby();
      });
    });

    el('btn-toggle-host-controls').addEventListener('click', () => {
      el('host-controls-panel').classList.toggle('hidden');
    });

    el('btn-toggle-event-log').addEventListener('click', () => {
      const nowHidden = el('event-log').classList.toggle('hidden');
      el('event-log-arrow').textContent = nowHidden ? '▾' : '▴';
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
      });
    });

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
      handleReverseClick(li && li.dataset.eventId);
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
      state.selectedMode = room.gameMode;
      renderFromRoom();
    });

    socket.on('room:closed', () => {
      clearSession();
      state.roomCode = null;
      state.playerId = null;
      state.isHost = false;
      state.room = null;
      showToast('The host closed the room.', false);
      showScreen('screen-hub');
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
  }

  function init() {
    renderHub();
    wireCore();
    updateConfirmRollsVisibility();
    Object.values(window.BarnBetsModes).forEach((mode) => {
      if (mode.wireSetup) mode.wireSetup();
      if (mode.wireLobby) mode.wireLobby();
      if (mode.wireGame) mode.wireGame();
    });
    showScreen('screen-hub');
    maybeShowSplash();
  }

  // Re-renders just the scoreboard/event-log/host-controls chrome from the last known room
  // state, without a server round-trip - used after a purely-local UI change like arming a
  // confirm button, where no room:update broadcast is coming to trigger a re-render.
  function refreshGameChrome() {
    if (!state.room || state.room.status === 'lobby') return;
    renderScoreboard(state.room);
    renderEventLog(state.room);
    renderHostControls(state.room);
  }

  return {
    socket,
    state,
    el,
    showScreen,
    escapeHtml,
    showToast,
    showEventToast,
    describeCommonEvent,
    showError,
    clearError,
    avatarColor,
    isArmed,
    arm,
    disarm,
    wireConfirmButton,
    createDiceSlotPicker,
    refreshGameChrome,
    init,
  };
})();
