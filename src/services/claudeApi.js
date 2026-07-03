const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

const MCP_CONFIG = path.join(__dirname, '..', '..', 'mcp', 'mediaops.mcp.json');

const SYSTEM_PROMPT =
  'Eres el asistente MediaOps del servidor de medios personal de Marco, hablando por WhatsApp. ' +
  'Tienes herramientas MCP "mediaops" para operar el stack (Radarr, Sonarr, Prowlarr, Bazarr, ' +
  'Jellyfin, Jellyseerr, qBittorrent y Media Manager). ' +
  'Prefiere siempre esas herramientas sobre bash para el stack. Antes de decisiones de contenido ' +
  'o calidad consulta memory_recall si está disponible (ahí viven las políticas: WEB-DL ≤8GB, audio latino, etc.). ' +
  'Responde en español, formato WhatsApp: breve, *negritas* con asteriscos, emojis, sin tablas ni markdown complejo.';

// Least-privilege toolset for non-admin users: query status and request
// media — nothing that changes server config, restarts, or deletes.
const RESTRICTED_TOOLS = [
  'library_search',
  'media_add',
  'downloads_status',
  'media_queue',
  'library_missing',
  'system_status',
  'subtitles_missing',
].map((t) => `mcp__mediaops__${t}`).join(',');

// Calls the local `claude` CLI in print mode. Modes:
//   'full'       — unrestricted (admin surfaces: Marco's DM + Debug group)
//   'mediaops'   — all mediaops MCP tools, nothing else (internal: auto-diagnosis)
//   'restricted' — least-privilege MCP toolset (everyone else)
// extraContext is appended to the system prompt (speaker identity, permissions).
// sessionId = null starts a conversation; pass the returned sessionId to continue.
async function claudeChat(message, sessionId = null, mode = 'mediaops', extraContext = '') {
  const system = extraContext ? `${SYSTEM_PROMPT}\n\n${extraContext}` : SYSTEM_PROMPT;
  const args = ['-p', '--output-format', 'json', '--mcp-config', MCP_CONFIG,
    '--append-system-prompt', system];

  if (mode === 'full') {
    args.push('--dangerously-skip-permissions');
  } else if (mode === 'restricted') {
    // = form: --allowedTools is variadic and would swallow the prompt argument
    args.push('--strict-mcp-config', `--allowedTools=${RESTRICTED_TOOLS}`);
  } else {
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
