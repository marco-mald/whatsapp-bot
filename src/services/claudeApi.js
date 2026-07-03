const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

const MCP_CONFIG = path.join(__dirname, '..', '..', 'mcp', 'mediaops.mcp.json');

// Calls the local `claude` CLI in print mode. Two modes:
//   'mediaops' — locked to the MediaOps MCP tools only (--strict-mcp-config,
//                no bash/file access). For !salud, !reiniciar and any flow
//                where Claude must not touch the host directly.
//   'full'     — unrestricted admin terminal (!claude session); MediaOps
//                tools are also loaded so the admin can use them too.
// sessionId = null starts a conversation; pass the returned sessionId to continue.
async function claudeChat(message, sessionId = null, mode = 'mediaops') {
  const args = ['-p', '--output-format', 'json', '--mcp-config', MCP_CONFIG];

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
