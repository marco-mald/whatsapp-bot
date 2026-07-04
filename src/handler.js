const { claudeChat } = require('./services/claudeApi');
const { getUser } = require('./users');
const { tryAcquire, release, REJECT_MESSAGE } = require('./ratelimit');
const { isTimedOut, timeout } = require('./moderation');

// Control token the LLM appends when it decides to time out an abusive user.
// Stripped from the visible reply; the ban is enforced deterministically here.
const TIMEOUT_TOKEN = /\[\[TIMEOUT:(\d{1,3})\]\]/;

// Natural-language-only router with least-privilege access:
//   - Admin surfaces (Marco's DM + the "Debug" group): every message → Claude
//     in 'full' mode.
//   - Other groups: only when the bot is @mentioned or quoted, and only from
//     registered users → Claude in 'restricted' mode (query + request media).
//   - DMs from registered non-admin users → 'restricted'.
//   - Unknown numbers: ignored entirely (zero trust).

const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '';
const ADMIN_GROUP_NAME = (process.env.ADMIN_GROUP_NAME || 'Debug').trim().toLowerCase();
const SESSION_TTL_MS = 20 * 60 * 1000;

const adminChatIds = new Set(
  (process.env.ADMIN_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
);
let botIds = new Set(); // bare numbers/lids identifying the bot itself

// chatJid:senderPhone → { sessionId, lastUsed }
const sessions = new Map();

function bare(jid) {
  return (jid || '').split(':')[0].split('@')[0];
}

// Called from bot.js on every (re)connect
function registerBotIdentity(sock) {
  botIds = new Set([sock.user?.id, sock.user?.lid].filter(Boolean).map(bare));
}

// Called from bot.js on connect: find the admin group by name
async function resolveAdminGroup(sock) {
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const [jid, meta] of Object.entries(groups)) {
      if ((meta.subject || '').trim().toLowerCase() === ADMIN_GROUP_NAME) {
        adminChatIds.add(jid);
        console.log(`[Handler] Grupo admin "${meta.subject}": ${jid}`);
      }
    }
    if (!adminChatIds.size) {
      console.warn(`[Handler] No encontré ningún grupo llamado "${ADMIN_GROUP_NAME}"`);
    }
  } catch (err) {
    console.error('[Handler] Error resolviendo grupo admin:', err.message);
  }
}

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    ''
  );
}

function isBotMentioned(msg) {
  const ctx =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo;
  if (!ctx) return false;
  if ((ctx.mentionedJid || []).some((j) => botIds.has(bare(j)))) return true;
  // replying to one of the bot's messages also counts as addressing it
  return Boolean(ctx.participant && botIds.has(bare(ctx.participant)));
}

function stripBotMention(text) {
  let out = text;
  for (const id of botIds) out = out.replaceAll(`@${id}`, '');
  return out.replace(/\s+/g, ' ').trim();
}

// In DMs, look up the canonical JID via onWhatsApp so we send to the right address
async function resolveReplyJid(sock, remoteJid) {
  if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@lid')) return remoteJid;
  try {
    const [result] = await sock.onWhatsApp(remoteJid.split('@')[0]);
    if (result?.jid) return result.jid;
  } catch {}
  return remoteJid;
}

function getSession(key) {
  const s = sessions.get(key);
  if (!s || Date.now() - s.lastUsed > SESSION_TTL_MS) return null;
  return s;
}

function buildContext({ user, isAdminSender, isGroup, mode, chatJid }) {
  const name = user?.displayName || (isAdminSender ? 'Marco' : 'desconocido');
  const lines = [
    `Hablas con: ${name}` +
      (user ? ` (jellyseerrId ${user.jellyseerrId})` : '') +
      (isAdminSender ? ' — es el administrador' : '') +
      `, por ${isGroup ? 'grupo' : 'mensaje directo'}.`,
    `ID de este chat (por si te lo preguntan): ${chatJid}`,
  ];
  if (Array.isArray(user?.notas) && user.notas.length) {
    const notas = user.notas.slice(0, 5).join('; ');
    lines.push(
      `Datos personales de esta persona (para dar calidez o bromear con naturalidad SOLO cuando ` +
        `venga al tema — nunca los enumeres, nunca los fuerces, úsalos con criterio): ${notas}.`
    );
  }
  if (mode === 'restricted') {
    lines.push(
      'Permisos de este usuario: consultar estado, pedir contenido y agregar subtítulos. ' +
        `Cuando pida una película/serie usa media_add con jellyseerr_user_id=${user?.jellyseerrId ?? 'null'} ` +
        'para que quede a su nombre. Si pide subtítulos de algo, usa subtitles_search. ' +
        'La biblioteca prefiere audio en español (latino) cuando existe; si solo hay en inglés, ' +
        'avísale y ofrécele agregar subtítulos en español. No tienes herramientas de administración ' +
        'aquí; si pide cambios al servidor, reinicios o borrar algo, dile amablemente que eso solo lo hace Marco. ' +
        'Si te pide una recomendación o "qué hay bueno" sin nombrar título, SÍ puedes recomendar: usa ' +
        'library_trending, elige 1-3 que se vean interesantes y ofrécele agregarlas — nunca le digas ' +
        'que no puedes recomendar.'
    );
    lines.push(
      'Tu propósito es el servidor de medios, NO platicar ni que te usen de juguete. ' +
        'Si esta persona te vacila, te insulta, juega contigo o te escribe cosas random que no ' +
        'tienen que ver con pelis/series/descargas/subtítulos, escala así:\n' +
        '1) La primera vez: pídele con buena onda que le pare y que te use para lo del servidor.\n' +
        '2) Si insiste: clávale una tirada con humor pesado de bro mexicano usando sus datos ' +
        'personales (estilo albur familiar, sin groserías fuertes de más).\n' +
        '3) Si AÚN así sigue insistiendo: además de tu respuesta, agrega al final EXACTAMENTE el ' +
        'texto [[TIMEOUT:15]] (esto lo callará 15 minutos). No expliques el token, solo agrégalo. ' +
        'Úsalo SOLO para quien claramente está vacilando y no para — jamás en una consulta legítima de medios.'
    );
  }
  return lines.join('\n');
}

