#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
# Rotação de logs e limpeza de disco do Hades. Política nas Configurações → Limpeza (HADES_CLEAN_*).
# Uso: clean.sh status [--tsv]                  tamanho e o que dá para liberar, por categoria
#      clean.sh list <categoria>                o que a categoria apagaria (item, bytes, nota)
#      clean.sh run [--dry-run] [--quiet] [--yes <categoria>]...
#                                               seguro (logs, panel-jobs, panel-cache) pela política; o que apaga
#                                               artefato (images, releases, worktrees) só lista até receber --yes
#      clean.sh yes <categoria>                 limpa só uma categoria que apaga artefato (o botão do painel)
#      clean.sh rotate [--dry-run]              só a rotação dos logs (hades logrotate)
#      clean.sh apply                           instala/ajusta o timer do usuário $HU-logrotate (HADES_CLEAN_TIMER/EVERY; no macOS, plist com StartInterval)
# Categoria nova: uma entrada em src/commands/clean.ts (size, list, clean e o modo); o painel e o status leem a lista daqui.
# Wrapper: a lógica está em src/commands/clean.ts (`hades clean`); este script mantém o caminho e o contrato até a 5.0.0.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hades-ts.sh"
hades_kit_ts clean "$@"
