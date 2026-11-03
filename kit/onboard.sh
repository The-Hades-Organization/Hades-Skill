#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
# Onboarding das features do Hades: quais o dono quer preparar agora e, para cada uma, o estado e os passos.
# O catálogo é onboard.tsv somado ao $D/plugin/onboard.tsv do plugin; a escolha do dono fica em $D/onboard.json. Só leitura, exceto select/skip/done/run.
# O que é do DONO (túnel público, login, sudo, token) só é mostrado, nunca executado; `run` só aceita passo da Hades.
# Uso: onboard.sh status [--json|--brief|--doctor] [--quick]   estado de cada passo (feito · pendente · não se aplica)
#      onboard.sh show <feature>      instruções e comandos de uma feature (remoto notificacoes automatico contas)
#      onboard.sh select <feature…>   preparar agora       onboard.sh skip <feature…>   não preparar
#      onboard.sh done|undone <passo> marca um passo manual (ex.: instalar o PWA)
#      onboard.sh run <passo>         roda o comando de um passo da Hades (peça o ok do dono antes)
#      onboard.sh pick                escolhe as features por menu (precisa de terminal)
#      onboard.sh reset               esquece a escolha
#   --quick   não consulta rede nem docker (devtunnel e firewall ficam "não verificado"); é o que o install.sh usa
# Saída: 0 ok · 2 uso inválido.
# Wrapper: a lógica está em src/commands/onboard.ts (`hades onboard`); este script mantém o caminho e o contrato até a 5.0.0.
export HADES_DATA=$D
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hades-ts.sh"
hades_kit_ts onboard "$@"
