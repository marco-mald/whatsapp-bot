const qbit = require('../services/qbittorrent');

const STATE_EMOJI = {
  downloading: '⬇️',
  uploading: '⬆️',
  stalledDL: '⏸',
  stalledUP: '⏸',
  pausedDL: '⏸',
  pausedUP: '⏸',
  queuedDL: '🕐',
  queuedUP: '🕐',
  checkingDL: '🔍',
  checkingUP: '🔍',
  moving: '📦',
  error: '❌',
  missingFiles: '⚠️',
  seeding: '✅',
};

function stateEmoji(state) {
  return STATE_EMOJI[state] || '❓';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatEta(secs) {
  if (!secs || secs <= 0 || secs > 8_640_000) return '∞';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function progressBar(progress, len = 10) {
  const filled = Math.round(progress * len);
  return '▓'.repeat(filled) + '░'.repeat(len - filled);
}

function truncate(str, max = 42) {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function renderTorrent(t) {
  const pct = (t.progress * 100).toFixed(1);
  const bar = progressBar(t.progress);
  const lines = [`${stateEmoji(t.state)} *${truncate(t.name)}*`];

  const parts = [`${bar} ${pct}%`];
  if (t.dlspeed > 0) parts.push(`⬇ ${formatBytes(t.dlspeed)}/s`);
  if (t.state === 'downloading' && t.eta > 0) parts.push(`⏱ ${formatEta(t.eta)}`);
  lines.push(parts.join(' | '));

  return lines.join('\n');
}

async function handleDescargas(sock, msg) {
  const chatId = msg.key.remoteJid;

  let torrents;
  try {
    torrents = await qbit.getTorrents();
  } catch (err) {
    await sock.sendMessage(chatId, {
      text: `❌ No se pudo conectar a qBittorrent:\n${err.message}`,
    });
    return;
  }

  if (!torrents.length) {
    await sock.sendMessage(chatId, { text: '📭 No hay descargas activas.' });
    return;
  }

  const downloading = torrents.filter((t) => t.state === 'downloading');
  const queued = torrents.filter((t) => t.state.startsWith('queued'));
  const stalled = torrents.filter((t) => t.state.startsWith('stalled'));
  const seeding = torrents.filter((t) => t.state === 'seeding' || t.state === 'uploading');
  const paused = torrents.filter((t) => t.state.startsWith('paused'));
  const other = torrents.filter(
    (t) =>
      !downloading.includes(t) &&
      !queued.includes(t) &&
      !stalled.includes(t) &&
      !seeding.includes(t) &&
      !paused.includes(t)
  );

  const lines = ['*📥 Estado de descargas*\n'];

  if (downloading.length) {
    lines.push(...downloading.map(renderTorrent));
    lines.push('');
  }

  if (queued.length) {
    lines.push(`*🕐 En cola (${queued.length})*`);
    queued.forEach((t) => lines.push(`  • ${truncate(t.name)}`));
    lines.push('');
  }

  if (stalled.length) {
    lines.push(`*⏸ Sin fuentes (${stalled.length})*`);
    stalled.forEach((t) => lines.push(`  • ${truncate(t.name)}`));
    lines.push('');
  }

  if (other.length) {
    other.forEach((t) => {
      lines.push(renderTorrent(t));
      lines.push('');
    });
  }

  if (seeding.length) {
    lines.push(`*✅ Sembrando: ${seeding.length}*`);
    seeding.slice(0, 4).forEach((t) => lines.push(`  • ${truncate(t.name)}`));
    if (seeding.length > 4) lines.push(`  _...y ${seeding.length - 4} más_`);
    lines.push('');
  }

  if (paused.length) {
    lines.push(`*⏸ En pausa: ${paused.length}*`);
  }

  lines.push(`_Total: ${torrents.length} torrent${torrents.length !== 1 ? 's' : ''}_`);
  lines.push('');
  lines.push('🎬 Ver tu contenido en: https://ver.kiguisore.com');

  await sock.sendMessage(chatId, { text: lines.join('\n') });
}

module.exports = { handleDescargas };
