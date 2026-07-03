const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Calls the local `claude` CLI in print mode.
// sessionId = null for first message, then pass the returned sessionId to continue.
async function claudeChat(message, sessionId = null) {
  const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions'];
  if (sessionId) args.push('--resume', sessionId);
  args.push(message);

  const { stdout } = await execFileAsync('claude', args, {
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
    cwd: process.env.HOME,
  });

  const data = JSON.parse(stdout.trim());

  if (data.is_error) throw new Error(data.result || 'Error desconocido del CLI');

  return { reply: data.result, sessionId: data.session_id };
}

module.exports = { claudeChat };
