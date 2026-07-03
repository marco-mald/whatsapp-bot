// Off-topic abuse control. The bot is for media ops, not for being used as a
// toy. Escalation (warn → roast → timeout) is decided by the LLM, but the
// timeout itself is enforced here, deterministically: a timed-out user's
// messages are dropped before any Claude run. In-memory (a bot restart lifts
// bans, which is fine for a 15-min cooldown). The admin is never timed out.

const timeouts = new Map(); // phone → expiry epoch ms
const MAX_MINUTES = 60;

function isTimedOut(phone) {
  const expiry = timeouts.get(phone);
  if (!expiry) return false;
  if (Date.now() >= expiry) {
    timeouts.delete(phone);
    return false;
  }
  return true;
}

function timeout(phone, minutes = 15) {
  const mins = Math.min(Math.max(1, minutes), MAX_MINUTES);
  timeouts.set(phone, Date.now() + mins * 60 * 1000);
  return mins;
}

module.exports = { isTimedOut, timeout };
