# Deploy pendiente — 6 commits nuevos

Ejecuta estos pasos en orden. Todo está en `~/Downloads/marcobot` salvo que se indique.

---

## 1. Bajar los cambios

```bash
cd ~/Downloads/marcobot
git pull
```

---

## 2. Instalar dependencias nuevas del MCP server

`uvicorn` es requerido por el transporte SSE (nuevo en este deploy). Si ya está, el comando no hace nada.

```bash
cd ~/Downloads/marcobot/mcp
uv pip install uvicorn
cd ..
```

---

## 3. Arrancar los dos servidores MCP persistentes

Son procesos nuevos — `pm2 start` los añade sin tocar `marcobot`.

```bash
pm2 start ecosystem.config.js
```

Verifica que los tres procesos estén `online`:

```bash
pm2 status
```

Espera resultado parecido a:
```
┌─ id ─┬─ name ────────────────┬─ status ─┐
│  0   │ marcobot              │ online   │
│  1   │ mediaops              │ online   │
│  2   │ mediaops-restricted   │ online   │
└──────┴───────────────────────┴──────────┘
```

Si `mediaops` aparece como `errored`, revisa los logs antes de continuar:

```bash
pm2 logs mediaops --lines 30
```

---

## 4. Verificar que los servidores SSE responden

```bash
# Debe conectar y quedarse colgado (stream SSE abierto) — Ctrl-C para salir
curl -s --max-time 3 http://127.0.0.1:8765/sse
curl -s --max-time 3 http://127.0.0.1:8766/sse
```

Si alguno devuelve `Connection refused`, revisa sus logs con `pm2 logs mediaops`.

---

## 5. Reiniciar el bot para que use los configs SSE

```bash
pm2 restart marcobot
```

---

## 6. Smoke test

Al arrancar el bot enviará automáticamente el anuncio de v1.1.0 a los grupos configurados en `TARGET_CHAT_ID`. Si no llega, revisa:

```bash
pm2 logs marcobot --lines 20 | grep Announcer
```

Luego manda un mensaje al bot desde WhatsApp (el grupo Debug o el que uses):

> "estado del servidor"

Debe responder con info de system_status. Revisa los logs para confirmar que conectó vía SSE y no hay errores de MCP:

```bash
pm2 logs marcobot --lines 50
```

No deben aparecer líneas de `spawning` ni `cold start` del servidor Python — el MCP ya estaba corriendo.

---

## Qué incluye este deploy

| Commit | Qué hace |
|--------|----------|
| `9a1a0a4` | Tier 1: retry con backoff, instrucciones de tool-retry en system prompt, guard en parse de stdout |
| `2cb2f4c` | Tier 2A+2C: historial enriquecido con tool keys (tmdbId/hash), queries ARR filtradas por tmdbId (más rápido), eliminado `--max-tokens` inexistente |
| `2dfadcb` | Tier 2D: history.js e inflight.js sin race conditions (Map en memoria, writes async) |
| `fb66d99` | Tier 3A: tools nuevas `recently_added`, `seasons_info`, `fix_stalled_downloads`, `media_remove`; auto-fix de torrents stalled cada 20 min |
| `ae11077` | Tier 3B: runId por invocación, correlaciona logs Node con tool-calls.jsonl |
| `cdd4707` | Tier 2B: MCP persistente vía SSE — elimina cold start Python ~300-500ms por mensaje |

---

## Rollback si algo falla

```bash
# Volver al commit anterior al deploy
git log --oneline -10   # identifica el commit antes de estos 6

# Detener los servidores MCP nuevos
pm2 delete mediaops mediaops-restricted

# Revertir código
git reset --hard <commit-anterior>

# Reiniciar bot
pm2 restart marcobot
```
