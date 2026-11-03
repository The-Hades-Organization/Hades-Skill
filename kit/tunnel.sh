#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
# Túnel público do front (Microsoft devtunnel), expondo SÓ a porta HADES_TUNNEL_PORT (Configurações → Túnel; o
# padrão vem do plugin do projeto, que diz o que escuta nela). Vazia: os comandos do front recusam.
#
# Os passos que PUBLICAM a máquina para fora (liberar acesso e hospedar) são do DONO: o auto mode do agente
# recusa "External Ingress Tunnel", e isso é correto. O agente roda install/create/status/url e entrega os
# comandos `! ...` para o dono executar.
#
#   tunnel.sh install        baixa o CLI para ~/.local/bin (≈56 MB; o download é lento, esperar o curl terminar)
#   tunnel.sh login-cmd      imprime o comando de login (device code GitHub) para o dono rodar
#   tunnel.sh create         cria o túnel persistente `hades` (30 dias; `hades-<id>` com HADES_ID) + porta HADES_TUNNEL_PORT
#   tunnel.sh publish-cmds   imprime os 2 comandos do dono: acesso anônimo 24 h + host como unit systemd
#   tunnel.sh url            lê a URL pública do journal da unit, grava em tunnel.url e aplica no .env (CORS e links)
#   tunnel.sh status | stop-cmd
#   macOS (launchd, sem systemd-run): publish-cmds e stop-cmd imprimem `tunnel.sh front-start` e `front-stop` no lugar das linhas systemd
#
# Túnel do PAINEL (controle remoto do Hades), separado do túnel do front: `hades-panel` (`hades-panel-<id>` com HADES_ID),
# porta do painel (HADES_PANEL_PORT, padrão 21220), 30 dias. Units: $HU-devtunnel (front, no slice) e $HU-panel-tunnel.
# Acesso SÓ da conta dona do devtunnel (login GitHub no navegador): nenhuma regra anônima ou de org é criada. Além
# disso o painel exige a chave de acesso remoto ($D/panel/remote.key, mostrada só no painel local).
#   tunnel.sh panel-start | panel-url | panel-stop | panel-status
#
# Túnel do WIDGET Android, terceiro e separado: `hades-widget` (`hades-widget-<id>`), porta HADES_WIDGET_PORT (21221), unit
# $HU-widget-tunnel. É o único com acesso ANÔNIMO além do front, e só nessa porta, onde o listener do painel responde só
# GET /api/widget; o token do widget é a única autenticação. O Cerberus vê acesso=anonimo e só deixa passar com exceção
# do dono (nada de isenção). Criar, status e url são do agente; publicar e renovar (30 d) são do DONO.
#   tunnel.sh widget-create | widget-publish-cmds | widget-stamp | widget-start | widget-url | widget-stop | widget-status | widget-renew-cmds
# Wrapper: a lógica está em src/commands/tunnel.ts (`hades tunnel`); este script mantém o caminho e o contrato até a 5.0.0.
export HADES_ID HU HSLICE
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hades-ts.sh"
hades_kit_ts tunnel "$@"
