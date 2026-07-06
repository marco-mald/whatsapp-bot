const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { notify, inTimeWindow, adminChatId } = require('./notifications');

// Night maintenance worker: drains the Media Manager normalization backlog,
// up to OPTIMIZE_CONCURRENCY files at a time (default 2, matching Media
// Manager's own encode-slot cap), only inside OPTIMIZE_WINDOW (default
// 01:00-08:00) and only when nobody is streaming on Jellyfin. Deterministic
// — no Claude runs.
//
// Priority: needs-fix (instant, mkvpropedit) → no-aac (minutes) → needs-video
// (30-90 min ffmpeg re-encode). Failed files are remembered and skipped.

const MM = 'http://localhost:5000/api';
const STATE_PATH = path.join(__dirname, '..', 'data', 'optimizer-state.json');
const TICK_MS = 5 * 60 * 1000;
const PRIORITY = { 'needs-fix': 0, 'no-aac': 1, 'needs-video': 2 };

function windowConfig() {
  return (process.env.OPTIMIZE_WINDOW || '01:00-08:00').trim();
}

function concurrencyConfig() {
  return parseInt(process.env.OPTIMIZE_CONCURRENCY || '2', 10);
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (!Array.isArray(state.currentJobs)) {
      state.currentJobs = state.currentJob ? [state.currentJob] : [];
    }
    delete state.currentJob;
    return state;
  } catch {
    return { failedIds: [], night: null, currentJobs: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
}

async function jellyfinPlayingCount() {
  const url = process.env.JELLYFIN_URL || 'http://localhost:8096';
  const key = process.env.JELLYFIN_API_KEY;
  if (!key) return 0; // without a key we can't check; don't block the worker
  const res = await axios.get(`${url}/Sessions`, { params: { api_key: key }, timeout: 8000 });
  return res.data.filter((s) => s.NowPlayingItem).length;
}

async function reconcileJobs(state) {
  const stillRunning = [];
  for (const job of state.currentJobs) {
    const res = await axios.get(`${MM}/job/${job.jobId}`, { timeout: 10000 });
    if (!res.data.done) {
      stillRunning.push(job);
      continue;
    }
    const log = res.data.log || [];
    const failed = log.some((l) => l.startsWith('ERROR:'));
    if (failed) {
      state.failedIds.push(job.fileId);
      state.night.failed.push(job.name);
      console.log(`[Optimizer] ❌ Falló: ${job.name}`);
    } else {
      state.night.fixed.push(job.name);
      console.log(`[Optimizer] ✅ Normalizado: ${job.name}`);
    }
  }
  state.currentJobs = stillRunning;
}

async function sendMorningSummary(state) {
  const night = state.night;
  if (!night || (!night.fixed.length && !night.failed.length)) {
    state.night = null;
    return;
  }
  const lines = [`🔧 *Mantenimiento nocturno* (${night.fixed.length} normalizado${night.fixed.length !== 1 ? 's' : ''})`];
  night.fixed.slice(0, 8).forEach((n) => lines.push(`  ✅ ${n.slice(0, 55)}`));
  if (night.fixed.length > 8) lines.push(`  _...y ${night.fixed.length - 8} más_`);
  if (night.failed.length) {
    lines.push(`❌ Fallaron ${night.failed.length}:`);
    night.failed.slice(0, 4).forEach((n) => lines.push(`  • ${n.slice(0, 55)}`));
  }
  if (typeof night.remaining === 'number') {
    lines.push(`\n📋 Pendientes en el backlog: ${night.remaining}`);
  }
  state.night = null;
  try {
    // Maintenance detail is admin noise for the family — Debug group only.
    await notify(lines.join('\n'), { chatIds: [adminChatId()] });
  } catch (err) {
    console.error('[Optimizer] Error enviando resumen:', err.message);
  }
}

async function pickCandidate(state) {
  const scan = await axios.get(`${MM}/scan_status`, { timeout: 15000 });
  if (!scan.data.done) {
    if (!scan.data.running) await axios.post(`${MM}/scan`, {}, { timeout: 10000 });
    console.log('[Optimizer] Scan de biblioteca en curso, espero al siguiente tick');
    return { candidate: null, remaining: null };
  }

  const inFlight = new Set(state.currentJobs.map((j) => j.fileId));
  const pending = (scan.data.files || [])
    .filter((f) => PRIORITY[f.status] !== undefined && !state.failedIds.includes(f.id) && !inFlight.has(f.id))
    .sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status]);

  return { candidate: pending[0] || null, remaining: pending.length };
}

