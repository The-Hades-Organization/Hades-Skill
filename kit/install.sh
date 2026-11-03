#!/usr/bin/env bash
# Casca do instalador: roda ANTES de haver Bun (é a entrada de uma máquina nova), por isso só confere o Bun pelo registro
# (src/deps/registry.tsv) e entrega tudo à CLI. A lógica, a ajuda e o contrato do ambiente (HADES_WT, HADES_ID,
# HADES_DATA, SKIP_*…) estão em src/commands/install.ts; nada além disto fica em bash.
set -euo pipefail
KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HADES_LIB_BUN_ONLY=1 source "$KIT/../loop/bin/lib.sh"
dep_need bun
exec "$(hades_bun)" "$KIT/../src/cli.ts" install "$@"
