# Versiones en producción

Referencia de lo que está corriendo en el servidor actual. Útil si vas a levantar
el repo en otra máquina y quieres reproducir el mismo entorno.

Última verificación: 2026-07-08, commit `3fa7fe7` (deploy de los 6 commits SSE aplicado).

## App

| Componente | Versión |
|---|---|
| marcobot (`package.json`) | 1.0.0 |
| Anuncio activo (`CHANGELOG.json`) | 1.1.0 |

> Nota: `package.json` y `CHANGELOG.json` están desalineados (1.0.0 vs 1.1.0). No se tocó
> al desplegar; si te importa la consistencia, sincronízalos en algún momento.

## Runtime del sistema

| Herramienta | Versión |
|---|---|
| Node.js | v22.23.1 |
| npm | 10.9.8 |
| pm2 | 7.0.1 |
| Python (venv `mcp/.venv`) | 3.12.3 |
| uv | 0.11.26 |
| OS | Ubuntu 24.04 (kernel 6.17.0-35-generic, x86_64) |

## Dependencias Node clave (`package.json`)

| Paquete | Rango declarado | Instalado |
|---|---|---|
| @whiskeysockets/baileys | ^6.7.18 | 6.7.23 |
| axios | ^1.7.9 | 1.18.1 |
| dotenv | ^16.4.7 | 16.6.1 |
| node-cron | ^3.0.3 | 3.0.3 |
| pino | ^9.5.0 | 9.14.0 |
| qrcode-terminal | ^0.12.0 | 0.12.0 |

WhatsApp Web protocol version reportado por Baileys en runtime: `2.3000.1035194821`
(esto es la versión del protocolo WA, no del paquete Baileys — cambia con el tiempo
vía `fetchLatestBaileysVersion()`, no hace falta fijarlo).

## Dependencias Python clave (`mcp/.venv`, gestionado con `uv`)

| Paquete | Versión |
|---|---|
| mcp | 1.28.1 |
| uvicorn | 0.49.0 |
| starlette | 1.3.1 |
| sse-starlette | 3.4.5 |
| pydantic | 2.13.4 |
| pydantic-settings | 2.14.2 |
| httpx | 0.28.1 |
| anyio | 4.14.1 |

## Procesos pm2

| Nombre | Script | Puerto | Notas |
|---|---|---|---|
| marcobot | `src/bot.js` | — (webhooks en 3010) | bot principal |
| mediaops | `mcp/.venv/bin/python -m mediaops.server --transport sse --port 8765` | 8765 | MCP perfil completo |
| mediaops-restricted | ídem, `MEDIAOPS_PROFILE=restricted` | 8766 | MCP perfil restringido |
| media-manager | externo, no gestionado en este repo | — | proceso preexistente, no tocar |

## Reproducir el entorno en otra máquina

```bash
# Node
nvm install 22.23.1   # o usa tu gestor de versiones preferido

# Python venv del MCP
cd mcp
uv venv --python 3.12
uv pip install -e .
uv pip install uvicorn

# pm2
npm install -g pm2@7.0.1
```
