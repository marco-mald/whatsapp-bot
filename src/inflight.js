const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'inflight.json');
const MAX_AGE_MS = 10 * 60 * 1000;

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function save(entries) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(entries, null, 2));
}

function track(msg, text, mode, senderPhone) {
  const entries = load();
  entries.push({
    msgId: msg.key.id,
    remoteJid: msg.key.remoteJid,
    participant: msg.key.participant || null,
    senderPhone,
    text,
    mode,
    timestamp: Date.now(),
  });
  save(entries);
}

function complete(msgId) {
  const entries = load().filter((e) => e.msgId !== msgId);
  save(entries);
}

function getPending() {
  const now = Date.now();
  const entries = load().filter((e) => now - e.timestamp < MAX_AGE_MS);
  save(entries);
  return entries;
}

module.exports = { track, complete, getPending };
