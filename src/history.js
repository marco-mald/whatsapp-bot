const fs = require('fs');
const path = require('path');

// Finite rolling conversation history per user+chat, persisted to disk.
// Replaces the old time-boxed CLI sessions: a follow-up works the same after
// 2 minutes or 2 hours, but the window is hard-capped so it never grows into
// an infinite log and never drags the whole past into every prompt.
//   { "<chatJid>:<phone>": [{ "role": "user"|"bot", "text": "...", "ts": 0 }] }

const FILE = path.join(__dirname, '..', 'data', 'chat-history.json');
const MAX_MESSAGES = 6; // 3 exchanges: enough for "descarga los subtítulos", small enough to not haunt unrelated commands
const MAX_LEN = 400; // chars kept per message

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function persist(store) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store, null, 1));
  } catch (err) {
    console.error('[History] No pude guardar chat-history.json:', err.message);
  }
}

function record(key, role, text) {
  const clean = (text || '').trim();
  if (!clean) return;
  const store = load();
  const list = store[key] || [];
  list.push({ role, text: clean.slice(0, MAX_LEN), ts: Date.now() });
  store[key] = list.slice(-MAX_MESSAGES); // rolling window, overwrites oldest
  persist(store);
}

function getHistory(key) {
  return load()[key] || [];
}

function clear(key) {
  const store = load();
  if (!store[key]) return false;
  delete store[key];
  persist(store);
  return true;
}

module.exports = { record, getHistory, clear, MAX_MESSAGES };
