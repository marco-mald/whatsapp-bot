const http = require('http');
const { notify, adminChatId } = require('./notifications');
const { findByJellyseerr } = require('./users');
const { claudeChat } = require('./services/claudeApi');

// Receives push events from Radarr / Sonarr / Jellyseerr so the bot never
// polls. Failure events additionally trigger a rate-limited Claude diagnosis
// (mediaops MCP tools only) whose summary is posted to the group.

const MAX_BODY = 1024 * 1024;
const DIAGNOSIS_COOLDOWN_MS = 30 * 60 * 1000;
const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;

let lastDiagnosisAt = 0;
const recentEvents = new Map(); // dedupe key → timestamp

function isDuplicate(key) {
  const now = Date.now();
  for (const [k, ts] of recentEvents) if (now - ts > DEDUPE_TTL_MS) recentEvents.delete(k);
  if (recentEvents.has(key)) return true;
  recentEvents.set(key, now);
  return false;
}

async function diagnose(context) {
  const now = Date.now();
  if (now - lastDiagnosisAt < DIAGNOSIS_COOLDOWN_MS) {
    console.log('[Webhooks] Diagnóstico omitido (cooldown de 30 min)');
    return;
  }
  lastDiagnosisAt = now;

  const prompt =
    'Ocurrió este evento en el stack de medios:\n\n' +
    `${context}\n\n` +
    'Investiga la causa con tus herramientas mediaops (diagnostics_explain, system_logs, ' +
    'diagnostics_health según aplique). No reinicies ni modifiques nada.\n' +
    'Responde en español, muy breve para WhatsApp (máximo ~8 líneas): causa probable y ' +
    'qué acción conviene tomar.';

  try {
    const { reply } = await claudeChat(prompt);
    await notify(`🧠 *Diagnóstico automático:*\n\n${reply}`, { chatIds: [adminChatId()] });
  } catch (err) {
    console.error('[Webhooks] Falló el diagnóstico automático:', err.message);
  }
}

// ---- Radarr / Sonarr -------------------------------------------------------

function describeMedia(source, payload) {
  if (source === 'radarr' && payload.movie) {
    return `${payload.movie.title} (${payload.movie.year || '?'})`;
  }
  if (source === 'sonarr' && payload.series) {
    const ep = payload.episodes?.[0];
    const epTag = ep ? ` S${String(ep.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}` : '';
    return `${payload.series.title}${epTag}`;
  }
  return source;
}

async function handleArr(source, payload) {
  const event = payload.eventType;

  if (event === 'Test') {
    console.log(`[Webhooks] Test recibido de ${source} ✓`);
    return;
  }

  if (event === 'HealthIssue') {
    // Warnings are visible via !salud; only errors reach the group
    if (payload.level !== 'error') {
      console.log(`[Webhooks] Health warning de ${source} (silencioso): ${payload.message}`);
      return;
    }
    if (isDuplicate(`health:${source}:${payload.message}`)) return;
    await notify(`⚠️ *Aviso técnico (${source}):*\n${payload.message}`, { chatIds: [adminChatId()] });
    diagnose(`HealthIssue nivel error en ${source}: ${payload.message}`).catch(() => {});
    return;
  }

  if (event === 'HealthRestored') {
    if (payload.level !== 'error') return;
    await notify(`✅ *Resuelto (${source}):*\n${payload.message}`, { chatIds: [adminChatId()] });
    return;
  }

  if (event === 'ManualInteractionRequired') {
    const media = describeMedia(source, payload);
    if (isDuplicate(`manual:${source}:${media}`)) return;
    await notify(`⚠️ *Descarga atorada:* ${media}\nRequiere intervención manual en ${source}.`, { chatIds: [adminChatId()] });
    diagnose(`Descarga atorada (ManualInteractionRequired) en ${source} para: ${media}`).catch(() => {});
    return;
  }

  console.log(`[Webhooks] Evento ${source}/${event} ignorado`);
}

