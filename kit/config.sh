#!/usr/bin/env bash
# Configurações do Hades: catálogo config.tsv (padrões, do kit) + $D/plugin/config.tsv (do plugin do projeto)
# + $D/config.env (valores do dono, estado).
#   source config.sh          feito pelo env.sh: exporta cada chave do catálogo. Precedência: variável já definida no
#                             shell > config.env > padrão do plugin > padrão do kit
#   config.sh apply-slice     grava ~/.config/systemd/user/$HSLICE.slice com HADES_SLICE_* e aplica no slice vivo (macOS: só aviso)
#   config.sh show|get|set|unset|export|import   as Configurações pela CLI (`hades config`): show lista os valores
#                             efetivos; mudar: painel → Configurações ou config.sh set K=V
# Instância (reference/projects.md §Várias instâncias): HADES_ID do env.sh (vazio = a original, nomes de sempre) dá os
# nomes que todo script usa: HU (prefixo de unit: $HU-panel, $HU-<svc>…), HSLICE (slice) e HPROJ (projeto compose).
# O kit usa recursos do bash 4+ (local -A, ${v,,}); o /bin/bash do macOS é o 3.2, que quebra com erro críptico
if (( BASH_VERSINFO[0] < 4 )); then
  printf 'hades: precisa de bash 4 ou mais novo (este é o %s, em %s). No macOS: brew install bash\n' "$BASH_VERSION" "$BASH" >&2
  exit 69
fi
_hades_config_load() {
  local dir=${D:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)} line k v
  local -A own=()
  if [[ -f $dir/config.env ]]; then
    while IFS='=' read -r k v; do [[ $k =~ ^[A-Z][A-Z0-9_]*$ ]] && own[$k]=$v; done < "$dir/config.env"
  fi
  [[ -f $dir/config.tsv ]] || return 0
  # corte explícito por TAB: o read com IFS=TAB junta tabs seguidos e perderia o padrão vazio (HADES_GH_USER).
  # O plugin vem depois: chave nova soma; chave do núcleo, o padrão dele vence o do kit
  local -A def=() ; local -a keys=()
  local f; for f in "$dir/config.tsv" "$dir/plugin/config.tsv"; do
    [[ -f $f ]] || continue
    while IFS= read -r line; do
      k=${line%%$'\t'*}; v=${line#*$'\t'}; v=${v%%$'\t'*}
      [[ $k =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
      [[ -n ${def[$k]+x} ]] || keys+=("$k")
      def[$k]=$v
    done < "$f"
  done
  for k in "${keys[@]}"; do
    if [[ -z ${!k+x} ]]; then
      v=${def[$k]}
      [[ -n ${own[$k]+x} ]] && v=${own[$k]}
      printf -v "$k" '%s' "$v"
    fi
    export "$k"
  done
}
_hades_config_load

# HADES_ID: o do ambiente (o env.sh o define antes de carregar este arquivo) ou a linha do $D/env.sh (config.sh rodado
# solto). Sem "-" depois de hades no slice: hífen em nome de slice vira hierarquia no systemd (hades-x = filho de hades)
_hades_instance() {
  local dir=${D:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
  [[ -n ${HADES_ID+x} ]] || HADES_ID=$(sed -n 's/^HADES_ID="\{0,1\}\([^" #]*\).*/\1/p' "$dir/env.sh" 2>/dev/null | head -1)
  if [[ ! $HADES_ID =~ ^[a-z0-9_]{0,24}$ ]]; then
    echo "hades: HADES_ID inválido no $dir/env.sh ('$HADES_ID'; só [a-z0-9_], até 24): usando a forma saneada" >&2
    HADES_ID=$(printf '%s' "${HADES_ID,,}" | tr -c 'a-z0-9_' '_' | cut -c1-24)
  fi
  HU=hds${HADES_ID:+_$HADES_ID}; HSLICE=hades${HADES_ID:+_$HADES_ID}; HPROJ=$HSLICE
  export HADES_ID HU HSLICE HPROJ
}
_hades_instance

# base da branch hades/local: branch.base do perfil > origin/<flow.base> > origin/develop (sem perfil). Uso: hades_base [<dir>]
hades_base() {
  local hp=${HADES_SKILL_DIR:-$HOME/.claude/skills/hades}/loop/bin/hades b
  b=$("$hp" project get branch.base '' --dir "${1:-$W}" 2>/dev/null)
  [[ -n $b ]] || { b=$("$hp" project get flow.base '' --dir "${1:-$W}" 2>/dev/null); [[ -n $b ]] && b=origin/$b; }
  printf '%s\n' "${b:-origin/develop}"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  D=${D:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
  case ${1:-show} in
    apply-slice)
      # sem slice no macOS (ADR 0003): o teto de serviço é só recomendação; o gate-lock tem o vigia de memória próprio
      if [[ ${HADES_SERVICE_MANAGER:-} == launchd || ( -z ${HADES_SERVICE_MANAGER:-} && $(uname) == Darwin ) ]]; then
        echo "macOS: sem slice (cgroup); HADES_SLICE_MAX=$HADES_SLICE_MAX não se aplica aos serviços. O teto dos gates é o vigia de memória do gate-lock."
        exit 0
      fi
      f=$HOME/.config/systemd/user/$HSLICE.slice
      # o que o slice abriga é do plugin (plugin.json → slice); sem ele, a descrição genérica
      what=$(jq -r '.slice // ""' "$D/plugin/plugin.json" 2>/dev/null)
      want=$(printf '[Unit]\nDescription=Hades%s (%s) — teto de memória\n[Slice]\nMemoryMax=%s\nMemoryHigh=%s\nMemorySwapMax=%s' \
        "${HADES_ID:+ $HADES_ID}" "${what:-processos do ambiente, túnel e painel}" "$HADES_SLICE_MAX" "$HADES_SLICE_HIGH" "$HADES_SLICE_SWAP")
      mkdir -p "$(dirname "$f")"
      if [[ ! -f $f || $(cat "$f") != "$want" ]]; then
        printf '%s\n' "$want" > "$f" && systemctl --user daemon-reload
        echo "$HSLICE.slice gravado: MemoryMax=$HADES_SLICE_MAX MemoryHigh=$HADES_SLICE_HIGH MemorySwapMax=$HADES_SLICE_SWAP"
      else
        echo "$HSLICE.slice já está com MemoryMax=$HADES_SLICE_MAX MemoryHigh=$HADES_SLICE_HIGH MemorySwapMax=$HADES_SLICE_SWAP"
      fi
      # o arquivo vale no próximo start do slice; set-property --runtime aplica já no slice que está rodando
      systemctl --user set-property --runtime "$HSLICE.slice" "MemoryMax=$HADES_SLICE_MAX" "MemoryHigh=$HADES_SLICE_HIGH" \
        "MemorySwapMax=$HADES_SLICE_SWAP" 2>/dev/null && echo "aplicado no slice em execução" ;;
    show|get|set|unset|export|import) exec bash "$D/hades-ts.sh" config "$@" ;;
    *) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
  esac
fi
