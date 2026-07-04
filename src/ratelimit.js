// Least-annoying rate limiting for the NL bot. Three layers:
//   1. Single-flight per user  — one active Claude run at a time. A normal user
//      never notices; a spammer physically can't fire in parallel.
//   2. Global concurrency cap  — protects host CPU / Jellyfin streaming.
//   3. Soft daily cap per user — generous backstop against runaway spend.
// The admin is exempt from the global and daily caps (never rate-limit yourself),
// but keeps single-flight to avoid accidental double-runs.

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_RUNS || 4);
const DAILY_LIMIT = Number(process.env.DAILY_MSG_LIMIT || 40);
const GROUP_DAILY_LIMIT = Number(process.env.GROUP_DAILY_LIMIT || 100);

let globalActive = 0;
const activeUsers = new Set(); // phones with a run in flight
const daily = new Map(); // phone → { date, count }
const groupDaily = new Map(); // chatJid → { date, count }

function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TIMEZONE || 'America/Mexico_City',
  }).format(new Date());
}

// Returns { ok:true } or { ok:false, reason:'busy_user'|'busy_global'|'daily'|'daily_group' }.
// Call release(phone) in a finally when the run ends.
function tryAcquire(phone, { admin = false, chatJid = null } = {}) {
  if (activeUsers.has(phone)) return { ok: false, reason: 'busy_user' };
  if (!admin && globalActive >= MAX_CONCURRENT) return { ok: false, reason: 'busy_global' };

  if (!admin) {
    const d = daily.get(phone);
    if (d && d.date === today() && d.count >= DAILY_LIMIT) return { ok: false, reason: 'daily' };

    if (chatJid) {
      const g = groupDaily.get(chatJid);
      if (g && g.date === today() && g.count >= GROUP_DAILY_LIMIT) return { ok: false, reason: 'daily_group' };
    }
  }

  activeUsers.add(phone);
  globalActive++;

  const d = daily.get(phone);
  if (!d || d.date !== today()) daily.set(phone, { date: today(), count: 1 });
  else d.count++;

  if (chatJid) {
    const g = groupDaily.get(chatJid);
    if (!g || g.date !== today()) groupDaily.set(chatJid, { date: today(), count: 1 });
    else g.count++;
  }

  return { ok: true };
}

function release(phone) {
  activeUsers.delete(phone);
  globalActive = Math.max(0, globalActive - 1);
}

const REJECT_MESSAGE = {
  busy_user: '⏳ Espérame tantito, sigo con tu mensaje anterior 🙂',
  busy_global: '⏳ Estoy atendiendo a alguien más, dame un momentito e insiste.',
  daily: 'Ya hiciste bastantes consultas hoy 😅 seguimos mañana. (Si es urgente, dile a Marco.)',
  daily_group: '⏳ Este grupo ya hizo muchas consultas hoy. Seguimos mañana 🙂',
};

module.exports = { tryAcquire, release, REJECT_MESSAGE };
