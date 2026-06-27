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
const { setupScheduler } = require('./scheduler');

const logger = pino({ level: 'silent' });
let schedulerInitialized = false;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./session');
  const { version } = await fetchLatestBaileysVersion();

  console.log(`[Bot] Usando Baileys v${version.join('.')}`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ['Marcobot', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

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
        schedulerInitialized = true;
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      try {
        await messageHandler(sock, msg);
      } catch (err) {
        console.error('[Handler] Error procesando mensaje:', err.message);
      }
    }
  });
}

connectToWhatsApp().catch((err) => {
  console.error('[Bot] Error fatal al iniciar:', err);
  process.exit(1);
});
