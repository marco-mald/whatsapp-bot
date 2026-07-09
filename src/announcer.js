const fs = require('fs');
const path = require('path');

const CHANGELOG_PATH = path.join(__dirname, '..', 'CHANGELOG.json');
const ANNOUNCED_PATH = path.join(__dirname, '..', 'data', 'announced-version.json');

function loadAnnounced() {
  try {
    return JSON.parse(fs.readFileSync(ANNOUNCED_PATH, 'utf8'));
  } catch {
    return { version: null };
  }
}

function saveAnnounced(version) {
  fs.mkdirSync(path.dirname(ANNOUNCED_PATH), { recursive: true });
  fs.writeFileSync(ANNOUNCED_PATH, JSON.stringify({ version }, null, 2));
}

// Called once on the first connection.open. Sends the announcement from
// CHANGELOG.json to all target groups if it hasn't been sent yet for this
// version. Announcement is only sent once — persisted in data/announced-version.json.
async function maybeAnnounce(sock) {
  let changelog;
  try {
    changelog = JSON.parse(fs.readFileSync(CHANGELOG_PATH, 'utf8'));
  } catch (err) {
    console.warn('[Announcer] No se pudo leer CHANGELOG.json:', err.message);
    return;
  }

  const { version, announcement } = changelog;
  if (!version || !announcement) return;

  const announced = loadAnnounced();
  if (announced.version === version) return;

  const { targetChatIds } = require('./notifications');
  const chatIds = targetChatIds();
  if (!chatIds.length) {
    console.warn('[Announcer] Sin TARGET_CHAT_ID — anuncio omitido');
    return;
  }

  for (const chatId of chatIds) {
    try {
      await sock.sendMessage(chatId, { text: announcement });
    } catch (err) {
      console.error(`[Announcer] Error enviando anuncio a ${chatId}:`, err.message);
    }
  }

  saveAnnounced(version);
  console.log(`[Announcer] Anuncio v${version} enviado a ${chatIds.length} grupo(s)`);
}

module.exports = { maybeAnnounce };