async function processCandidate(state, candidate) {
  // Re-probe: the scan cache can be stale after previous normalizations
  const fresh = (await axios.get(`${MM}/file/${candidate.id}`, { timeout: 30000 })).data;

  if (fresh.status === 'needs-fix') {
    const aac = (fresh.tracks || []).find((t) => t.codec === 'aac' && t.channels === 2);
    if (!aac) {
      state.failedIds.push(candidate.id);
      return;
    }
    await axios.post(`${MM}/set_default`, { file_id: candidate.id, track_index: aac.index }, { timeout: 30000 });
    state.night.fixed.push(fresh.name || candidate.name);
    console.log(`[Optimizer] ✅ Default AAC fijado: ${fresh.name}`);
    return;
  }

  if (fresh.status === 'no-aac' || fresh.status === 'needs-video') {
    const res = await axios.post(`${MM}/normalize`, { file_id: candidate.id }, { timeout: 15000 });
    if (res.data.job_id) {
      state.currentJobs.push({ jobId: res.data.job_id, fileId: candidate.id, name: fresh.name || candidate.name });
      console.log(`[Optimizer] ▶️ Job iniciado (${fresh.status}): ${fresh.name}`);
    }
  }
  // any other status: the file no longer needs work
}

async function tick() {
  const state = loadState();

  const inWindow = inTimeWindow(windowConfig());
  if (!inWindow) {
    if (state.night) {
      await reconcileJobs(state); // let running jobs finish their accounting
      if (state.currentJobs.length === 0) await sendMorningSummary(state);
    }
    saveState(state);
    return;
  }

  if (!state.night) state.night = { fixed: [], failed: [], remaining: null };

  await reconcileJobs(state);

  const concurrency = concurrencyConfig();
  const sysinfo = await axios.get(`${MM}/sysinfo`, { timeout: 10000 });
  const foreignActive = Math.max(0, sysinfo.data.active_jobs - state.currentJobs.length);
  const slotBudget = Math.max(0, concurrency - foreignActive);

  if (state.currentJobs.length >= slotBudget) {
    saveState(state);
    return; // no free slots (either our own jobs or something else is using them)
  }

  const playing = await jellyfinPlayingCount();
  if (playing > 0) {
    console.log(`[Optimizer] ${playing} sesión(es) de Jellyfin activas — no encodeo`);
    saveState(state);
    return;
  }

  while (state.currentJobs.length < slotBudget) {
    const { candidate, remaining } = await pickCandidate(state);
    if (remaining !== null) state.night.remaining = Math.max(0, remaining - 1);
    if (!candidate) break;
    await processCandidate(state, candidate); // needs-fix resolves instantly without using a slot
  }

  saveState(state);
}

function setupOptimizer() {
  const window = windowConfig();
  if (window.toLowerCase() === 'off') {
    console.log('[Optimizer] Desactivado (OPTIMIZE_WINDOW=off)');
    return;
  }
  setInterval(() => tick().catch((err) => console.error('[Optimizer] Error en tick:', err.message)), TICK_MS);
  console.log(`[Optimizer] Mantenimiento nocturno activo: ${window} (${process.env.TIMEZONE || 'America/Mexico_City'})`);
}

module.exports = { setupOptimizer, tick };
