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

async function deliver({ text, imageUrl }) {
  const chatId = process.env.TARGET_CHAT_ID;
  const sock = sockRef?.current;
  if (!chatId || !sock) throw new Error('sin socket activo o TARGET_CHAT_ID');

  if (imageUrl) {
    try {
      const res = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
      await sock.sendMessage(chatId, { image: Buffer.from(res.data), caption: text });
      return;
    } catch {
      // fall back to plain text
    }
  }
  await sock.sendMessage(chatId, { text });
}

// Main entry point: sends now, or queues during quiet hours.
async function notify(text, { imageUrl } = {}) {
  if (inQuietHours()) {
    const queue = loadQueue();
    queue.push({ text, ts: Date.now() });
    saveQueue(queue);
    console.log(`[Notify] Horario de no molestar — encolado (${queue.length} pendientes)`);
    return 'queued';
  }
  await deliver({ text, imageUrl });
  console.log(`[Notify] Enviado: ${text.split('\n')[0].slice(0, 70)}`);
  return 'sent';
}

async function flushQueue() {
  if (inQuietHours() || !sockRef?.current) return;
  const queue = loadQueue();
  if (!queue.length) return;

  saveQueue([]);
  const items = queue
    .map((i) => `• ${i.text.replace(/\s*\n+\s*/g, ' — ').slice(0, 220)}`)
    .join('\n');
  const text = `🌙 *Mientras dormías* (${queue.length} aviso${queue.length !== 1 ? 's' : ''}):\n\n${items}`;

  try {
    await deliver({ text });
    console.log(`[Notify] Digest matutino enviado (${queue.length} avisos)`);
  } catch (err) {
    saveQueue(queue); // re-queue, retry on next tick
    console.error('[Notify] Error enviando digest, reintentará:', err.message);
  }
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

module.exports = { setupNotifications, notify, inQuietHours };
