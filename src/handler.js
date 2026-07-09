const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { claudeChat } = require('./services/claudeApi');
const { getUser } = require('./users');
const { tryAcquire, release, REJECT_MESSAGE } = require('./ratelimit');
const { isTimedOut, timeout } = require('./moderation');
const { friendlyError } = require('./errors');
const { track, complete, getPending } = require('./inflight');
const { recall, remember, forget } = require('./usermemory');
const history = require('./history');

// Control token the LLM appends when it decides to time out an abusive user.
// Stripped from the visible reply; the ban is enforced deterministically here.
const TIMEOUT_TOKEN = /\[\[TIMEOUT:(\d{1,3})\]\]/;

// Control token the LLM includes per movie/series it presents, so the bot can
// send the real poster image alongside the text (Claude's output is text-only).
const POSTER_TOKEN = /\[\[POSTER:([^|\]]+)\|([^\]]+)\]\]/g;
const MAX_POSTERS = 4;

// Control token the LLM emits to persist a durable fact about the speaker
// (preference, habit, standing request). Saved keyed by the sender's phone —
// the model never picks whose memory it writes to. Stripped from the reply.
const MEMORY_TOKEN = /\[\[RECUERDA:([^\]]+)\]\]/g;

// The bot has no scheduler and no state between messages, but the model
// occasionally claims otherwise (incident 2026-07-06: "programé una revisión
// en ~20 min para ir encadenando"). The prompt now forbids this, but prompts
// are not reliable enforcement — catch it deterministically as a backstop
// and replace the whole reply with an honest one instead of shipping the lie.
const FALSE_PROMISE_RE = /program[eé]|agend[eé]|te aviso (en|cuando)|encaden|automáticamente (en|dentro)|revisión automática|cuando termine te (notif|aviso)/i;

// Natural-language-only router with least-privilege access. Groups only —
// DMs are ignored entirely (unreliable delivery, and a common source of
// confusion when someone means to address the group but taps the bot's
// contact instead):
//   - Admin surface (the "Debug" group): every message from the admin number
//     → Claude in 'full' mode.
//   - Other groups: only when the bot is @mentioned or quoted, and only from
//     registered users → Claude in 'restricted' mode (query + request media).
//   - Unknown numbers: ignored entirely (zero trust).

// Extract key identifiers from Claude's tool_use blocks so the history can
// carry them forward without re-searching. Keeps only the fields that help
// disambiguate follow-ups ("agrégala", "cancélalo", "dame info").
const TOOL_KEY_FIELDS = {
  library_search: ['tmdbId'],
  media_add: ['tmdbId'],
  media_file_info: ['tmdbId'],
  downloads_status: ['hash'],
  downloads_delete: ['hash'],
  downloads_control: ['hash', 'job_id'],
  optimization_run: ['job_id'],
  optimization_job: ['job_id'],
  optimization_cancel: ['job_id'],
};

function extractToolKeys(toolUses) {
  if (!toolUses || !toolUses.length) return null;
  const out = [];
  for (const tu of toolUses) {
    const rawName = tu.name || '';
    // Strip the mcp__mediaops__ prefix added by the CLI
    const name = rawName.replace(/^mcp__[^_]+__/, '');
    const fields = TOOL_KEY_FIELDS[name];
    if (!fields) continue;
    for (const field of fields) {
      const val = tu.input?.[field];
      if (val != null) out.push({ name, key: field, value: val });
    }
  }
  return out.length ? out : null;
}

const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '';
const ADMIN_GROUP_NAME = (process.env.ADMIN_GROUP_NAME || 'Debug').trim().toLowerCase();

