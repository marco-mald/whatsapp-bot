# Propuesta arquitectónica: MediaOps Bot — revisión de ingeniero senior AI

## Contexto

Análisis estructural completo del sistema. El bot funciona bien para el caso base (petición de media, status de descarga). Los hallazgos apuntan a tres categorías de problema: **calidad de respuesta** (sin max_tokens, contexto plano sin señales temporales), **latencia** (cold start MCP x request, media_file_info carga toda la biblioteca), y **correctitud** (race conditions en history/inflight, retry sin backoff). Hay también capacidades ausentes con alta demanda de uso.

El modelo en producción es Sonnet (vía `CLAUDE_MODEL=sonnet` en .env del servidor). No hay Haiku en ningún path activo — todas las referencias en código han sido limpiadas.

La propuesta se divide en tres tiers ordenados por impacto/esfuerzo.

---

## Tier 1 — Quick wins (2-3h en total, impacto inmediato, sin riesgo)

### 1A. max_tokens + temperatura en la invocación de Claude

**Problema:** no hay `--max-tokens` configurado. Sonnet puede generar hasta ~8,000 tokens por respuesta. La respuesta media del bot es ~400 tokens. Sin límite, el modelo puede generar respuestas muy largas que consumen tiempo y costo innecesario, y que luego se truncan a 59,000 chars en handler.js como último recurso.

**Cambio en `src/services/claudeApi.js`:**
```js
'--max-tokens', '800',    // restricted/mediaops
// admin: '--max-tokens', '1500'  (diagnósticos son más largos)
```

Temperatura: Sonnet ya tiene comportamiento razonablemente consistente. No cambiar temperature por ahora — el CLI de Claude no expone `--temperature` como flag documentado estable. El foco es `--max-tokens`.

**Impacto:** ~30-50% reducción en tokens de output en promedio, latencia de generación reducida, costo por llamada menor.

---

### 1B. Mover instrucción de uso de historial al SYSTEM_PROMPT

**Problema:** `buildContext()` en handler.js inyecta inline con los datos de historial un párrafo explicando *cuándo* usar o ignorar el historial. Eso es una instrucción de comportamiento que no debería variar por llamada — pertenece al prompt estático.

**Cambio en `src/services/claudeApi.js` (SYSTEM_PROMPT):**
Añadir al final, antes de `# Solo sin tools`:
```
# Historial de conversación
Si recibes un bloque [HISTORIAL], úsalo SOLO si el mensaje actual claramente lo continúa (referencias como "ese", "la segunda", "cancélalo"). Comandos independientes lo ignoran.
```

Y en `src/handler.js` `buildContext()`: eliminar el párrafo de instrucción de uso que hoy se genera inline (~líneas 148-151).

---

### 1C. Instrucción de retry de tools en system prompt

**Problema:** cuando un tool devuelve `"library_search failed: ..."`, el modelo decide solo si reintenta. Sin instrucción explícita, a veces responde desde memoria (mal).

**Añadir a SYSTEM_PROMPT en claudeApi.js:**
```
Si una tool devuelve un mensaje que contiene "failed:", reintenta exactamente una vez con los mismos parámetros. Si falla de nuevo, responde: "⚙️ tuve un problema técnico, intenta de nuevo."
```

---

### 1D. Guard en JSON.parse de stdout

**Problema:** `JSON.parse(stdout.trim())` en claudeApi.js línea 90 lanza `SyntaxError` sin contexto si stdout contiene warnings de startup del CLI. El error que llega al log dice "Unexpected token" sin diagnóstico útil.

**Cambio en claudeApi.js:**
```js
let data;
try {
  data = JSON.parse(stdout.trim());
} catch (e) {
  throw new Error(`CLI output parse failed: ${e.message}\nstdout (first 500): ${stdout.slice(0, 500)}`);
}
```

---

### 1E. Backoff en el retry de claudeApi.js

**Problema:** el retry en líneas 139-155 es inmediato — si falla por rate limit (429), el segundo intento también falla. No hay clasificación de errores retryables.

**Cambio:** añadir `await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000))` antes del segundo intento. Solo reintentar en errores de proceso/red (`ENOENT`, `ETIMEDOUT`, `ERR_CHILD_PROCESS`, salida con código no-cero), no en errores de parsing o lógica.

---

## Tier 2 — Mejoras de arquitectura (1-2 días)

### 2A. Historial enriquecido con resultados de tool calls

**Problema central:** el historial guarda solo el texto visible del bot. Si el turno anterior incluyó un `library_search` que devolvió `tmdbId=157336`, ese ID no está en el historial — el modelo tiene que re-buscarlo si el usuario dice "agrégala".

**Cambio en `src/history.js` y `src/handler.js`:**

Extender el schema de history entries para incluir un campo `tools` opcional:
```json
{
  "role": "bot",
  "text": "Encontré Interstellar (2014). ¿La agrego?",
  "ts": 1234567890,
  "tools": [{"name": "library_search", "key": "tmdbId", "value": 157336}]
}
```

El CLI en `--output-format json` incluye todos los `tool_uses` en el objeto de respuesta. Parsear ese campo al completar la llamada y guardar pares clave/valor relevantes (tmdbId, job_id, hash).

Al construir el bloque de historial en `buildContext()`, incluir inline:
```
Bot [library_search → tmdbId=157336]: "Encontré Interstellar (2014). ¿La agrego?"
```

Esto elimina la clase completa de "¿cuál era el ID?" y reduce re-búsquedas innecesarias.

