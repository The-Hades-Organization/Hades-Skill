#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
# Reconstrói hades/local do zero: a base (hades_base: branch.base do perfil > origin/<flow.base> > origin/develop) +
# conjunto de PRs de hades pr-set ($D/prs.list; padrão @me), em ordem topológica.
# Saída: prs.tsv (ordem aplicada), rebuild.report (resultado). Não reinicia serviços.
# Wrapper: a lógica está em src/commands/rebuild-branch.ts (`hades rebuild-branch`); este script mantém o caminho e o contrato até a 5.0.0.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hades-ts.sh"
hades_kit_ts rebuild-branch "$@"
