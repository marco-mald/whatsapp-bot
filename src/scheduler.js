const cron = require('node-cron');
const axios = require('axios');
const jellyseerr = require('./services/jellyseerr');

function mediaTypeLabel(mediaType) {
  return mediaType === 'movie' ? '🎬 Película' : '📺 Serie';
}

function releaseYear(media) {
  const date = media.releaseDate || media.firstAirDate || '';
  return date.split('-')[0] || '?';
}

async function sendTrending(sockRef) {
  const chatId = process.env.TARGET_CHAT_ID;
  if (!chatId) {
    console.warn('[Scheduler] TARGET_CHAT_ID no configurado. Saltando notificación trending.');
    return;
  }

  if (!sockRef.current) {
    console.warn('[Scheduler] Sin socket activo. Saltando notificación trending.');
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

  await sockRef.current.sendMessage(chatId, {
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
        await sockRef.current.sendMessage(chatId, { image: Buffer.from(res.data), caption });
      } else {
        await sockRef.current.sendMessage(chatId, { text: caption });
      }
    } catch (err) {
      console.error('[Scheduler] Error enviando media trending:', err.message);
      try {
        await sockRef.current.sendMessage(chatId, { text: caption });
      } catch {}
    }

    await new Promise((r) => setTimeout(r, 1500));
  }
}

function setupScheduler(sockRef) {
  const timezone = process.env.TIMEZONE || 'America/Mexico_City';

  cron.schedule(
    '0 11 * * 0',
    () => {
      console.log('[Scheduler] Enviando sugerencias trending...');
      sendTrending(sockRef).catch((err) =>
        console.error('[Scheduler] Error fatal en sendTrending:', err)
      );
    },
    { timezone }
  );

  console.log(`[Scheduler] Notificaciones programadas: domingos 11:00am (${timezone})`);
}

module.exports = { setupScheduler, sendTrending };
