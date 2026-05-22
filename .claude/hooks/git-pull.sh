#!/usr/bin/env bash
# Hook: hace git pull al iniciar sesión (UserPromptSubmit, solo primera vez).
# Usa un archivo lock para no correr en cada mensaje, solo al abrir Claude.

LOCK="/tmp/portal-facturas-pull.lock"
REPO="$(dirname "$0")/../.."

# Si ya corrió en esta sesión de terminal, salir
if [ -f "$LOCK" ]; then
  exit 0
fi

touch "$LOCK"

# Pull silencioso — solo muestra output si hay cambios reales
RESULT=$(git -C "$REPO" pull --ff-only 2>&1)

if echo "$RESULT" | grep -q "Already up to date"; then
  echo "[HOOK] ✅ Repo sincronizado (ya estaba al día)"
elif echo "$RESULT" | grep -q "error\|fatal\|conflict"; then
  echo "[HOOK] ⚠️  git pull tuvo un problema — revisa manualmente"
  echo "[HOOK]    $RESULT"
else
  echo "[HOOK] 🔄 Repo actualizado:"
  echo "$RESULT" | sed 's/^/[HOOK]   /'
fi

exit 0
