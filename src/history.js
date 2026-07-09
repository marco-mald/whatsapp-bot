const fs = require('fs');
const path = require('path');

// Finite rolling conversation history per user+chat, persisted to disk.
// Replaces the old time-boxed CLI sessions: a follow-up works the same after
// 2 minutes or 2 hours, but the window is hard-capped so it never grows into
// an infinite log and never drags the whole past into every prompt.
//   { "<chatJid>:<phone>": [{ "role": "user"|"bot", "text": "...", "ts": 0 }] }
//
// State is kept in _store (a Map in memory) so concurrent runs don't clobber
// each other via non-atomic load/modify/save on disk. Disk is written async
// after every mutation — a crash can lose the last entry but never corrupts
// the file (writeFile is atomic at the OS level on Linux).

const FILE = path.join(__dirname, '..', 'data', 'chat-history.json');
const MAX_MESSAGES = 6; // 3 exchanges: enough for "descarga los subtítulos", small enough to not haunt unrelated commands
const MAX_LEN = 400; // chars kept per message

// In-memory store: loaded once at require time, written async after each change.
let _store;

function _load() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8'))));
  } catch {
    return new Map();
  }
}

function _getStore() {
  if (!_store) _store = _load();
  return _store;
}

function _persist() {
  const store = _getStore();
  const dir = path.dirname(FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFile(FILE, JSON.stringify(Object.fromEntries(store), null, 1), (err) => {
    if (err) console.error('[History] No pude guardar chat-history.json:', err.message);
  });
}

// tools: optional array of { name, key, value } extracted from tool_use blocks,
// e.g. [{ name: "library_search", key: "tmdbId", value: 157336 }]. Rendered
// inline in HISTORIAL so the model doesn't need to re-search for known IDs.
function record(key, role, text, tools) {
  const clean = (text || '').trim();
  if (!clean) return;
  const store = _getStore();
  const list = store.get(key) || [];
  const entry = { role, text: clean.slice(0, MAX_LEN), ts: Date.now() };
  if (tools && tools.length) entry.tools = tools;
  list.push(entry);
  store.set(key, list.slice(-MAX_MESSAGES)); // rolling window, overwrites oldest
  _persist();
}

function getHistory(key) {
  return _getStore().get(key) || [];
}

function clear(key) {
  const store = _getStore();
  if (!store.has(key)) return false;
  store.delete(key);
  _persist();
  return true;
}

module.exports = { record, getHistory, clear, MAX_MESSAGES };
