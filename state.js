const fs = require('fs');
const path = require('path');
const STATE_FILE = path.join(__dirname, 'state.json');

let _state = {};

if (fs.existsSync(STATE_FILE)) {
  try {
    _state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    console.log('📂 State loaded');
  } catch {
    _state = {};
  }
}

const PERSIST_KEYS = [
  'channelsCreated', 'seenTransactions', 'rosterSnapshot',
  'nflWeek', 'rosterChannelMap', 'contentPosted'
];

function save() {
  const out = {};
  PERSIST_KEYS.forEach(k => {
    if (_state[k] !== undefined) out[k] = _state[k];
  });
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(out, null, 2));
  } catch (e) {
    console.log('Could not save state:', e.message);
  }
}

module.exports = {
  get: (key) => _state[key],
  set: (key, value) => {
    _state[key] = value;
    save();
  }
};
