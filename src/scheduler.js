const cron = require('node-cron');
const axios = require('axios');
const jellyseerr = require('./services/jellyseerr');
const { targetChatIds } = require('./notifications');

function mediaTypeLabel(mediaType) {
  return mediaType === 'movie' ? '🎬 Película' : '📺 Serie';
}

function releaseYear(media) {
  const date = media.releaseDate || media.firstAirDate || '';
  return date.split('-')[0] || '?';
}

async function sendTrending(sockRef) {
  const chatIds = targetChatIds();
  if (!chatIds.length) {
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

  // Build every item once (poster download included), then fan out per group
  const items = [];
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

    let image = null;
    if (media.posterPath) {
      try {
        const url = `https://image.tmdb.org/t/p/w500${media.posterPath}`;
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
        image = Buffer.from(res.data);
      } catch {}
    }
    items.push({ caption, image });
  }

  for (const chatId of chatIds) {
    try {
      await sockRef.current.sendMessage(chatId, {
        text: '🌟 *Sugerencias de la semana* 🌟\n_Los picks de este domingo:_\n\n¿Te interesa algo? Pídelo en: https://pedir.kiguisore.com',
      });

      for (const { caption, image } of items) {
        try {
          await sockRef.current.sendMessage(chatId, image ? { image, caption } : { text: caption });
        } catch (err) {
          console.error('[Scheduler] Error enviando media trending:', err.message);
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (err) {
      console.error(`[Scheduler] Error enviando trending a ${chatId}:`, err.message);
    }
  }
}

async function sendDailySummary(sockRef) {
  const chatIds = targetChatIds();
  if (!chatIds.length || !sockRef.current) return;

  let downloads;
  try {
    const { execFileAsync } = require('./services/claudeApi');
    // Quick query via MCP — just get download status
    const axios = require('axios');
    const cfg = { url: process.env.QBIT_URL || 'http://localhost:8080' };
    const login = await axios.post(`${cfg.url}/api/v2/auth/login`,
      `username=${process.env.QBIT_USER}&password=${process.env.QBIT_PASS}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const cookie = login.headers['set-cookie']?.[0]?.split(';')[0];
    const res = await axios.get(`${cfg.url}/api/v2/torrents/info`, {
      headers: { Cookie: cookie },
    });
    downloads = res.data;
  } catch (err) {
    console.error('[Scheduler] Error obteniendo resumen diario:', err.message);
    return;
  }

  const completed = downloads.filter((t) => t.progress >= 1.0);
  const active = downloads.filter((t) => t.progress < 1.0 && t.progress > 0);
  const stalled = downloads.filter((t) => t.progress < 1.0 && t.dlspeed === 0);

  if (!completed.length && !active.length) return;

  const lines = ['📊 *Resumen diario del servidor*\n'];
  if (completed.length) {
    lines.push(`✅ *${completed.length} descarga(s) completada(s):*`);
    completed.slice(0, 10).forEach((t) => lines.push(`  • ${t.name}`));
  }
  if (active.length) {
    lines.push(`\n⬇️ *${active.length} descargando:*`);
    active.slice(0, 5).forEach((t) =>
      lines.push(`  • ${t.name} — ${Math.round(t.progress * 100)}%`)
    );
  }
  if (stalled.length) {
    lines.push(`\n⚠️ *${stalled.length} sin velocidad* (posibles torrents muertos)`);
  }

  const text = lines.join('\n');
  for (const chatId of chatIds) {
    try {
      await sockRef.current.sendMessage(chatId, { text });
    } catch (err) {
      console.error(`[Scheduler] Error enviando resumen a ${chatId}:`, err.message);
    }
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

  cron.schedule(
    '0 9 * * *',
    () => {
      console.log('[Scheduler] Enviando resumen diario...');
      sendDailySummary(sockRef).catch((err) =>
        console.error('[Scheduler] Error fatal en sendDailySummary:', err)
      );
    },
    { timezone }
  );

  console.log(`[Scheduler] Notificaciones programadas: domingos 11:00am, diario 9:00am (${timezone})`);
}

module.exports = { setupScheduler, sendTrending };
