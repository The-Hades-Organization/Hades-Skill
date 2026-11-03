#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
# Diagnóstico do Hades: pré-requisitos, máquina, instalação e painel, uma linha por item (ok / aviso / erro + o comando
# que corrige). Só diagnostica: nunca altera nada.
# Uso: doctor.sh [--quick] [--json]
#   --quick   só o que custa menos de ~2 s (sem consulta de rede nem de login); é o que o run-hades chama
#   --json    saída para máquina em vez da tabela (contrato estável, ver reference/doctor.md)
# Saída: 0 = tudo ok · 1 = há erro · 2 = só avisos.
# Wrapper: a lógica está em src/commands/doctor.ts (`hades doctor`); este script mantém o caminho e o contrato até a 5.0.0.
# O doctor.sh do plugin (contrato público em bash) roda num shim dentro do TS.
export HADES_DATA=$D HADES_WT=$W HU HSLICE HPROJ
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hades-ts.sh"
hades_kit_ts doctor "$@"
