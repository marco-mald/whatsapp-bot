// User map: WhatsApp phone number → Jellyseerr account.
// Real data lives in data/users.local.json (gitignored — this repo is public):
//   { "521XXXXXXXXXX": { "jellyseerrId": 1, "displayName": "Name" }, ... }
// Key format: country code + number, no '+', no spaces (as it appears in a
// WhatsApp JID). Mexico example: +52 333 123 4567 → "5213331234567".

const path = require('path');

let USERS = {};
try {
  USERS = require(path.join(__dirname, '..', 'data', 'users.local.json'));
} catch {
  console.warn('[Users] data/users.local.json no encontrado — !buscar no funcionará para nadie');
}

// Looks up a user by their WhatsApp JID.
// Handles both regular JIDs (@s.whatsapp.net) and LID JIDs (@lid, newer WhatsApp).
function getUser(senderJid, senderPn) {
  // For LID senders, senderPn carries the real phone number JID
  const phoneJid = senderPn || (!senderJid.endsWith('@lid') ? senderJid : null);
  if (phoneJid) {
    const phone = phoneJid.split('@')[0];
    if (USERS[phone]) return USERS[phone];
  }
  return null;
}

module.exports = { getUser };
