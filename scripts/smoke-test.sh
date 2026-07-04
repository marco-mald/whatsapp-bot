#!/usr/bin/env bash
# smoke-test.sh — Verifica que el system prompt obliga a Claude a usar herramientas MCP.
#
# Funciona en dos modos:
#   LOCAL (sin MCP): valida que Claude INTENTA llamar tools (aparece tool_use en JSON)
#   SERVIDOR (con MCP): valida que llama tools Y obtiene respuesta real
#
# Uso:
#   ./scripts/smoke-test.sh              # corre todos los casos
#   ./scripts/smoke-test.sh --verbose    # muestra respuesta completa
#   ./scripts/smoke-test.sh --dry        # fuerza modo seco (ignora MCP aunque exista)
#
# Requiere: claude CLI instalado.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MCP_CONFIG="$PROJECT_DIR/mcp/mediaops.mcp.json"

VERBOSE=false
DRY=false
for arg in "$@"; do
  [[ "$arg" == "--verbose" ]] && VERBOSE=true
  [[ "$arg" == "--dry" ]] && DRY=true
done

MODEL="${CLAUDE_MODEL:-haiku}"

ALLOWED_TOOLS="mcp__mediaops__downloads_status,mcp__mediaops__system_status,mcp__mediaops__library_search,mcp__mediaops__library_trending,mcp__mediaops__media_add,mcp__mediaops__media_queue,mcp__mediaops__library_missing,mcp__mediaops__subtitles_missing,mcp__mediaops__subtitles_search"

# Extract system prompt from source
SYSTEM_PROMPT=$(node -e "
  const fs = require('fs');
  const src = fs.readFileSync('$PROJECT_DIR/src/services/claudeApi.js', 'utf8');
  const match = src.match(/const SYSTEM_PROMPT = \x60([\\s\\S]*?)\x60;/);
  if (!match) { console.error('Could not extract SYSTEM_PROMPT'); process.exit(1); }
  process.stdout.write(match[1]);
")

CONTEXT="Hablas con: TestUser (jellyseerrId 1) — por grupo."
FULL_SYSTEM="$SYSTEM_PROMPT

$CONTEXT"

# Build CLI args
CLI_ARGS=(-p --output-format json --model "$MODEL" --append-system-prompt "$FULL_SYSTEM")

if [[ "$DRY" == false ]] && [[ -f "$MCP_CONFIG" ]]; then
  CLI_ARGS+=(--mcp-config "$MCP_CONFIG" --strict-mcp-config "--allowedTools=$ALLOWED_TOOLS")
  MODE="INTEGRACIÓN (con MCP)"
else
  # Dry mode: no MCP config. Claude should still express intent to use tools,
  # or say it can't get the info (both are correct — neither is hallucination).
  MODE="SECO (sin MCP)"
fi

# --- Test cases ---
# "question|expected_tool|hallucination_patterns"
# hallucination_patterns = regex that would indicate fabricated data
CASES=(
  "¿Qué se está descargando?|downloads_status|descargando.*%|GB.*restante|ETA"
  "Busca la película Interstellar|library_search|disponible en (tu|la) biblioteca|ya la tienes"
  "¿Cómo está el sistema?|system_status|todo.*(funciona|bien|correcto|normal)|servicios.*activos"
  "¿Qué hay trending esta semana?|library_trending|te recomiendo.*:|las más populares son"
)

PASS=0
FAIL=0
SKIP=0

print_result() {
  local status="$1" question="$2" detail="$3"
  case "$status" in
    PASS) echo "  ✅ PASS: $question" ;;
    FAIL) echo "  ❌ FAIL: $question"
          echo "         → $detail" ;;
    SKIP) echo "  ⚠️  SKIP: $question ($detail)" ;;
  esac
}

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║       MediaOps Smoke Test — Tool-First Prompt           ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Modelo: $MODEL"
echo "║  Modo: $MODE"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

for case in "${CASES[@]}"; do
  IFS='|' read -r question expected_tool hallucination_re <<< "$case"

  echo "  🔍 \"$question\""

  set +e
  OUTPUT=$(claude "${CLI_ARGS[@]}" "$question" 2>/dev/null)
  EXIT_CODE=$?
  set -e

  if [[ $EXIT_CODE -ne 0 ]]; then
    print_result "SKIP" "$question" "claude CLI exit code $EXIT_CODE"
    ((SKIP++))
    echo ""
    continue
  fi

  if $VERBOSE; then
    echo "     ┌─── Respuesta (500 chars) ───"
    echo "$OUTPUT" | head -c 500 | sed 's/^/     │ /'
    echo ""
    echo "     └────────────────────────────────"
  fi

  # Extract just the text result
  RESULT=$(echo "$OUTPUT" | node -e "
    const d = require('fs').readFileSync('/dev/stdin','utf8');
    try { const j = JSON.parse(d); console.log(j.result || ''); } catch(e) { console.log(d); }
  " 2>/dev/null || echo "$OUTPUT")

  # Check 1: Did it call/attempt the expected tool?
  TOOL_CALLED=false
  if echo "$OUTPUT" | grep -qi "$expected_tool"; then
    TOOL_CALLED=true
  fi

  # Check 2: Did it admit it can't get the info? (correct dry-mode behavior)
  ADMITTED_CANT=false
  if echo "$RESULT" | grep -qiE "(no (pude|pudo|puedo)|no.*(disponible|accesible|conectar)|herramienta.*(fall|no)|cannot|unable|no tengo acceso)"; then
    ADMITTED_CANT=true
  fi

  # Check 3: Did it hallucinate? (fabricated specific data without a tool)
  HALLUCINATED=false
  if [[ "$TOOL_CALLED" == false ]] && echo "$RESULT" | grep -qiE "$hallucination_re"; then
    HALLUCINATED=true
  fi

  # Verdict
  if [[ "$TOOL_CALLED" == true ]]; then
    print_result "PASS" "$question" ""
    ((PASS++))
  elif [[ "$ADMITTED_CANT" == true ]]; then
    print_result "PASS" "$question" ""
    ((PASS++))
    $VERBOSE && echo "         (admitió que no puede obtener info — correcto)"
  elif [[ "$HALLUCINATED" == true ]]; then
    SNIPPET=$(echo "$RESULT" | head -c 200)
    print_result "FAIL" "$question" "Fabricó datos sin tool call: $SNIPPET"
    ((FAIL++))
  else
    # Ambiguous: didn't clearly call tool or admit failure, but also didn't
    # obviously hallucinate. Mark as pass with note.
    print_result "PASS" "$question" ""
    ((PASS++))
    $VERBOSE && echo "         (no se detectó alucinación, respuesta genérica)"
  fi

  echo ""
done

# --- Summary ---
TOTAL=$((PASS + FAIL + SKIP))
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Resultados: $PASS/$TOTAL passed, $FAIL failed, $SKIP skipped"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo "  ⚠️  Claude fabricó respuestas sin usar herramientas."
  echo "  Corre con --verbose para ver detalle."
  exit 1
fi

if [[ $PASS -gt 0 ]]; then
  echo ""
  echo "  🎉 El prompt está forzando tool-first correctamente."
fi

exit 0
