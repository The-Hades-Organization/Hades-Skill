#!/usr/bin/env bash
# Checagens de estado compartilhadas (doctor.sh, run-hades.sh, onboard.sh): uma definição só de "está pronto?".
# Só leitura. Uso: source "$D/lib-checks.sh" (depois do env.sh). Cada função devolve 0 = sim, 1 = não.

# conta do gh que abastece o git: HADES_GH_USER ou a ativa. Imprime o token (vazio = sem login); o chamador não loga.
chk_gh_token() {
  if [[ -n ${HADES_GH_USER:-} ]]; then gh auth token --user "$HADES_GH_USER" 2>/dev/null
  else gh auth token 2>/dev/null; fi
}

# `timeout` é do GNU coreutils: no macOS só existe como gtimeout (brew install coreutils); sem nenhum, o teto é um sleep
# corrido contra o comando (wait -n, bash 4.3+). Como o timeout do GNU, o estouro mata o grupo de processos inteiro
# (set -m dá ao comando um grupo próprio: um neto vivo seguraria o pipe de quem lê) e sai 124.
_chk_timeout() {
  if command -v timeout >/dev/null; then timeout "$@"
  elif command -v gtimeout >/dev/null; then gtimeout "$@"
  elif (( BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 3 )); then shift; "$@"  # sem wait -n: roda sem teto
  else
    (
      set -m +e  # +e: com o errexit herdado, o wait -n de um comando que falhou sairia antes de dispensar o sleep
      exec 3>&2 2>/dev/null  # o aviso de job do set -m ("Concluído") vai para o lixo; o stderr do comando, não
      secs=$1
      shift
      "$@" 2>&3 & pid=$!
      sleep "$secs" & timer=$!
      wait -n
      if kill -0 "$pid"; then kill -TERM -- -"$pid"; wait "$pid"; exit 124; fi
      kill "$timer"
      wait "$pid"
    )
  fi
}

# devtunnel com login feito (consulta a rede: ~1–8 s)
chk_devtunnel_login() { _chk_timeout 8 devtunnel user show 2>&1 | grep -qiE 'logged in as'; }

# macOS (ou HADES_SERVICE_MANAGER=launchd): sem systemctl nem loginctl; a pergunta vai à CLI, que fala com o launchd
_chk_launchd() { [[ ${HADES_SERVICE_MANAGER:-} == launchd || ( -z ${HADES_SERVICE_MANAGER:-} && $(uname) == Darwin ) ]]; }
_chk_cli() { ( source "${HADES_KIT_DIR:-${D:?}}/hades-ts.sh"; hades_kit_ts "$@" ); }

chk_linger() {
  if _chk_launchd; then [[ $(_chk_cli linger state 2>/dev/null) == yes ]]  # no launchd é n/a: nunca "yes"
  else [[ $(${HADES_LOGINCTL:-loginctl} show-user "$USER" -p Linger --value 2>/dev/null) == yes ]]; fi
}

chk_unit_enabled() {
  if _chk_launchd; then _chk_cli svc is-enabled "$1" 2>/dev/null
  else [[ $(systemctl --user is-enabled "$1" 2>/dev/null) == enabled ]]; fi
}
chk_unit_active() {
  if _chk_launchd; then _chk_cli svc is-active "$1" 2>/dev/null
  else [[ $(systemctl --user is-active "$1" 2>/dev/null) == active ]]; fi
}

# Sub-rede docker da instância: HADES_DOCTOR_SUBNET (o plugin dá o padrão); vazia, a da rede <projeto>_default se já existe
# (plugin antigo, que não declarava a chave); sem nenhuma das duas, vazio = não há o que medir nem o que liberar.
fw_subnet() {
  local subnet=${HADES_DOCTOR_SUBNET:-}
  [[ -n $subnet ]] || subnet=$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "${HPROJ:-hades}_default" 2>/dev/null | awk '$1 ~ /^[0-9.]+\/[0-9]+$/ {print $1; exit}')
  [[ $subnet =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/([0-9]{1,2})$ ]] && echo "$subnet"
  return 0
}

# gateway da sub-rede (o primeiro endereço, que é o que o docker dá à bridge): 172.21.0.0/16 -> 172.21.0.1
fw_gateway() {
  local subnet=${1:-$(fw_subnet)} ip
  [[ $subnet =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/([0-9]{1,2})$ ]] || return 1
  local -a o=("${BASH_REMATCH[@]:1:4}"); local bits=${BASH_REMATCH[5]}
  (( bits <= 30 && o[0] < 256 && o[1] < 256 && o[2] < 256 && o[3] < 256 )) || return 1
  ip=$(( (10#${o[0]} << 24) | (10#${o[1]} << 16) | (10#${o[2]} << 8) | 10#${o[3]} ))
  ip=$(( (ip & (0xFFFFFFFF << (32 - bits) & 0xFFFFFFFF)) + 1 ))
  echo "$(( ip >> 24 )).$(( ip >> 16 & 255 )).$(( ip >> 8 & 255 )).$(( ip & 255 ))"
}

# o container alcança o host na porta de um serviço? (firewall docker -> host; 25/10: o gateway não chegava nos serviços)
# A sonda é HADES_FW_PROBE=<container>:<porta>, do plugin do projeto. 2 = sem sonda válida ou sem sub-rede (não medível)
fw_test() {
  local probe=${HADES_FW_PROBE:-} ctr port gw
  ctr=${probe%%:*}; port=${probe##*:}
  [[ $probe == *:* && $ctr =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ && $port =~ ^[0-9]{1,5}$ ]] || return 2
  gw=$(fw_gateway) || return 2
  docker exec "$ctr" bash -c "timeout 4 bash -c 'echo > /dev/tcp/$gw/$port'" >/dev/null 2>&1
}

# comando certo p/ liberar a rede docker->host conforme o firewall ativo da máquina (da sub-rede desta instância)
fw_cmd() {
  local net; net=$(fw_subnet)
  if [[ -z $net ]] && _chk_launchd; then echo "libere a rede docker do Hades -> host no firewall do macOS (pf)"
  elif [[ -z $net ]]; then echo "libere a rede docker do Hades -> host no seu firewall (nft/iptables, ufw ou firewalld)"
  elif ! _chk_launchd && command -v ufw >/dev/null && systemctl is-active --quiet ufw; then echo "sudo ufw allow from $net"
  elif command -v firewall-cmd >/dev/null; then echo "sudo firewall-cmd --permanent --zone=trusted --add-source=$net && sudo firewall-cmd --reload"
  else echo "libere $net -> host no seu firewall (nft/iptables)"
  fi
}
