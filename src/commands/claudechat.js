const { claudeChat } = require('../services/claudeApi');

// senderJid → { sessionId: string | null, turns: number }
const sessions = new Map();

function hasSession(senderJid) {
  return sessions.has(senderJid);
}

async function handleClaudeStart(sock, senderJid, replyJid) {
  if (hasSession(senderJid)) {
    await sock.sendMessage(replyJid, {
      text: '⚠️ Ya tienes una sesión activa. Escribe `exit()` para terminarla primero.',
    });
    return;
  }

  sessions.set(senderJid, { sessionId: null, turns: 0 });

  await sock.sendMessage(replyJid, {
    text:
      '🤖 *Sesión de Claude iniciada*\n\n' +
      'Habla libremente. Escribe `exit()` para terminar.',
  });
}

async function handleClaudeMessage(sock, text, senderJid, replyJid) {
  const session = sessions.get(senderJid);

  try {
    await sock.sendPresenceUpdate('composing', replyJid);

    const { reply, sessionId } = await claudeChat(text, session.sessionId, 'full');
    session.sessionId = sessionId;
    session.turns += 1;

    const out =
      reply.length > 59000 ? reply.slice(0, 59000) + '\n\n_[respuesta truncada]_' : reply;

    await sock.sendMessage(replyJid, { text: out });
  } catch (err) {
    await sock.sendMessage(replyJid, { text: `❌ Error: ${err.message}` });
  } finally {
    await sock.sendPresenceUpdate('paused', replyJid).catch(() => {});
  }
}

async function handleClaudeExit(sock, senderJid, replyJid) {
  const session = sessions.get(senderJid);
  const turns = session?.turns ?? 0;
  sessions.delete(senderJid);

  await sock.sendMessage(replyJid, {
    text: `👋 Sesión terminada. (${turns} intercambio${turns !== 1 ? 's' : ''})`,
  });
}

module.exports = { hasSession, handleClaudeStart, handleClaudeMessage, handleClaudeExit };
