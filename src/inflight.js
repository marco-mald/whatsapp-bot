const fs = require('fs');
const path = require('path');

// Tracks messages currently being processed so they can be replayed if the
// bot restarts mid-run. State lives in memory (_entries Map keyed by msgId)
// and is flushed to disk only on SIGTERM/SIGINT, not on every track/complete
// call — this eliminates the non-atomic load/modify/save that could cause
// duplicate or lost entries under concurrent runs (MAX_CONCURRENT_RUNS=4).
//
// A crash (SIGKILL, OOM) may skip the flush, leaving inflight.json stale from
// the previous clean shutdown. getPending() already guards against this by
// filtering entries older than MAX_AGE_MS (10 min), so stale entries are
// discarded harmlessly on the next startup.

const FILE = path.join(__dirname, '..', 'data', 'inflight.json');
const MAX_AGE_MS = 10 * 60 * 1000;

// In-memory state: msgId → entry object
const _entries = new Map();
let _initialized = false;

function _init() {
  if (_initialized) return;
  _initialized = true;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const now = Date.now();
    for (const e of raw) {
      if (e.msgId && now - e.timestamp < MAX_AGE_MS) {
        _entries.set(e.msgId, e);
      }
    }
  } catch { /* no file or parse error — start empty */ }
}

function _flush() {
  const dir = path.dirname(FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify([..._entries.values()], null, 2));
  } catch (err) {
    console.error('[Inflight] No pude guardar inflight.json:', err.message);
  }
}

// Flush to disk on clean shutdown so getPending() can replay on next startup.
process.once('SIGTERM', () => { _flush(); process.exit(0); });
process.once('SIGINT', () => { _flush(); process.exit(0); });

function track(msg, text, mode, senderPhone) {
  _init();
  _entries.set(msg.key.id, {
    msgId: msg.key.id,
    remoteJid: msg.key.remoteJid,
    participant: msg.key.participant || null,
    senderPhone,
    text,
    mode,
    timestamp: Date.now(),
  });
}

function complete(msgId) {
  _init();
  _entries.delete(msgId);
}

function getPending() {
  _init();
  const now = Date.now();
  const pending = [];
  for (const [id, e] of _entries) {
    if (now - e.timestamp >= MAX_AGE_MS) {
      _entries.delete(id); // prune expired entries
    } else {
      pending.push(e);
    }
  }
  return pending;
}

module.exports = { track, complete, getPending };
