const fs = require('fs');
const path = require('path');
const axios = require('axios');

// All notifications go to the group (TARGET_CHAT_ID). DMs are not used: they
// currently fail (status PENDING) — the group is the only reliable channel.
//
// Quiet hours: messages during the window (default 22:00–08:00, QUIET_HOURS
// in .env, "off" to disable) are queued on disk and delivered as a single
// morning digest instead of waking people up.

const QUEUE_PATH = path.join(__dirname, '..', 'data', 'notify-queue.json');
const DEFAULT_QUIET = { start: 22 * 60, end: 8 * 60 };

let sockRef = null;

function timezone() {
  return process.env.TIMEZONE || 'America/Mexico_City';
}

function quietConfig() {
  const raw = (process.env.QUIET_HOURS || '22:00-08:00').trim().toLowerCase();
  if (raw === 'off') return null;
  const m = raw.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) {
    console.warn(`[Notify] QUIET_HOURS inválido ("${raw}"), usando 22:00-08:00`);
    return DEFAULT_QUIET;
  }
  return { start: +m[1] * 60 + +m[2], end: +m[3] * 60 + +m[4] };
}

function minutesNow() {
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone(), hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Generic "HH:MM-HH:MM" window check (handles spanning midnight). Returns
// false for "off" or unparseable values.
function inTimeWindow(raw) {
  const m = (raw || '').trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const start = +m[1] * 60 + +m[2];
  const end = +m[3] * 60 + +m[4];
  const now = minutesNow();
  if (start <= end) return now >= start && now < end;
  return now >= start || now < end;
}

function inQuietHours() {
  const q = quietConfig();
  if (!q) return false;
  const now = minutesNow();
  if (q.start <= q.end) return now >= q.start && now < q.end;
  return now >= q.start || now < q.end; // window spans midnight
}

function loadQueue() {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveQueue(queue) {
  fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 1));
}

// TARGET_CHAT_ID accepts a comma-separated list of group JIDs
function targetChatIds() {
  return (process.env.TARGET_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// The Debug group: technical/admin-only notifications land here, and it is
// the fallback destination when a requester can't be mapped to a group.
function adminChatId() {
  return (process.env.ADMIN_CHAT_ID || '').trim() || targetChatIds()[0];
}

async function deliver({ text, imageUrl, chatIds, mentions }) {
  const targets = chatIds?.length ? chatIds : targetChatIds();
  const sock = sockRef?.current;
  if (!targets.length || !sock) throw new Error('sin socket activo o destino');

  let image = null;
  if (imageUrl) {
    try {
      const res = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
      image = Buffer.from(res.data);
    } catch {
      // fall back to plain text
    }
  }

  const extra = mentions?.length ? { mentions } : {};
  let delivered = 0;
  for (const chatId of targets) {
    try {
      await sock.sendMessage(chatId, image ? { image, caption: text, ...extra } : { text, ...extra });
      delivered++;
    } catch (err) {
      console.error(`[Notify] Error enviando a ${chatId}:`, err.message);
    }
  }
  if (!delivered) throw new Error('no se pudo entregar a ningún chat');
}

// Main entry point: sends now, or queues during quiet hours.
// opts.chatIds routes to specific groups (default: all TARGET_CHAT_ID);
// opts.mentions is a list of JIDs to @-mention (text must contain @<number>).
async function notify(text, { imageUrl, chatIds, mentions } = {}) {
  if (inQuietHours()) {
    const queue = loadQueue();
    queue.push({ text, ts: Date.now(), chatIds: chatIds || null, mentions: mentions || null });
    saveQueue(queue);
    console.log(`[Notify] Horario de no molestar — encolado (${queue.length} pendientes)`);
    return 'queued';
  }
  await deliver({ text, imageUrl, chatIds, mentions });
  console.log(`[Notify] Enviado: ${text.split('\n')[0].slice(0, 70)}`);
  return 'sent';
}

async function flushQueue() {
  if (inQuietHours() || !sockRef?.current) return;
  const queue = loadQueue();
  if (!queue.length) return;

  saveQueue([]);

  // Queued items can have different destinations — build one digest per chat.
  const byChat = new Map();
  for (const item of queue) {
    const targets = item.chatIds?.length ? item.chatIds : targetChatIds();
    for (const chatId of targets) {
      if (!byChat.has(chatId)) byChat.set(chatId, { items: [], mentions: new Set() });
      const entry = byChat.get(chatId);
      entry.items.push(`• ${item.text.replace(/\s*\n+\s*/g, ' — ').slice(0, 220)}`);
      for (const m of item.mentions || []) entry.mentions.add(m);
    }
  }

  const failed = [];
  for (const [chatId, { items, mentions }] of byChat) {
    const text = `🌙 *Mientras dormías* (${items.length} aviso${items.length !== 1 ? 's' : ''}):\n\n${items.join('\n')}`;
    try {
      await deliver({ text, chatIds: [chatId], mentions: [...mentions] });
    } catch (err) {
      console.error(`[Notify] Error enviando digest a ${chatId}, reintentará:`, err.message);
      failed.push(...queue.filter((i) => (i.chatIds?.length ? i.chatIds : targetChatIds()).includes(chatId)));
    }
  }
  if (failed.length) saveQueue([...loadQueue(), ...failed]); // retry on next tick
  else console.log(`[Notify] Digest matutino enviado (${queue.length} avisos)`);
}

function setupNotifications(ref) {
  sockRef = ref;
  setInterval(() => flushQueue().catch((e) => console.error('[Notify]', e.message)), 60 * 1000);
  const q = quietConfig();
  const fmt = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  console.log(
    q
      ? `[Notify] No molestar: ${fmt(q.start)}–${fmt(q.end)} (${timezone()})`
      : '[Notify] Horario de no molestar desactivado'
  );
}

module.exports = { setupNotifications, notify, inQuietHours, inTimeWindow, targetChatIds, adminChatId };
