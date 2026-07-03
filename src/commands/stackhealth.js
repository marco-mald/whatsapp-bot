const { SERVICES } = require('../services/stackhealth');
const { claudeChat } = require('../services/claudeApi');

const SERVICE_LIST = 'radarr, sonarr, prowlarr, bazarr, jellyseerr, qbittorrent, jellyfin, media-manager';
const MAX_REPLY_CHARS = 59000;

function buildServiceContext() {
  return SERVICES.map((s) => {
    const target =
      s.type === 'docker' ? `contenedor Docker "${s.container}" (docker ps / docker logs / docker restart)` :
      s.type === 'systemd' ? `servicio systemd "${s.service}" (systemctl status/restart / journalctl -u)` :
      `proceso PM2 "${s.process}" (pm2 status/restart / pm2 logs)`;
    return `- ${s.name} (${s.id}): ${target}, health endpoint ${s.healthUrl}`;
  }).join('\n');
}

async function sendClaudeReply(sock, chatId, reply) {
  const out = reply.length > MAX_REPLY_CHARS
    ? reply.slice(0, MAX_REPLY_CHARS) + '\n\n_[respuesta truncada]_'
    : reply;
  await sock.sendMessage(chatId, { text: out });
}

async function handleSalud(sock, msg) {
  const chatId = msg.key.remoteJid;

  await sock.sendMessage(chatId, { text: '🔍 Investigando el estado del stack...' });

  const prompt =
    'Eres el administrador de un servidor de medios personal (arr stack + qBittorrent + Jellyfin + Jellyseerr). ' +
    'Investiga el estado real de los siguientes servicios usando tus herramientas (Bash: docker ps, docker logs, curl, journalctl, pm2):\n\n' +
    `${buildServiceContext()}\n\n` +
    'Instrucciones:\n' +
    '- Para cada servicio, comprueba que el proceso/contenedor esté corriendo Y que su endpoint HTTP responda.\n' +
    '- Si alguno falla o se ve raro (reinicios recientes, errores en logs), investiga la causa revisando sus logs recientes y resume qué encontraste.\n' +
    '- Esto es solo de lectura: no reinicies ni modifiques nada.\n' +
    '- Responde en español, formato breve para WhatsApp (usa *negritas* con asteriscos y emojis ✅❌, sin tablas ni markdown complejo).\n' +
    '- Una línea por servicio y un resumen final. Si algo falló, sugiere si conviene revisar logs o reiniciar.';

  try {
    const { reply } = await claudeChat(prompt);
    await sendClaudeReply(sock, chatId, reply);
  } catch (err) {
    await sock.sendMessage(chatId, { text: `❌ Error al investigar el stack:\n${err.message}` });
  }
}

async function handleReiniciar(sock, msg, args) {
  const chatId = msg.key.remoteJid;
  const svcName = args.trim();

  if (!svcName) {
    await sock.sendMessage(chatId, {
      text: `⚠️ Uso: *!reiniciar <servicio>*\n\nServicios: ${SERVICE_LIST}`,
    });
    return;
  }

  await sock.sendMessage(chatId, { text: `🔄 Reiniciando *${svcName}*...` });

  const prompt =
    'Eres el administrador de un servidor de medios personal. El usuario pidió reiniciar un servicio con el comando ' +
    `"!reiniciar ${svcName}".\n\n` +
    `Servicios disponibles:\n${buildServiceContext()}\n\n` +
    'Instrucciones:\n' +
    '- Identifica a qué servicio se refiere (puede tener typos o mayúsculas distintas). Si no existe, dilo sin ejecutar nada.\n' +
    '- Reinícialo con el comando apropiado según su tipo (docker restart <contenedor>, pm2 restart <proceso>, sudo systemctl restart <servicio>).\n' +
    '- Después de reiniciar, verifica que quedó arriba (docker ps / pm2 status / systemctl status y su health endpoint).\n' +
    '- Responde en español para WhatsApp, breve: confirma si quedó bien o si algo falló, y por qué.';

  try {
    const { reply } = await claudeChat(prompt);
    await sendClaudeReply(sock, chatId, reply);
  } catch (err) {
    await sock.sendMessage(chatId, { text: `❌ Error al reiniciar:\n${err.message}` });
  }
}

module.exports = { handleSalud, handleReiniciar };
