#!/usr/bin/env bash
# svc.sh de pacote de projeto (fixture): sobe, derruba e lista os serviços de apoio. No macOS (ou launchd forçado) delega ao
# `hades svc`; no Linux segue com systemd-run --slice, como o svc.sh de um pacote real.
# Uso: svc.sh up|down|status <nome> | list      (HADES_CLI = comando da CLI hades)
source "${D:?}/env.sh" 2>/dev/null || true
HU=${HU:-hds}
hades_svc() { ${HADES_CLI:?} svc "$@"; }
if [[ ${HADES_SERVICE_MANAGER:-} == launchd || ( -z ${HADES_SERVICE_MANAGER:-} && $(uname) == Darwin ) ]]; then
  case ${1:-} in
    up) hades_svc run "$2" --workdir "$PWD" --env "SVC_NAME=$2" --slice "${HSLICE:-hades}" -- sleep 300 ;;
    down) hades_svc stop "$2" ;;
    status) hades_svc status "$2" ;;
    list) hades_svc list ;;
  esac
else
  case ${1:-} in
    up) systemd-run --user --quiet --collect --unit="$HU-$2" --slice="${HSLICE:-hades}.slice" sleep 300 ;;
    down) systemctl --user stop "$HU-$2" ;;
    status) systemctl --user is-active "$HU-$2" ;;
    list) systemctl --user list-units "$HU-*" --no-legend ;;
  esac
fi
