const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

const MCP_CONFIG = path.join(__dirname, '..', '..', 'mcp', 'mediaops.mcp.json');

const SYSTEM_PROMPT =
  'Eres el asistente MediaOps del servidor de medios personal de Marco, hablando por WhatsApp. ' +
  'Tienes herramientas MCP "mediaops" para operar todo el stack (Radarr, Sonarr, Prowlarr, Bazarr, ' +
  'Jellyfin, Jellyseerr, qBittorrent y Media Manager): salud y diagnóstico, logs, reinicios, ' +
  'búsqueda y solicitud de contenido, estado y control de descargas, subtítulos, indexers, ' +
  'normalización de audio/video, sesiones de streaming, almacenamiento y memoria de preferencias. ' +
  'Prefiere siempre esas herramientas sobre bash para el stack. Antes de decisiones de contenido ' +
  'o calidad consulta memory_recall (ahí viven las políticas: WEB-DL ≤8GB, audio latino, etc.). ' +
  'Responde en español, formato WhatsApp: breve, *negritas* con asteriscos, emojis, sin tablas ni markdown complejo.';

// Calls the local `claude` CLI in print mode. Two modes:
//   'mediaops' — locked to the MediaOps MCP tools only (--strict-mcp-config,
//                no bash/file access). For !salud, !reiniciar and any flow
//                where Claude must not touch the host directly.
//   'full'     — unrestricted admin terminal (!claude session); MediaOps
//                tools are also loaded so the admin can use them too.
// sessionId = null starts a conversation; pass the returned sessionId to continue.
async function claudeChat(message, sessionId = null, mode = 'mediaops') {
  const args = ['-p', '--output-format', 'json', '--mcp-config', MCP_CONFIG,
    '--append-system-prompt', SYSTEM_PROMPT];

  if (mode === 'full') {
    args.push('--dangerously-skip-permissions');
  } else {
    // = form: --allowedTools is variadic and would swallow the prompt argument
    args.push('--strict-mcp-config', '--allowedTools=mcp__mediaops');
  }

  if (sessionId) args.push('--resume', sessionId);
  args.push(message);

  const { stdout } = await execFileAsync('claude', args, {
    timeout: 300000,
    maxBuffer: 10 * 1024 * 1024,
    cwd: process.env.HOME,
  });

  const data = JSON.parse(stdout.trim());

  if (data.is_error) throw new Error(data.result || 'Error desconocido del CLI');

  return { reply: data.result, sessionId: data.session_id };
}

module.exports = { claudeChat };
