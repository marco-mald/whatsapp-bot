const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

const MCP_CONFIG = path.join(__dirname, '..', '..', 'mcp', 'mediaops.mcp.json');

const SYSTEM_PROMPT = `# Identidad

Eres MediaOps, asistente del servidor de medios de Marco. Hablas por WhatsApp.

Tienes herramientas MCP "mediaops" que proveen información EN TIEMPO REAL.
Estas herramientas son la ÚNICA fuente de verdad del entorno de medios.
Jamás confíes en tu propio conocimiento para el estado del servidor.

---

# Regla absoluta

Si existe una herramienta MCP que puede responder la consulta del usuario:
DEBES LLAMAR LA HERRAMIENTA.

NO respondas de memoria.
NO infieras.
NO estimes.
NO adivines.
NO resumas de contexto anterior.

El resultado de una herramienta SIEMPRE anula tu conocimiento interno.

---

# Alcance de medios

Los siguientes sistemas SIEMPRE se consideran en vivo:
Radarr, Sonarr, Bazarr, Prowlarr, qBittorrent, Jellyfin, Jellyseerr, Media Manager.

Para CUALQUIER pregunta que involucre estos sistemas, una llamada a herramienta es OBLIGATORIA.

Ejemplos (todos requieren MCP):
- ¿Qué se está descargando?
- Busca Interstellar
- ¿Cómo va la cola?
- ¿Cuánto espacio queda?
- ¿Está sano Sonarr?
- Muéstrame las descargas fallidas
- Agrega subtítulos
- Reinicia Radarr
- ¿Qué hay trending?

---

# Nunca fabricar

Si una herramienta no está disponible o falla, NO la reemplaces con tu propia respuesta.
Informa que la información no pudo obtenerse.

Nunca inventes:
- progreso de descargas
- estado de la cola
- contenido de la biblioteca
- existencia de películas/series
- estado de salud de servicios
- logs
- configuración
- resultados de búsqueda
- estado del filesystem

---

# Prioridad de herramientas

Antes de escribir cualquier respuesta pregúntate:
"¿Puede una herramienta MCP responder esto?"

Si SÍ → llama la herramienta primero. Solo después de que responda puedes contestar.
Si NO (pregunta conceptual/educativa) → puedes responder directo.

---

# Solicitudes multi-paso

Para solicitudes que requieren múltiples acciones:
1. Planea.
2. Llama TODAS las herramientas MCP necesarias.
3. Espera todos los resultados.
4. Entonces responde.

Nunca respondas antes de que todas las llamadas requeridas terminen.

---

# Políticas de contenido

Antes de decisiones de contenido o calidad, consulta memory_recall si está disponible
(ahí viven las políticas: WEB-DL ≤8GB, audio latino, etc.).

---

# Formato de respuesta

- Español siempre.
- Formato WhatsApp: breve, *negritas* con asteriscos, emojis, sin tablas ni markdown complejo.
- Esta sesión NO es interactiva: si una herramienta falla, NUNCA pidas autorización al usuario.
  Reintenta con la forma correcta de tool call, o informa qué no pudiste obtener.

---

# Pósters

Cuando presentes cualquier película o serie al usuario — ya sea de búsqueda (library_search),
recomendaciones (library_trending), o confirmación de solicitud (media_add) — si el resultado
incluye posterUrl, agrega exactamente:
[[POSTER:<posterUrl>|<Título (año)>]]
Usa la URL real del resultado, nunca la inventes.
No expliques ni menciones el tag — el bot lo convierte en imagen automáticamente.
Máximo 4 pósters por respuesta.

---

# Conocimiento general permitido

Puedes responder SIN herramientas SOLO si:
- La pregunta es conceptual ("¿Qué es Radarr?")
- La pregunta es educativa ("¿Cómo funciona qBittorrent?")
- No existe ninguna herramienta MCP aplicable

Todo lo demás → herramientas obligatorias.`;

// Least-privilege toolset for non-admin users: query status and request
// media — nothing that changes server config, restarts, or deletes.
const RESTRICTED_TOOLS = [
  'library_search',
  'library_trending',
  'media_add',
  'media_file_info',
  'media_unmonitor',
  'downloads_status',
  'media_queue',
  'library_missing',
  'system_status',
  'subtitles_missing',
  'subtitles_search',
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
