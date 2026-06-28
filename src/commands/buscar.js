const axios = require('axios');
const jellyseerr = require('../services/jellyseerr');
const db = require('../db');

// "chatId:participantId" -> { results: [], expires: timestamp }
const pendingSearches = new Map();

const PENDING_TTL_MS = 5 * 60 * 1000;

// In groups, participant is the individual sender; in DMs it's the chatId itself
function senderKey(msg) {
  const chat = msg.key.remoteJid;
  const participant = msg.key.participant || chat;
  return `${chat}:${participant}`;
}

function mediaTypeLabel(mediaType) {
  return mediaType === 'movie' ? '🎬 Película' : '📺 Serie';
}

function releaseYear(media) {
  const date = media.releaseDate || media.firstAirDate || '';
  return date.split('-')[0] || '?';
}

async function sendPoster(sock, chatId, posterPath, caption) {
  if (!posterPath) return false;
  try {
    const url = `https://image.tmdb.org/t/p/w500${posterPath}`;
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
    await sock.sendMessage(chatId, { image: Buffer.from(res.data), caption });
    return true;
  } catch {
    return false;
  }
}

async function handleBuscar(sock, msg, query) {
  const chatId = msg.key.remoteJid;
  const senderJid = msg.key.participant || msg.key.remoteJid;

  if (!db.getUser(senderJid)) {
    await sock.sendMessage(chatId, {
      text: '⚠️ Necesitas vincular tu cuenta antes de pedir contenido.\n\nUsa *!vincular <tu_usuario_jellyseerr>* para hacerlo.',
    });
    return;
  }

  if (!query) {
    await sock.sendMessage(chatId, { text: '❌ Uso: *!buscar <nombre>*\nEjemplo: !buscar Breaking Bad' });
    return;
  }

  await sock.sendMessage(chatId, { text: `🔍 Buscando _${query}_...` });

  let results;
  try {
    results = await jellyseerr.search(query);
  } catch (err) {
    await sock.sendMessage(chatId, { text: `❌ Error al buscar en Jellyseerr:\n${err.message}` });
    return;
  }

  if (!results.length) {
    await sock.sendMessage(chatId, { text: '😕 Sin resultados. Prueba con otro nombre.' });
    return;
  }

  const top = results.slice(0, 5);

  // Store pending search keyed by sender so multiple users in a group don't conflict
  pendingSearches.set(senderKey(msg), { results: top, expires: Date.now() + PENDING_TTL_MS });

  if (top.length === 1) {
    const r = top[0];
    const year = releaseYear(r);
    const title = r.title || r.name;
    const caption = `${mediaTypeLabel(r.mediaType)} *${title}* (${year})\n\nResponde con *1* para solicitar o cualquier otra cosa para cancelar.`;
    const sent = await sendPoster(sock, chatId, r.posterPath, caption);
    if (!sent) await sock.sendMessage(chatId, { text: caption });
    return;
  }

  let text = `*Resultados para "${query}":*\n\n`;
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    text += `*${i + 1}.* ${mediaTypeLabel(r.mediaType)} — ${r.title || r.name} (${releaseYear(r)})\n`;
  }
  text += '\n_Responde con el número para solicitar_';

  await sock.sendMessage(chatId, { text });
}

async function handleSelection(sock, msg, numberStr) {
  const chatId = msg.key.remoteJid;
  const key = senderKey(msg);
  const pending = pendingSearches.get(key);

  if (!pending || Date.now() > pending.expires) {
    pendingSearches.delete(key);
    return false;
  }

  const idx = parseInt(numberStr, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= pending.results.length) {
    await sock.sendMessage(chatId, {
      text: `❌ Número inválido. Elige entre 1 y ${pending.results.length}.`,
    });
    return true;
  }

  const media = pending.results[idx];
  pendingSearches.delete(key);

  const title = media.title || media.name;
  const year = releaseYear(media);

  // Resolve linked Jellyseerr user
  const senderJid = msg.key.participant || msg.key.remoteJid;
  const linkedUser = db.getUser(senderJid);
  const userId = linkedUser?.jellyseerrId || null;

  // Show poster while requesting
  const caption = `${mediaTypeLabel(media.mediaType)} *${title}* (${year})\n\n⏳ Solicitando...`;
  const sent = await sendPoster(sock, chatId, media.posterPath, caption);
  if (!sent) await sock.sendMessage(chatId, { text: caption });

  try {
    await jellyseerr.requestMedia(media.mediaType, media.id, userId);
    const userTag = linkedUser ? ` (a nombre de *${linkedUser.displayName}*)` : '';
    await sock.sendMessage(chatId, {
      text: `✅ *${title}* solicitada correctamente${userTag}.\nJellyseerr gestionará la descarga automáticamente.\n\n📋 Revisa el estado en: https://pedir.kiguisore.com`,
    });
  } catch (err) {
    const apiMsg = err.response?.data?.message || '';
    if (/already|existe|disponible/i.test(apiMsg)) {
      await sock.sendMessage(chatId, {
        text: `ℹ️ *${title}* ya estaba solicitada o ya está disponible en tu biblioteca.`,
      });
    } else {
      await sock.sendMessage(chatId, {
        text: `❌ Error al solicitar: ${apiMsg || err.message}`,
      });
    }
  }

  return true;
}

module.exports = { handleBuscar, handleSelection };
