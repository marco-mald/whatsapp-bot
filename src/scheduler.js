const cron = require('node-cron');
const axios = require('axios');
const jellyseerr = require('./services/jellyseerr');
const qbittorrent = require('./services/qbittorrent');

function mediaTypeLabel(mediaType) {
  return mediaType === 'movie' ? '🎬 Película' : '📺 Serie';
}

function releaseYear(media) {
  const date = media.releaseDate || media.firstAirDate || '';
  return date.split('-')[0] || '?';
}

async function sendTrending(sock) {
  const chatId = process.env.TARGET_CHAT_ID;
  if (!chatId) {
    console.warn('[Scheduler] TARGET_CHAT_ID no configurado. Saltando notificación trending.');
    return;
  }

  let trending;
  try {
    trending = await jellyseerr.getTrending();
  } catch (err) {
    console.error('[Scheduler] Error al obtener trending:', err.message);
    return;
  }

  if (!trending.length) return;

  await sock.sendMessage(chatId, {
    text: '🌟 *Sugerencias de la semana* 🌟\n_Los picks de este domingo:_\n\n¿Te interesa algo? Pídelo en: https://pedir.kiguisore.com',
  });

  for (const media of trending) {
    const title = media.title || media.name;
    const year = releaseYear(media);
    const overview = media.overview
      ? media.overview.length > 220
        ? media.overview.slice(0, 218) + '…'
        : media.overview
      : '';

    const caption =
      `${mediaTypeLabel(media.mediaType)} *${title}* (${year})\n\n${overview}`.trim();

    try {
      if (media.posterPath) {
        const url = `https://image.tmdb.org/t/p/w500${media.posterPath}`;
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
        await sock.sendMessage(chatId, { image: Buffer.from(res.data), caption });
      } else {
        await sock.sendMessage(chatId, { text: caption });
      }
    } catch (err) {
      console.error('[Scheduler] Error enviando media trending:', err.message);
      // Fallback: send text only
      try {
        await sock.sendMessage(chatId, { text: caption });
      } catch {}
    }

    // Avoid flooding
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const COMPLETED_STATES = new Set([
  'uploading', 'stalledUP', 'pausedUP', 'queuedUP', 'forcedUP', 'checkingUP', 'moving',
]);

function isCompleted(torrent) {
  return COMPLETED_STATES.has(torrent.state) || torrent.progress >= 1;
}

async function checkCompletedDownloads(sock, notifiedHashes, isFirstRun) {
  const chatId = process.env.TARGET_CHAT_ID;
  if (!chatId) return;

  let torrents;
  try {
    torrents = await qbittorrent.getTorrents();
  } catch (err) {
    console.error('[Watcher] Error al obtener torrents:', err.message);
    return;
  }

  for (const t of torrents) {
    if (!isCompleted(t)) continue;
    if (notifiedHashes.has(t.hash)) continue;

    notifiedHashes.add(t.hash);

    if (isFirstRun) continue; // seed silently on startup

    console.log(`[Watcher] Descarga completada: ${t.name}`);
    try {
      await sock.sendMessage(chatId, {
        text:
          `✅ *Descarga completada* 🎉\n\n` +
          `📁 *${t.name}*\n\n` +
          `Ya está listo en tu biblioteca 👇\n` +
          `🎬 https://ver.kiguisore.com`,
      });
    } catch (err) {
      console.error('[Watcher] Error enviando notificación:', err.message);
    }
  }
}

function setupDownloadWatcher(sock) {
  const notifiedHashes = new Set();
  let isFirstRun = true;

  const run = () =>
    checkCompletedDownloads(sock, notifiedHashes, isFirstRun).finally(() => {
      isFirstRun = false;
    });

  run(); // seed immediately on startup
  setInterval(run, 2 * 60 * 1000); // then every 2 minutes

  console.log('[Watcher] Vigilando descargas completadas (cada 2 min)');
}

function setupScheduler(sock) {
  const timezone = process.env.TIMEZONE || 'America/Mexico_City';

  // Every Sunday at 11:00am
  cron.schedule(
    '0 11 * * 0',
    () => {
      console.log('[Scheduler] Enviando sugerencias trending...');
      sendTrending(sock).catch((err) =>
        console.error('[Scheduler] Error fatal en sendTrending:', err)
      );
    },
    { timezone }
  );

  console.log(`[Scheduler] Notificaciones programadas: domingos 11:00am (${timezone})`);
}

module.exports = { setupScheduler, setupDownloadWatcher, sendTrending };
