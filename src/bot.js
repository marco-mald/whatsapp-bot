require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { messageHandler } = require('./handler');
const { setupScheduler, setupDownloadWatcher } = require('./scheduler');

const logger = pino({ level: 'silent' });
let schedulerInitialized = false;

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

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Cache all messages (including outgoing) for retry support
    for (const msg of messages) {
      if (msg.message && msg.key?.id) {
        messageStore.set(`${msg.key.remoteJid}:${msg.key.id}`, msg.message);
      }
    }

    if (type !== 'notify' && type !== 'append') return;

    const TEN_MIN_AGO = Date.now() - 10 * 60 * 1000;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      // For catch-up messages, skip anything older than 10 minutes
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
    if (qr) {
      console.log('\n[Bot] Escanea este QR con WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      console.log(`[Bot] Conexión cerrada. Código: ${code}. Reconectando: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      } else {
        console.log('[Bot] Sesión cerrada. Borra la carpeta /session y reinicia para escanear el QR.');
      }
    } else if (connection === 'open') {
      console.log('[Bot] ✅ Conectado a WhatsApp');

      if (!schedulerInitialized) {
        setupScheduler(sock);
        setupDownloadWatcher(sock);
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
