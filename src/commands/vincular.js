const axios = require('axios');
const jellyseerr = require('../services/jellyseerr');
const db = require('../db');

async function fetchAvatar(url) {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
    return Buffer.from(res.data);
  } catch {
    return null;
  }
}

async function handleVincular(sock, msg, username) {
  const chatId = msg.key.remoteJid;
  const senderJid = msg.key.participant || msg.key.remoteJid;

  if (!username) {
    await sock.sendMessage(chatId, {
      text: '❌ Uso: *!vincular <usuario_jellyseerr>*\nEjemplo: !vincular marcos',
    });
    return;
  }

  await sock.sendMessage(chatId, { text: `🔍 Buscando usuario _${username}_ en Jellyseerr...` });

  let user;
  try {
    user = await jellyseerr.findUserByUsername(username);
  } catch (err) {
    await sock.sendMessage(chatId, {
      text: `❌ Error al conectar con Jellyseerr:\n${err.message}`,
    });
    return;
  }

  if (!user) {
    await sock.sendMessage(chatId, {
      text: `❌ Usuario *${username}* no encontrado en Jellyseerr.\nVerifica que el nombre de usuario sea exacto (también puedes usar tu email).`,
    });
    return;
  }

  try {
    db.setUser(senderJid, user.id, user.displayName || user.username);
  } catch (err) {
    await sock.sendMessage(chatId, {
      text: `❌ No se pudo guardar el vínculo (error de disco):\n${err.message}`,
    });
    return;
  }

  const displayName = user.displayName || user.username;
  const confirmText =
    `✅ Cuenta vinculada correctamente.\n\n` +
    `👤 *${displayName}* (ID: ${user.id})\n\n` +
    `Tus próximas peticiones se registrarán a tu nombre en Jellyseerr.`;

  const avatar = user.avatar ? await fetchAvatar(user.avatar) : null;

  if (avatar) {
    await sock.sendMessage(chatId, { image: avatar, caption: confirmText });
  } else {
    await sock.sendMessage(chatId, { text: confirmText });
  }
}

async function handleDesvincular(sock, msg) {
  const chatId = msg.key.remoteJid;
  const senderJid = msg.key.participant || msg.key.remoteJid;

  const existing = db.getUser(senderJid);
  if (!existing) {
    await sock.sendMessage(chatId, { text: 'ℹ️ No tienes ninguna cuenta vinculada.' });
    return;
  }

  db.removeUser(senderJid);
  await sock.sendMessage(chatId, {
    text: `✅ Cuenta *${existing.displayName}* desvinculada. Las peticiones irán al perfil admin.`,
  });
}

module.exports = { handleVincular, handleDesvincular };
