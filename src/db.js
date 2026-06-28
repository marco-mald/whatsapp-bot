const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'users.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function getUser(whatsappJid) {
  return load()[whatsappJid] || null;
}

function setUser(whatsappJid, jellyseerrId, displayName) {
  const data = load();
  data[whatsappJid] = { jellyseerrId, displayName };
  save(data);
}

function removeUser(whatsappJid) {
  const data = load();
  delete data[whatsappJid];
  save(data);
}

module.exports = { getUser, setUser, removeUser };
