const { spawn } = require('child_process');
const path = require('path');

const MCP_CONFIG = path.join(__dirname, '..', '..', 'mcp', 'mediaops.mcp.json');
// Same server with MEDIAOPS_PROFILE=restricted: only registers the 17
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
- Si una tool devuelve un mensaje que contiene "failed:", reintenta exactamente una vez con los mismos parámetros. Si falla de nuevo, di solo "⚙️ tuve un problema técnico, intenta de nuevo." — nunca inventes la información.
- NUNCA menciones tecnicismos internos (MCP, ToolSearch, tools, servidores, sesiones). Si algo técnico falla di solo "⚙️ tuve un problema técnico, intenta de nuevo".

# Detalles de items
Cuando des detalles de UN item específico (una descarga, una película de la
biblioteca, "info de X"), incluye SIEMPRE que la tool los provea: peso en GB
(size_gb), idiomas de audio (audioLanguages) y subtítulos (subtitles) — para
películas y series eso sale de media_file_info (auto-detecta el tipo); para
torrents, downloads_status trae size_gb. Si la tool no trae el dato, di "no
disponible" — no lo inventes.

# Pósters
Si un resultado incluye posterUrl, agrega: [[POSTER:<posterUrl>|<Título (año)>]]
URL real, nunca inventada. No menciones el tag. Máx 4 por respuesta.
- Catálogo: divide en 🎬 Películas / 📺 Series, 2-3 pósters representativos. Si >30, agrupa A-M / N-Z.
- "Info de X": póster + sinopsis + audio (media_file_info) + calidad.

# Historial de conversación
Si recibes un bloque [HISTORIAL], úsalo SOLO si el mensaje actual claramente lo continúa (referencias como "ese", "la segunda", "cancélalo", "agrégala"). Comandos autocontenidos o de otro tema lo ignoran por completo. Si es genuinamente ambiguo, pregunta — no adivines.

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
  'downloads_control',
  'media_search_release',
  'media_queue',
  'library_missing',
  'system_status',
  'analytics_storage',
  'analytics_library',
  'subtitles_missing',
  'subtitles_search',
  'recently_added',
  'seasons_info',
  'fix_stalled_downloads',
  'library_by_audio_language',
].map((t) => `mcp__mediaops__${t}`).join(',');

// Runs the Claude CLI and returns { reply, toolUses }.
// Uses stream-json + --verbose to capture tool_use events in real time,
// so callers can persist which tools ran (and with what key args) alongside
// the bot's visible reply in the conversation history.
function runOnce(args, runId) {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-p', '--verbose', '--output-format', 'stream-json', ...args];
    const proc = spawn('claude', fullArgs, {
      cwd: process.env.HOME,
      // ENABLE_TOOL_SEARCH=false: CLI ≥2.1 defers MCP tools behind a ToolSearch
      // step by default, which adds an extra round-trip and tells users
      // "el servidor mediaops sigue reconectando". Our 30-ish tools fit
      // fine in context, so load them eagerly.
      // MEDIAOPS_RUN_ID is inherited by the MCP server subprocess the CLI
      // spawns (stdio mode), letting us correlate Node logs with tool-calls.jsonl.
      env: { ...process.env, ENABLE_TOOL_SEARCH: 'false', MEDIAOPS_RUN_ID: runId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buf = '';
    let stderrBuf = '';
    const toolUses = [];
    let resultEvent = null;
    let settled = false;

    function processLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event;
      try { event = JSON.parse(trimmed); } catch { return; }
      if (event.type === 'assistant') {
        for (const block of (event.message?.content || [])) {
          if (block.type === 'tool_use') toolUses.push(block);
        }
      } else if (event.type === 'result') {
        resultEvent = event;
      }
    }

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete trailing fragment
      for (const line of lines) processLine(line);
    });

    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(Object.assign(err, { stderr: stderrBuf }));
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      const err = new Error('CLI timeout after 90s');
      err.code = 'ETIMEDOUT';
      err.stderr = stderrBuf;
      reject(err);
    }, 90000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      // Process any remaining buffered fragment
      if (buf.trim()) processLine(buf);

      if (!resultEvent) {
        const err = new Error(`CLI exited ${code} with no result event — stderr: ${stderrBuf.slice(0, 400)}`);
        err.code = code;
        err.stderr = stderrBuf;
        return reject(err);
      }

      if (resultEvent.is_error) {
        const err = new Error(resultEvent.result || 'Error desconocido del CLI');
        err.code = code;
        err.stderr = stderrBuf;
        return reject(err);
      }

      resolve({ reply: resultEvent.result, toolUses });
    });
  });
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
// Admin gets a stronger model and the complete 32-tool mediaops surface —
// full control of the media stack — but never raw shell/filesystem/cron on
// the host triggered by a chat message.
async function claudeChat(message, mode = 'mediaops', extraContext = '') {
  const base = mode === 'restricted' ? SYSTEM_PROMPT : SYSTEM_PROMPT + MEMORY_POLICY;
  const system = extraContext ? `${base}\n\n${extraContext}` : base;
  const defaultModel = process.env.CLAUDE_MODEL || 'sonnet';
  const adminModel = process.env.CLAUDE_MODEL_ADMIN || 'sonnet';
  const model = mode === 'full' ? adminModel : defaultModel;
  // Note: the Claude CLI does not expose --max-tokens in print mode (2.1.x).
  // Token budget is enforced via --max-budget-usd if needed.
  const args = ['--model', model,
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

  // Unique ID for this invocation — logged by the handler and inherited as
  // MEDIAOPS_RUN_ID by the MCP server, so a single grep correlates both logs.
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  try {
    return { runId, ...await runOnce(args, runId) };
  } catch (err) {
    // Parse failures are not transient — retrying the exact same call won't fix
    // a bad stdout. Only retry process/network errors (no exit code = spawn
    // failure; code 1 = CLI error; ETIMEDOUT = timeout).
    const isTransient = !err.message.startsWith('CLI exited') &&
      (err.code == null || err.code === 1 || err.code === 'ETIMEDOUT');
    console.error(
      '[ClaudeApi] Primer intento falló%s. code=%s msg=%s',
      isTransient ? ', reintentando' : ', no reintentable',
      err.code, err.message.slice(0, 200)
    );
    if (!isTransient) throw err;
    // Brief backoff before retry — avoids hammering a rate-limited API.
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
    try {
      return { runId, ...await runOnce(args, runId) };
    } catch (err2) {
      console.error(
        '[ClaudeApi] Reintento también falló. code=%s msg=%s',
        err2.code, err2.message.slice(0, 200)
      );
      throw err2;
    }
  }
}

module.exports = { claudeChat };
