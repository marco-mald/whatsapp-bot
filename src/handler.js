const { handleBuscar, handleSelection } = require('./commands/buscar');
const { handleDescargas } = require('./commands/descargas');
const { handleVincular, handleDesvincular } = require('./commands/vincular');
const db = require('./db');

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    ''
  );
}

async function messageHandler(sock, msg) {
  if (msg.key.remoteJid === 'status@broadcast') return;

  // LID JIDs (@lid) can't receive replies — use the phone JID instead
  if (msg.key.remoteJid?.endsWith('@lid') && msg.key.senderPn) {
    msg.key.remoteJid = msg.key.senderPn;
  }

  if (!msg.message) return;

  const text = extractText(msg).trim();
  if (!text) return;

  const lower = text.toLowerCase();

  if (lower.startsWith('!buscar')) {
    const query = text.slice('!buscar'.length).trim();
    await handleBuscar(sock, msg, query);
    return;
  }

  if (lower === '!descargas') {
    await handleDescargas(sock, msg);
    return;
  }

  if (lower.startsWith('!vincular')) {
    const username = text.slice('!vincular'.length).trim();
    await handleVincular(sock, msg, username);
    return;
  }

  if (lower === '!desvincular') {
    await handleDesvincular(sock, msg);
    return;
  }

  if (lower === '!micuenta') {
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const linked = db.getUser(senderJid);
    await sock.sendMessage(msg.key.remoteJid, {
      text: linked
        ? `👤 Tu cuenta vinculada: *${linked.displayName}* (ID: ${linked.jellyseerrId})`
        : `ℹ️ No tienes cuenta vinculada. Usa *!vincular <usuario>* para hacerlo.`,
    });
    return;
  }

  if (lower === '!chatid') {
    await sock.sendMessage(msg.key.remoteJid, {
      text: `🆔 Chat ID de este chat:\n\`${msg.key.remoteJid}\`\n\nCópialo en TARGET_CHAT_ID de tu .env`,
    });
    return;
  }

  if (lower === '!ayuda') {
    const sent = await sock.sendMessage(msg.key.remoteJid, {
      text:
        '*Comandos disponibles:*\n\n' +
        '🔍 *!buscar <nombre>* — Busca y solicita una película o serie\n' +
        '📥 *!descargas* — Estado actual de qBittorrent\n' +
        '🔗 *!vincular <usuario>* — Vincula tu cuenta de Jellyseerr\n' +
        '👤 *!micuenta* — Ver tu cuenta vinculada\n' +
        '❌ *!desvincular* — Desvincula tu cuenta\n' +
        '🆔 *!chatid* — Muestra el ID de este chat\n\n' +
        '🎬 Ver contenido: https://ver.kiguisore.com\n' +
        '📋 Pedir contenido: https://pedir.kiguisore.com',
    });
    return;
  }

  // Check if this is a selection number for a pending !buscar search
  if (/^\d+$/.test(text)) {
    await handleSelection(sock, msg, text);
  }
}

module.exports = { messageHandler };
