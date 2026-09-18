// Bootstrap: by the time this runs, core.js and every js/modes/*.js file has already
// registered itself into window.BarnBetsModes - this just starts the app.
(function () {
  window.BarnBets.init();
  window.__barnbets = { socket: window.BarnBets.socket, getState: () => window.BarnBets.state };
})();
