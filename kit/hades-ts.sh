#!/usr/bin/env bash
# Delega um script do kit a um subcomando da CLI hades (src/commands/). Os wrappers .sh o carregam (source) e chamam
# `hades_kit_ts <subcomando> "$@"`; o HADES_KIT_DIR (a pasta do shim) vale também quando o script é executado em vez de carregado.
# O kit instalado ($D) não leva o src/: a CLI vem da skill ao lado (kit/ dentro da skill) ou de HADES_SKILL_DIR.
# HADES_KIT_DIR (exportado aqui) é a pasta do wrapper: o $D dos subcomandos que leem estado do kit.
hades_kit_ts() {
  local here sk
  # chamado por um shim .sh: a pasta dele; executado: HADES_KIT_DIR, que o shim define
  if [[ -n ${BASH_SOURCE[1]:-} ]]; then here=$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd); else here=${HADES_KIT_DIR:-}; fi
  [[ -n $here ]] || { printf 'hades: HADES_KIT_DIR não definido\n' >&2; exit 1; }
  sk=$here/..; [[ -f $sk/src/cli.ts ]] || sk=${HADES_SKILL_DIR:-$HOME/.claude/skills/hades}
  [[ -f $sk/loop/bin/lib.sh ]] || { printf 'hades: skill não encontrada em %s (HADES_SKILL_DIR)\n' "$sk" >&2; exit 1; }
  export HADES_KIT_DIR=$here
  HADES_LIB_BUN_ONLY=1 source "$sk/loop/bin/lib.sh"
  hades_ts "$@"
}
# if, não &&: carregado (source) sob set -e, o status 1 do teste derrubaria o chamador
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then hades_kit_ts "$@"; fi