---

### 2B. MCP server persistente (SSE transport)

**Problema mayor de latencia:** cada invocación de `claude -p` levanta un proceso Python fresco. Cold start ~300-500ms por llamada. El cache TTL en server.py es efectivamente un no-op (el proceso muere tras cada run).

**Cambio arquitectónico:**

1. Correr el MCP server como proceso persistente vía pm2:
```bash
pm2 start "python -m mediaops.server --transport sse --port 8765" --name mediaops
pm2 start "MEDIAOPS_PROFILE=restricted python -m mediaops.server --transport sse --port 8766" --name mediaops-restricted
```

2. Cambiar `mediaops.mcp.json` y `mediaops-restricted.mcp.json` de `stdio` a `sse`:
```json
{
  "mcpServers": {
    "mediaops": { "transport": "sse", "url": "http://localhost:8765/sse" }
  }
}
```

**Beneficios:**
- Elimina cold start (~300-500ms) en cada llamada
- El cache TTL en server.py se vuelve funcional entre requests (system_status 30s, library_catalog 60s)
- Una llamada de 2s puede pasar a 1.2s

**Prerequisito:** verificar que FastMCP en pyproject.toml soporta SSE transport antes de implementar.

---

### 2C. Optimizar media_file_info (evitar carga de biblioteca completa)

**Problema:** `movie_file_info` hace `GET /api/v3/movie` (todos los movies), `series_file_info` hace `GET /api/v3/series` (todas las series). Para una biblioteca de 500+ elementos, descarga y descarta el 99% del payload en cada llamada.

**Fix en `mcp/src/mediaops/services/arr_media.py`:**
```python
# En lugar de: movies = await _get("radarr", "/movie")
movies = await _get("radarr", "/movie", {"tmdbId": tmdb_id})
match = next(iter(movies), None)

# Sonarr:
series_list = await _get("sonarr", "/series", {"tmdbId": tmdb_id})
match = next(iter(series_list), None)
```

Ambas APIs soportan filtro por `tmdbId`. **Impacto esperado:** 2-4s → 200-400ms en estas llamadas.

---

### 2D. Corregir race conditions en history.js e inflight.js

**Problema:** `load() → modify → save()` es no-atómico. Con `MAX_CONCURRENT_RUNS=4`, dos turnos completando simultáneamente pueden pisar los datos del otro: entradas de historial o inflight perdidas silenciosamente.

**Fix:** mantener el estado en memoria como fuente de verdad, cargando desde disco solo en el arranque. Eliminar los `readFileSync` en el hot path:

```js
// Cargar una vez al inicio del proceso
const _history = JSON.parse(fs.readFileSync(HISTORY_FILE) || '{}');
// Writes son síncronos sobre el Map en memoria + persist async al disco
```

Para `inflight.js`: mantener un `Set` en memoria y persistir solo en `SIGTERM`/`SIGINT`, eliminando el write en cada track/complete.

---

## Tier 3 — Nuevas capacidades

### 3A. Nuevas tools de alta demanda

**`recently_added` (restricted 👪)**
Últimas N películas/series añadidas a la biblioteca (últimos X días). Responde "¿qué hay de nuevo esta semana?" sin cargar el catálogo completo.
```
GET /api/v3/movie?sortBy=dateAdded&sortDir=desc
```

**`seasons_info` (restricted 👪)**
Dado un `tmdb_id` de serie, devuelve las temporadas disponibles y las que faltan — alimenta la UI de `media_add` (hoy el modelo debe adivinar qué temporadas existen).
```
GET /api/v3/series/{sonarrId} → statistics.seasonStatistics[]
```

**`fix_stalled_downloads` (admin only)**
Automatiza el flujo detect → delete → search para torrents estancados. Evita el flujo manual de 3 tool calls con posibilidad de error en cada paso.

**`media_remove` (admin only)**
`DELETE /api/v3/movie/{id}?deleteFiles=false` — elimina el movie del monitoring sin borrar archivo. Llena el hueco "quiero dejar de monitorear X".

---

### 3B. Correlación de logs Node ↔ MCP

Generar un `runId` por invocación en `claudeApi.js` y pasarlo al MCP server como env var. El MCP server lo incluye en cada entrada de `tool-calls.jsonl`. El Node handler lo loguea en su línea de `[NL]`.

Resultado: al debuggear "¿por qué el usuario X recibió respuesta Y?", se busca `runId` en ambos logs y se reconstruye el turno completo.

---

## Hallazgos que NO se van a cambiar (decisión documentada)

- **Absolute paths en config.py y memory.py** (`/home/marko_mald/...`): servidor de uso personal en red local, riesgo aceptado.
- **Webhook token en query string**: servidor interno, riesgo aceptado.
- **`--tools ''` syntax**: funciona en la versión actual del CLI; monitorear en upgrades.
- **6-message rolling window**: correcto para el caso base. Los job_ids de optimization se manejan con instrucción explícita en el docstring.

---

## Orden de implementación

```
Inmediato: 1D + 1E     (correctitud, sin cambio de comportamiento)
Semana 1:  1A + 1B + 1C (calidad de respuesta)
Semana 1:  2C          (latencia media_file_info — 1h, sin riesgo)
Semana 2:  2D          (correctitud history/inflight)
Semana 2:  2A          (historial enriquecido)
Semana 3:  2B          (MCP persistente — verificar FastMCP versión primero)
Semana 3:  3A tools    (recently_added + seasons_info primero)
```
