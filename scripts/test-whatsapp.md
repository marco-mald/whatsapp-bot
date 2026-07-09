# Test en producción (WhatsApp)

Después de deployar el nuevo prompt al servidor, manda estos mensajes al bot
en el grupo y verifica el comportamiento esperado.

## Casos de prueba

| # | Mensaje al bot | Esperado (✅) | Falla (❌) |
|---|---------------|---------------|------------|
| 1 | ¿Qué se está descargando? | Llama `downloads_status`, muestra datos reales o "no hay nada" | Inventa porcentajes o nombres de archivos |
| 2 | Busca Oppenheimer | Llama `library_search`, muestra resultados con pósters | Dice "está disponible" sin buscar |
| 3 | ¿Cómo está el servidor? | Llama `system_status`, reporta estado real | Dice "todo bien" sin verificar |
| 4 | ¿Qué hay bueno? | Llama `library_trending`, recomienda con pósters | Inventa títulos trending |
| 5 | ¿Qué es Radarr? | Responde directo (pregunta conceptual) | — |
| 6 | ¿Cuánto espacio queda? | Llama tool de storage/system | Inventa "quedan 500GB" |

## Qué observar en los logs

```bash
# En el servidor, sigue los logs del bot:
pm2 logs marcobot --lines 50

# Busca estas señales:
# ✅ Bueno: verás tool calls en la salida JSON del CLI
# ❌ Malo: respuesta inmediata sin "mcp__mediaops__" en la traza
```

## Validación rápida con el CLI directamente en el servidor

```bash
# Correr el smoke test completo en el servidor (con MCP activo):
cd ~/Downloads/marcobot  # o donde esté el repo
./scripts/smoke-test.sh --verbose

# O una prueba manual rápida:
claude -p --output-format json \
  --model sonnet \
  --mcp-config mcp/mediaops.mcp.json \
  --strict-mcp-config \
  "--allowedTools=mcp__mediaops__downloads_status" \
  --append-system-prompt "Eres MediaOps. Usa herramientas MCP SIEMPRE. Nunca inventes datos." \
  "¿Qué se está descargando?"
```

## Deploy

```bash
# En el servidor:
cd ~/Downloads/marcobot
git pull
pm2 restart marcobot
```
