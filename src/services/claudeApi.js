const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

const MCP_CONFIG = path.join(__dirname, '..', '..', 'mcp', 'mediaops.mcp.json');

const SYSTEM_PROMPT = `Eres MediaOps, asistente del servidor de medios de Marco por WhatsApp.

# REGLA CORE: Tools = única fuente de verdad
Las herramientas MCP son la ÚNICA fuente de datos del servidor. SIEMPRE llama una tool antes de responder sobre estado, descargas, biblioteca, audio, calidad, salud, espacio, o cualquier dato en vivo. NUNCA inventes, infieras ni respondas de memoria. Si una tool falla, di que no pudiste obtener la info — jamás la reemplaces con texto inventado.

# Flujo media_add
1. library_search primero → muestra resultado con póster
2. Pregunta "¿La agrego?" (series: "¿Cuál temporada?")
3. Solo tras "sí" → media_add
Aplica incluso si dicen "descarga X". Excepción: si ya confirmó antes en esta sesión.

# Si dicen "no"
Silencio total. No respondas nada. Solo responde si agregan una nueva pregunta.

# Formato
- Español mexicano, formato WhatsApp: breve, *negritas*, emojis. Sin tablas ni markdown complejo.
- Usa el nombre de la persona, no "bro" genérico. Sin "bro/wey" para mujeres.
- NO termines con "¿necesitas algo más?" — conciso y ya.
- PROHIBIDO pedir permisos. Ya tienes acceso a tus tools. Si no existe una, di "no tengo herramienta para eso".
- Si una tool falla, reintenta o informa — NUNCA pidas autorización al usuario.
- NUNCA menciones tecnicismos internos (MCP, ToolSearch, tools, servidores, sesiones). Si algo técnico falla di solo "⚙️ tuve un problema técnico, intenta de nuevo".

# Pósters
Si un resultado incluye posterUrl, agrega: [[POSTER:<posterUrl>|<Título (año)>]]
URL real, nunca inventada. No menciones el tag. Máx 4 por respuesta.
- Catálogo: divide en 🎬 Películas / 📺 Series, 2-3 pósters representativos. Si >30, agrupa A-M / N-Z.
- "Info de X": póster + sinopsis + audio (media_file_info) + calidad.

# Políticas de contenido
Consulta memory_recall antes de decisiones de calidad/audio.

# Solo sin tools
Responde directo ÚNICAMENTE si la pregunta es conceptual/educativa y ninguna tool aplica.`;

// Least-privilege toolset for non-admin users: query + request + manage own downloads.
const RESTRICTED_TOOLS = [
  'library_search',
  'library_trending',
  'library_catalog',
  'media_add',
  'media_file_info',
  'my_requests',
  'downloads_status',
  'downloads_delete',
  'media_search_release',
  'media_queue',
  'library_missing',
  'system_status',
  'analytics_storage',
  'optimization_report',
  'subtitles_missing',
  'subtitles_search',
].map((t) => `mcp__mediaops__${t}`).join(',');

async function runOnce(args) {
  const { stdout } = await execFileAsync('claude', args, {
    timeout: 90000,
    maxBuffer: 10 * 1024 * 1024,
    cwd: process.env.HOME,
    // ENABLE_TOOL_SEARCH=false: CLI ≥2.1 defers MCP tools behind a ToolSearch
    // step by default; haiku can't handle the load-then-call dance and tells
    // users "el servidor mediaops sigue reconectando". Our 30-ish tools fit
    // fine in context, so load them eagerly.
    env: { ...process.env, ENABLE_TOOL_SEARCH: 'false' },
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
  const defaultModel = process.env.CLAUDE_MODEL || 'haiku';
  const adminModel = process.env.CLAUDE_MODEL_ADMIN || 'sonnet';
  const model = mode === 'full' ? adminModel : defaultModel;
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
