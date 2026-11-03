#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
# Notificações do Hades no desktop (notify-send) e no celular (ntfy). Canais, eventos e silêncio nas Configurações →
# Notificações (HADES_NOTIFY*). O vigia é a unit persistente $HU-notify, fora do slice: avisa com o painel parado.
# Unit em ~/.config/systemd/user/$HU-notify.service, regravada a cada apply; sobe com o login (com a máquina, se o
# linger estiver ligado: Configurações → Painel → início automático = boot). HADES_NOTIFY_UNIT troca o nome (testes).
# Uso: notify.sh send <evento> <info|warn|error> <texto> [--obj NOME] [--state S]   (texto sem token, URL nem log)
#      notify.sh test                  manda em todos os canais ligados (ignora switches de evento e silêncio)
#      notify.sh apply                 liga/desliga o vigia conforme HADES_NOTIFY (o painel chama ao salvar)
#      notify.sh restart|status|watch
#      notify.sh topic [show|rotate]   tópico secreto do ntfy ($D/ntfy.topic, 600)
# Wrapper: a lógica está em src/commands/notify.ts (`hades notify`); este script mantém o caminho e o contrato até a 5.0.0.
export LOCKS
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hades-ts.sh"
hades_kit_ts notify "$@"