async function runClaude(sock, msg, { text, replyJid, sessionKey, mode, context, senderPhone, isAdmin }) {
  const session = getSession(sessionKey);
  try {
    await sock.sendPresenceUpdate('composing', replyJid);
    const { reply, sessionId } = await claudeChat(text, session?.sessionId, mode, context);
    sessions.set(sessionKey, { sessionId, lastUsed: Date.now() });

    // Moderation: the LLM appends [[TIMEOUT:N]] to ban a persistent abuser.
    // Enforce the ban here, strip the token from what the user sees. Admin immune.
    const match = reply.match(TIMEOUT_TOKEN);
    if (match && !isAdmin) {
      const mins = timeout(senderPhone, parseInt(match[1], 10));
      console.log(`[Mod] Timeout ${mins}min a ${senderPhone} (vacile persistente)`);
    }
    const visible = reply.replace(TIMEOUT_TOKEN, '').trim();

    const out = visible.length > 59000 ? visible.slice(0, 59000) + '\n\n_[truncado]_' : visible;
    if (out) await sock.sendMessage(replyJid, { text: out });
  } catch (err) {
    console.error('[NL] Error en run de Claude:', err.message);
    await sock.sendMessage(replyJid, { text: `❌ Algo falló procesando tu mensaje: ${err.message}` });
  } finally {
    await sock.sendPresenceUpdate('paused', replyJid).catch(() => {});
  }
}

async function messageHandler(sock, msg) {
  if (msg.key.remoteJid === 'status@broadcast') return;

  // LID JIDs (@lid) can't receive replies — use the phone JID instead
  if (msg.key.remoteJid?.endsWith('@lid') && msg.key.senderPn) {
    msg.key.remoteJid = msg.key.senderPn;
  }
  if (msg.key.participant?.endsWith('@lid') && msg.key.participantPn) {
    msg.key.participant = msg.key.participantPn;
  }

  if (!msg.message) return;

  const text = extractText(msg).trim();
  if (!text) return;

  const isGroup = msg.key.remoteJid?.endsWith('@g.us');
  const senderJid = msg.key.participant || msg.key.remoteJid;
  const senderPhone = bare(senderJid);

  const user = getUser(senderJid, msg.key.senderPn);
  const isAdminSender = Boolean(ADMIN_NUMBER) && senderPhone === ADMIN_NUMBER;

  // Zero trust: unknown numbers are ignored entirely
  if (!user && !isAdminSender) return;

  const isAdminSurface = adminChatIds.has(msg.key.remoteJid) || (!isGroup && isAdminSender);

  // In normal groups the bot only reacts when addressed
  if (isGroup && !isAdminSurface && !isBotMentioned(msg)) {
    if (text.startsWith('!')) {
      const replyJid = msg.key.remoteJid;
      await sock.sendMessage(replyJid, {
        text: 'ℹ️ Los comandos con *!* ya no existen — ahora háblame normal mencionándome (@) y dime qué necesitas. 🤖',
      });
    }
    return;
  }

  const replyJid = isGroup ? msg.key.remoteJid : await resolveReplyJid(sock, msg.key.remoteJid);
  const mode = isAdminSurface && isAdminSender ? 'full' : 'restricted';
  const sessionKey = `${msg.key.remoteJid}:${senderPhone}`;

  // Timed-out abusers are dropped silently (no reply, no Claude run). Admin immune.
  if (!isAdminSender && isTimedOut(senderPhone)) {
    console.log(`[Mod] Ignorado (en timeout): ${user?.displayName || senderPhone}`);
    return;
  }

  const lower = text.toLowerCase();
  if (lower === 'exit()' || lower === 'reset') {
    sessions.delete(sessionKey);
    await sock.sendMessage(replyJid, { text: '🔄 Conversación reiniciada.' });
    return;
  }

  const cleanText = isGroup ? stripBotMention(text) : text;
  if (!cleanText) return;

  const gate = tryAcquire(senderPhone, { admin: mode === 'full' });
  if (!gate.ok) {
    console.log(`[NL] Rechazado (${gate.reason}): ${user?.displayName || senderPhone}`);
    await sock.sendMessage(replyJid, { text: REJECT_MESSAGE[gate.reason] });
    return;
  }

  console.log(`[NL] ${user?.displayName || senderPhone} (${mode}) @ ${msg.key.remoteJid}: ${cleanText.slice(0, 80)}`);

  const context = buildContext({ user, isAdminSender, isGroup, mode, chatJid: msg.key.remoteJid });
  try {
    await runClaude(sock, msg, {
      text: cleanText, replyJid, sessionKey, mode, context,
      senderPhone, isAdmin: isAdminSender,
    });
  } finally {
    release(senderPhone);
  }
}

module.exports = { messageHandler, registerBotIdentity, resolveAdminGroup };