const adminChatIds = new Set(
  (process.env.ADMIN_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
);
let botIds = new Set(); // bare numbers/lids identifying the bot itself

// Conversation continuity comes from src/history.js: a finite rolling window
// of the last exchanges per chat+user (no time limit — a follow-up 2 hours
// later still has context) injected into each run's prompt. There are no CLI
// --resume sessions anymore: every run is fresh + this window, so context
// tokens stay bounded.

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
      console.log(`[Handler] Grupo: "${meta.subject || '(sin nombre)'}" → ${jid} (${(meta.participants || []).length} miembros)`);
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

// When the user replies (quotes) a specific message, extract its text so the
// model knows exactly what "esto" refers to — even if it's older than the
// rolling history window.
function extractQuoted(msg) {
  const ctx =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo;
  const q = ctx?.quotedMessage;
  if (!q) return null;
  const text = (q.conversation || q.extendedTextMessage?.text || q.imageMessage?.caption || '').trim();
  if (!text) return null;
  const fromBot = Boolean(ctx.participant && botIds.has(bare(ctx.participant)));
  const author = fromBot
    ? 'del bot (tuyo)'
    : `de ${getUser(ctx.participant || '')?.displayName || 'otra persona'}`;
  return { text: text.slice(0, 400), author };
}

function buildContext({ user, isAdminSender, mode, chatJid, senderPhone }) {
  const name = user?.displayName || (isAdminSender ? 'Marco' : 'desconocido');
  const lines = [
    `Usuario: ${name}` +
      (user ? ` (jellyseerrId ${user.jellyseerrId})` : '') +
      (isAdminSender ? ' [ADMIN]' : '') +
      ` | chat: ${chatJid}`,
  ];
  if (Array.isArray(user?.notas) && user.notas.length) {
    lines.push(`Notas (usa con criterio, no fuerces): ${user.notas.slice(0, 5).join('; ')}`);
  }
  const memories = senderPhone ? recall(senderPhone) : [];
  if (memories.length) {
    lines.push(`Memoria de ${name} (de conversaciones pasadas): ${memories.join('; ')}`);
  }
  const recent = history.getHistory(`${chatJid}:${senderPhone}`);
  if (recent.length) {
    const convo = recent.map((h) => {
      const speaker = h.role === 'bot' ? 'Tú' : name;
      const toolTag = (h.tools && h.tools.length)
        ? ` [${h.tools.map((t) => `${t.name}→${t.key}=${t.value}`).join(', ')}]`
        : '';
      return `${speaker}${toolTag}: ${h.text}`;
    }).join('\n');
    lines.push(`[HISTORIAL con ${name}]:\n${convo}`);
  }
  lines.push(
    'Memoria: si aprendes un dato DURABLE del usuario (preferencia de audio/calidad, gustos, ' +
      'algo que pidió y quedó pendiente), agrega [[RECUERDA:dato breve]] al final de tu respuesta. ' +
      'Solo hechos que sirvan en futuras conversaciones, no eventos puntuales. No menciones el tag ' +
      'ni repitas lo que ya está en su memoria.'
  );
  if (mode === 'restricted') {
    lines.push(
      `Modo restringido. media_add siempre con jellyseerr_user_id=${user?.jellyseerrId ?? 'null'}. ` +
        'Series: solo 1 temporada (seasons=[N]), pregunta cuál. ' +
        'Las solicitudes se auto-aprueban al instante — nunca digas que algo "quedó pendiente de aprobación". ' +
        'Sin tools de admin — si piden reinicios, borrar archivos o cambiar config, dile que eso lo hace Marco.\n' +
        'Audio/calidad: SIEMPRE usa media_file_info antes de afirmar idioma o resolución — funciona ' +
        'para películas y series (auto-detecta). Series devuelve codecs/audio agregados de todos los episodios. ' +
        'Si eligen versión inferior, avisa que Marco debe desactivar monitoreo.\n' +
        `Borrar torrents (downloads_delete): siempre con jellyseerr_user_id=${user?.jellyseerrId ?? 'null'} — ` +
        'la tool solo borra lo pedido por esa persona; lo que venga en "refused" NO se borró, explica que eso solo lo quita Marco.\n' +
        'Vacile: 1) pide que pare 2) roast con datos personales 3) agrega [[TIMEOUT:15]] al final.'
    );
  }
  return lines.join('\n');
}

async function sendPosters(sock, replyJid, text) {
  const items = [...text.matchAll(POSTER_TOKEN)].slice(0, MAX_POSTERS);
  for (const [, url, title] of items) {
    try {
      const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
      await sock.sendMessage(replyJid, { image: Buffer.from(res.data), caption: title.trim() });
    } catch (err) {
      console.error(`[Handler] Error enviando póster (${title}):`, err.message);
    }
  }
}

const THINKING_REPLIES = ['🔍 Déjame checar...', '⏳ Un momento...', '🎬 Buscando...', '👀 Revisando...'];

async function runClaude(sock, msg, { text, historyText, replyJid, sessionKey, mode, context, senderPhone, isAdmin }) {
  track(msg, text, mode, senderPhone);
  try {
    await sock.sendPresenceUpdate('composing', replyJid);
    const thinking = THINKING_REPLIES[Math.floor(Math.random() * THINKING_REPLIES.length)];
    await sock.sendMessage(replyJid, { text: thinking });
    const { reply, toolUses } = await claudeChat(text, mode, context);

    // Moderation: the LLM appends [[TIMEOUT:N]] to ban a persistent abuser.
    // Enforce the ban here, strip the token from what the user sees. Admin immune.
    const match = reply.match(TIMEOUT_TOKEN);
    if (match && !isAdmin) {
      const mins = timeout(senderPhone, parseInt(match[1], 10));
      console.log(`[Mod] Timeout ${mins}min a ${senderPhone} (vacile persistente)`);
    }

    for (const [, note] of reply.matchAll(MEMORY_TOKEN)) {
      remember(senderPhone, note);
    }

    const withPosters = reply.replace(TIMEOUT_TOKEN, '').replace(MEMORY_TOKEN, '');
    let visible = withPosters.replace(POSTER_TOKEN, '').trim();

    if (FALSE_PROMISE_RE.test(visible)) {
      console.warn(`[NL] Bloqueada promesa falsa de scheduling de ${senderPhone}: "${visible.slice(0, 200)}"`);
      visible = 'Ya arranqué lo que pediste. No tengo forma de avisarte solo cuando termine — pregúntame en un rato y reviso el estado real.';
    }

    const out = visible.length > 59000 ? visible.slice(0, 59000) + '\n\n_[truncado]_' : visible;
    if (out) {
      const sent = await sock.sendMessage(replyJid, { text: out });
      console.log(`[NL] Respuesta enviada (id ${sent?.key?.id || '?'}) a ${replyJid}`);
    } else {
      console.warn('[NL] Respuesta vacía del CLI — no se envió nada');
    }
    history.record(sessionKey, 'user', historyText || text);
    history.record(sessionKey, 'bot', visible, extractToolKeys(toolUses));
    await sendPosters(sock, replyJid, withPosters);
  } catch (err) {
    console.error(
      '[NL] Error en run de Claude: code=%s message=%s stderr=%s',
      err.code, err.message, (err.stderr || '').slice(0, 500)
    );
    await sock.sendMessage(replyJid, { text: friendlyError(err) });
  } finally {
    complete(msg.key.id);
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

  // DMs are disabled entirely: unreliable delivery, and a common source of
  // confusion (someone taps the bot's contact meaning to address the group).
  // The admin's reliable channel is the Debug group.
  const isGroup = msg.key.remoteJid?.endsWith('@g.us');
  if (!isGroup) return;

  const text = extractText(msg).trim();
  if (!text) return;

  const senderJid = msg.key.participant || msg.key.remoteJid;
  const senderPhone = bare(senderJid);

  const user = getUser(senderJid, msg.key.senderPn);
  const isAdminSender = Boolean(ADMIN_NUMBER) && senderPhone === ADMIN_NUMBER;

  // Zero trust: unknown numbers are ignored entirely
  if (!user && !isAdminSender) return;

  const isAdminSurface = adminChatIds.has(msg.key.remoteJid);

  // The bot only reacts when addressed
  if (!isAdminSurface && !isBotMentioned(msg)) {
    if (text.startsWith('!')) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: 'ℹ️ Los comandos con *!* ya no existen — ahora háblame normal mencionándome (@) y dime qué necesitas. 🤖',
      });
    }
    return;
  }

  const replyJid = msg.key.remoteJid;
  const mode = isAdminSurface && isAdminSender ? 'full' : 'restricted';
  const sessionKey = `${msg.key.remoteJid}:${senderPhone}`;

  // Timed-out abusers are dropped silently (no reply, no Claude run). Admin immune.
  if (!isAdminSender && isTimedOut(senderPhone)) {
    console.log(`[Mod] Ignorado (en timeout): ${user?.displayName || senderPhone}`);
    return;
  }

  const lower = text.toLowerCase();
  if (lower === 'exit()' || lower === 'reset') {
    history.clear(sessionKey);
    await sock.sendMessage(replyJid, { text: '🔄 Conversación reiniciada.' });
    return;
  }

  if (lower === 'olvidame' || lower === 'olvídame') {
    const had = forget(senderPhone);
    history.clear(sessionKey);
    await sock.sendMessage(replyJid, {
      text: had ? '🧠 Listo, borré todo lo que recordaba de ti.' : '🤷 No tenía nada guardado de ti.',
    });
    return;
  }

  const cleanText = stripBotMention(text);
  if (!cleanText) return;

  // Intercept "no" responses before calling Claude — react with 👍 and save the API call.
  const NO_PATTERNS = /^(no|nel|nah|nop|nope|mejor no|después|despues|déjalo|dejalo|ya no|naa|simon que no|nel pastel|va que no|nel mergas|ntc|neta que no|pas)\.?$/i;
  if (NO_PATTERNS.test(cleanText.trim())) {
    try {
      await sock.sendMessage(replyJid, {
        react: { text: '👍', key: msg.key },
      });
      // The declined offer matters for the next run's context ("no" → don't re-offer)
      history.record(sessionKey, 'user', cleanText);
    } catch (err) {
      console.error('[Handler] Error reaccionando:', err.message);
    }
    return;
  }

  const gate = tryAcquire(senderPhone, { admin: mode === 'full', chatJid: replyJid });
  if (!gate.ok) {
    console.log(`[NL] Rechazado (${gate.reason}): ${user?.displayName || senderPhone}`);
    await sock.sendMessage(replyJid, { text: REJECT_MESSAGE[gate.reason] });
    return;
  }

  console.log(`[NL] ${user?.displayName || senderPhone} (${mode}) @ ${msg.key.remoteJid}: ${cleanText.slice(0, 80)}`);

  // Replying to a specific message pins the referent explicitly (beats any
  // ambiguity, and works even for messages older than the history window)
  const quoted = extractQuoted(msg);
  const promptText = quoted
    ? `[${user?.displayName || 'El usuario'} responde a este mensaje ${quoted.author}: "${quoted.text}"]\n${cleanText}`
    : cleanText;

  const context = buildContext({ user, isAdminSender, mode, chatJid: msg.key.remoteJid, senderPhone });
  try {
    await runClaude(sock, msg, {
      text: promptText, historyText: cleanText, replyJid, sessionKey, mode, context,
      senderPhone, isAdmin: isAdminSender,
    });
  } finally {
    release(senderPhone);
  }
}

