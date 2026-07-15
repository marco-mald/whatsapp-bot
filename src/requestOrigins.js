const fs = require('fs');
const path = require('path');

// Maps a requested tmdbId -> the chat it was requested from, so the download
// lifecycle notifications (approved / available / failed) land back in that
// same group instead of the requester's fixed notifyChatId. This matters most
// for the admin, who is in several groups: without this, everything he asks
// for — no matter which group he asked in — notifies the Debug group.
const FILE = path.join(__dirname, '..', 'data', 'request-origins.json');
// A download can legitimately take a while (rare release, few seeds), but a
// tmdbId->chat mapping older than this is almost certainly a stale entry from
// a request whose notification already fired — drop it so the file stays small.
const TTL_MS = 21 * 24 * 60 * 60 * 1000; // 21 days

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(store) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

function remember(tmdbId, chatId) {
  if (!tmdbId || !chatId) return;
  const store = load();
  store[String(tmdbId)] = { chatId, ts: Date.now() };
  const now = Date.now();
  for (const k of Object.keys(store)) {
    if (now - (store[k].ts || 0) > TTL_MS) delete store[k];
  }
  save(store);
}

// Returns the chat a tmdbId was requested from, or null if unknown/expired.
function lookup(tmdbId) {
  if (!tmdbId) return null;
  const entry = load()[String(tmdbId)];
  if (!entry) return null;
  if (Date.now() - (entry.ts || 0) > TTL_MS) return null;
  return entry.chatId;
}

module.exports = { remember, lookup };
