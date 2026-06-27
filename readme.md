# Marcobot

WhatsApp bot para servidor multimedia personal. Permite buscar y solicitar contenido vía Jellyseerr, ver el estado de descargas en qBittorrent, y recibe sugerencias trending cada domingo.

## Requisitos

- Node.js 18+
- Jellyseerr corriendo y accesible
- qBittorrent con WebUI activada
- (Opcional) PM2 para producción: `npm install -g pm2`

## Instalación

```bash
git clone <repo>
cd marcobot
npm install
cp .env.example .env
```

## Configuración (.env)

```env
JELLYSEERR_URL=http://localhost:5055
JELLYSEERR_API_KEY=tu_api_key_aqui

QBIT_URL=http://localhost:8080
QBIT_USER=admin
QBIT_PASS=tu_password

TARGET_CHAT_ID=           # Ver sección "Cómo obtener el Chat ID"
TIMEZONE=America/Mexico_City
```

**Cómo obtener la API Key de Jellyseerr:**
1. Abre Jellyseerr → Ajustes → General
2. Copia el valor de "API Key"

## Primer arranque (vincular WhatsApp)

```bash
node src/bot.js
```

Aparecerá un código QR en la terminal. Escanéalo desde WhatsApp:
- Android: Ajustes → Dispositivos vinculados → Vincular dispositivo
- iPhone: Ajustes → Dispositivos vinculados → Vincular dispositivo

La sesión queda guardada en `/session`. El QR solo aparece la primera vez.

## Cómo obtener TARGET_CHAT_ID

El `TARGET_CHAT_ID` es el identificador del chat donde el bot enviará las sugerencias de los domingos (puede ser un grupo o tu chat personal).

1. Arranca el bot con `node src/bot.js`
2. Desde el chat donde quieres recibir las notificaciones, escribe `!chatid`
3. El bot te responde con el ID. Cópialo en `.env` como `TARGET_CHAT_ID`

Formatos habituales:
- Chat personal: `5215512345678@s.whatsapp.net`
- Grupo: `120363XXXXXXXXXXXXXXXX@g.us`

## Comandos disponibles

| Comando | Descripción |
|---------|-------------|
| `!buscar <nombre>` | Busca en Jellyseerr (películas y series). Si hay varios resultados, responde con el número para solicitar. |
| `!descargas` | Estado actual de qBittorrent: nombre, progreso, velocidad y ETA. |
| `!chatid` | Muestra el ID del chat actual (para configurar `TARGET_CHAT_ID`). |
| `!ayuda` | Lista de comandos. |

### Flujo de !buscar

```
Tú:   !buscar Breaking Bad
Bot:  🔍 Buscando Breaking Bad...
Bot:  Resultados:
      1. 📺 Serie — Breaking Bad (2008)
      2. 📺 Serie — Better Call Saul (2015)
Tú:   1
Bot:  [poster] ✅ Breaking Bad solicitada correctamente.
```

## Notificaciones automáticas

Cada **domingo a las 11:00am** (según `TIMEZONE` en `.env`) el bot envía 3 sugerencias trending de Jellyseerr al chat configurado en `TARGET_CHAT_ID`. Cada sugerencia incluye el poster, título, año y descripción.

## Producción con PM2

```bash
# Crear carpeta de logs
mkdir -p logs

# Arrancar con PM2
pm2 start ecosystem.config.js

# Ver logs en tiempo real
pm2 logs marcobot

# Hacer que arranque con el sistema
pm2 startup
pm2 save
```

## Estructura del proyecto

```
marcobot/
├── src/
│   ├── bot.js              # Punto de entrada, conexión Baileys
│   ├── handler.js          # Enrutador de mensajes
│   ├── scheduler.js        # Cron domingos 11am
│   ├── commands/
│   │   ├── buscar.js       # !buscar con selección en dos pasos
│   │   └── descargas.js    # !descargas con barra de progreso
│   └── services/
│       ├── jellyseerr.js   # API client Jellyseerr
│       └── qbittorrent.js  # API client qBittorrent (cookie SID)
├── session/                # Sesión de Baileys (ignorada en git)
├── logs/                   # Logs de PM2
├── .env                    # Tu configuración (ignorada en git)
├── .env.example            # Plantilla
└── ecosystem.config.js     # Configuración PM2
```

## Solución de problemas

**El QR no aparece:** Borra la carpeta `/session` y reinicia.

**Error 403 en qBittorrent:** Verifica que el usuario/contraseña sean correctos y que la WebUI esté habilitada en qBittorrent → Ajustes → WebUI.

**"Forbidden" en Jellyseerr:** Revisa que la API key sea correcta y que `JELLYSEERR_URL` no tenga barra al final.

**Las notificaciones no llegan:** Confirma que `TARGET_CHAT_ID` esté configurado y que el bot esté en ese chat/grupo.
