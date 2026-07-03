const { handleBuscar, handleSelection } = require('./commands/buscar');
const { handleDescargas } = require('./commands/descargas');
const { handleSalud, handleReiniciar } = require('./commands/stackhealth');
const { hasSession, handleClaudeStart, handleClaudeMessage, handleClaudeExit } = require('./commands/claudechat');

const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '';

function isAdmin(jid) {
  return Boolean(ADMIN_NUMBER) && jid?.startsWith(ADMIN_NUMBER);
}

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    ''
  );
}

// In DMs, look up the canonical JID via onWhatsApp so we send to the right address
// (some users have migrated to LID-based JIDs and @s.whatsapp.net no longer routes)
async function resolveReplyJid(sock, remoteJid) {
  if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@lid')) return remoteJid;

  try {
    const number = remoteJid.split('@')[0];
    const [result] = await sock.onWhatsApp(number);
    if (result?.jid) {
      if (result.jid !== remoteJid) {
        console.log(`[Handler] JID resolved: ${remoteJid} → ${result.jid}`);
      }
      return result.jid;
    }
  } catch {
    // fall through to original JID
  }

  return remoteJid;
}

async function messageHandler(sock, msg) {
  if (msg.key.remoteJid === 'status@broadcast') return;

  // LID JIDs (@lid) can't receive replies — use the phone JID instead
  if (msg.key.remoteJid?.endsWith('@lid') && msg.key.senderPn) {
    msg.key.remoteJid = msg.key.senderPn;
  }

  // In groups, the sender's participant JID can also come as @lid — normalize
  // it too, since isAdmin() and account linking key off the phone number
  if (msg.key.participant?.endsWith('@lid') && msg.key.participantPn) {
    msg.key.participant = msg.key.participantPn;
  }

  if (!msg.message) return;

  const text = extractText(msg).trim();
  if (!text) return;

  const lower = text.toLowerCase();

  // For DMs, resolve the canonical reply JID before any sendMessage call
  const isGroup = msg.key.remoteJid?.endsWith('@g.us');
  const replyJid = isGroup
    ? msg.key.remoteJid
    : await resolveReplyJid(sock, msg.key.remoteJid);

  // Patch remoteJid so downstream commands (buscar, vincular, etc.) use the correct JID
  msg.key.remoteJid = replyJid;

  const senderJid = msg.key.participant || msg.key.remoteJid;

  // Active Claude session: intercept all messages before command routing
  if (hasSession(senderJid)) {
    if (lower === 'exit()' || lower === '!salir') {
      await handleClaudeExit(sock, senderJid, replyJid);
    } else {
      await handleClaudeMessage(sock, text, senderJid, replyJid);
    }
    return;
  }

  if (lower.startsWith('!buscar')) {
    const query = text.slice('!buscar'.length).trim();
    await handleBuscar(sock, msg, query);
    return;
  }

  if (lower === '!descargas') {
    await handleDescargas(sock, msg);
    return;
  }

  if (lower === '!ayuda') {
    const adminSection = isAdmin(senderJid)
      ? '*Administración del servidor:*\n' +
        '🏥 *!salud* — Estado de todos los servicios\n' +
        '🔄 *!reiniciar <servicio>* — Reinicia un servicio (incluye Jellyfin)\n' +
        '🤖 *!claude* — Chat con Claude CLI (exit() para terminar)\n' +
        '🆔 *!chatid* — ID del chat actual\n\n'
      : '';

    await sock.sendMessage(replyJid, {
      text:
        '*Comandos disponibles:*\n\n' +
        '🔍 *!buscar <nombre>* — Busca y solicita una película o serie\n' +
        '📥 *!descargas* — Estado actual de qBittorrent\n\n' +
        adminSection +
        '🎬 Ver contenido: https://ver.kiguisore.com\n' +
        '📋 Pedir contenido: https://pedir.kiguisore.com',
    });
    return;
  }

  if (lower === '!claude') {
    if (isAdmin(senderJid)) await handleClaudeStart(sock, senderJid, replyJid);
    return;
  }

  if (lower === '!chatid') {
    if (isAdmin(senderJid)) {
      await sock.sendMessage(replyJid, {
        text: `🆔 Chat ID de este chat:\n\`${replyJid}\``,
      });
    }
    return;
  }

  if (lower === '!salud') {
    if (isAdmin(senderJid)) await handleSalud(sock, msg);
    return;
  }

  if (lower.startsWith('!reiniciar')) {
    if (isAdmin(senderJid)) await handleReiniciar(sock, msg, text.slice('!reiniciar'.length));
    return;
  }

  if (/^\d+$/.test(text)) {
    await handleSelection(sock, msg, text);
  }
}

module.exports = { messageHandler };
