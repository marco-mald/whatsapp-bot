// Per-user persistent memory: durable facts the LLM learns in conversation
// (preferences, habits, standing requests) so a new session doesn't start
// from zero. The LLM emits [[RECUERDA:...]] control tokens; the handler saves
// them here keyed by the speaker's phone — the model never chooses whose
// memory it writes to.
//   { "5213331234567": [{ "date": "2026-07-05", "note": "..." }, ...], ... }

const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '..', 'data', 'user-memory.json');
const MAX_NOTES_PER_USER = 20;
const MAX_NOTE_LENGTH = 200;

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function persist(store) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 1));
  } catch (err) {
    console.error('[UserMemory] No pude guardar user-memory.json:', err.message);
  }
}

function recall(phone) {
  const notes = load()[phone];
  return Array.isArray(notes) ? notes.map((n) => n.note) : [];
}

function remember(phone, note) {
  const clean = note.trim().slice(0, MAX_NOTE_LENGTH);
  if (!clean) return;
  const store = load();
  const notes = Array.isArray(store[phone]) ? store[phone] : [];
  // Skip near-duplicates so repeated conversations don't fill the cap
  if (notes.some((n) => n.note.toLowerCase() === clean.toLowerCase())) return;
  notes.push({ date: new Date().toISOString().slice(0, 10), note: clean });
  store[phone] = notes.slice(-MAX_NOTES_PER_USER);
  persist(store);
  console.log(`[UserMemory] ${phone}: "${clean.slice(0, 80)}"`);
}

function forget(phone) {
  const store = load();
  if (!store[phone]) return false;
  delete store[phone];
  persist(store);
  return true;
}

module.exports = { recall, remember, forget };
