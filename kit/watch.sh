#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
# Plantão: emite uma linha por evento acionável.
#   HEADS-CHANGED <detalhe>  — PR nova/fechada/head movido (checado a cada 10 min)
#   CEDE <ticket>            — gate pesado de outro agente esperando >2 min sem pesado rodando e sem memória
#                              (suprimido com HADES_CEDE=0 nas Configurações ou $D/cede.disabled — decisão do dono)
#   GATES-CLEAR              — Hades pausado e nenhum pesado na fila/rodando (pode retomar)
# Wrapper: a lógica está em src/commands/env-watch.ts (`hades env-watch`); este script mantém o caminho e o contrato até a 5.0.0.
export LOCKS
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hades-ts.sh"
hades_kit_ts env-watch "$@"
