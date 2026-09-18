const chickenout = require('./chickenOut');
const pigout = require('./pigout');
const quackquack = require('./quackQuack');
const horserace = require('./horseRace');

const modes = { chickenout, pigout, quackquack, horserace };

function getMode(key) {
  return modes[key] || null;
}

module.exports = { modes, getMode };