async function retryPending(sock) {
  const pending = getPending();
  if (!pending.length) return;
  console.log(`[Handler] Reintentando ${pending.length} mensaje(s) interrumpido(s)...`);

  for (const entry of pending) {
    const user = getUser(entry.participant || entry.remoteJid);
    const isAdminSender = Boolean(ADMIN_NUMBER) && entry.senderPhone === ADMIN_NUMBER;
    const isAdminSurface = adminChatIds.has(entry.remoteJid);
    const mode = isAdminSurface && isAdminSender ? 'full' : entry.mode;
    const sessionKey = `${entry.remoteJid}:${entry.senderPhone}`;
    const context = buildContext({ user, isAdminSender, mode, chatJid: entry.remoteJid, senderPhone: entry.senderPhone });

    const fakeMsg = { key: { id: entry.msgId, remoteJid: entry.remoteJid, participant: entry.participant } };

    console.log(`[Handler] Retry: ${user?.displayName || entry.senderPhone} → "${entry.text.slice(0, 60)}"`);
    try {
      await runClaude(sock, fakeMsg, {
        text: entry.text,
        replyJid: entry.remoteJid,
        sessionKey,
        mode,
        context,
        senderPhone: entry.senderPhone,
        isAdmin: isAdminSender,
      });
    } catch (err) {
      console.error(`[Handler] Retry falló para ${entry.msgId}:`, err.message);
      complete(entry.msgId);
    }
  }
}

module.exports = { messageHandler, registerBotIdentity, resolveAdminGroup, retryPending };
