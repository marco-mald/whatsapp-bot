const { handleBuscar, handleSelection } = require('./commands/buscar');
const { handleDescargas } = require('./commands/descargas');

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

  if (lower === '!chatid') {
    await sock.sendMessage(msg.key.remoteJid, {
      text: `🆔 Chat ID de este chat:\n\`${msg.key.remoteJid}\`\n\nCópialo en TARGET_CHAT_ID de tu .env`,
    });
    return;
  }

  if (lower === '!ayuda') {
    await sock.sendMessage(msg.key.remoteJid, {
      text:
        '*Comandos disponibles:*\n\n' +
        '🔍 *!buscar <nombre>* — Busca y solicita una película o serie\n' +
        '📥 *!descargas* — Estado actual de qBittorrent\n' +
        '🆔 *!chatid* — Muestra el ID de este chat (para configurar notificaciones)\n\n🎬 Ver contenido: https://ver.kiguisore.com\n📋 Pedir contenido: https://pedir.kiguisore.com',
    });
    return;
  }

  // Check if this is a selection number for a pending !buscar search
  if (/^\d+$/.test(text)) {
    await handleSelection(sock, msg, text);
  }
}

module.exports = { messageHandler };
