const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

const MCP_CONFIG = path.join(__dirname, '..', '..', 'mcp', 'mediaops.mcp.json');
// Same server with MEDIAOPS_PROFILE=restricted: only registers the 16
// family-facing tools, so restricted runs don't pay context for the rest.
const MCP_CONFIG_RESTRICTED = path.join(__dirname, '..', '..', 'mcp', 'mediaops-restricted.mcp.json');

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

# Honestidad sobre acciones
NO tienes scheduler, timers ni procesos entre mensajes: lo ÚNICO que ocurre es lo que tus tools hicieron en ESTE mensaje. PROHIBIDO decir "programé", "agendé", "te aviso en X min", "voy a encadenar los siguientes" — es mentira. Trabajo largo: di qué arrancó (con su job_id) y que pregunten después.

# Formato
- Español mexicano, formato WhatsApp: breve, *negritas*, emojis. Sin tablas ni markdown complejo.
- Usa el nombre de la persona, no "bro" genérico. Sin "bro/wey" para mujeres.
- NO termines con "¿necesitas algo más?" — conciso y ya.
- PROHIBIDO pedir permisos. Ya tienes acceso a tus tools. Si no existe una, di "no tengo herramienta para eso".
- Si una tool falla, reintenta o informa — NUNCA pidas autorización al usuario.
- NUNCA menciones tecnicismos internos (MCP, ToolSearch, tools, servidores, sesiones). Si algo técnico falla di solo "⚙️ tuve un problema técnico, intenta de nuevo".

# Detalles de items
Cuando des detalles de UN item específico (una descarga, una película de la
biblioteca, "info de X"), incluye SIEMPRE que la tool los provea: peso en GB
(size_gb), idiomas de audio (audioLanguages) y subtítulos (subtitles) — para
películas eso sale de media_file_info; para torrents, downloads_status trae
size_gb. Si la tool no trae el dato, di "no disponible" — no lo inventes.

# Pósters
Si un resultado incluye posterUrl, agrega: [[POSTER:<posterUrl>|<Título (año)>]]
URL real, nunca inventada. No menciones el tag. Máx 4 por respuesta.
- Catálogo: divide en 🎬 Películas / 📺 Series, 2-3 pósters representativos. Si >30, agrupa A-M / N-Z.
- "Info de X": póster + sinopsis + audio (media_file_info) + calidad.

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
  return { reply: data.result };
}

// Only modes that actually have the memory tools get this instruction —
// telling restricted users' runs to call a tool they don't have produces
// confused/hallucinated replies.
const MEMORY_POLICY =
  '\n\n# Políticas de contenido\nConsulta memory_recall antes de decisiones de calidad/audio.';

// Calls the local `claude` CLI in print mode. Modes:
//   'full'       — admin surface (Debug group): stronger model, still MCP-locked
//   'mediaops'   — all mediaops MCP tools, nothing else (internal: auto-diagnosis)
//   'restricted' — least-privilege MCP toolset (everyone else)
// extraContext is appended to the system prompt (speaker identity, permissions,
// rolling conversation history). Every run is fresh — continuity comes from
// the finite history the handler injects, not from CLI --resume sessions.
//
// No mode gets Claude Code's own builtin tools (Bash/Write/Edit/Cron/Task/
// WebFetch/...) — decided 2026-07-06 after 'full' mode's unrestricted access
// let the model reference real scheduling tools (CronCreate/ScheduleWakeup)
// it had no business touching from a WhatsApp message, which is exactly what
// produced "programé una revisión en ~20 min" (no such job ever existed).
// Admin gets a stronger model and the complete 35-tool mediaops surface —
// full control of the media stack — but never raw shell/filesystem/cron on
// the host triggered by a chat message.
async function claudeChat(message, mode = 'mediaops', extraContext = '') {
  const base = mode === 'restricted' ? SYSTEM_PROMPT : SYSTEM_PROMPT + MEMORY_POLICY;
  const system = extraContext ? `${base}\n\n${extraContext}` : base;
  const defaultModel = process.env.CLAUDE_MODEL || 'haiku';
  const adminModel = process.env.CLAUDE_MODEL_ADMIN || 'sonnet';
  const model = mode === 'full' ? adminModel : defaultModel;
  const args = ['-p', '--output-format', 'json', '--model', model,
    '--system-prompt', system, '--tools', '', '--strict-mcp-config'];

  if (mode === 'restricted') {
    args.push('--mcp-config', MCP_CONFIG_RESTRICTED,
      // = form: --allowedTools is variadic and would swallow the prompt argument
      `--allowedTools=${RESTRICTED_TOOLS}`);
  } else {
    // 'full' and 'mediaops' both get the complete 35-tool server.
    args.push('--mcp-config', MCP_CONFIG, '--allowedTools=mcp__mediaops');
  }

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
