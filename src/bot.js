require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { messageHandler, registerBotIdentity, resolveAdminGroup, retryPending } = require('./handler');
const { setupScheduler } = require('./scheduler');
const { setupNotifications, notify, adminChatId } = require('./notifications');
const { setupWebhooks } = require('./webhooks');
const { setupOptimizer } = require('./optimizer');

const logger = pino({ level: 'silent' });
let schedulerInitialized = false;

// Reconnection backoff state
const RECONNECT_BASE_MS = 3000;
const RECONNECT_CAP_MS = 60000;
const STABLE_OPEN_MS = 30000; // reset backoff after this long connected
let reconnectDelay = RECONNECT_BASE_MS;
let openSince = 0;

// Zombie socket watchdog state
let lastActivity = 0;
let watchdogTimer = null;

// Reconnection storm detection
const RECON_WINDOW_MS = 5 * 60 * 1000;
const RECON_STORM_THRESHOLD = 8;
const reconTimestamps = [];

// Mutable ref so scheduler/watcher always use the current active socket
const sockRef = { current: null };

// Stores sent messages so Baileys can re-encrypt on retry requests from devices
// that failed to decrypt (fixes "Esperando el mensaje" on mobile)
const messageStore = new Map();

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./session');
  const { version } = await fetchLatestBaileysVersion();

  console.log(`[Bot] Usando Baileys v${version.join('.')}`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: state.keys,
    },
    browser: ['Marcobot', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    getMessage: async (key) => {
      const stored = messageStore.get(`${key.remoteJid}:${key.id}`);
      return stored || { conversation: '' };
    },
  });

  sockRef.current = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    lastActivity = Date.now();
    for (const msg of messages) {
      if (msg.message && msg.key?.id) {
        messageStore.set(`${msg.key.remoteJid}:${msg.key.id}`, msg.message);
      }
    }

    if (type !== 'notify' && type !== 'append') return;

    const TEN_MIN_AGO = Date.now() - 10 * 60 * 1000;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      if (type === 'append') {
        const msgTime = Number(msg.messageTimestamp || 0) * 1000;
        if (msgTime < TEN_MIN_AGO) continue;
      }

      try {
        await messageHandler(sock, msg);
      } catch (err) {
        console.error('[Handler] Error procesando mensaje:', err.message);
      }
    }
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    lastActivity = Date.now();

    if (qr) {
      console.log('\n[Bot] Escanea este QR con WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      // Cancel watchdog for this socket — it's already dead
      if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }

      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      // Reconnection storm detection: alert Debug group if too many reconnects in window
      const now = Date.now();
      reconTimestamps.push(now);
      while (reconTimestamps.length && reconTimestamps[0] < now - RECON_WINDOW_MS) reconTimestamps.shift();
      if (reconTimestamps.length === RECON_STORM_THRESHOLD) {
        const adminId = adminChatId();
        if (adminId) {
          notify(
            `⚠️ *Bot: tormenta de reconexiones* — ${RECON_STORM_THRESHOLD} cierres en los últimos 5 min (código actual: ${code}). Revisar conectividad o estado de WhatsApp.`,
            { chatIds: [adminId] }
          ).catch(() => {});
        }
      }

      // Reset backoff only if we were stably connected long enough
      if (openSince && Date.now() - openSince >= STABLE_OPEN_MS) {
        reconnectDelay = RECONNECT_BASE_MS;
      }
      openSince = 0;

      console.log(`[Bot] Conexión cerrada. Código: ${code}. Reconectando: ${shouldReconnect}. Próximo intento en ${reconnectDelay / 1000}s`);

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, reconnectDelay);
        // Exponential backoff with ±20% jitter, capped at RECONNECT_CAP_MS
        const next = reconnectDelay * 2;
        const capped = Math.min(next, RECONNECT_CAP_MS);
        reconnectDelay = Math.round(capped * (0.8 + Math.random() * 0.4));
      } else {
        console.log('[Bot] Sesión cerrada. Borra la carpeta /session y reinicia para escanear el QR.');
      }
    } else if (connection === 'open') {
      console.log('[Bot] ✅ Conectado a WhatsApp');
      openSince = Date.now();
      lastActivity = Date.now();

      // Zombie socket watchdog: force-close if no activity for >5 min while "open"
      if (watchdogTimer) clearInterval(watchdogTimer);
      watchdogTimer = setInterval(() => {
        const ZOMBIE_TIMEOUT_MS = 5 * 60 * 1000;
        if (sockRef.current === sock && Date.now() - lastActivity > ZOMBIE_TIMEOUT_MS) {
          console.warn('[Bot] Watchdog: socket inactivo >5 min — forzando reconexión');
          try { sock.end(new Error('watchdog: socket inactivo')); } catch {}
        }
      }, 60 * 1000);

      registerBotIdentity(sock);
      resolveAdminGroup(sock).then(() => retryPending(sock)).catch(() => {});

      if (!schedulerInitialized) {
        setupScheduler(sockRef);
        setupNotifications(sockRef);
        setupWebhooks();
        setupOptimizer();
        schedulerInitialized = true;
      }
    }
  });
}

process.on('uncaughtException', (err) => {
  console.error('[Bot] uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Bot] unhandledRejection:', reason);
});

connectToWhatsApp().catch((err) => {
  console.error('[Bot] Error fatal al iniciar:', err);
  process.exit(1);
});
