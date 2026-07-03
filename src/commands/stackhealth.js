const { claudeChat } = require('../services/claudeApi');

const SERVICE_LIST = 'radarr, sonarr, prowlarr, bazarr, jellyseerr, qbittorrent, jellyfin, media-manager';
const MAX_REPLY_CHARS = 59000;

const WHATSAPP_STYLE =
  'Responde en español, formato breve para WhatsApp: usa *negritas* con asteriscos ' +
  'y emojis ✅❌⚠️, sin tablas ni markdown complejo.';

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
    'Eres el administrador del servidor de medios. Investiga el estado del stack con tus ' +
    'herramientas mediaops: empieza con diagnostics_health; si algo se ve mal, profundiza ' +
    'con diagnostics_explain o system_logs sobre ese servicio.\n' +
    'No reinicies ni modifiques nada: esta revisión es solo de lectura.\n' +
    `${WHATSAPP_STYLE}\n` +
    'Formato: una línea por servicio (✅/❌ y detalle solo si hay problema), después las ' +
    'advertencias activas de los ARR si las hay, y un resumen final de una línea. ' +
    'Si encontraste algo mal, sugiere el siguiente paso.';

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
    `El usuario pidió reiniciar "${svcName}" (puede tener typos; los servicios válidos son: ${SERVICE_LIST}). ` +
    'Si no corresponde a ninguno, dilo sin ejecutar nada. Si corresponde, reinícialo con ' +
    'system_restart y revisa el reporte post-reinicio que devuelve la herramienta.\n' +
    `${WHATSAPP_STYLE}\n` +
    'Confirma brevemente si quedó arriba o explica qué falló.';

  try {
    const { reply } = await claudeChat(prompt);
    await sendClaudeReply(sock, chatId, reply);
  } catch (err) {
    await sock.sendMessage(chatId, { text: `❌ Error al reiniciar:\n${err.message}` });
  }
}

module.exports = { handleSalud, handleReiniciar };