// ---- Jellyseerr ------------------------------------------------------------

// Route a request event to the requester's own group only (Nickole's requests
// → her group, family requests → the family group). Unknown requester →
// Debug, so no group gets someone else's noise.
function requesterRoute(requestedBy) {
  const user = findByJellyseerr({ username: requestedBy });
  if (!user?.notifyChatId) {
    console.warn(`[Webhooks] Solicitante "${requestedBy || '?'}" sin grupo asignado — aviso solo a Debug`);
    return { chatIds: [adminChatId()], user: null };
  }
  return { chatIds: [user.notifyChatId], user };
}

async function handleJellyseerr(payload) {
  const type = payload.notification_type;
  const subject = payload.subject || 'Contenido';
  const requestedBy = payload.request?.requestedBy_username;

  if (type === 'TEST_NOTIFICATION') {
    console.log('[Webhooks] Test recibido de jellyseerr ✓');
    return;
  }

  if (type === 'MEDIA_AVAILABLE') {
    if (isDuplicate(`available:${subject}`)) return;
    const { chatIds, user } = requesterRoute(requestedBy);
    // Real @mention so WhatsApp pings the requester
    const who = user ? `@${user.phone} ` : (requestedBy ? `*${requestedBy}*: ` : '');
    const mentions = user ? [`${user.phone}@s.whatsapp.net`] : [];
    await notify(
      `🍿 ${who}tu descarga está lista: *${subject}* ✅\n\n🎬 https://ver.kiguisore.com`,
      { imageUrl: payload.image || undefined, chatIds, mentions }
    );
    return;
  }

  if (type === 'MEDIA_APPROVED' || type === 'MEDIA_AUTO_APPROVED') {
    if (isDuplicate(`approved:${subject}`)) return;
    const { chatIds } = requesterRoute(requestedBy);
    const byLine = requestedBy ? ` (pedido por *${requestedBy}*)` : '';
    await notify(`📥 *${subject}* aprobado${byLine} — descargando…`, { chatIds });
    return;
  }

  if (type === 'MEDIA_FAILED') {
    if (isDuplicate(`failed:${subject}`)) return;
    const { chatIds } = requesterRoute(requestedBy);
    await notify(`❌ *${subject}* falló al procesarse.`, { chatIds });
    diagnose(`Jellyseerr reporta MEDIA_FAILED para "${subject}". Mensaje: ${payload.message || 'n/a'}`).catch(() => {});
    return;
  }

  console.log(`[Webhooks] Evento jellyseerr/${type} ignorado`);
}

// ---- HTTP server -----------------------------------------------------------

const HANDLERS = {
  radarr: (p) => handleArr('radarr', p),
  sonarr: (p) => handleArr('sonarr', p),
  jellyseerr: handleJellyseerr,
};

function setupWebhooks() {
  const port = Number(process.env.WEBHOOK_PORT || 3010);
  const token = process.env.WEBHOOK_TOKEN;
  if (!token) {
    console.warn('[Webhooks] WEBHOOK_TOKEN no configurado — receptor desactivado');
    return;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const source = url.pathname.match(/^\/hooks\/(\w+)$/)?.[1];

    if (req.method !== 'POST' || !source || !HANDLERS[source]) {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get('token') !== token) {
      res.writeHead(403).end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      res.writeHead(200).end('ok');
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        console.error(`[Webhooks] Body inválido de ${source}`);
        return;
      }
      HANDLERS[source](payload).catch((err) =>
        console.error(`[Webhooks] Error procesando ${source}:`, err.message)
      );
    });
  });

  server.on('error', (err) => console.error('[Webhooks] Error del servidor:', err.message));
  server.listen(port, '0.0.0.0', () => {
    console.log(`[Webhooks] Escuchando en puerto ${port} (radarr, sonarr, jellyseerr)`);
  });
}

module.exports = { setupWebhooks };
