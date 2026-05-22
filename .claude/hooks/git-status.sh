#!/usr/bin/env bash
# Hook: muestra estado de git al terminar la sesión (Stop).
# Si hay cambios sin commit, avisa para no perderlos.

STATUS=$(git -C "$(dirname "$0")/../.." status --porcelain 2>/dev/null)

if [ -z "$STATUS" ]; then
  echo "[HOOK] ✅ Git limpio — nada pendiente de commit"
else
  echo "[HOOK] ⚠️  Hay cambios sin commit en el repo:"
  git -C "$(dirname "$0")/../.." status --short 2>/dev/null | sed 's/^/[HOOK]   /'
  echo "[HOOK] → Recuerda hacer commit y push antes de cerrar"
fi

exit 0
