#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
# Conjunto de PRs do Hades ($D/prs.list). Sem arquivo = "@me" (abertas não-draft do dono).
#   prs.sh show                 entradas + resolução (o que entraria agora, em ordem)
#   prs.sh set 4937 4959 @me    substitui a lista (números, @me, author:<login>, -<n> para excluir)
#   prs.sh add 5020 -4964       acrescenta entradas
#   prs.sh remove 5020          tira entradas
#   prs.sh reset                volta ao padrão (@me)
# Depois de mudar: $D/update.sh para aplicar.
# Wrapper: a lógica está em src/commands/prs.ts (`hades prs`); este script mantém o caminho e o contrato até a 5.0.0.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hades-ts.sh"
hades_kit_ts prs "$@"
