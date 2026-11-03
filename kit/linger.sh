#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
# Linger do systemd (user manager de pé sem login), do painel do Hades.
# Precisa dele só o painel em modo boot (HADES_PANEL_AUTOSTART=boot). Uma marca só,
# $D/linger.mine: o Hades só desliga o linger que ele mesmo ligou, e só quando ninguém mais o pede.
# Uso: linger.sh sync|state
#   sync    liga ou desliga conforme as Configurações (sai 1 se não conseguir ligar)
#   state   yes | no
# Wrapper: a lógica está em src/commands/linger.ts (`hades linger`); este script mantém o caminho e o contrato até a 5.0.0.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hades-ts.sh"
hades_kit_ts linger "$@"
