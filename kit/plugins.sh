#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
# Plugins do Hades (página Plugins do painel, ou aqui no terminal): listar, adicionar por URL com prévia, atualizar
# com prévia, ligar, desligar e remover. A lógica e o uso completo estão em src/commands/plugins.ts (`hades plugins`); este script só carrega o env.sh
# (worktree, $D e as Configurações, como HADES_PLUGIN_GIT_TIMEOUT).
# Uso: plugins.sh list | add <url> | add --apply <id> --commit <sha> | update <nome> [--apply --commit <sha>] |
#      enable <nome> | disable <nome> | remove <nome> --confirm <nome>   [--json] [--check]
set -euo pipefail
source "$D/hades-ts.sh"
hades_kit_ts plugins "$@"
