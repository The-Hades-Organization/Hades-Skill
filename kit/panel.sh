#!/usr/bin/env bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
# Painel do Hades (monitoramento + ações) em http://127.0.0.1:$HADES_PANEL_PORT (padrão 21220), serviço $HU-panel.
# Fica FORA do slice $HSLICE: não conta no teto do Hades e continua no ar com o Hades pausado.
# Serviço persistente do usuário (systemd: ~/.config/systemd/user/$HU-panel.service; macOS: plist do launchd), regravado a
# cada start (porta, PATH, caminhos), para o início automático (HADES_PANEL_AUTOSTART: off | login | boot) subir o mesmo
# serviço que o start usa.
# Uso: panel.sh start|stop|restart|status|url|autostart
# Wrapper: a lógica está em src/commands/panel-service.ts (`hades panel service`); este script mantém o caminho e o contrato.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hades-ts.sh"
# restart = stop e start em duas chamadas, cada uma com o env.sh lido de novo (é o que o start regrava no serviço)
if [[ ${1:-} == restart ]]; then "$0" stop; "$0" start; exit; fi
hades_kit_ts panel service "$@"
