const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

const MCP_CONFIG = path.join(__dirname, '..', '..', 'mcp', 'mediaops.mcp.json');

const SYSTEM_PROMPT =
  'Eres el asistente MediaOps del servidor de medios personal de Marco, hablando por WhatsApp. ' +
  'Tienes herramientas MCP "mediaops" para operar el stack (Radarr, Sonarr, Prowlarr, Bazarr, ' +
  'Jellyfin, Jellyseerr, qBittorrent y Media Manager). ' +
  'Úsalas SIEMPRE mediante tool calls directos (mcp__mediaops__*) — NUNCA las escribas como comando de ' +
  'bash/shell, eso siempre falla. Esta sesión no es interactiva: si una herramienta es denegada o falla, ' +
  'el usuario NO puede darte permisos ni confirmar nada — jamás le pidas autorización ni "acceso completo". ' +
  'Simplemente reintenta con la forma correcta de tool call, o si de plano no puedes, dile qué sí lograste. ' +
  'Antes de decisiones de contenido ' +
  'o calidad consulta memory_recall si está disponible (ahí viven las políticas: WEB-DL ≤8GB, audio latino, etc.). ' +
  'Responde en español, formato WhatsApp: breve, *negritas* con asteriscos, emojis, sin tablas ni markdown complejo. ' +
  'Cuando muestres resultados de búsqueda o recomendaciones de películas/series (library_search, ' +
  'library_trending), por cada título que tenga posterUrl agrega en tu respuesta, junto a ese título, ' +
  'exactamente el tag [[POSTER:<posterUrl>|<Título (año)>]] (usa la URL real, no la inventes) — el bot ' +
  'lo convierte en la imagen del póster automáticamente, así que no expliques el tag ni lo menciones. ' +
  'Máximo 4 pósters por respuesta para no saturar el chat.';

// Least-privilege toolset for non-admin users: query status and request
// media — nothing that changes server config, restarts, or deletes.
const RESTRICTED_TOOLS = [
  'library_search',
  'library_trending', // lets the bot actually recommend something on request
  'media_add',
  'downloads_status',
  'media_queue',
  'library_missing',
  'system_status',
  'subtitles_missing',
  'subtitles_search', // convenience: users can add subs to their own content
].map((t) => `mcp__mediaops__${t}`).join(',');

async function runOnce(args) {
  const { stdout } = await execFileAsync('claude', args, {
    timeout: 300000,
    maxBuffer: 10 * 1024 * 1024,
    cwd: process.env.HOME,
    // Explicit closed stdin: without this the CLI waits ~3s checking for
    // piped input on every single call, adding latency for no reason here.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const data = JSON.parse(stdout.trim());
  if (data.is_error) throw new Error(data.result || 'Error desconocido del CLI');
  return { reply: data.result, sessionId: data.session_id };
}

// Calls the local `claude` CLI in print mode. Modes:
//   'full'       — unrestricted (admin surfaces: Marco's DM + Debug group)
//   'mediaops'   — all mediaops MCP tools, nothing else (internal: auto-diagnosis)
//   'restricted' — least-privilege MCP toolset (everyone else)
// extraContext is appended to the system prompt (speaker identity, permissions).
// sessionId = null starts a conversation; pass the returned sessionId to continue.
async function claudeChat(message, sessionId = null, mode = 'mediaops', extraContext = '') {
  const system = extraContext ? `${SYSTEM_PROMPT}\n\n${extraContext}` : SYSTEM_PROMPT;
  const model = process.env.CLAUDE_MODEL || 'haiku'; // cheapest by default
  const args = ['-p', '--output-format', 'json', '--model', model,
    '--mcp-config', MCP_CONFIG, '--append-system-prompt', system];

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

  try {
    return await runOnce(args);
  } catch (err) {
    // Transient CLI/API hiccups happen occasionally; one silent retry before
    // surfacing an error to the user. Log full stdout/stderr either way —
    // err.message alone hides the actual cause.
    console.error(
      '[ClaudeApi] Primer intento falló, reintentando. code=%s stdout=%s stderr=%s',
      err.code, (err.stdout || '').slice(0, 500), (err.stderr || '').slice(0, 500)
    );
    try {
      return await runOnce(args);
    } catch (err2) {
      console.error(
        '[ClaudeApi] Reintento también falló. code=%s stdout=%s stderr=%s',
        err2.code, (err2.stdout || '').slice(0, 500), (err2.stderr || '').slice(0, 500)
      );
      throw err2;
    }
  }
}

module.exports = { claudeChat };
